/** @typedef {{ id: number; email: string; role: string; hasSubscription: boolean; subscriptionDaysRemaining: number; subscription_expires_at: string | null }} MeUser */

const WHATSAPP_SIGNUP_E164 = "971565041443";
const WHATSAPP_SIGNUP_DISPLAY = "+971 56 504 1443";
const STRIPE_PAYMENT_LINK =
  "https://buy.stripe.com/14AfZg10w7ZOaxq49gak01c";

/** @type {MeUser | null} */
let me = null;

let sessionInvalidatedMessage = "";

function el(id) {
  return document.getElementById(id);
}

function apiUrl(path) {
  return path.startsWith("/") ? path : `/${path}`;
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(apiUrl(path), {
    ...opts,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  return res;
}

function isAdmin() {
  return me?.role === "admin";
}

function hasActiveSubscription() {
  if (!me) return false;
  if (me.role === "admin") return true;
  return !!me.hasSubscription;
}

function stripeCheckoutUrlForUser() {
  if (!me?.id) return STRIPE_PAYMENT_LINK;
  const sep = STRIPE_PAYMENT_LINK.includes("?") ? "&" : "?";
  return `${STRIPE_PAYMENT_LINK}${sep}client_reference_id=${encodeURIComponent(String(me.id))}`;
}

function setMeFromResponse(data) {
  me = data.user || null;
}

/** How often to verify the server still recognizes this session (another login replaces the token). */
const SESSION_CHECK_MS = 30000;

let sessionMonitorTimer = null;
let sessionCheckInFlight = false;

function stopSessionInvalidationMonitor() {
  if (sessionMonitorTimer != null) {
    clearInterval(sessionMonitorTimer);
    sessionMonitorTimer = null;
  }
  document.removeEventListener("visibilitychange", onVisibilityForSession);
  window.removeEventListener("focus", onWindowFocusForSession);
}

function onVisibilityForSession() {
  if (document.visibilityState === "visible") void verifySessionWithServer();
}

function onWindowFocusForSession() {
  void verifySessionWithServer();
}

function applySessionLostUi() {
  sessionInvalidatedMessage =
    sessionInvalidatedMessage ||
    "Your session ended (signed in elsewhere, signed out, or account disabled).";
  stopSessionInvalidationMonitor();
  const path = window.location.pathname || "";
  if (path.endsWith("admin.html") || path.endsWith("/admin")) {
    window.location.href = "/?admin=1";
    return;
  }
  syncAccessUi();
  updateHeader();
  updateSubscriptionBanner();
}

function sessionMeFingerprint() {
  if (!me) return "";
  return JSON.stringify({
    id: me.id,
    role: me.role,
    hasSubscription: me.hasSubscription,
    subscriptionDaysRemaining: me.subscriptionDaysRemaining,
    subscription_expires_at: me.subscription_expires_at,
  });
}

async function verifySessionWithServer() {
  if (!me || sessionCheckInFlight) return;
  sessionCheckInFlight = true;
  const before = sessionMeFingerprint();
  try {
    const sessionOk = await refreshMe();
    if (!sessionOk) {
      applySessionLostUi();
      return;
    }
    if (sessionMeFingerprint() !== before) {
      syncAccessUi();
      updateHeader();
      updateSubscriptionBanner();
    }
  } finally {
    sessionCheckInFlight = false;
  }
}

function startSessionInvalidationMonitor() {
  stopSessionInvalidationMonitor();
  if (!me) return;
  sessionMonitorTimer = setInterval(() => void verifySessionWithServer(), SESSION_CHECK_MS);
  document.addEventListener("visibilitychange", onVisibilityForSession);
  window.addEventListener("focus", onWindowFocusForSession);
}

async function refreshMe() {
  const res = await apiFetch("/api/me");
  if (res.status === 401) {
    stopSessionInvalidationMonitor();
    me = null;
    return false;
  }
  if (!res.ok) {
    return true;
  }
  const data = await res.json();
  setMeFromResponse(data);
  return true;
}

/**
 * Optional: copy garment/design file to the server (self-hosted disk under `data/uploads/`).
 * Masking and preview still run in the browser; this is for backup / audit / future features.
 * Returns `{ ok, filename, bytes }` or null if disabled / offline / not signed in.
 */
async function uploadWorkFileToServer(file, kind) {
  if (!me || !file) return null;
  const k = kind === "design" ? "design" : "garment";
  try {
    const fd = new FormData();
    fd.append("file", file, file.name || (k === "design" ? "design.png" : "photo.jpg"));
    const res = await fetch(apiUrl(`/api/blob-upload/${k}`), {
      method: "POST",
      credentials: "include",
      body: fd,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    return data;
  } catch (_) {
    return null;
  }
}

async function recordActivity(type, count = 1) {
  try {
    const res = await apiFetch("/api/activity", {
      method: "POST",
      body: JSON.stringify({ type, count }),
    });
    if (res.status === 401) {
      sessionInvalidatedMessage = "Your session ended. Sign in again.";
      stopSessionInvalidationMonitor();
      me = null;
      syncAccessUi();
      updateHeader();
      updateSubscriptionBanner();
      return;
    }
    if (res.status === 402) {
      updateSubscriptionBanner();
      return;
    }
  } catch (_) {
    /* offline — ignore */
  }
}

function updateSubscriptionBanner() {
  const strip = el("subscriptionStrip");
  const noSub = el("subscriptionNoSub");
  const hasSub = el("subscriptionHasSub");
  const adminNote = el("subscriptionAdminNote");
  const link = el("subscriptionStripeLink");
  const daysLeft = el("subscriptionDaysLeft");
  const daysActive = el("subscriptionDaysActive");
  if (!strip) return;
  if (!me) {
    strip.hidden = true;
    return;
  }
  if (!hasActiveSubscription() && !isAdmin()) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  if (noSub) noSub.hidden = true;
  if (hasSub) hasSub.hidden = true;
  if (adminNote) adminNote.hidden = true;
  if (isAdmin()) {
    if (adminNote) adminNote.hidden = false;
    return;
  }
  if (hasActiveSubscription()) {
    if (hasSub) hasSub.hidden = false;
    if (daysActive) daysActive.textContent = String(me.subscriptionDaysRemaining ?? 0);
  } else {
    if (noSub) noSub.hidden = false;
    if (link) link.href = stripeCheckoutUrlForUser();
    if (daysLeft) daysLeft.textContent = String(me.subscriptionDaysRemaining > 0 ? me.subscriptionDaysRemaining : 0);
  }
}

function updateHeader() {
  const wrap = el("headerAccount");
  const userEmail = el("headerUserEmail");
  const adminLink = el("headerAdminLink");
  const logoutBtn = el("headerLogoutBtn");
  if (wrap) wrap.hidden = !me;
  if (userEmail) userEmail.textContent = me?.email || "";
  if (adminLink) adminLink.hidden = !isAdmin();
  if (logoutBtn) logoutBtn.hidden = !me;
}

function showAuthGate(show) {
  const gate = el("authGate");
  if (gate) {
    gate.hidden = !show;
    gate.setAttribute("aria-hidden", show ? "false" : "true");
  }
  const msg = el("authGateMessage");
  if (msg && sessionInvalidatedMessage) {
    msg.textContent = sessionInvalidatedMessage;
    msg.hidden = false;
  } else if (msg) {
    msg.textContent = "";
    msg.hidden = true;
  }
}

function showSubscriptionGate(show) {
  const gate = el("subscriptionGate");
  if (gate) {
    gate.hidden = !show;
    gate.setAttribute("aria-hidden", show ? "false" : "true");
  }
  if (!show) return;
  const link = el("subscriptionGateStripeLink");
  const days = el("subscriptionGateDays");
  if (link) link.href = stripeCheckoutUrlForUser();
  if (days) days.textContent = String(me?.subscriptionDaysRemaining > 0 ? me.subscriptionDaysRemaining : 0);
}

function syncAccessUi() {
  const shell = el("appShell");
  if (!me) {
    showAuthGate(true);
    showSubscriptionGate(false);
    if (shell) shell.classList.add("app-shell--locked");
    return;
  }
  if (hasActiveSubscription() || isAdmin()) {
    showAuthGate(false);
    showSubscriptionGate(false);
    if (shell) shell.classList.remove("app-shell--locked");
    return;
  }
  showAuthGate(false);
  showSubscriptionGate(true);
  if (shell) shell.classList.add("app-shell--locked");
}

async function onLoginSubmit(ev) {
  ev.preventDefault();
  const email = el("loginEmail")?.value?.trim() || "";
  const password = el("loginPassword")?.value || "";
  const err = el("loginError");
  if (err) {
    err.textContent = "";
    err.hidden = true;
  }
  const res = await apiFetch("/api/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (err) {
      err.textContent = data.error || "Sign-in failed.";
      err.hidden = false;
    }
    return;
  }
  sessionInvalidatedMessage = "";
  setMeFromResponse(data);
  const qs = new URLSearchParams(window.location.search);
  if (qs.get("admin") === "1" && me?.role === "admin") {
    window.location.href = "/admin.html";
    return;
  }
  syncAccessUi();
  updateHeader();
  updateSubscriptionBanner();
  startSessionInvalidationMonitor();
}

async function onLogout() {
  try {
    await apiFetch("/api/logout", { method: "POST", body: "{}" });
  } catch (_) {}
  stopSessionInvalidationMonitor();
  me = null;
  syncAccessUi();
  updateHeader();
  updateSubscriptionBanner();
}

async function initAuth() {
  const ok = await refreshMe();
  if (ok && me) {
    syncAccessUi();
    updateHeader();
    updateSubscriptionBanner();
    startSessionInvalidationMonitor();
  } else {
    syncAccessUi();
    updateHeader();
    updateSubscriptionBanner();
  }

  el("loginForm")?.addEventListener("submit", onLoginSubmit);
  el("headerLogoutBtn")?.addEventListener("click", () => onLogout());
  el("subscriptionGateLogoutBtn")?.addEventListener("click", () => onLogout());
  el("loginPasswordToggle")?.addEventListener("click", () => {
    const pwd = el("loginPassword");
    const btn = el("loginPasswordToggle");
    if (!pwd || !btn) return;
    const show = pwd.type === "password";
    pwd.type = show ? "text" : "password";
    btn.textContent = show ? "🙈" : "👁";
    btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
  });
}

window.AppAuth = {
  get me() {
    return me;
  },
  WHATSAPP_SIGNUP_E164,
  WHATSAPP_SIGNUP_DISPLAY,
  apiUrl,
  apiFetch,
  isAdmin,
  hasActiveSubscription,
  stripeCheckoutUrlForUser,
  refreshMe,
  recordActivity,
  initAuth,
  startSessionInvalidationMonitor,
  stopSessionInvalidationMonitor,
  uploadWorkFileToServer,
};
