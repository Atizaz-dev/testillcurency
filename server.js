/**
 * Serves `public/` and provides auth, usage tracking, admin APIs, and Stripe webhooks.
 * Local: `npm start` (SQLite in ./data unless DATABASE_URL is set).
 * Vercel: set DATABASE_URL (Neon etc.) — see vercel.json + api/index.js
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const compression = require("compression");
const multer = require("multer");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { initStore, getStore, nowIso, addDaysIso, maxIso } = require("./lib/store");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_COOKIE = "gc_session";
const SESSION_DAYS = 60;
const SUBSCRIPTION_GRANT_DAYS = 30;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

function parseUserIdFromReference(ref) {
  if (ref == null || ref === "") return null;
  const n = Number(String(ref).trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Normalize DB driver dates for JSON + rowToPublicUser. */
function normalizeRow(row) {
  if (!row) return null;
  const o = { ...row };
  for (const k of ["subscription_expires_at", "last_login_at", "created_at"]) {
    if (o[k] instanceof Date) o[k] = o[k].toISOString();
    else if (o[k] != null && typeof o[k] !== "string") o[k] = String(o[k]);
  }
  if (o.disabled != null) o.disabled = Number(o.disabled);
  if (o.role) o.role = String(o.role);
  if (o.email) o.email = String(o.email);
  return o;
}

function rowToPublicUser(row) {
  row = normalizeRow(row);
  if (!row) return null;
  const expires = row.subscription_expires_at;
  const now = Date.now();
  const expMs = expires ? new Date(expires).getTime() : 0;
  const hasSubscription = row.role === "admin" || (!!expires && expMs > now);
  let subscriptionDaysRemaining = 0;
  if (row.role !== "admin" && expires && expMs > now) {
    subscriptionDaysRemaining = Math.ceil((expMs - now) / 86400000);
  }
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    disabled: !!row.disabled,
    subscription_expires_at: row.subscription_expires_at,
    hasSubscription,
    subscriptionDaysRemaining,
    last_login_at: row.last_login_at,
  };
}

async function autoExtendExpiredUserAccess(store, row) {
  const user = normalizeRow(row);
  if (!user) return user;
  if (user.role === "admin" || user.disabled) return user;
  if (!user.subscription_expires_at) return user;
  const expMs = new Date(user.subscription_expires_at).getTime();
  if (Number.isNaN(expMs) || expMs > Date.now()) return user;
  const nextExpiry = addDaysIso(nowIso(), SUBSCRIPTION_GRANT_DAYS);
  await store.applyUserPatch(user.id, { subscription_expires_at: nextExpiry });
  const refreshed = await store.getUserById(user.id);
  return normalizeRow(refreshed) || { ...user, subscription_expires_at: nextExpiry };
}

function cookieSecure() {
  const v = String(process.env.COOKIE_SECURE || "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off") return false;
  if (v === "1" || v === "true" || v === "on") return true;
  return process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    maxAge: SESSION_DAYS * 86400000,
    path: "/",
  });
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function buildApp() {
  const app = express();
  const rawTp = process.env.TRUST_PROXY;
  let trustProxyVal = 1;
  if (rawTp != null && String(rawTp).trim() !== "") {
    const n = Number(rawTp);
    trustProxyVal = Number.isFinite(n) ? n : rawTp;
  }
  app.set("trust proxy", trustProxyVal);

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    if (!STRIPE_WEBHOOK_SECRET || !STRIPE_SECRET_KEY) {
      return res.status(503).send("Stripe not configured");
    }
    const Stripe = require("stripe");
    const stripe = new Stripe(STRIPE_SECRET_KEY);
    let event;
    try {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.warn("[stripe webhook]", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const store = getStore();
    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const userId = parseUserIdFromReference(session.client_reference_id);
        const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
        if (customerId && userId) await store.setStripeCustomerIfEmpty(userId, customerId);
        let newEnd = null;
        if (session.mode === "subscription" && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          newEnd = new Date(sub.current_period_end * 1000).toISOString();
        } else if (session.mode === "payment") {
          newEnd = addDaysIso(nowIso(), SUBSCRIPTION_GRANT_DAYS);
        }
        if (userId && newEnd) await store.mergeSubscriptionExpiry(userId, newEnd);
      }
      if (event.type === "invoice.paid") {
        const inv = event.data.object;
        const customerId = inv.customer;
        if (customerId) {
          const user = await store.getUserByStripeCustomer(customerId);
          if (user) {
            let newEnd = addDaysIso(nowIso(), SUBSCRIPTION_GRANT_DAYS);
            const line = inv.lines?.data?.[0];
            if (line?.period?.end) {
              newEnd = new Date(line.period.end * 1000).toISOString();
            }
            await store.mergeSubscriptionExpiry(user.id, newEnd);
          }
        }
      }
    } catch (e) {
      console.error("[stripe webhook handler]", e);
      return res.status(500).json({ error: "Webhook handler failed" });
    }
    res.json({ received: true });
  });

  app.use(cookieParser());
  app.use(compression());
  app.use(express.json({ limit: "400kb" }));

  async function getSessionUser(req) {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return null;
    const store = getStore();
    const row = await store.getUserBySession(token);
    if (!row || row.disabled) return null;
    return normalizeRow(row);
  }

  const requireAuth = asyncHandler(async (req, res, next) => {
    const u = await getSessionUser(req);
    if (!u) return res.status(401).json({ error: "Unauthorized" });
    req.user = u;
    next();
  });

  const requireAdmin = asyncHandler(async (req, res, next) => {
    const u = await getSessionUser(req);
    if (!u || u.disabled) return res.status(401).json({ error: "Unauthorized" });
    if (u.role !== "admin") return res.status(403).json({ error: "Forbidden" });
    req.user = u;
    next();
  });

  function userHasActiveSubscription(row) {
    if (row.role === "admin") return true;
    if (!row.subscription_expires_at) return false;
    return new Date(row.subscription_expires_at).getTime() > Date.now();
  }

  app.post(
    "/api/login",
    asyncHandler(async (req, res) => {
      const store = getStore();
      const email = String(req.body?.email || "")
        .trim()
        .toLowerCase();
      const password = String(req.body?.password || "");
      if (!email || !password) return res.status(400).json({ error: "Email and password required" });
      const row = normalizeRow(await store.getUserByEmail(email));
      if (!row || row.disabled) {
        return res.status(401).json({ error: "Invalid email or password" });
      }
      if (!bcrypt.compareSync(password, row.password_hash)) {
        return res.status(401).json({ error: "Invalid email or password" });
      }
      const effectiveUser = await autoExtendExpiredUserAccess(store, row);
      const token = crypto.randomBytes(32).toString("hex");
      await store.setSession(effectiveUser.id, token, nowIso());
      setSessionCookie(res, token);
      res.json({ user: rowToPublicUser(effectiveUser) });
    })
  );

  app.post(
    "/api/logout",
    requireAuth,
    asyncHandler(async (req, res) => {
      const store = getStore();
      await store.clearSession(req.user.id);
      res.clearCookie(SESSION_COOKIE, { path: "/" });
      res.json({ ok: true });
    })
  );

  app.get(
    "/logout",
    asyncHandler(async (req, res) => {
      const store = getStore();
      const u = await getSessionUser(req);
      if (u) {
        await store.clearSession(u.id);
      }
      res.clearCookie(SESSION_COOKIE, { path: "/" });
      res.redirect("/");
    })
  );

  app.get(
    "/api/me",
    requireAuth,
    asyncHandler(async (req, res) => {
      const store = getStore();
      const row = normalizeRow(await store.getUserById(req.user.id));
      const effectiveUser = await autoExtendExpiredUserAccess(store, row);
      res.json({ user: rowToPublicUser(effectiveUser) });
    })
  );

  function currentYearMonth() {
    const d = new Date();
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }

  app.post(
    "/api/activity",
    requireAuth,
    asyncHandler(async (req, res) => {
      const store = getStore();
      const row = normalizeRow(await store.getUserById(req.user.id));
      const effectiveUser = await autoExtendExpiredUserAccess(store, row);
      if (!effectiveUser || effectiveUser.disabled) return res.status(401).json({ error: "Unauthorized" });
      if (!userHasActiveSubscription(effectiveUser)) return res.status(402).json({ error: "Subscription required" });
      const type = String(req.body?.type || "");
      const count = Math.max(1, Math.min(500, Number(req.body?.count) || 1));
      const ym = currentYearMonth();
      if (type === "generate") await store.bumpGenerate(effectiveUser.id, ym, count);
      else if (type === "download") await store.bumpDownload(effectiveUser.id, ym, count);
      else return res.status(400).json({ error: "Invalid type" });
      res.json({ ok: true });
    })
  );

  app.get(
    "/api/health",
    asyncHandler(async (req, res) => {
      const store = getStore();
      res.json({
        ok: true,
        db_backend: store.kind,
        vercel: process.env.VERCEL === "1",
        server_uploads:
          process.env.VERCEL !== "1" && process.env.DISABLE_SERVER_UPLOADS !== "1",
        now: new Date().toISOString(),
      });
    })
  );

  const uploadRoot = path.join(__dirname, "data", "uploads");
  const UPLOAD_FILENAME_RE = /^(\d+)_([a-f0-9]{32})\.(jpg|jpeg|png|webp|gif)$/i;

  function serverBlobUploadsEnabled() {
    return process.env.VERCEL !== "1" && process.env.DISABLE_SERVER_UPLOADS !== "1";
  }

  function uploadGate(req, res, next) {
    if (!serverBlobUploadsEnabled()) {
      return res.status(503).json({ error: "Server-side upload storage is not enabled in this environment." });
    }
    next();
  }

  let _uploadMw;
  function getUploadMiddleware() {
    if (_uploadMw) return _uploadMw;
    fs.mkdirSync(uploadRoot, { recursive: true });
    const storage = multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadRoot),
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || "").toLowerCase();
        const allow = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
        const safeExt = allow.has(ext) ? ext : ".bin";
        cb(null, `${req.user.id}_${crypto.randomBytes(16).toString("hex")}${safeExt}`);
      },
    });
    _uploadMw = multer({
      storage,
      limits: { fileSize: 18 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (!/^image\//i.test(file.mimetype || "")) {
          return cb(new Error("Only image uploads are allowed"));
        }
        cb(null, true);
      },
    });
    return _uploadMw;
  }

  const blobUploadOk = asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Missing file field (multipart name: file)" });
    res.json({ ok: true, filename: req.file.filename, bytes: req.file.size });
  });

  app.post("/api/blob-upload/garment", requireAuth, uploadGate, getUploadMiddleware().single("file"), blobUploadOk);

  app.post("/api/blob-upload/design", requireAuth, uploadGate, getUploadMiddleware().single("file"), blobUploadOk);

  app.get(
    "/api/blob-upload/file/:filename",
    requireAuth,
    asyncHandler(async (req, res) => {
      if (!serverBlobUploadsEnabled()) {
        return res.status(503).json({ error: "Server-side upload storage is not enabled in this environment." });
      }
      const name = path.basename(String(req.params.filename || ""));
      if (!UPLOAD_FILENAME_RE.test(name)) return res.status(400).json({ error: "Invalid filename" });
      const m = name.match(UPLOAD_FILENAME_RE);
      const uid = m ? Number(m[1]) : NaN;
      if (!Number.isFinite(uid) || uid !== req.user.id) {
        return res.status(403).json({ error: "Forbidden" });
      }
      const abs = path.resolve(uploadRoot, name);
      const rel = path.relative(path.resolve(uploadRoot), abs);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        return res.status(400).json({ error: "Invalid path" });
      }
      try {
        await fs.promises.access(abs, fs.constants.R_OK);
      } catch {
        return res.status(404).json({ error: "Not found" });
      }
      res.sendFile(abs);
    })
  );

  app.get(
    "/api/admin/users",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const store = getStore();
      const ym = currentYearMonth();
      const rows = (await store.listUsersAdmin(ym)).map((r) => normalizeRow(r));
      const out = rows.map((r) => ({
        ...r,
        user: rowToPublicUser(r),
      }));
      res.json({ users: out, month: ym });
    })
  );

  app.post(
    "/api/admin/users",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const store = getStore();
      const email = String(req.body?.email || "")
        .trim()
        .toLowerCase();
      const password = String(req.body?.password || "");
      if (!email || !password || password.length < 8) {
        return res.status(400).json({ error: "Valid email and password (min 8 chars) required" });
      }
      const exists = await store.getUserByEmailExists(email);
      if (exists) return res.status(409).json({ error: "Email already registered" });
      const hash = bcrypt.hashSync(password, 10);
      const newId = await store.insertUser(email, hash);
      const row = normalizeRow(await store.getUserByIdFull(newId));
      res.status(201).json({ user: rowToPublicUser(row) });
    })
  );

  app.patch(
    "/api/admin/users/:id",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const store = getStore();
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      const target = await store.getUserRole(id);
      if (!target) return res.status(404).json({ error: "Not found" });
      if (req.body?.disabled === true && target.role === "admin") {
        const admins = await store.countEnabledAdmins();
        if (admins <= 1) {
          return res.status(400).json({ error: "Cannot disable the only enabled admin" });
        }
      }
      const patch = {};
      if (typeof req.body?.disabled === "boolean") patch.disabled = req.body.disabled;
      if (req.body?.subscription_expires_at !== undefined) {
        patch.subscription_expires_at = req.body.subscription_expires_at;
      }
      if (Object.keys(patch).length === 0) return res.status(400).json({ error: "No updates" });
      await store.applyUserPatch(id, patch);
      const row = normalizeRow(await store.getUserByIdFull(id));
      res.json({ user: rowToPublicUser(row) });
    })
  );

  app.post(
    "/api/admin/users/:id/reset-password",
    requireAdmin,
    asyncHandler(async (req, res) => {
      const store = getStore();
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });
      const target = await store.getUserRole(id);
      if (!target) return res.status(404).json({ error: "Not found" });
      const newPassword = String(req.body?.password || "");
      if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }
      const hash = bcrypt.hashSync(newPassword, 10);
      await store.setUserPassword(id, hash);
      res.json({ ok: true });
    })
  );

  const isProd = process.env.NODE_ENV === "production";
  app.use(
    express.static(PUBLIC_DIR, {
      extensions: ["html"],
      etag: true,
      lastModified: true,
      setHeaders(res, filePath) {
        const lower = filePath.toLowerCase();
        if (lower.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache");
          return;
        }
        if (isProd && /\.(js|mjs|css|woff2?|ttf|eot|ico|svg)$/i.test(lower)) {
          res.setHeader("Cache-Control", "public, max-age=86400");
        }
      },
    })
  );

  app.use((err, req, res, next) => {
    console.error(err);
    if (res.headersSent) return;
    if (err && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File too large (max 18 MB)" });
    }
    if (err && String(err.message || "").includes("Only image uploads")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Server error" });
  });

  return app;
}

let _appPromise;
async function getApp() {
  if (!_appPromise) {
    _appPromise = (async () => {
      await initStore();
      return buildApp();
    })();
  }
  return _appPromise;
}

if (require.main === module) {
  getApp()
    .then((app) => {
      const listenHost = process.env.LISTEN_HOST || undefined;
      const onListen = () => {
        const where = listenHost ? `${listenHost}:${PORT}` : `port ${PORT}`;
        console.log(`Garment mockup server listening on ${where}`);
      };
      if (listenHost) {
        app.listen(PORT, listenHost, onListen);
      } else {
        app.listen(PORT, onListen);
      }
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = getApp;
