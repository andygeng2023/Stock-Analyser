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
    updateProgress(prefix, data);
    if (data.status === "completed") return data.result;
    if (data.status === "failed") throw Error(data.error || "The analysis failed.");
    statusElement.textContent = data.status === "running"
      ? "The worker is processing this job…"
      : "Queued; waiting for the shared GitHub Actions worker…";
    await wait(2500);
  }
  throw Error("This analysis is taking longer than expected. Its job may still finish; try again later.");
}

function metricValue(stock) {
  if (stock.return_1m != null) return { label: "1m", value: pct(stock.return_1m) };
  if (stock.expected_change_percent != null) return { label: "Model", value: pct(stock.expected_change_percent) };
  return { label: "Day", value: pct(stock.change_percent) };
}

function stockCard(stock, tag = "") {
  const metric = metricValue(stock);
  const negative = String(metric.value).startsWith("-");
  const company = stock.company || stock.ticker;
  return `
    <button type="button" class="stock-card" data-ticker="${esc(stock.ticker)}">
      <span class="stock-card-top">
        <span class="stock-card-name"><strong>${esc(company)}</strong><span>${esc(stock.ticker)} · ${esc(stock.sector || stock.exchange || "Listed stock")}</span></span>
        ${tag ? '<span class="stock-card-tag">' + esc(tag) + '</span>' : ""}
      </span>
      <span class="stock-card-bottom"><strong class="stock-price">${esc(cash(stock.price, stock.currency))}</strong><span class="stock-metric ${negative ? "negative" : ""}">${esc(metric.value)} <span class="stock-ticker">${esc(metric.label)}</span></span></span>
      <span class="stock-card-foot"><span>${stock.market_cap ? "Market cap " + esc(compactMoney(stock.market_cap)) : esc(stock.industry || "Open analysis")}</span><span>View analysis →</span></span>
    </button>`;
}

function compactMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e12) return "$" + fmt(n / 1e12, 1) + "T";
  if (n >= 1e9) return "$" + fmt(n / 1e9, 1) + "B";
  if (n >= 1e6) return "$" + fmt(n / 1e6, 0) + "M";
  return "$" + fmt(n, 0);
}

function compactStock(stock) {
  const metric = metricValue(stock);
  const negative = String(metric.value).startsWith("-");
  return `
    <button type="button" class="compact-stock" data-ticker="${esc(stock.ticker)}">
      <span class="compact-main"><strong>${esc(stock.company || stock.ticker)}</strong><span>${esc(stock.ticker)} · ${esc(stock.exchange || stock.sector || "Listed stock")}</span></span>
      <span class="compact-price">${esc(cash(stock.price, stock.currency))}</span>
      <span class="compact-return ${negative ? "negative" : ""}">${esc(metric.value)}</span>
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
  root.innerHTML = stocks.map(stock => stockCard(stock, tag)).join("");
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
    ? latest.slice(0, 6).map(compactStock).join("")
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

  $("scan-list").innerHTML = results.map((item, index) => `
    <article class="scan-result">
      <div>
        <h3>${index + 1}. ${esc(item.company)} <span class="muted">(${esc(item.ticker)})</span></h3>
        <p>${esc(item.exchange || "Listed equity")} · Price ${esc(cash(item.price, item.currency))} · Daily move ${esc(pct(item.change_percent))}<br>
        Validation directional accuracy: ${esc(fmt(item.directional_accuracy))}%</p>
      </div>
      <div class="scan-return"><strong>${esc(pct(item.expected_change_percent))}</strong><small>30-day model estimate</small>
        <button type="button" data-ticker="${esc(item.ticker)}">Detailed view</button>
      </div>
    </article>`
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
