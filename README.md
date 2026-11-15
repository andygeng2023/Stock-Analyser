# Stock Analyser

A responsive stock research dashboard using Yahoo Finance data and a walk-forward-tested ARIMA, SVM, SVR and XGBoost forecasting ensemble.

## Production architecture

- **GitHub Pages** serves the static frontend.
- **Supabase Edge Functions** hosts the protected HTTPS API only. Supabase is not used as an application database.
- **TiDB Cloud PostgreSQL-compatible Starter** is the sole application database.
- **GitHub Actions** runs the analysis queue, PreviewIndex, FullIndex, WatchIndex, background scanning and cache maintenance workers. Workers connect directly to TiDB and hand off to successor runs before the runner time limit.
- **Yahoo Finance** supplies quotes, historical data and symbol search.

The browser calls the Edge Function using a public publishable key. TiDB credentials are stored only as Edge Function secrets and GitHub Actions secrets; they are never included in frontend JavaScript.

New index results use PreviewIndex and FullIndex. Legacy rapidIndex cache rows are left untouched and will age out through normal cache maintenance; they are not read by the new API.

## One-time API secret configuration

In the Supabase project **Stock-Analyser** (`nlaookgsiqojxejwvdsn`), open **Project Settings → Edge Functions → Secrets** and add these two secrets using the same values already configured in GitHub Actions:

- `DATABASE_URL`
- `TIDB_PASSWORD`

Do not paste either value into the repository or chat. The Edge Function accepts the TiDB PostgreSQL connection string (including the TiDB CLI `psql` format) and uses TLS.

The API health endpoint performs a real TiDB connection and verifies all eight required tables:

`https://nlaookgsiqojxejwvdsn.supabase.co/functions/v1/stock-analyser-api/api/health`

## GitHub Actions secrets

The background workers use:

- `DATABASE_URL`
- `TIDB_PASSWORD`

No Supabase database credentials or Cloudflare credentials are required by the workers.

## Background workers

- Analysis queue: every 5 minutes.
- PreviewIndex: every 6 hours, split across two workers; up to five years of daily history and a 10-model adaptive ensemble.
- FullIndex: every 6 hours on a staggered schedule, split across two workers; up to ten years of daily history and a 16-model adaptive ensemble.
- Background market scanning: every 6 hours.
- WatchIndex: every 6 hours.
- Cache cleanup: every 6 hours.

Each long-running worker uses a 5-hour-45-minute runtime and hands off to a successor before the GitHub runner's job timeout.

## Local development

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

## Forecasting and adaptive learning

PreviewIndex fits an adaptive ensemble of 10 regression models alongside ARIMA and a separate SVC directional classifier. FullIndex adds six complementary regression models and uses up to ten years of daily history. Both indexes score candidate models on a chronological holdout, reject weak or anomalous members, and adapt model weights using current holdout results plus a modest prior from deployment-wide shared model-performance memory.

The shared learning memory is global to the deployment and contains aggregate model metrics only; it does not contain account activity or personal information. Analyses update the relevant index profile as well as ticker-specific memory. The 70% directional-accuracy figure is a target, not a guarantee. Only measured out-of-sample results are reported. Forecasts are estimates, not guarantees of future performance.

For research and education only. Not investment advice.
