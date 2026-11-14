# Stock Analyser

A responsive stock research dashboard using Yahoo Finance data and a walk-forward-tested ARIMA, SVM, SVR and XGBoost forecasting ensemble.

## Production architecture

- **GitHub Pages** serves the static frontend.
- **Supabase Edge Functions** hosts the protected HTTPS API only. Supabase is not used as an application database.
- **TiDB Cloud PostgreSQL-compatible Starter** is the sole application database.
- **GitHub Actions** runs analysis, RapidIndex, SlowIndex, WatchIndex, background scanning and cache maintenance workers. Workers connect directly to TiDB and hand off to successor runs before the runner time limit.
- **Yahoo Finance** supplies quotes, historical data and symbol search.

The browser calls the Edge Function using a public publishable key. TiDB credentials are stored only as Edge Function secrets and GitHub Actions secrets; they are never included in frontend JavaScript.

No old indexed stock data is migrated. The TiDB schema is created cleanly and indexes are rebuilt from Yahoo Finance.

## One-time API secret configuration

In the Supabase project **Stock-Analyser** (`dwhhdwdgoamzcsehuhiq`), open **Project Settings → Edge Functions → Secrets** and add these two secrets using the same values already configured in GitHub Actions:

- `DATABASE_URL`
- `TIDB_PASSWORD`

Do not paste either value into the repository or chat. The Edge Function accepts the TiDB PostgreSQL connection string (including the TiDB CLI `psql` format) and uses TLS.

The API health endpoint performs a real TiDB connection and verifies all seven required tables:

`https://dwhhdwdgoamzcsehuhiq.supabase.co/functions/v1/stock-analyser-api/api/health`

## GitHub Actions secrets

The background workers use:

- `DATABASE_URL`
- `TIDB_PASSWORD`

No Supabase database credentials or Cloudflare credentials are required by the workers.

## Background workers

- Analysis queue: every 5 minutes.
- RapidIndex and SlowIndex: every 6 hours, split across four workers.
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

## Forecasting model

The forecasting system combines ARIMA, SVC, SVR and XGBoost. The primary continuous-return ensemble is a fixed 50/50 blend of the ARIMA+SVR estimate and XGBoost estimate. SVC supplies a separate directional classification.

Validation uses chronological out-of-sample testing. Forecasts are estimates, not guarantees of future performance.

For research and education only. Not investment advice.
