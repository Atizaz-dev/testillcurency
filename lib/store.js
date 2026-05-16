/**
 * Data layer: local SQLite (better-sqlite3) or Postgres (DATABASE_URL) for Vercel / serverless.
 */
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

let backend = null;

function nowIso() {
  return new Date().toISOString();
}

function addDaysIso(isoStart, days) {
  const d = new Date(isoStart);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function maxIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) >= new Date(b) ? a : b;
}

async function createPg() {
  const { Pool } = require("pg");
  const conn = process.env.DATABASE_URL;
  const pool = new Pool({
    connectionString: conn,
    max: 2,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
    ssl: conn.includes("localhost") || conn.includes("127.0.0.1") ? false : { rejectUnauthorized: false },
  });

  const run = (text, params = []) => pool.query(text, params).then((r) => r.rows);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
      disabled INT NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
      subscription_expires_at TIMESTAMPTZ,
      stripe_customer_id TEXT,
      last_login_at TIMESTAMPTZ,
      session_token TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (LOWER(email))`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_monthly (
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      year_month TEXT NOT NULL,
      generates INT NOT NULL DEFAULT 0,
      downloads INT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, year_month)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_users_session ON users(session_token) WHERE session_token IS NOT NULL`
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL`
  );

  return {
    kind: "pg",
    pool,
    close: () => pool.end(),
    countAdmins: async () => {
      const r = await run(`SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin'`);
      return r[0].c;
    },
    insertAdmin: async (email, hash, subUntil) => {
      try {
        await pool.query(
          `INSERT INTO users (email, password_hash, role, disabled, subscription_expires_at)
           VALUES ($1, $2, 'admin', 0, $3::timestamptz)`,
          [email, hash, subUntil]
        );
      } catch (e) {
        if (e.code === "23505") return;
        throw e;
      }
    },
    syncAdminCredentials: async (email, hash) => {
      await pool.query(
        `UPDATE users
         SET password_hash = $1, role = 'admin', disabled = 0
         WHERE LOWER(email) = LOWER($2)`,
        [hash, email]
      );
    },
    getUserByEmail: async (email) => {
      const r = await run(
        `SELECT id, email, password_hash, role, disabled, subscription_expires_at, last_login_at
         FROM users WHERE LOWER(email) = LOWER($1)`,
        [email]
      );
      return r[0] || null;
    },
    setSession: async (userId, token, loginAt) => {
      await pool.query(`UPDATE users SET session_token = $1, last_login_at = $2::timestamptz WHERE id = $3`, [
        token,
        loginAt,
        userId,
      ]);
    },
    clearSession: async (userId) => {
      await pool.query(`UPDATE users SET session_token = NULL WHERE id = $1`, [userId]);
    },
    getUserBySession: async (token) => {
      const r = await run(
        `SELECT id, email, role, disabled, subscription_expires_at, last_login_at
         FROM users WHERE session_token = $1`,
        [token]
      );
      return r[0] || null;
    },
    getUserById: async (id) => {
      const r = await run(
        `SELECT id, email, role, disabled, subscription_expires_at, last_login_at FROM users WHERE id = $1`,
        [id]
      );
      return r[0] || null;
    },
    getUserAuthRow: async (id) => {
      const r = await run(`SELECT id, role, disabled, subscription_expires_at FROM users WHERE id = $1`, [id]);
      return r[0] || null;
    },
    bumpGenerate: async (userId, ym, count) => {
      await pool.query(
        `INSERT INTO usage_monthly (user_id, year_month, generates, downloads)
         VALUES ($1, $2, $3, 0)
         ON CONFLICT (user_id, year_month) DO UPDATE SET generates = usage_monthly.generates + EXCLUDED.generates`,
        [userId, ym, count]
      );
    },
    bumpDownload: async (userId, ym, count) => {
      await pool.query(
        `INSERT INTO usage_monthly (user_id, year_month, generates, downloads)
         VALUES ($1, $2, 0, $3)
         ON CONFLICT (user_id, year_month) DO UPDATE SET downloads = usage_monthly.downloads + EXCLUDED.downloads`,
        [userId, ym, count]
      );
    },
    listUsersAdmin: async (ym) => {
      return run(
        `SELECT u.id, u.email, u.role, u.disabled, u.subscription_expires_at, u.stripe_customer_id,
                u.last_login_at, u.created_at,
                COALESCE(m.generates, 0)::int AS generates_this_month,
                COALESCE(m.downloads, 0)::int AS downloads_this_month,
                COALESCE(t.generates_total, 0)::bigint AS generates_all_time,
                COALESCE(t.downloads_total, 0)::bigint AS downloads_all_time
         FROM users u
         LEFT JOIN usage_monthly m ON m.user_id = u.id AND m.year_month = $1
         LEFT JOIN (
           SELECT user_id,
                  SUM(generates)::bigint AS generates_total,
                  SUM(downloads)::bigint AS downloads_total
           FROM usage_monthly
           GROUP BY user_id
         ) t ON t.user_id = u.id
         ORDER BY u.id ASC`,
        [ym]
      );
    },
    getUserByEmailExists: async (email) => {
      const r = await run(`SELECT id FROM users WHERE LOWER(email) = LOWER($1)`, [email]);
      return r[0] || null;
    },
    insertUser: async (email, hash) => {
      const r = await run(
        `INSERT INTO users (email, password_hash, role, disabled, subscription_expires_at)
         VALUES ($1, $2, 'user', 0, NULL) RETURNING id`,
        [email, hash]
      );
      return r[0].id;
    },
    getUserByIdFull: async (id) => {
      const r = await run(
        `SELECT id, email, role, disabled, subscription_expires_at, last_login_at FROM users WHERE id = $1`,
        [id]
      );
      return r[0] || null;
    },
    getUserRole: async (id) => {
      const r = await run(`SELECT id, role FROM users WHERE id = $1`, [id]);
      return r[0] || null;
    },
    countEnabledAdmins: async () => {
      const r = await run(`SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin' AND disabled = 0`);
      return r[0].c;
    },
    applyUserPatch: async (id, body) => {
      const parts = [];
      const vals = [];
      if (typeof body.disabled === "boolean") {
        vals.push(body.disabled ? 1 : 0);
        parts.push(`disabled = $${vals.length}`);
        if (body.disabled) parts.push("session_token = NULL");
      }
      if (body.subscription_expires_at !== undefined) {
        const v = body.subscription_expires_at;
        if (v === null || v === "") parts.push("subscription_expires_at = NULL");
        else {
          vals.push(String(v));
          parts.push(`subscription_expires_at = $${vals.length}::timestamptz`);
        }
      }
      if (!parts.length) return;
      vals.push(id);
      const text = `UPDATE users SET ${parts.join(", ")} WHERE id = $${vals.length}`;
      await pool.query(text, vals);
    },
    setUserPassword: async (id, passwordHash) => {
      await pool.query(`UPDATE users SET password_hash = $1, session_token = NULL WHERE id = $2`, [
        passwordHash,
        id,
      ]);
    },
    mergeSubscriptionExpiry: async (userId, newIso) => {
      const r = await run(`SELECT subscription_expires_at FROM users WHERE id = $1`, [userId]);
      if (!r[0]) return;
      const cur = r[0].subscription_expires_at;
      const curIso = cur ? new Date(cur).toISOString() : null;
      const merged = maxIso(curIso, newIso);
      await pool.query(`UPDATE users SET subscription_expires_at = $1::timestamptz WHERE id = $2`, [merged, userId]);
    },
    setStripeCustomerIfEmpty: async (userId, customerId) => {
      await pool.query(
        `UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, $1) WHERE id = $2`,
        [customerId, userId]
      );
    },
    getUserByStripeCustomer: async (customerId) => {
      const r = await run(`SELECT id FROM users WHERE stripe_customer_id = $1`, [customerId]);
      return r[0] || null;
    },
  };
}

function createSqlite() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (e) {
    throw new Error(
      "SQLite backend requires Node with built-in node:sqlite (recommended: Node 24+)."
    );
  }
  const DATA_DIR = path.join(__dirname, "..", "data");
  const DB_PATH = process.env.SQLITE_PATH || path.join(DATA_DIR, "app.db");
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
      disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0,1)),
      subscription_expires_at TEXT,
      stripe_customer_id TEXT,
      last_login_at TEXT,
      session_token TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS usage_monthly (
      user_id INTEGER NOT NULL,
      year_month TEXT NOT NULL,
      generates INTEGER NOT NULL DEFAULT 0,
      downloads INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, year_month),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_users_session ON users(session_token);
    CREATE INDEX IF NOT EXISTS idx_users_stripe_customer ON users(stripe_customer_id);
  `);

  const wrap = (fn) => (...args) => Promise.resolve(fn(...args));

  return {
    kind: "sqlite",
    sql: null,
    close: () => db.close(),
    countAdmins: wrap(() => db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c),
    insertAdmin: wrap((email, hash, subUntil) => {
      try {
        db.prepare(
          "INSERT INTO users (email, password_hash, role, disabled, subscription_expires_at) VALUES (?,?,?,?,?)"
        ).run(email, hash, "admin", 0, subUntil);
      } catch (e) {
        if (String(e.message || "").includes("UNIQUE")) return;
        throw e;
      }
    }),
    syncAdminCredentials: wrap((email, hash) => {
      db.prepare(
        "UPDATE users SET password_hash = ?, role = 'admin', disabled = 0 WHERE lower(email) = lower(?)"
      ).run(hash, email);
    }),
    getUserByEmail: wrap((email) =>
      db
        .prepare(
          "SELECT id, email, password_hash, role, disabled, subscription_expires_at, last_login_at FROM users WHERE email = ?"
        )
        .get(email)
    ),
    setSession: wrap((userId, token, loginAt) => {
      db.prepare("UPDATE users SET session_token = ?, last_login_at = ? WHERE id = ?").run(token, loginAt, userId);
    }),
    clearSession: wrap((userId) => {
      db.prepare("UPDATE users SET session_token = NULL WHERE id = ?").run(userId);
    }),
    getUserBySession: wrap((token) =>
      db
        .prepare(
          "SELECT id, email, role, disabled, subscription_expires_at, last_login_at FROM users WHERE session_token = ?"
        )
        .get(token)
    ),
    getUserById: wrap((id) =>
      db.prepare("SELECT id, email, role, disabled, subscription_expires_at, last_login_at FROM users WHERE id = ?").get(id)
    ),
    getUserAuthRow: wrap((id) =>
      db.prepare("SELECT id, role, disabled, subscription_expires_at FROM users WHERE id = ?").get(id)
    ),
    bumpGenerate: wrap((userId, ym, count) => {
      db.prepare(
        `INSERT INTO usage_monthly (user_id, year_month, generates, downloads)
         VALUES (?, ?, ?, 0)
         ON CONFLICT(user_id, year_month) DO UPDATE SET generates = generates + excluded.generates`
      ).run(userId, ym, count);
    }),
    bumpDownload: wrap((userId, ym, count) => {
      db.prepare(
        `INSERT INTO usage_monthly (user_id, year_month, generates, downloads)
         VALUES (?, ?, 0, ?)
         ON CONFLICT(user_id, year_month) DO UPDATE SET downloads = downloads + excluded.downloads`
      ).run(userId, ym, count);
    }),
    listUsersAdmin: wrap((ym) =>
      db
        .prepare(
          `SELECT u.id, u.email, u.role, u.disabled, u.subscription_expires_at, u.stripe_customer_id,
                  u.last_login_at, u.created_at,
                  COALESCE(m.generates, 0) AS generates_this_month,
                  COALESCE(m.downloads, 0) AS downloads_this_month,
                  COALESCE(t.generates_total, 0) AS generates_all_time,
                  COALESCE(t.downloads_total, 0) AS downloads_all_time
           FROM users u
           LEFT JOIN usage_monthly m ON m.user_id = u.id AND m.year_month = ?
           LEFT JOIN (
             SELECT user_id,
                    SUM(generates) AS generates_total,
                    SUM(downloads) AS downloads_total
             FROM usage_monthly
             GROUP BY user_id
           ) t ON t.user_id = u.id
           ORDER BY u.id ASC`
        )
        .all(ym)
    ),
    getUserByEmailExists: wrap((email) => db.prepare("SELECT id FROM users WHERE email = ?").get(email)),
    insertUser: wrap((email, hash) => {
      const info = db
        .prepare("INSERT INTO users (email, password_hash, role, disabled, subscription_expires_at) VALUES (?,?,?,?,NULL)")
        .run(email, hash, "user", 0);
      return info.lastInsertRowid;
    }),
    getUserByIdFull: wrap((id) =>
      db.prepare("SELECT id, email, role, disabled, subscription_expires_at, last_login_at FROM users WHERE id = ?").get(id)
    ),
    getUserRole: wrap((id) => db.prepare("SELECT id, role FROM users WHERE id = ?").get(id)),
    countEnabledAdmins: wrap(() => db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0").get().c),
    applyUserPatch: wrap((id, body) => {
      const patches = [];
      const vals = [];
      if (typeof body.disabled === "boolean") {
        patches.push("disabled = ?");
        vals.push(body.disabled ? 1 : 0);
        if (body.disabled) patches.push("session_token = NULL");
      }
      if (body.subscription_expires_at !== undefined) {
        const v = body.subscription_expires_at;
        if (v === null || v === "") patches.push("subscription_expires_at = NULL");
        else {
          patches.push("subscription_expires_at = ?");
          vals.push(String(v));
        }
      }
      if (!patches.length) return;
      vals.push(id);
      db.prepare(`UPDATE users SET ${patches.join(", ")} WHERE id = ?`).run(...vals);
    }),
    setUserPassword: wrap((id, passwordHash) => {
      db.prepare("UPDATE users SET password_hash = ?, session_token = NULL WHERE id = ?").run(passwordHash, id);
    }),
    mergeSubscriptionExpiry: wrap((userId, newIso) => {
      const row = db.prepare("SELECT subscription_expires_at FROM users WHERE id = ?").get(userId);
      if (!row) return;
      const merged = maxIso(row.subscription_expires_at, newIso);
      db.prepare("UPDATE users SET subscription_expires_at = ? WHERE id = ?").run(merged, userId);
    }),
    setStripeCustomerIfEmpty: wrap((userId, customerId) => {
      db.prepare("UPDATE users SET stripe_customer_id = COALESCE(stripe_customer_id, ?) WHERE id = ?").run(customerId, userId);
    }),
    getUserByStripeCustomer: wrap((customerId) =>
      db.prepare("SELECT id FROM users WHERE stripe_customer_id = ?").get(customerId)
    ),
  };
}

async function ensureBootstrapAdmin(store) {
  const email = (process.env.ADMIN_EMAIL || "admin@localhost").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "changeme-admin-2026";
  const hash = bcrypt.hashSync(password, 10);
  const adminCount = await store.countAdmins();
  if (adminCount <= 0) {
    await store.insertAdmin(email, hash, addDaysIso(nowIso(), 365 * 10));
    console.log(`[bootstrap] Created admin user ${email} (change ADMIN_PASSWORD in .env)`);
    return;
  }
  await store.syncAdminCredentials(email, hash);
  console.log(`[bootstrap] Synced admin credentials for ${email}`);
}

async function initStore() {
  if (backend) return backend;
  if (process.env.VERCEL === "1" && !process.env.DATABASE_URL) {
    throw new Error("On Vercel, set DATABASE_URL (e.g. Neon Postgres) — the serverless filesystem cannot persist SQLite.");
  }
  if (process.env.DATABASE_URL) {
    backend = await createPg();
  } else {
    backend = createSqlite();
  }
  await ensureBootstrapAdmin(backend);
  return backend;
}

function getStore() {
  if (!backend) throw new Error("Store not initialized; call initStore() first");
  return backend;
}

module.exports = { initStore, getStore, nowIso, addDaysIso, maxIso };
