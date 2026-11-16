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
