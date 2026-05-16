const AppAuth = window.AppAuth || {};
const authApiFetch = AppAuth.apiFetch || (async () => new Response(null, { status: 500 }));
const authRefreshMe = AppAuth.refreshMe || (async () => false);
const currentMe = () => AppAuth.me || null;

async function requireAdminPage() {
  const ok = await authRefreshMe();
  const me = currentMe();
  if (!ok || !me || me.role !== "admin") {
    window.location.href = "/?admin=1";
    return false;
  }
  return true;
}

async function loadEnvBadge() {
  const badge = document.getElementById("adminEnvBadge");
  if (!badge) return;
  try {
    const res = await fetch("/api/health", { credentials: "include" });
    if (!res.ok) throw new Error("health failed");
    const data = await res.json();
    const backend = String(data.db_backend || "unknown");
    const host = data.vercel ? "vercel" : "local";
    badge.textContent = `Env: ${backend} · ${host}`;
  } catch {
    badge.textContent = "Env: unavailable";
  }
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

function setMsg(el, text, isError) {
  if (!el) return;
  el.hidden = !text;
  el.textContent = text;
  el.className = "admin-form-msg" + (isError ? " error" : " ok");
}

function makeTempPassword() {
  const rand = Math.random().toString(36).slice(2, 8);
  return `Temp#${rand}9`;
}

async function loadUsers() {
  const errEl = document.getElementById("adminLoadError");
  const tbody = document.getElementById("adminUserTbody");
  const monthLabel = document.getElementById("adminMonthLabel");
  if (errEl) errEl.classList.add("is-hidden");
  const res = await authApiFetch("/api/admin/users");
  if (res.status === 401 || res.status === 403) {
    window.location.href = "/?admin=1";
    return;
  }
  if (!res.ok) {
    if (errEl) {
      errEl.textContent = "Could not load users.";
      errEl.classList.remove("is-hidden");
    }
    return;
  }
  const data = await res.json();
  if (monthLabel) monthLabel.textContent = data.month ? `(usage: ${data.month})` : "";
  if (!tbody) return;
  tbody.innerHTML = "";
  for (const row of data.users || []) {
    const u = row.user || row;
    const tr = document.createElement("tr");
    if (row.disabled) tr.classList.add("admin-row-disabled");
    const sub =
      u.subscription_expires_at && u.hasSubscription
        ? `${u.subscriptionDaysRemaining}d left`
        : u.subscription_expires_at && !u.hasSubscription
          ? "Expired"
          : "None";
    const expAttr = (row.subscription_expires_at || "").replace(/"/g, "&quot;");
    const accessBtns = `<div class="admin-access-btns">
      <button type="button" class="btn btn-secondary btn-compact admin-add30" data-id="${row.id}" data-expiry="${expAttr}">+30 days</button>
      <button type="button" class="btn btn-ghost btn-compact admin-clear-sub" data-id="${row.id}">Clear sub</button>
    </div>`;
    const disableBtn = row.disabled
      ? `<button type="button" class="btn btn-secondary btn-compact admin-toggle" data-id="${row.id}" data-action="enable">Enable</button>`
      : `<button type="button" class="btn btn-secondary btn-compact admin-toggle is-danger-outline" data-id="${row.id}" data-action="disable">Disable</button>`;
    const resetPasswordBtn = `<button type="button" class="btn btn-ghost btn-compact admin-reset-pw" data-id="${row.id}" data-email="${esc(row.email)}">Reset password</button>`;
    tr.innerHTML = `
      <td>${esc(row.email)}</td>
      <td>${esc(row.role)}</td>
      <td>${esc(fmtDate(row.last_login_at))}</td>
      <td>${row.generates_this_month ?? 0}</td>
      <td>${row.downloads_this_month ?? 0}</td>
      <td>${row.generates_all_time ?? 0}</td>
      <td>${row.downloads_all_time ?? 0}</td>
      <td>${esc(sub)}</td>
      <td>${accessBtns}</td>
      <td><div class="admin-access-btns">${resetPasswordBtn}${disableBtn}</div></td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll(".admin-reset-pw").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      const email = btn.getAttribute("data-email") || "user";
      const suggested = makeTempPassword();
      const password = prompt(
        `Set a new temporary password for ${email} (min 8 chars):`,
        suggested
      );
      if (password == null) return;
      if (password.length < 8) {
        alert("Password must be at least 8 characters.");
        return;
      }
      const r = await authApiFetch(`/api/admin/users/${id}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(j.error || "Password reset failed");
        return;
      }
      alert(`Password updated for ${email}. Share it securely with the user.`);
    });
  });

  tbody.querySelectorAll(".admin-add30").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      const daysInput = prompt("How many days do you want to add?", "30");
      if (daysInput == null) return;
      const daysToAdd = Number.parseInt(daysInput, 10);
      if (!Number.isFinite(daysToAdd) || daysToAdd <= 0 || daysToAdd > 3650) {
        alert("Please enter a valid number of days between 1 and 3650.");
        return;
      }
      if (!confirm(`Add ${daysToAdd} day(s) of subscription access for this account?`)) return;
      const existing = btn.getAttribute("data-expiry") || "";
      const now = Date.now();
      const baseMs = existing ? Math.max(now, new Date(existing).getTime()) : now;
      const d = new Date(baseMs);
      d.setUTCDate(d.getUTCDate() + daysToAdd);
      const r = await authApiFetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ subscription_expires_at: d.toISOString() }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(j.error || "Update failed");
        return;
      }
      loadUsers();
    });
  });

  tbody.querySelectorAll(".admin-clear-sub").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      if (!confirm("Remove subscription end date for this user?")) return;
      const r = await authApiFetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ subscription_expires_at: null }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(j.error || "Update failed");
        return;
      }
      loadUsers();
    });
  });

  tbody.querySelectorAll(".admin-toggle").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-id");
      const action = btn.getAttribute("data-action");
      const disabled = action === "disable";
      const r = await authApiFetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ disabled }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(j.error || "Update failed");
        return;
      }
      loadUsers();
    });
  });
}

document.getElementById("adminLogoutBtn")?.addEventListener("click", async (ev) => {
  ev.preventDefault();
  await authApiFetch("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
  window.location.href = "/logout";
});

document.getElementById("createUserForm")?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const msgEl = document.getElementById("createUserMsg");
  const email = document.getElementById("newUserEmail")?.value?.trim() || "";
  const password = document.getElementById("newUserPassword")?.value || "";
  const res = await authApiFetch("/api/admin/users", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    setMsg(msgEl, j.error || "Could not create user", true);
    return;
  }
  setMsg(msgEl, `Created ${email}. Share the password securely.`, false);
  document.getElementById("newUserEmail").value = "";
  document.getElementById("newUserPassword").value = "";
  loadUsers();
});

(async () => {
  const ready = await requireAdminPage();
  if (ready) {
    AppAuth.startSessionInvalidationMonitor?.();
    loadEnvBadge();
    loadUsers();
  }
})();
