import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const appSource = readFileSync(new URL("../app/static/app.js", import.meta.url), "utf8");
const renderStart = appSource.indexOf("function render(data) {");
const renderEnd = appSource.indexOf("\nfunction renderScan(data)", renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart, "The detail render function must exist.");
const renderSource = appSource.slice(renderStart, renderEnd);

function makeSampleAnalysis() {
  return {
    ticker: "TEST",
    company: "Test Company",
    exchange: "TEST",
    currency: "USD",
    price: 101.25,
    change_percent: 1.2,
    market_summary: {
      return_1m: 2.1,
      return_1y: 8.4,
      annualized_volatility: 24,
      max_drawdown: -12
    },
    technicals: { rsi_14: 52.1, sma_20: 99.2 },
    fundamentals: { sector: "Technology" },
    history: {
      dates: ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06"],
      close: [98, 99, 100, 101]
    },
    forecast: {
      horizon: 30,
      dates: ["2026-10-07", "2026-10-08", "2026-10-09"],
      hybrid: [101.5, 102.1, 103.2],
      upper: [102, 103, 104],
      lower: [100.5, 101, 102],
      components: { ridge: [101.4, 102, 103] },
      expected_change_percent: 2.1
    },
    model: {
      model_version: "adaptive-ensemble-v4",
      model_family: "ARIMA + adaptive ML ensemble",
      arima_order: [1, 1, 1],
      adf_p_value: 0.02,
      observations: 1200,
      learning_state: { analyses_seen: 12 },
      ensemble: {
        method: "adaptive robust blend",
        candidate_count: 29,
        average_active_models_per_step: 8.5,
        architecture: {
          original_models: 15,
          first_order_hybrids: 10,
          hybrids_of_hybrids: 3
        },
        weights: { ridge: 0.65 },
        forecast_dynamic_rejections: { ridge: 0 }
      },
      metrics: {
        backtest: {
          method: "Chronological holdout",
          observations: 40,
          start: "2026-08-01",
          end: "2026-09-30",
          test_accuracy: 62.5,
          ensemble: { directional_accuracy: 62.5, mae: 0.2, rmse: 0.3 }
        },
        model_assessment: {
          ridge: { directional_accuracy: 62.5, rmse: 0.3, anomaly_rate: 0.01 }
        },
        models: {
          ridge: { directional_accuracy: 62.5, mae: 0.2, rmse: 0.3 }
        },
        hybrid: { directional_accuracy: 62.5, mae: 0.2, rmse: 0.3 }
      }
    }
  };
}

test("detail render draws populated history and adaptive forecast charts", () => {
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) {
      elements.set(id, { id, innerHTML: "", textContent: "", hidden: false, style: {} });
    }
    return elements.get(id);
  };
  const plots = [];
  const context = {
    $: getElement,
    cash: value => value == null ? "—" : "$" + Number(value).toFixed(2),
    pct: value => value == null ? "—" : Number(value).toFixed(2) + "%",
    fmt: (value, digits = 2) => value == null || !Number.isFinite(Number(value))
      ? "—" : Number(value).toFixed(digits),
    esc: value => String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[char])),
    rows: object => Object.entries(object || {}).map(([key, value]) =>
      "<div>" + key + ": " + String(value ?? "—") + "</div>").join(""),
    Plotly: {
      react: (...args) => { plots.push(args); return Promise.resolve(); }
    },
    document: { documentElement: { dataset: { theme: "dark" } } },
    console,
    Intl,
    Date,
    Math,
    Number,
    Object,
    Array,
    String
  };
  vm.createContext(context);
  vm.runInContext(renderSource + "\nglobalThis.__renderDetail = render;", context);
  assert.doesNotThrow(() => context.__renderDetail(makeSampleAnalysis()));

  assert.equal(plots.length, 2, "Both history and forecast graphs must be rendered.");
  assert.equal(plots[0][0], "history");
  assert.equal(plots[1][0], "forecast");
  assert.deepEqual(Array.from(plots[0][1][0].y), [98, 99, 100, 101]);
  const forecastTraces = plots[1][1];
  const primary = forecastTraces.find(trace => trace.name === "Primary adaptive hybrid forecast");
  const component = forecastTraces.find(trace => String(trace.name).startsWith("Ridge"));
  assert.ok(primary, "The primary hybrid prediction must be plotted.");
  assert.deepEqual(Array.from(primary.y), [101.5, 102.1, 103.2]);
  assert.ok(component, "At least one selected model component must be plotted.");
  assert.deepEqual(Array.from(component.y), [101.4, 102, 103]);
});

test("queue and detail navigation retain the complete lifecycle", () => {
  assert.match(appSource, /TERMINAL_JOB_RETENTION_MS = 3 \* 60 \* 1000/);
  assert.match(appSource, /Date\.now\(\) \+ 6 \* 60 \* 60 \* 1000/);
  assert.match(appSource, /detailRequestSequence/);
  assert.match(appSource, /data-job-indexer/);
});

test("market-card refresh never fans out one analysis request per visible card", () => {
  assert.doesNotMatch(
    appSource,
    /requestAnalysis\(ticker,\s*["']5y["'],\s*30,\s*["']analysis["'],\s*false,\s*false,\s*["']previewIndex["']\)/
  );
});


test("queue tracker initialises safely and keeps completed progress visible", () => {
  const queueStart = appSource.indexOf('const QUEUE_KEY = "stock-analyser-active-jobs";');
  const queueEnd = appSource.indexOf("\n\nfunction rows(obj)", queueStart);
  assert.ok(queueStart >= 0 && queueEnd > queueStart, "The global queue module must exist.");
  const queueSource = appSource.slice(queueStart, queueEnd);
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, hidden: true, textContent: "", innerHTML: "",
        classList: { toggle() {} },
        setAttribute() {},
        querySelectorAll() { return []; }
      });
    }
    return elements.get(id);
  };
  const storage = new Map();
  const context = {
    config: { apiBaseUrl: "" },
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value)
    },
    document: { addEventListener() {} },
    Element: class Element {},
    setInterval() {},
    $: getElement,
    esc: value => String(value ?? ""),
    console
  };
  vm.createContext(context);
  vm.runInContext(
    queueSource + "\nglobalThis.__queue = { trackJob, updateTrackedJob, getJobs: () => trackedJobs };",
    context
  );
  context.__queue.trackJob({
    id: "job-1", ticker: "AAPL", type: "analysis", status: "queued",
    progress: 0, stage: "Waiting for a worker"
  });
  context.__queue.updateTrackedJob("job-1", {
    status: "running", progress: 38, stage: "Fitting models"
  });
  let jobs = Array.from(context.__queue.getJobs());
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "running");
  assert.equal(jobs[0].progress, 38);
  context.__queue.updateTrackedJob("job-1", {
    status: "completed", progress: 100, stage: "Complete"
  });
  jobs = Array.from(context.__queue.getJobs());
  assert.equal(jobs.length, 1, "Completed jobs should remain in recent requests.");
  assert.equal(jobs[0].status, "completed");
  assert.equal(jobs[0].progress, 100);
  assert.ok(Number.isFinite(jobs[0].finishedAt));
  assert.ok(storage.has("stock-analyser-active-jobs"));
});


test("detail charts use an SVG fallback when Plotly is missing", () => {
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, {
      id, innerHTML: "", textContent: "", hidden: false, style: {}
    });
    return elements.get(id);
  };
  const context = {
    $: getElement,
    cash: value => value == null ? "—" : "$" + Number(value).toFixed(2),
    pct: value => value == null ? "—" : Number(value).toFixed(2) + "%",
    fmt: (value, digits = 2) => value == null || !Number.isFinite(Number(value))
      ? "—" : Number(value).toFixed(digits),
    esc: value => String(value ?? ""),
    rows: object => Object.entries(object || {}).map(([key, value]) => key + ": " + String(value ?? "—")).join(", "),
    document: { documentElement: { dataset: { theme: "dark" } } },
    console: { warn() {} },
    Date,
    Math,
    Number,
    Object,
    Array,
    String,
    Promise
  };
  vm.createContext(context);
  vm.runInContext(renderSource + "\nglobalThis.__renderDetail = render;", context);
  context.__renderDetail(makeSampleAnalysis());
  assert.match(getElement("history").innerHTML, /<svg class="chart-fallback"/);
  assert.match(getElement("forecast").innerHTML, /<svg class="chart-fallback"/);
  assert.match(getElement("forecast").innerHTML, /Primary adaptive hybrid forecast/);
});

test("index selector keeps both choices available and marks the active one", () => {
  const start = appSource.indexOf("function showIndexAvailability(");
  const end = appSource.indexOf("\nasync function runStockDetails", start);
  assert.ok(start >= 0 && end > start);
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, { hidden: true, innerHTML: "", textContent: "" });
    return elements.get(id);
  };
  const context = {
    availableIndexOptions: [],
    selectedIndexId: "",
    $: getElement,
    esc: value => String(value ?? "")
  };
  vm.createContext(context);
  vm.runInContext(
    "let availableIndexOptions = []; let selectedIndexId = '';\n" +
    appSource.slice(start, end) +
    "\nglobalThis.__showAvailability = showIndexAvailability;",
    context
  );
  const choices = [
    { id: "previewIndex", label: "PreviewIndex" },
    { id: "FullIndex", label: "FullIndex" }
  ];
  context.__showAvailability(choices);
  assert.equal(getElement("detail-index-choice-controls").hidden, false);
  assert.equal((getElement("detail-index-choice-controls").innerHTML.match(/data-index-choice=/g) || []).length, 2);
  context.__showAvailability(choices, "selected", "FullIndex");
  assert.equal(getElement("detail-index-choice-title").textContent, "Using FullIndex");
  const buttons = getElement("detail-index-choice-controls").innerHTML;
  assert.match(buttons, /data-index-choice="FullIndex" aria-pressed="true"/);
  assert.match(buttons, /data-index-choice="previewIndex" aria-pressed="false"/);
});

test("home-card sparkline draws historical data without a forecast", () => {
  const start = appSource.indexOf("function stockSparkline(stock) {");
  const end = appSource.indexOf("\nfunction riskLabelMarkup", start);
  assert.ok(start >= 0 && end > start);
  const context = { Math, Number };
  vm.createContext(context);
  vm.runInContext(appSource.slice(start, end) + "\nglobalThis.__sparkline = stockSparkline;", context);
  const svg = context.__sparkline({
    history_preview: [98, 99, 100, 101],
    forecast_preview: []
  });
  assert.match(svg, /<svg class="stock-sparkline"/);
  assert.match(svg, /stock-history-line/);
});
