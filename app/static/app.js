const $ = id => document.getElementById(id);
const config = window.STOCK_ANALYSER_CONFIG || {};
const authClient = config.supabaseUrl && config.supabasePublishableKey && window.supabase?.createClient
  ? window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, { auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true } })
  : null;
const fmt = (v, d = 2) => v == null || !Number.isFinite(Number(v)) ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d });
const pct = v => v == null || !Number.isFinite(Number(v)) ? "—" : (Number(v) > 0 ? "+" : "") + fmt(v) + "%";
const cash = (v, c) => v == null || !Number.isFinite(Number(v)) ? "—" : new Intl.NumberFormat(undefined, { style: "currency", currency: c || "USD", maximumFractionDigits: 2 }).format(Number(v));
const esc = s => String(s ?? "—").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = name => config.supabaseUrl.replace(/\/$/, "") + "/functions/v1/" + name;
const headers = () => ({ "Content-Type": "application/json", "apikey": config.supabasePublishableKey });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function applyTheme(theme) {
  const selected = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = selected;
  const toggle = $("theme-toggle");
  const status = $("theme-status");
  if (toggle) toggle.textContent = selected === "dark" ? "Switch to light mode" : "Switch to dark mode";
  if (status) status.textContent = (selected === "dark" ? "Dark" : "Light") + " mode is active on this device.";
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute("content", selected === "light" ? "#f4f6fa" : "#0b1120");
  try { localStorage.setItem("stock-analyser-theme", selected); } catch {}
  if (window.Plotly) {
    const fontColor = selected === "light" ? "#52627a" : "#aab8ce";
    const gridColor = selected === "light" ? "#e5eaf1" : "#263650";
    document.querySelectorAll(".js-plotly-plot").forEach(plot => {
      try {
        window.Plotly.relayout(plot, {
          "font.color": fontColor,
          "xaxis.gridcolor": gridColor,
          "yaxis.gridcolor": gridColor,
          "paper_bgcolor": "rgba(0,0,0,0)",
          "plot_bgcolor": "rgba(0,0,0,0)"
        });
      } catch {}
    });
  }
}

let currentScreen = "home";
let currentTab = "home";
let detailReturnScreen = "home";
let currentDetailTicker = "";
let currentDetailIndexer = "rapidIndex";
let marketFeed = null;
let marketFeedLoadedAt = 0;
let marketFeedLoading = false;
let marketFeedRefreshQueued = false;
let latestScanId = null;
let latestScanLoaded = false;
let latestScanRefreshBusy = false;
let authSession = null;
let authUser = null;
let authMode = "signin";
let watchlistItems = [];
let watchlistLoaded = false;
let watchlistLoading = false;
async function watchlistRequest(action, ticker) {
  if (!authClient) throw new Error("Supabase Auth is unavailable. Reload the app and try again.");
  const { data, error: sessionError } = await authClient.auth.getSession();
  if (sessionError) throw sessionError;
  const session = data.session || authSession;
  if (!session?.access_token) {
    openAuthDialog("signin");
    throw new Error("Sign in to use your watchlist.");
  }
  const response = await fetch(api("watchlist"), {
    method: "POST",
    headers: { ...headers(), Authorization: "Bearer " + session.access_token },
    body: JSON.stringify({ action, ticker })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Watchlist request failed.");
  return result;
}

function authRedirectUrl() {
  return window.location.origin + window.location.pathname;
}

function updateAuthUI() {
  const signedIn = Boolean(authUser);
  const button = $("settings-account-button");
  if (button) {
    button.textContent = authUser?.email ? "Manage account" : "Sign in or create account";
    button.title = authUser?.email || "Sign in or create an account";
    button.classList.toggle("signed-in", signedIn);
  }
  const status = $("settings-account-status");
  if (status) status.textContent = authUser?.email
    ? "Signed in as " + authUser.email + ". Your saved watchlist is synced to this account."
    : "Sign in to save and sync your watchlist across devices.";
  $("auth-form-panel").hidden = signedIn;
  $("auth-account-panel").hidden = !signedIn;
  if (authUser) $("auth-account-email").textContent = authUser.email || "Signed-in account";

  const controls = $("account-controls");
  const signedOutNote = $("account-signed-out-note");
  if (controls) controls.hidden = !signedIn;
  if (signedOutNote) signedOutNote.hidden = signedIn;
  if (signedIn) {
    const verified = Boolean(authUser.email_confirmed_at || authUser.confirmed_at);
    $("account-current-email").textContent = authUser.email || "—";
    $("account-email-status").textContent = verified ? "Verified" : "Confirmation pending";
    $("account-created").textContent = authUser.created_at ? new Date(authUser.created_at).toLocaleString() : "—";
    $("account-last-signin").textContent = authUser.last_sign_in_at ? new Date(authUser.last_sign_in_at).toLocaleString() : "—";
    $("account-display-name").value = authUser.user_metadata?.display_name || "";
  }
}

function setAuthMode(mode) {
  authMode = mode;
  const reset = mode === "reset";
  const signup = mode === "signup";
  const update = mode === "update";
  $("auth-title").textContent = update ? "Choose a new password" : reset ? "Reset password" : signup ? "Create account" : "Sign in";
  $("auth-description").textContent = update
    ? "Set a new password for your account."
    : reset
      ? "Enter your email address and we’ll send a password reset link."
      : signup
        ? "Create an account to keep your watchlist synced across devices."
        : "Sign in to access your saved watchlist from any device.";
  $("auth-email-label").hidden = update;
  $("auth-email").required = !update;
  if (update && authUser?.email) $("auth-email").value = authUser.email;
  $("auth-password-label").hidden = reset;
  $("auth-password").required = !reset;
  $("auth-password").autocomplete = signup || update ? "new-password" : "current-password";
  $("auth-submit").textContent = update ? "Update password" : reset ? "Send reset link" : signup ? "Create account" : "Sign in";
  $("auth-mode-toggle").hidden = reset || update;
  $("auth-mode-toggle").textContent = signup ? "Already have an account? Sign in" : "Create an account";
  $("auth-reset-link").hidden = signup || reset || update;
  $("auth-feedback").textContent = "";
}

function openAuthDialog(mode = "signin") {
  if (mode === "update") {
    setAuthMode("update");
    $("auth-form-panel").hidden = false;
    $("auth-account-panel").hidden = true;
  } else if (authUser) {
    updateAuthUI();
  } else {
    setAuthMode(mode);
  }
  $("auth-modal").hidden = false;
  document.body.classList.add("auth-open");
  if (!authUser || mode === "update") $("auth-email").focus();
}

function closeAuthDialog() {
  $("auth-modal").hidden = true;
  document.body.classList.remove("auth-open");
}

function applyAuthSession(session) {
  const previousUserId = authUser?.id || null;
  authSession = session || null;
  authUser = session?.user || null;
  const nextUserId = authUser?.id || null;
  updateAuthUI();

  if (previousUserId !== nextUserId) {
    watchlistItems = [];
    watchlistLoaded = false;
    if (currentScreen === "watchlist" && authUser) window.setTimeout(() => loadWatchlist(true), 0);
    if (currentScreen === "watchlist" && !authUser) renderWatchlistSignedOut();
    if (currentDetailTicker) window.setTimeout(() => updateDetailWatchlistButton(), 0);
  }
}

async function initializeAuth() {
  if (!authClient) {
    $("settings-account-button").disabled = true;
    $("settings-account-button").textContent = "Authentication unavailable";
    $("auth-feedback").textContent = "Supabase URL and publishable key are required to enable accounts.";
    return;
  }
  authClient.auth.onAuthStateChange((event, session) => {
    applyAuthSession(session);
    if (event === "PASSWORD_RECOVERY") openAuthDialog("update");
  });
  const { data, error } = await authClient.auth.getSession();
  if (error) {
    $("auth-feedback").textContent = "Could not restore your sign-in session: " + error.message;
    return;
  }
  applyAuthSession(data.session);
}

$("settings-account-button").addEventListener("click", () => openAuthDialog());

$("account-signin").addEventListener("click", () => openAuthDialog("signin"));

function setAccountFeedback(message, isError = false) {
  const target = $("account-settings-feedback");
  if (!target) return;
  target.textContent = message || "";
  target.classList.toggle("is-error", Boolean(isError));
}

$("account-refresh").addEventListener("click", async () => {
  if (!authClient || !authUser) return;
  const button = $("account-refresh");
  button.disabled = true;
  try {
    const { data, error } = await authClient.auth.getUser();
    if (error) throw error;
    authUser = data.user;
    const { data: sessionData } = await authClient.auth.getSession();
    authSession = sessionData.session || authSession;
    updateAuthUI();
    setAccountFeedback("Account details refreshed.");
  } catch (error) {
    setAccountFeedback(error.message || "Could not refresh account details.", true);
  } finally {
    button.disabled = false;
  }
});

$("account-profile-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!authClient || !authUser) return;
  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    const displayName = $("account-display-name").value.trim();
    const { data, error } = await authClient.auth.updateUser({
      data: { ...(authUser.user_metadata || {}), display_name: displayName }
    });
    if (error) throw error;
    authUser = data.user || authUser;
    updateAuthUI();
    setAccountFeedback("Profile details saved.");
  } catch (error) {
    setAccountFeedback(error.message || "Could not save profile details.", true);
  } finally {
    if (button) button.disabled = false;
  }
});

$("account-email-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!authClient || !authUser) return;
  const button = event.submitter;
  const nextEmail = $("account-new-email").value.trim();
  if (!nextEmail || nextEmail.toLowerCase() === String(authUser.email || "").toLowerCase()) {
    setAccountFeedback("Enter a different email address.", true);
    return;
  }
  if (button) button.disabled = true;
  try {
    const { error } = await authClient.auth.updateUser(
      { email: nextEmail },
      { emailRedirectTo: authRedirectUrl() }
    );
    if (error) throw error;
    $("account-new-email").value = "";
    setAccountFeedback("Email change requested. Follow the confirmation instructions sent by your email provider.");
  } catch (error) {
    setAccountFeedback(error.message || "Could not update the email address.", true);
  } finally {
    if (button) button.disabled = false;
  }
});

$("account-password-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!authClient || !authUser) return;
  const button = event.submitter;
  const password = $("account-new-password").value;
  const confirmation = $("account-confirm-password").value;
  if (password.length < 8) {
    setAccountFeedback("Choose a password with at least 8 characters.", true);
    return;
  }
  if (password !== confirmation) {
    setAccountFeedback("The new passwords do not match.", true);
    return;
  }
  if (button) button.disabled = true;
  try {
    const { error } = await authClient.auth.updateUser({ password });
    if (error) throw error;
    $("account-new-password").value = "";
    $("account-confirm-password").value = "";
    setAccountFeedback("Your password has been updated.");
  } catch (error) {
    setAccountFeedback(error.message || "Could not update the password.", true);
  } finally {
    if (button) button.disabled = false;
  }
});

$("account-password-reset").addEventListener("click", async () => {
  if (!authClient || !authUser?.email) return;
  const button = $("account-password-reset");
  button.disabled = true;
  try {
    const { error } = await authClient.auth.resetPasswordForEmail(authUser.email, { redirectTo: authRedirectUrl() });
    if (error) throw error;
    setAccountFeedback("A password-reset email has been requested for " + authUser.email + ".");
  } catch (error) {
    setAccountFeedback(error.message || "Could not send a password-reset email.", true);
  } finally {
    button.disabled = false;
  }
});

$("account-signout-others").addEventListener("click", async () => {
  if (!authClient || !authUser) return;
  const button = $("account-signout-others");
  button.disabled = true;
  try {
    const { error } = await authClient.auth.signOut({ scope: "others" });
    if (error) throw error;
    setAccountFeedback("Other sessions have been signed out.");
  } catch (error) {
    setAccountFeedback(error.message || "Could not sign out other devices.", true);
  } finally {
    button.disabled = false;
  }
});

$("account-signout-all").addEventListener("click", async () => {
  if (!authClient || !authUser) return;
  if (!window.confirm("Sign out this account on every device? This will also sign you out here.")) return;
  const button = $("account-signout-all");
  button.disabled = true;
  try {
    const { error } = await authClient.auth.signOut({ scope: "global" });
    if (error) throw error;
    applyAuthSession(null);
    if (currentScreen === "watchlist") switchScreen("home");
    setAccountFeedback("All sessions have been signed out.");
  } catch (error) {
    setAccountFeedback(error.message || "Could not sign out all devices.", true);
  } finally {
    button.disabled = false;
  }
});

function csvCell(value) {
  const text = String(value ?? "");
  return '"' + text.replace(/"/g, '""') + '"';
}

$("account-export-watchlist").addEventListener("click", async () => {
  if (!authUser) return;
  const button = $("account-export-watchlist");
  button.disabled = true;
  try {
    if (!watchlistLoaded) await loadWatchlist(true);
    const headers = ["Ticker", "Company", "Price", "Currency", "Daily change (%)", "1-month return (%)", "1-year return (%)", "Forecast change (%)", "Indexed at"];
    const rows = watchlistItems.map(item => {
      const data = item.analysis || {};
      const summary = data.market_summary || {};
      const forecast = data.forecast || {};
      return [item.ticker, data.company || item.ticker, data.price, data.currency, data.change_percent,
        summary.return_1m, summary.return_1y, forecast.expected_change_percent, data.indexed_at];
    });
    const csv = [headers, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "stock-analyser-watchlist.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setAccountFeedback("Watchlist CSV exported.");
  } catch (error) {
    setAccountFeedback(error.message || "Could not export the watchlist.", true);
  } finally {
    button.disabled = false;
  }
});

$("account-clear-watchlist").addEventListener("click", async () => {
  if (!authUser) return;
  if (!watchlistLoaded) await loadWatchlist(true);
  const count = watchlistItems.length;
  if (!count) {
    setAccountFeedback("Your watchlist is already empty.");
    return;
  }
  if (!window.confirm("Permanently remove all " + count + " saved stocks from your watchlist?")) return;
  const button = $("account-clear-watchlist");
  button.disabled = true;
  let removed = 0;
  try {
    for (const item of [...watchlistItems]) {
      setAccountFeedback("Removing " + item.ticker + " (" + (removed + 1) + " of " + count + ")…");
      await watchlistRequest("remove", item.ticker);
      removed += 1;
    }
    watchlistItems = [];
    watchlistLoaded = true;
    renderWatchlist();
    setAccountFeedback("Removed " + removed + " saved stocks.");
  } catch (error) {
    await loadWatchlist(true);
    setAccountFeedback("Removed " + removed + " of " + count + " stocks. " + (error.message || "The remaining entries could not be removed."), true);
  } finally {
    button.disabled = false;
  }
});

$("auth-close").addEventListener("click", closeAuthDialog);
$("auth-modal").addEventListener("click", event => {
  if (event.target.matches("[data-auth-close]")) closeAuthDialog();
});
$("auth-mode-toggle").addEventListener("click", () => setAuthMode(authMode === "signup" ? "signin" : "signup"));
$("auth-reset-link").addEventListener("click", () => setAuthMode("reset"));

$("auth-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!authClient) return;
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  const submit = $("auth-submit");
  submit.disabled = true;
  $("auth-feedback").textContent = authMode === "signup" ? "Creating your account…" : authMode === "reset" ? "Sending reset link…" : "Signing in…";
  try {
    if (authMode === "update") {
      const { error } = await authClient.auth.updateUser({ password });
      if (error) throw error;
      $("auth-password").value = "";
      $("auth-feedback").textContent = "Your password has been updated.";
      setAuthMode("signin");
      $("auth-feedback").textContent = "Your password has been updated. You can now continue using your account.";
      updateAuthUI();
      return;
    } else if (authMode === "signup") {
      const { data, error } = await authClient.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: authRedirectUrl() }
      });
      if (error) throw error;
      if (data.session) {
        applyAuthSession(data.session);
        closeAuthDialog();
      } else {
        $("auth-feedback").textContent = "Account created. Check your inbox and confirm your email address before signing in.";
      }
    } else if (authMode === "reset") {
      const { error } = await authClient.auth.resetPasswordForEmail(email, { redirectTo: authRedirectUrl() });
      if (error) throw error;
      $("auth-feedback").textContent = "If an account exists for that email, a password reset link has been sent.";
    } else {
      const { data, error } = await authClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
      applyAuthSession(data.session);
      closeAuthDialog();
    }
  } catch (error) {
    $("auth-feedback").textContent = error.message || "Authentication failed. Try again.";
  } finally {
    submit.disabled = false;
  }
});

$("auth-signout").addEventListener("click", async () => {
  if (!authClient) return;
  const { error } = await authClient.auth.signOut();
  if (error) {
    $("auth-feedback").textContent = error.message;
    return;
  }
  applyAuthSession(null);
  closeAuthDialog();
  if (currentScreen === "watchlist") switchScreen("home");
});

function renderWatchlistSignedOut() {
  if (!$("watchlist-grid")) return;
  $("watchlist-count").textContent = "";
  $("watchlist-status").textContent = "Sign in to keep your saved stocks synced across devices.";
  $("watchlist-grid").innerHTML = '<div class="empty-feed watchlist-empty"><p>Watchlists are linked to your account, not this browser.</p><button type="button" id="watchlist-signin">Sign in or create an account</button></div>';
  $("watchlist-signin").addEventListener("click", () => openAuthDialog("signin"));
}

const QUEUE_KEY = "stock-analyser-active-jobs";
let trackedJobs = loadTrackedJobs();
let queueRefreshBusy = false;
const locallyPollingJobIds = new Set();

function loadTrackedJobs() {
  try {
    const saved = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
    // Completed/failed requests are not queue entries; discard any left by older versions.
    return Array.isArray(saved) ? saved.filter(job => job && job.id && !["completed", "failed"].includes(job.status)) : [];
  } catch { return []; }
}
function saveTrackedJobs() {
  trackedJobs = trackedJobs.filter(job => job && job.id && !["completed", "failed"].includes(job.status)).slice(0, 30);
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(trackedJobs)); } catch {}
  renderGlobalQueue();
}
function trackJob(job) {
  if (!job?.id) return;
  trackedJobs = trackedJobs.filter(item => item.id !== job.id);
  trackedJobs.unshift({ id: job.id, ticker: job.ticker || "Market scan", type: job.type || "analysis",
    status: job.status || "queued", progress: Number(job.progress) || 0, stage: job.stage || "Waiting for a worker…" });
  saveTrackedJobs();
}
function updateTrackedJob(id, data) {
  const item = trackedJobs.find(job => job.id === id);
  if (!item) return;
  Object.assign(item, { status: data.status || item.status, progress: Math.max(0, Math.min(100, Number(data.progress) || 0)),
    stage: data.stage || item.stage, error: data.error || null });
  // Remove terminal jobs immediately from the dropdown, count, and persisted queue.
  if (["completed", "failed"].includes(item.status)) {
    trackedJobs = trackedJobs.filter(job => job.id !== id);
  }
  saveTrackedJobs();
}
function renderGlobalQueue() {
  const active = trackedJobs.filter(job => !["completed", "failed"].includes(job.status));
  const button = $("global-queue-toggle");
  const count = $("global-queue-count");
  const list = $("global-queue-list");
  if (!button || !count || !list) return;
  count.textContent = active.length ? String(active.length) : "";
  button.classList.toggle("has-jobs", active.length > 0);
  list.innerHTML = trackedJobs.length ? trackedJobs.map(job => {
    const pctValue = Math.max(0, Math.min(100, Number(job.progress) || 0));
    return '<button type="button" class="queue-job" data-job-id="' + esc(job.id) + '" data-job-type="' + esc(job.type) + '" data-job-ticker="' + esc(job.ticker) + '">' +
      '<span class="queue-job-top"><strong>' + esc(job.ticker) + '</strong><small>' + esc(job.status) + ' · ' + pctValue + '%</small></span>' +
      '<span class="queue-track"><span style="width:' + pctValue + '%"></span></span><small class="queue-stage">' + esc(job.stage) + '</small></button>';
  }).join("") : '<p class="queue-empty">No recent analysis requests.</p>';
  list.querySelectorAll("[data-job-id]").forEach(el => el.addEventListener("click", () => {
    $("global-queue-popover").hidden = true;
    if (el.dataset.jobType === "scan") {
      switchScreen("discover");
      $("scan-status").textContent = "Opening your tracked market scan…";
      return;
    }
    openStockDetails(el.dataset.jobTicker, { jobId: el.dataset.jobId, returnScreen: currentTab });
  }));
}
async function refreshGlobalQueue() {
  if (queueRefreshBusy || !config.supabaseUrl || !config.supabasePublishableKey) return;
  queueRefreshBusy = true;
  try {
    const active = trackedJobs.filter(job => !["completed", "failed"].includes(job.status) && !locallyPollingJobIds.has(job.id));
    await Promise.all(active.map(async job => {
      try {
        const response = await fetch(api("analysis-status") + "?id=" + encodeURIComponent(job.id), {
          headers: { "apikey": config.supabasePublishableKey }
        });
        const data = await response.json();
        if (response.ok) updateTrackedJob(job.id, data);
      } catch {}
    }));
    trackedJobs = trackedJobs.filter(job => !job.finishedAt || Date.now() - job.finishedAt < 10 * 60 * 1000);
    saveTrackedJobs();
  } finally { queueRefreshBusy = false; }
}
function setGlobalQueueOpen(open) {
  const toggle = $("global-queue-toggle");
  const popover = $("global-queue-popover");
  if (!toggle || !popover) return;
  popover.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
}
document.addEventListener("click", event => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const toggle = target.closest("#global-queue-toggle");
  if (toggle) {
    event.preventDefault();
    setGlobalQueueOpen($("global-queue-popover").hidden);
    return;
  }
  if (!target.closest(".global-queue")) setGlobalQueueOpen(false);
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") setGlobalQueueOpen(false);
});
renderGlobalQueue();
refreshGlobalQueue();
setInterval(refreshGlobalQueue, 5000);


function rows(obj) {
  return Object.entries(obj || {}).map(([k, v]) =>
    '<div class="row"><span>' + esc(k.replaceAll("_", " ")) + '</span><strong>' +
    esc(v == null ? "—" : v) + '</strong></div>'
  ).join("");
}

async function requestAnalysis(ticker, period, horizon, mode = "analysis", hardRescan = false, latestOnly = false, saveToIndexer = "rapidIndex") {
  const payload = mode === "scan"
    ? { mode: "scan", source: $("scan-source").value, hard_rescan: hardRescan, latest_only: latestOnly }
    : { ticker, period, horizon, hard_rescan: hardRescan, save_to_indexer: saveToIndexer };
  const response = await fetch(api("request-analysis"), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Could not start analysis.");
  return data;
}

function updateProgress(prefix, data) {
  const wrap = $(prefix + "-progress");
  wrap.hidden = false;
  const value = Math.max(0, Math.min(100, Number(data.progress) || 0));
  $(prefix + "-progress-fill").style.width = value + "%";
  $(prefix + "-progress-percent").textContent = value + "%";
  $(prefix + "-progress-label").textContent =
    data.status === "queued" ? "Queued" :
    data.status === "completed" ? "Complete" :
    data.status === "failed" ? "Failed" : "Processing";
  $(prefix + "-progress-stage").textContent =
    data.stage || (data.status === "queued" ? "Waiting for a worker…" : "Working…");
}

async function waitForResult(id, statusElement, prefix = "search") {
  locallyPollingJobIds.add(id);
  try {
    const started = Date.now();
    while (Date.now() - started < 15 * 60 * 1000) {
      const response = await fetch(api("analysis-status") + "?id=" + encodeURIComponent(id), {
        headers: { "apikey": config.supabasePublishableKey }
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "Could not retrieve analysis status.");
      updateProgress(prefix, data);
      updateTrackedJob(id, data);
      if (data.status === "completed") return data.result;
      if (data.status === "failed") throw Error(data.error || "The analysis failed.");
      statusElement.textContent = data.status === "running"
        ? "The worker is processing this job…"
        : "Queued; waiting for the shared GitHub Actions worker…";
      await wait(2500);
    }
    throw Error("This analysis is taking longer than expected. Its job may still finish; try again later.");
  } finally {
    locallyPollingJobIds.delete(id);
  }
}

function stockSparkline(stock) {
  const history = (Array.isArray(stock.history_preview) ? stock.history_preview : [])
    .map(Number).filter(Number.isFinite);
  const future = (Array.isArray(stock.forecast_preview) ? stock.forecast_preview : [])
    .map(Number).filter(Number.isFinite);
  if (!history.length) {
    return '<div class="stock-chart-placeholder">Indexed chart unavailable</div>';
  }

  const all = history.concat(future);
  const min = Math.min(...all);
  const max = Math.max(...all);
  const spread = max - min || Math.max(Math.abs(max) * 0.01, 1);
  const width = 280;
  const height = 54;
  const pad = 5;
  const total = Math.max(2, history.length + future.length);
  const point = (value, index) => {
    const x = (index / (total - 1)) * width;
    const y = height - pad - ((value - min) / spread) * (height - pad * 2);
    return [x, y];
  };
  const pathFor = (values, offset = 0) => values.map((value, index) => {
    const [x, y] = point(value, index + offset);
    return (index ? "L" : "M") + x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");
  const historyPath = pathFor(history);
  const forecastValues = future.length ? [history[history.length - 1], ...future] : [];
  const forecastPath = forecastValues.length ? pathFor(forecastValues, history.length - 1) : "";
  const forecastClass = Number(stock.expected_change_percent) < 0 ? "negative" : "positive";

  return '<svg class="stock-sparkline" viewBox="0 0 280 54" preserveAspectRatio="none" role="img" aria-label="Historical price and indexed model forecast">' +
    '<path class="stock-history-line" d="' + historyPath + '"></path>' +
    (forecastPath ? '<path class="stock-forecast-line ' + forecastClass + '" d="' + forecastPath + '"></path>' : '') +
    '</svg>';
}

function stockCard(stock) {
  const company = stock.company || stock.name || stock.ticker;
  const dailyChange = stock.change_percent;
  const dailyClass = Number(dailyChange) < 0 ? "negative" : "positive";
  const predicted = stock.expected_change_percent == null
    ? ""
    : '<span class="stock-predicted ' + (Number(stock.expected_change_percent) < 0 ? "negative" : "positive") +
      '"><strong>' + esc(pct(stock.expected_change_percent)) + '</strong><small>30D</small></span>';

  const stats = [];
  if (stock.return_1m != null) stats.push({ label: "1M", value: pct(stock.return_1m) });
  else if (stock.validation_rmse != null) stats.push({ label: "RMSE", value: fmt(stock.validation_rmse, 4) });
  if (stock.directional_accuracy != null) {
    stats.push({ label: "Accuracy", value: fmt(stock.directional_accuracy, 0) + "%" });
  } else if (stock.annualized_volatility != null) {
    stats.push({ label: "Volatility", value: pct(stock.annualized_volatility) });
  }

  const statMarkup = stats.slice(0, 2).map(stat =>
    '<span class="stock-analysis-stat"><strong>' + esc(stat.value) + '</strong><small>' + esc(stat.label) + '</small></span>'
  ).join("");

  return `
    <button type="button" class="stock-card" data-ticker="${esc(stock.ticker)}" aria-label="Open analysis for ${esc(stock.ticker)}">
      <span class="stock-card-heading">
        <span class="stock-card-left">
          <strong class="stock-ticker">${esc(stock.ticker)}</strong>
          <span class="stock-company">${esc(company)}</span>
        </span>
        <span class="stock-open-arrow" aria-hidden="true">↗</span>
      </span>
      <span class="stock-card-price-row">
        <strong class="stock-price">${esc(cash(stock.price, stock.currency))}</strong>
        <span class="stock-daily-change ${dailyClass}">${esc(pct(dailyChange))}</span>
      </span>
      <span class="stock-card-chart">
        ${stockSparkline(stock)}
        <span class="stock-analysis-meta">${predicted}${statMarkup}</span>
      </span>
    </button>`;
}


function moneyCompact(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e12) return "$" + fmt(n / 1e12, 2) + "T";
  if (n >= 1e9) return "$" + fmt(n / 1e9, 2) + "B";
  if (n >= 1e6) return "$" + fmt(n / 1e6, 2) + "M";
  if (n >= 1e3) return "$" + fmt(n / 1e3, 1) + "K";
  return cash(n, "USD");
}

function watchlistCard(item) {
  const data = item.analysis || null;
  const summary = data?.market_summary || {};
  const fundamentals = data?.fundamentals || {};
  const accuracy = data?.model?.metrics?.hybrid?.directional_accuracy;
  const expected = data?.forecast?.expected_change_percent;
  const daily = data?.change_percent;
  const company = data?.company || item.ticker;
  const updated = data?.indexed_at ? new Date(data.indexed_at).toLocaleString() : "";
  const dailyClass = Number(daily) < 0 ? "negative" : "positive";
  const expectedClass = Number(expected) < 0 ? "negative" : "positive";
  const forecastDays = data?.forecast?.horizon ?? 30;
  const meta = fundamentals.sector || fundamentals.industry || "Company research";
  const status = data
    ? "RapidIndex" + (updated ? " · Updated " + esc(updated) : "")
    : "Waiting for WatchIndex";

  const stats = [];
  const addStat = (label, value, formatted, tone = "") => {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return;
    stats.push(
      '<span class="watchlist-v2-stat">' +
        '<small>' + esc(label) + '</small>' +
        '<strong' + (tone ? ' class="' + tone + '"' : '') + '>' + esc(formatted) + '</strong>' +
      '</span>'
    );
  };
  addStat("1-month return", summary.return_1m, pct(summary.return_1m), Number(summary.return_1m) < 0 ? "negative" : "positive");
  addStat("1-year return", summary.return_1y, pct(summary.return_1y), Number(summary.return_1y) < 0 ? "negative" : "positive");
  addStat("Forecast · " + forecastDays + " days", expected, pct(expected), expectedClass);
  addStat("Model direction", accuracy, fmt(accuracy, 0) + "%");
  addStat("Annual volatility", summary.annualized_volatility, pct(summary.annualized_volatility));
  addStat("Maximum drawdown", summary.max_drawdown, pct(summary.max_drawdown));
  addStat("Market capitalisation", fundamentals.market_cap, moneyCompact(fundamentals.market_cap));

  const chart = stockSparkline({
    history_preview: data?.history_preview || [],
    forecast_preview: data?.forecast_preview || [],
    expected_change_percent: expected
  });
  const quote = data
    ? '<strong class="watchlist-v2-price">' + esc(cash(data.price, data.currency)) + '</strong>' +
      '<small class="watchlist-v2-daily ' + dailyClass + '">' + esc(pct(daily)) + ' today</small>'
    : '<strong class="watchlist-v2-price">Pending</strong><small class="watchlist-v2-daily">Awaiting indexed price</small>';

  return '<article class="watchlist-v2-item">' +
    '<button type="button" class="watchlist-v2-main" data-watch-open="' + esc(item.ticker) + '" aria-label="Open analysis for ' + esc(item.ticker) + '">' +
      '<span class="watchlist-v2-identity">' +
        '<strong class="watchlist-v2-ticker">' + esc(item.ticker) + '</strong>' +
        '<span class="watchlist-v2-company">' + esc(company) + '</span>' +
      '</span>' +
      '<span class="watchlist-v2-quote">' + quote + '</span>' +
      '<span class="watchlist-v2-chart">' +
        '<span class="watchlist-v2-chart-heading"><span>Price history</span><span>RapidIndex</span></span>' +
        chart +
      '</span>' +
    '</button>' +
    '<div class="watchlist-v2-stats">' +
      (stats.length ? stats.join("") : '<span class="watchlist-v2-no-stats">Market statistics will appear when WatchIndex completes this stock.</span>') +
    '</div>' +
    '<footer class="watchlist-v2-footer">' +
      '<span class="watchlist-v2-company-meta">' + esc(meta) + '</span>' +
      '<span class="watchlist-v2-status">' + status + '</span>' +
      '<button type="button" class="watch-card-remove watchlist-v2-remove" data-watch-remove="' + esc(item.ticker) + '" aria-label="Remove ' + esc(item.ticker) + ' from watchlist">Remove</button>' +
    '</footer>' +
  '</article>';
}

function renderWatchlist() {
  const root = $("watchlist-grid");
  $("watchlist-count").textContent = watchlistItems.length + (watchlistItems.length === 1 ? " stock" : " stocks");
  if (!watchlistItems.length) {
    root.innerHTML = '<div class="empty-feed watchlist-empty">Your watchlist is empty. Open a stock analysis and select “Add to watchlist” to save it here.</div>';
    return;
  }
  root.innerHTML = watchlistItems.map(watchlistCard).join("");
  root.querySelectorAll("[data-watch-open]").forEach(button => {
    button.addEventListener("click", () => openStockDetails(button.dataset.watchOpen, { returnScreen: "watchlist" }));
  });
  root.querySelectorAll("[data-watch-remove]").forEach(button => {
    button.addEventListener("click", async () => {
      const ticker = button.dataset.watchRemove;
      button.disabled = true;
      try {
        await watchlistRequest("remove", ticker);
        watchlistItems = watchlistItems.filter(item => item.ticker !== ticker);
        renderWatchlist();
        $("watchlist-status").textContent = ticker + " removed from your watchlist.";
        if (currentDetailTicker === ticker) updateDetailWatchlistButton();
      } catch (error) {
        button.disabled = false;
        $("watchlist-status").textContent = error.message;
      }
    });
  });
}

async function loadWatchlist(force = false) {
  if (!authUser) { renderWatchlistSignedOut(); return; }
  if (watchlistLoading || (watchlistLoaded && !force)) return;
  watchlistLoading = true;
  $("watchlist-status").textContent = "Loading your saved stocks…";
  try {
    const data = await watchlistRequest("list");
    watchlistItems = Array.isArray(data.items) ? data.items : [];
    watchlistLoaded = true;
    renderWatchlist();
    const pending = watchlistItems.filter(item => !item.analysis).length;
    $("watchlist-status").textContent = pending
      ? pending + " stock" + (pending === 1 ? " is" : "s are") + " waiting for WatchIndex. Results appear automatically when indexed."
      : "Your RapidIndex data is up to date.";
  } catch (error) {
    $("watchlist-status").textContent = error.message;
    $("watchlist-grid").innerHTML = '<div class="empty-feed">Your watchlist could not be loaded.</div>';
  } finally { watchlistLoading = false; }
}

async function updateDetailWatchlistButton() {
  const button = $("detail-watchlist");
  if (!button || !currentDetailTicker) return;
  if (!authUser) {
    button.textContent = "Sign in to save";
    button.classList.remove("watchlist-added");
    button.disabled = false;
    button.dataset.added = "false";
    return;
  }
  const ticker = currentDetailTicker;
  button.disabled = true;
  try {
    if (!watchlistLoaded) {
      const data = await watchlistRequest("list");
      watchlistItems = Array.isArray(data.items) ? data.items : [];
      watchlistLoaded = true;
    }
    if (currentDetailTicker !== ticker) return;
    const exists = watchlistItems.some(item => item.ticker === ticker);
    button.textContent = exists ? "✓ In watchlist" : "＋ Add to watchlist";
    button.classList.toggle("watchlist-added", exists);
    button.disabled = exists;
    button.dataset.added = String(exists);
  } catch (error) {
    button.textContent = "＋ Add to watchlist";
    button.disabled = false;
    button.title = error.message;
  }
}

$("detail-watchlist").addEventListener("click", async () => {
  const ticker = currentDetailTicker;
  const button = $("detail-watchlist");
  if (!ticker) return;
  if (!authUser) { openAuthDialog("signin"); return; }
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = "Adding…";
  try {
    await watchlistRequest("add", ticker);
    if (!watchlistItems.some(item => item.ticker === ticker)) {
      watchlistItems.unshift({ ticker, added_at: new Date().toISOString(), analysis: null });
    }
    if (currentDetailTicker !== ticker) return;
    button.textContent = "✓ In watchlist";
    button.classList.add("watchlist-added");
    button.dataset.added = "true";
    if (currentScreen === "watchlist") renderWatchlist();
  } catch (error) {
    if (currentDetailTicker === ticker) {
      button.textContent = "＋ Add to watchlist";
      button.disabled = false;
      button.title = error.message;
    }
  }
});
function bindStockButtons(root) {
  if (!root) return;
  root.querySelectorAll("[data-ticker]").forEach(button => {
    button.addEventListener("click", () => openStockDetails(button.dataset.ticker));
  });
}

function fillStockGrid(id, stocks, tag = "") {
  const root = $(id);
  if (!root) return;
  if (!Array.isArray(stocks) || !stocks.length) {
    root.innerHTML = '<div class="empty-feed">No stocks currently meet this screen. The lists update as new market results are indexed.</div>';
    return;
  }
  root.innerHTML = stocks.map(stockCard).join("");
  bindStockButtons(root);
}

function renderMarketFeed(data) {
  marketFeed = data;
  const updated = data.generated_at ? new Date(data.generated_at) : null;
  $("market-feed-updated").textContent = updated && !Number.isNaN(updated.valueOf())
    ? "Updated " + updated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";

  const latest = data.latest_scan?.results || [];
  $("home-latest-scan").innerHTML = latest.length
    ? latest.slice(0, 6).map(stockCard).join("")
    : '<div class="empty-feed">No completed background scan is available yet. The section will populate after the next shared scan finishes.</div>';
  bindStockButtons($("home-latest-scan"));

  fillStockGrid("home-recommended", data.recommended, "Research shortlist");
  fillStockGrid("home-trending", data.trending, "Trending");
  fillStockGrid("home-popular", data.popular, "Popular");
  fillStockGrid("home-opportunities", data.opportunities, "Smaller company");

  fillStockGrid("search-trending", data.trending, "Trending");
  fillStockGrid("search-popular", data.popular, "Popular");

  fillStockGrid("discover-smaller", data.smaller_companies, "Smaller company");
  fillStockGrid("discover-opportunities", data.opportunities, "Quality screen");
  fillStockGrid("discover-trending", data.trending, "Momentum");

  $("discover-stats").innerHTML = `
    <div><strong>${fmt(data.indexed_count, 0)}</strong><span>Indexed stocks</span></div>
    <div><strong>${fmt(data.small_company_count, 0)}</strong><span>Smaller companies</span></div>
    <div><strong>${fmt(data.quality_small_company_count, 0)}</strong><span>Quality-screened</span></div>`;
}

async function loadMarketFeed(force = false) {
  if (!config.supabaseUrl || !config.supabasePublishableKey) {
    $("home-latest-scan").innerHTML = '<div class="empty-feed">Supabase is not configured. Add the project URL and publishable key to the app deployment variables.</div>';
    return;
  }
  if (marketFeedLoading) {
    marketFeedRefreshQueued = marketFeedRefreshQueued || force;
    return;
  }
  if (!force && marketFeed && Date.now() - marketFeedLoadedAt < 60_000) return;
  marketFeedLoading = true;
  try {
    const response = await fetch(api("market-feed"), { method: "GET", headers: { "apikey": config.supabasePublishableKey } });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "Could not load market overview.");
    renderMarketFeed(data);
    marketFeedLoadedAt = Date.now();
  } catch (error) {
    if (!marketFeed) {
      $("home-latest-scan").innerHTML = '<div class="empty-feed">Could not load market data: ' + esc(error.message) + '</div>';
    }
  } finally {
    marketFeedLoading = false;
    if (marketFeedRefreshQueued) {
      marketFeedRefreshQueued = false;
      loadMarketFeed(true);
    }
  }
}

function switchScreen(screen) {
  currentScreen = screen;
  if (screen !== "detail") currentTab = screen;
  ["home", "search", "discover", "watchlist", "settings", "detail"].forEach(name => {
    $(name + "-screen").hidden = name !== screen;
  });
  document.body.classList.toggle("detail-mode", screen === "detail");

  ["home", "search", "discover", "watchlist", "settings"].forEach(name => {
    const button = $("nav-" + name);
    button.classList.toggle("active", currentTab === name);
    if (currentTab === name) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  window.scrollTo({ top: 0, behavior: "instant" });
  if (screen === "home" || screen === "search" || screen === "discover") loadMarketFeed();
  if (screen === "discover") loadLatestScan();
  if (screen === "watchlist") loadWatchlist(true);
}

$("nav-home").addEventListener("click", () => switchScreen("home"));
$("nav-search").addEventListener("click", () => switchScreen("search"));
$("nav-discover").addEventListener("click", () => switchScreen("discover"));
$("nav-watchlist").addEventListener("click", () => switchScreen("watchlist"));
$("nav-settings").addEventListener("click", () => switchScreen("settings"));
$("detail-back").addEventListener("click", () => switchScreen(detailReturnScreen || currentTab));

const autocompleteTimers = new Map();
const autocompleteControllers = new Map();

function attachStockAutocomplete(inputId, dropdownId, returnScreen, settings = () => ({})) {
  const input = $(inputId);
  const dropdown = $(dropdownId);
  if (!input || !dropdown) return;
  let suggestions = [];
  let activeIndex = -1;
  let requestSequence = 0;

  const close = () => {
    dropdown.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    activeIndex = -1;
  };

  const choose = stock => {
    if (!stock?.ticker) return;
    input.value = stock.ticker;
    close();
    const options = settings();
    openStockDetails(stock.ticker, {
      returnScreen,
      period: options.period || "5y",
      horizon: options.horizon || 30
    });
  };

  const renderSuggestions = items => {
    suggestions = items;
    activeIndex = -1;
    if (!items.length) {
      dropdown.innerHTML = '<div class="autocomplete-message">No matching listed companies found.</div>';
      dropdown.hidden = false;
      input.setAttribute("aria-expanded", "true");
      return;
    }
    dropdown.innerHTML = items.map((stock, index) =>
      '<button type="button" role="option" aria-selected="false" id="' + inputId + '-option-' + index +
      '" class="autocomplete-option" data-index="' + index + '">' +
      '<span class="autocomplete-symbol">' + esc(stock.ticker) + '</span>' +
      '<span class="autocomplete-company">' + esc(stock.company || stock.ticker) + '</span>' +
      '<span class="autocomplete-exchange">' + esc(stock.exchange || stock.type || "Stock") + '</span>' +
      '</button>'
    ).join("");
    dropdown.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };

  const search = query => {
    const sequence = ++requestSequence;
    clearTimeout(autocompleteTimers.get(inputId));
    autocompleteControllers.get(inputId)?.abort();
    if (!query) { close(); return; }
    if (!config.supabaseUrl || !config.supabasePublishableKey) {
      dropdown.innerHTML = '<div class="autocomplete-message">Search is not configured.</div>';
      dropdown.hidden = false;
      input.setAttribute("aria-expanded", "true");
      return;
    }
    dropdown.innerHTML = '<div class="autocomplete-message">Searching stocks…</div>';
    dropdown.hidden = false;
    input.setAttribute("aria-expanded", "true");
    const timer = setTimeout(async () => {
      const controller = new AbortController();
      autocompleteControllers.set(inputId, controller);
      try {
        const response = await fetch(api("market-feed") + "?q=" + encodeURIComponent(query), {
          headers: { "apikey": config.supabasePublishableKey },
          signal: controller.signal
        });
        const data = await response.json();
        if (sequence !== requestSequence) return;
        if (!response.ok) throw Error(data.error || "Stock search is temporarily unavailable.");
        renderSuggestions(data.suggestions || []);
      } catch (error) {
        if (error.name === "AbortError" || sequence !== requestSequence) return;
        dropdown.innerHTML = '<div class="autocomplete-message">Could not search stocks. Try again.</div>';
        dropdown.hidden = false;
        input.setAttribute("aria-expanded", "true");
      }
    }, 180);
    autocompleteTimers.set(inputId, timer);
  };

  const setActive = index => {
    if (!suggestions.length) return;
    activeIndex = (index + suggestions.length) % suggestions.length;
    dropdown.querySelectorAll(".autocomplete-option").forEach((option, i) => {
      const selected = i === activeIndex;
      option.setAttribute("aria-selected", String(selected));
      if (selected) {
        input.setAttribute("aria-activedescendant", option.id);
        option.scrollIntoView({ block: "nearest" });
      }
    });
  };

  input.addEventListener("input", () => search(input.value.trim()));
  input.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" && !dropdown.hidden) {
      event.preventDefault(); setActive(activeIndex + 1);
    } else if (event.key === "ArrowUp" && !dropdown.hidden) {
      event.preventDefault(); setActive(activeIndex < 0 ? suggestions.length - 1 : activeIndex - 1);
    } else if (event.key === "Enter" && !dropdown.hidden) {
      if (activeIndex >= 0 && suggestions[activeIndex]) {
        event.preventDefault(); choose(suggestions[activeIndex]);
      }
    } else if (event.key === "Escape") close();
  });
  dropdown.addEventListener("click", event => {
    const option = event.target.closest(".autocomplete-option");
    if (option) choose(suggestions[Number(option.dataset.index)]);
  });
  input.addEventListener("focus", () => {
    if (input.value.trim() && !dropdown.hidden) input.setAttribute("aria-expanded", "true");
  });
  document.addEventListener("click", event => {
    if (!event.target.closest("#" + inputId) && !event.target.closest("#" + dropdownId)) close();
  });
}

$("quick-search").addEventListener("submit", event => event.preventDefault());
attachStockAutocomplete("quick-ticker", "quick-suggestions", "home");
attachStockAutocomplete("ticker", "search-suggestions", "search");

async function openStockDetails(ticker, options = {}) {
  const symbol = String(ticker || "").trim().toUpperCase();
  if (!symbol) return;
  currentDetailTicker = symbol;
  updateDetailWatchlistButton();
  const indexer = options.indexer === "SlowIndex" ? "SlowIndex" : "rapidIndex";
  currentDetailIndexer = indexer;
  const period = options.customPeriod || (indexer === "SlowIndex" ? "max" : "5y");
  const horizon = Number(options.customHorizon || (indexer === "SlowIndex" ? 252 : 30));
  updateDetailIndexerSwitch();
  if (!config.supabaseUrl || !config.supabasePublishableKey) {
    switchScreen("detail");
    $("detail-status").textContent = "Supabase is not configured. Add the project URL and publishable key to the app deployment variables.";
    return;
  }

  detailReturnScreen = options.returnScreen || (currentScreen === "detail" ? detailReturnScreen : currentScreen);
  $("ticker").value = symbol;
  switchScreen("detail");

  $("results").hidden = true;
  $("search-progress").hidden = true;
  $("detail-status").textContent = "Preparing analysis for " + symbol + "…";
  $("detail-hard-rerun").disabled = true;

  try {
    const request = options.jobId
      ? { id: options.jobId, status: "queued", reused: true }
      : await requestAnalysis(symbol, period, horizon, "analysis", options.hardRescan === true, false, options.saveToIndexer || indexer);
    trackJob({ id: request.id, ticker: symbol, type: "analysis", status: request.status || "queued", progress: request.progress, stage: request.stage });
    let result;
    if (request.status === "completed" && request.cached) {
      const response = await fetch(api("analysis-status") + "?id=" + encodeURIComponent(request.id), {
        headers: { "apikey": config.supabasePublishableKey }
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "Could not retrieve cached analysis.");
      result = data.result;
      updateProgress("search", {
        status: "completed",
        progress: 100,
        stage: "Shared cached analysis · " + new Date(request.cache_created_at).toLocaleString()
      });
    } else {
      result = await waitForResult(request.id, $("detail-status"), "search");
    }
    if (!result) throw Error("The analysis returned no result.");
    $("results").hidden = false;
    render(result);
    $("detail-status").textContent = "Analysis complete · " + (result.as_of || "");
    if (window.Plotly) {
      Plotly.Plots.resize($("history"));
      Plotly.Plots.resize($("forecast"));
    }
  } catch (error) {
    $("detail-status").textContent = error.message;
  } finally {
    $("detail-hard-rerun").disabled = false;
  }
}

$("search").addEventListener("submit", event => event.preventDefault());
function updateDetailIndexerSwitch() {
  document.querySelectorAll("#detail-indexer-switch [data-indexer]").forEach(button => {
    const selected = button.dataset.indexer === currentDetailIndexer;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

$("detail-indexer-switch").addEventListener("click", event => {
  const button = event.target.closest("[data-indexer]");
  if (!button || button.dataset.indexer === currentDetailIndexer || !currentDetailTicker) return;
  openStockDetails(currentDetailTicker, {
    returnScreen: detailReturnScreen,
    indexer: button.dataset.indexer
  });
});

const hardRerunMenu = $("hard-rerun-menu");
function setHardRerunMenu(open) {
  hardRerunMenu.hidden = !open;
  $("detail-hard-rerun").setAttribute("aria-expanded", String(open));
  if (!open) $("hard-rerun-custom").hidden = true;
}
$("detail-hard-rerun").addEventListener("click", () => {
  setHardRerunMenu(hardRerunMenu.hidden);
});
hardRerunMenu.addEventListener("click", event => {
  const choice = event.target.closest("[data-rerun-indexer]");
  if (choice) {
    const indexer = choice.dataset.rerunIndexer;
    setHardRerunMenu(false);
    openStockDetails(currentDetailTicker, { returnScreen: detailReturnScreen, indexer, hardRescan: true, saveToIndexer: indexer });
    return;
  }
  if (event.target.closest("[data-rerun-custom]")) $("hard-rerun-custom").hidden = false;
});
$("hard-rerun-custom").addEventListener("submit", event => {
  event.preventDefault();
  const period = $("rerun-history").value;
  const horizon = Number($("rerun-horizon").value);
  const saveToIndexer = $("rerun-save").value;
  const displayIndexer = period === "max" && horizon === 252 ? "SlowIndex" :
    period === "5y" && horizon === 30 ? "rapidIndex" : currentDetailIndexer;
  setHardRerunMenu(false);
  openStockDetails(currentDetailTicker, {
    returnScreen: detailReturnScreen, indexer: displayIndexer,
    customPeriod: period, customHorizon: horizon, hardRescan: true, saveToIndexer
  });
});
document.addEventListener("click", event => {
  if (!event.target.closest(".hard-rerun-wrap")) setHardRerunMenu(false);
});

function render(data) {
  const currency = data.currency || "USD";
  $("symbol").textContent = data.ticker + " · " + (data.exchange || "");
  $("name").textContent = data.company || data.ticker;
  $("price").textContent = cash(data.price, currency);
  $("change").textContent = pct(data.change_percent);

  const market = data.market_summary || {};
  $("summary").innerHTML = [
    ["1-month return", pct(market.return_1m)],
    ["1-year return", pct(market.return_1y)],
    ["Annual volatility", pct(market.annualized_volatility)],
    ["Maximum drawdown", pct(market.max_drawdown)]
  ].map(([label, value]) =>
    '<div class="card"><small>' + esc(label) + '</small><strong>' + esc(value) + '</strong></div>'
  ).join("");

  const technicals = Object.fromEntries(Object.entries(data.technicals || {}).map(([key, value]) => [
    key, value == null ? null : fmt(value, 4)
  ]));
  $("technicals").innerHTML = rows(technicals);
  $("fundamentals").innerHTML = rows(data.fundamentals || {});

  const forecast = data.forecast || {};
  const model = data.model || {};
  $("forecast-summary").innerHTML = [
    ["Expected change", pct(forecast.expected_change_percent)],
    ["Horizon", (forecast.horizon ?? "—") + " trading days"],
    ["ARIMA order", Array.isArray(model.arima_order) ? model.arima_order.join(", ") : "—"]
  ].map(([label, value]) =>
    '<div class="card"><small>' + esc(label) + '</small><strong>' + esc(value) + '</strong></div>'
  ).join("");

  const metricRows = Object.entries(model.metrics || {}).map(([name, value]) =>
    '<tr><td>' + esc(name) + '</td><td>' + fmt(value.mae, 6) + '</td><td>' +
    fmt(value.rmse, 6) + '</td><td>' + fmt(value.directional_accuracy) + '%</td></tr>'
  ).join("");
  $("metrics").innerHTML =
    '<div class="table-wrap"><table><thead><tr><th>Model</th><th>MAE</th><th>RMSE</th><th>Directional accuracy</th></tr></thead><tbody>' +
    metricRows + '</tbody></table></div>';

  $("model-note").textContent =
    "ARIMA order: " + (Array.isArray(model.arima_order) ? model.arima_order.join(", ") : "—") +
    " · ADF p-value: " + fmt(model.adf_p_value, 6) +
    " · observations: " + fmt(model.observations, 0);

  const lightTheme = document.documentElement.dataset.theme === "light";
  const layout = {
    paper_bgcolor: "transparent",
    plot_bgcolor: "transparent",
    font: { color: lightTheme ? "#52627a" : "#aab8ce" },
    margin: { l: 55, r: 20, t: 15, b: 40 },
    xaxis: { gridcolor: lightTheme ? "#e5eaf1" : "#263650" },
    yaxis: { gridcolor: lightTheme ? "#e5eaf1" : "#263650" },
    hovermode: "x unified"
  };
  const history = data.history || { dates: [], close: [] };
  const dates = forecast.dates || [];
  const hybrid = forecast.hybrid || [];
  const arima = forecast.arima || [];
  const upper = forecast.upper || [];
  const lower = forecast.lower || [];

  Plotly.react("history", [{
    x: history.dates,
    y: history.close,
    type: "scatter",
    mode: "lines",
    line: { color: "#8aa5ff", width: 2 },
    name: "Adjusted close"
  }], layout, { responsive: true, displayModeBar: false });

  Plotly.react("forecast", [
    {
      x: history.dates.slice(-100),
      y: history.close.slice(-100),
      name: "History",
      type: "scatter",
      mode: "lines",
      line: { color: "#8aa5ff" }
    },
    {
      x: dates, y: hybrid, name: "ARIMA + SVR",
      type: "scatter", mode: "lines",
      line: { color: "#39c99a", width: 2 }
    },
    {
      x: dates, y: arima, name: "ARIMA",
      type: "scatter", mode: "lines",
      line: { color: "#e9b86b", dash: "dot" }
    },
    { x: dates, y: upper, type: "scatter", mode: "lines", line: { width: 0 }, showlegend: false },
    {
      x: dates, y: lower, type: "scatter", mode: "lines",
      line: { width: 0 }, fill: "tonexty",
      fillcolor: "rgba(57,201,154,.12)", showlegend: false
    }
  ], layout, { responsive: true, displayModeBar: false });
}

function renderScan(data) {
  const results = data.results || [];
  $("scan-meta").textContent =
    "Universe: " + fmt(data.universe_size, 0) +
    " stocks · " + fmt(data.eligible_after_fast_filter, 0) +
    " passed the fast filter · " + fmt(data.arima_svr_refined, 0) +
    " refined with ARIMA–SVR · " + results.length + " ranked results";

  const indexedStocks = [
    ...(marketFeed?.recommended || []),
    ...(marketFeed?.trending || []),
    ...(marketFeed?.popular || []),
    ...(marketFeed?.opportunities || []),
    ...(marketFeed?.smaller_companies || []),
  ];
  const indexedByTicker = new Map(indexedStocks.map(stock => [stock.ticker, stock]));
  $("scan-list").innerHTML = results.map(item =>
    stockCard({ ...(indexedByTicker.get(item.ticker) || {}), ...item })
  ).join("");
  $("scan-results").hidden = results.length === 0;
  bindStockButtons($("scan-list"));
  if (!results.length) $("scan-status").textContent = "The scan completed but could not produce valid refinements. Try again later.";
}

async function startScan(hard = false) {
  if (!config.supabaseUrl || !config.supabasePublishableKey) {
    $("scan-status").textContent = "Supabase is not configured. Add the project URL and publishable key to the app deployment variables.";
    return;
  }
  $("start-scan").disabled = true;
  $("hard-rescan").disabled = true;
  try {
    $("scan-status").textContent = hard
      ? "Requesting a fresh market scan…"
      : "Checking the shared eight-hour cache…";
    const request = await requestAnalysis(null, null, null, "scan", hard);
    trackJob({ id: request.id, ticker: "Market scan", type: "scan", status: request.status || "queued", progress: request.progress, stage: request.stage });
    $("scan-progress").hidden = false;
    let result;
    if (request.status === "completed" && request.cached) {
      const response = await fetch(api("analysis-status") + "?id=" + encodeURIComponent(request.id), {
        headers: { "apikey": config.supabasePublishableKey }
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "Could not retrieve cached scan.");
      result = data.result;
      updateProgress("scan", {
        status: "completed",
        progress: 100,
        stage: "Shared cached result · generated " + new Date(request.cache_created_at).toLocaleString()
      });
      $("scan-status").textContent = "Loaded the shared scan from cache. No new scan was run.";
    } else {
      $("scan-status").textContent = request.reused
        ? "A scan is already running. Joining its progress…"
        : "Scan queued. The previous completed results remain available while it runs.";
      result = await waitForResult(request.id, $("scan-status"), "scan");
      $("scan-status").textContent = "Market scan complete · " + (result.as_of || "");
    }
    renderScan(result);
    latestScanLoaded = false;
    latestScanId = request.id || latestScanId;
    loadMarketFeed(true);
  } catch (error) {
    $("scan-status").textContent = error.message;
  } finally {
    $("start-scan").disabled = false;
    $("hard-rescan").disabled = false;
  }
}

$("start-scan").addEventListener("click", () => startScan(false));
$("hard-rescan").addEventListener("click", () => startScan(true));

$("scan-source").addEventListener("change", () => {
  latestScanLoaded = false;
  latestScanId = null;
  if (currentScreen === "discover") loadLatestScan();
});

async function loadLatestScan() {
  if (latestScanLoaded || !config.supabaseUrl || !config.supabasePublishableKey) return;
  latestScanLoaded = true;
  try {
    $("scan-status").textContent = "Checking the latest shared background scan…";
    const request = await requestAnalysis(null, null, null, "scan", false, true);
    if (!request.found && !request.id) {
      $("scan-status").textContent = "No completed background scan is available for this source yet.";
      return;
    }
    const response = await fetch(api("analysis-status") + "?id=" + encodeURIComponent(request.id), {
      headers: { "apikey": config.supabasePublishableKey }
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "Could not retrieve the latest scan.");
    renderScan(data.result);
    latestScanId = request.id;
    updateProgress("scan", {
      status: "completed",
      progress: 100,
      stage: "Latest completed scan · " + new Date(request.cache_created_at).toLocaleString()
    });
    $("scan-status").textContent = "Showing the latest completed scan · " + new Date(request.cache_created_at).toLocaleString();
  } catch (error) {
    latestScanLoaded = false;
    $("scan-status").textContent = "Could not load the latest scan: " + error.message;
  }
}

async function refreshLatestScan() {
  if (currentScreen !== "discover" || latestScanRefreshBusy || !config.supabaseUrl || !config.supabasePublishableKey) return;
  latestScanRefreshBusy = true;
  try {
    const request = await requestAnalysis(null, null, null, "scan", false, true);
    if (request.id && request.id !== latestScanId) {
      const response = await fetch(api("analysis-status") + "?id=" + encodeURIComponent(request.id), {
        headers: { "apikey": config.supabasePublishableKey }
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || "Could not retrieve the updated scan.");
      renderScan(data.result);
      latestScanId = request.id;
      updateProgress("scan", {
        status: "completed",
        progress: 100,
        stage: "Updated background scan · " + new Date(request.cache_created_at).toLocaleString()
      });
      $("scan-status").textContent = "Updated with the latest shared scan · " + new Date(request.cache_created_at).toLocaleString();
      loadMarketFeed(true);
    }
  } catch (error) {
    $("scan-status").textContent = "Could not refresh the latest scan: " + error.message;
  } finally {
    latestScanRefreshBusy = false;
  }
}

const savedTheme = (() => {
  try { return localStorage.getItem("stock-analyser-theme") || "dark"; } catch { return "dark"; }
})();
applyTheme(savedTheme);
$("theme-toggle").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
});

const requestedTab = new URLSearchParams(window.location.search).get("tab");
switchScreen(["home", "search", "discover", "watchlist", "settings"].includes(requestedTab) ? requestedTab : "home");
initializeAuth();
setInterval(() => {
  if (currentScreen === "home" || currentScreen === "discover") loadMarketFeed(true);
  if (currentScreen === "watchlist") loadWatchlist(true);
  refreshLatestScan();
}, 60_000);
