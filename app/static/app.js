const $ = id => document.getElementById(id);
const config = window.STOCK_ANALYSER_CONFIG || {};
const fmt = (v, d = 2) => v == null || !Number.isFinite(Number(v)) ? "—" : Number(v).toLocaleString(undefined, { maximumFractionDigits: d });
const pct = v => v == null || !Number.isFinite(Number(v)) ? "—" : (Number(v) > 0 ? "+" : "") + fmt(v) + "%";
const cash = (v, c) => v == null || !Number.isFinite(Number(v)) ? "—" : new Intl.NumberFormat(undefined, { style: "currency", currency: c || "USD", maximumFractionDigits: 2 }).format(Number(v));
const esc = s => String(s ?? "—").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = name => config.supabaseUrl.replace(/\/$/, "") + "/functions/v1/" + name;
const headers = () => ({ "Content-Type": "application/json", "apikey": config.supabasePublishableKey });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

let currentScreen = "home";
let currentTab = "home";
let detailReturnScreen = "home";
let marketFeed = null;
let marketFeedLoadedAt = 0;
let marketFeedLoading = false;
let marketFeedRefreshQueued = false;
let latestScanId = null;
let latestScanLoaded = false;
let latestScanRefreshBusy = false;

const QUEUE_KEY = "stock-analyser-active-jobs";
let trackedJobs = loadTrackedJobs();
let queueRefreshBusy = false;

function loadTrackedJobs() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); }
  catch { return []; }
}
function saveTrackedJobs() {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(trackedJobs.slice(0, 30))); } catch {}
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
  if (["completed", "failed"].includes(item.status)) item.finishedAt = Date.now();
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
    const active = trackedJobs.filter(job => !["completed", "failed"].includes(job.status));
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
$("global-queue-toggle")?.addEventListener("click", () => {
  $("global-queue-popover").hidden = !$("global-queue-popover").hidden;
});
document.addEventListener("click", event => {
  if (!event.target.closest(".global-queue")) $("global-queue-popover").hidden = true;
});
renderGlobalQueue();


function rows(obj) {
  return Object.entries(obj || {}).map(([k, v]) =>
    '<div class="row"><span>' + esc(k.replaceAll("_", " ")) + '</span><strong>' +
    esc(v == null ? "—" : v) + '</strong></div>'
  ).join("");
}

async function requestAnalysis(ticker, period, horizon, mode = "analysis", hardRescan = false, latestOnly = false) {
  const payload = mode === "scan"
    ? { mode: "scan", source: $("scan-source").value, hard_rescan: hardRescan, latest_only: latestOnly }
    : { ticker, period, horizon, hard_rescan: hardRescan };
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
  const started = Date.now();
  while (Date.now() - started < 15 * 60 * 1000) {
    const response = await fetch(api("analysis-status") + "?id=" + encodeURIComponent(id), {
      headers: { "apikey": config.supabasePublishableKey }
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "Could not retrieve analysis status.");
    updateProgress(prefix, data);\n    updateTrackedJob(id, data);
    if (data.status === "completed") return data.result;
    if (data.status === "failed") throw Error(data.error || "The analysis failed.");
    statusElement.textContent = data.status === "running"
      ? "The worker is processing this job…"
      : "Queued; waiting for the shared GitHub Actions worker…";
    await wait(2500);
  }
  throw Error("This analysis is taking longer than expected. Its job may still finish; try again later.");
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
  ["home", "search", "discover", "detail"].forEach(name => {
    $(name + "-screen").hidden = name !== screen;
  });
  document.body.classList.toggle("detail-mode", screen === "detail");

  $("nav-home").classList.toggle("active", currentTab === "home");
  $("nav-search").classList.toggle("active", currentTab === "search");
  $("nav-discover").classList.toggle("active", currentTab === "discover");
  ["home", "search", "discover"].forEach(name => {
    const button = $("nav-" + name);
    if (currentTab === name) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  window.scrollTo({ top: 0, behavior: "instant" });
  if (screen === "home" || screen === "search" || screen === "discover") loadMarketFeed();
  if (screen === "discover") loadLatestScan();
}

$("nav-home").addEventListener("click", () => switchScreen("home"));
$("nav-search").addEventListener("click", () => switchScreen("search"));
$("nav-discover").addEventListener("click", () => switchScreen("discover"));
$("detail-back").addEventListener("click", () => switchScreen(detailReturnScreen || currentTab));

$("quick-search").addEventListener("submit", event => {
  event.preventDefault();
  const symbol = $("quick-ticker").value.trim().toUpperCase();
  if (!symbol) return;
  $("ticker").value = symbol;
  switchScreen("search");
  $("ticker").focus();
});

async function openStockDetails(ticker, options = {}) {
  const symbol = String(ticker || "").trim().toUpperCase();
  if (!symbol) return;
  if (!config.supabaseUrl || !config.supabasePublishableKey) {
    switchScreen("detail");
    $("detail-status").textContent = "Supabase is not configured. Add the project URL and publishable key to the app deployment variables.";
    return;
  }

  detailReturnScreen = options.returnScreen || (currentScreen === "detail" ? detailReturnScreen : currentScreen);
  $("ticker").value = symbol;
  $("period").value = options.period || "5y";
  $("horizon").value = String(options.horizon || 30);
  switchScreen("detail");

  $("results").hidden = true;
  $("search-progress").hidden = true;
  $("detail-status").textContent = "Preparing analysis for " + symbol + "…";
  $("submit").disabled = true;
  $("hard-rescan-search").disabled = true;

  try {
    const request = await requestAnalysis(
      symbol,
      $("period").value,
      Number($("horizon").value),
      "analysis",
      options.hardRescan === true
    );
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
    $("submit").disabled = false;
    $("hard-rescan-search").disabled = false;
  }
}

$("search").addEventListener("submit", event => {
  event.preventDefault();
  openStockDetails($("ticker").value.trim().toUpperCase(), {
    returnScreen: "search",
    period: $("period").value,
    horizon: Number($("horizon").value),
    hardRescan: event.submitter?.id === "hard-rescan-search"
  });
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

  const layout = {
    paper_bgcolor: "transparent",
    plot_bgcolor: "transparent",
    font: { color: "#aab8ce" },
    margin: { l: 55, r: 20, t: 15, b: 40 },
    xaxis: { gridcolor: "#263650" },
    yaxis: { gridcolor: "#263650" },
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
    const request = await requestAnalysis(null, null, null, "scan", hard);\n    trackJob({ id: request.id, ticker: "Market scan", type: "scan", status: request.status || "queued", progress: request.progress, stage: request.stage });
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

switchScreen("home");
setInterval(() => {
  if (currentScreen === "home" || currentScreen === "discover") loadMarketFeed(true);
  refreshLatestScan();
}, 60_000);
