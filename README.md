# Stock Analyser

A responsive stock research dashboard using Yahoo Finance data and a walk-forward-tested ARIMA, SVM, SVR and XGBoost forecasting ensemble.

## Runtime architecture

- **GitHub Pages** serves the static frontend.
- **TiDB Cloud PostgreSQL-compatible Starter** is the target primary database.
- **GitHub Actions** runs the Python analysis, RapidIndex, SlowIndex, WatchIndex and background-scanning workers. These workers connect directly to TiDB using the `DATABASE_URL` repository secret.
- **The existing Cloudflare Worker** is still the website's HTTP API during the migration. Its D1 database remains the source for the one-time export until the API itself has been switched to TiDB. D1 has not yet been retired.
- **Yahoo Finance** supplies quotes, historical data and symbol search.

There is no Vercel deployment in this architecture.

## TiDB migration status

The worker code now uses direct PostgreSQL connections to TiDB. The one-time migration workflow creates the TiDB schema and copies the existing D1 records without deleting the source.

Before running **Migrate existing data to TiDB**, configure these GitHub Actions secrets:

- `DATABASE_URL`: the actual PostgreSQL connection string from TiDB Cloud. Use the connection string itself, not the surrounding `psql` command. Replace any example database placeholder with the real database name.
- `CLOUDFLARE_ADMIN_API_TOKEN`: the temporary token used only to export existing D1 records.

The migration must complete and its row counts must be verified before the website API is switched. The indexing workers are manual-dispatch only until that switch is complete, so they do not write to a database the website is not yet using.

## Indexing profiles

- **RapidIndex** indexes five years of price history and a 30-trading-day forecast.
- **SlowIndex** indexes the maximum available history and a 252-trading-day forecast.
- Detailed stock analysis and Hard rerun use these same profiles. Custom reruns can select a different history period, forecast horizon (up to 504 trading days), and independent save destination.
- Results are cached separately by ticker, history period, forecast horizon, and destination indexer.

## Accounts and Watchlist

Watchlists are scoped to authenticated accounts. The TiDB schema includes users, sessions and watchlist records. The website API still needs to be migrated before the new TiDB-backed watchlist path can be considered live.

## Local Python server

For local development only:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

## Model

The forecasting system combines four components:

- **ARIMA** models daily log returns and supplies the statistical time-series baseline.
- **SVC (Support Vector Classification)** predicts the next session's direction.
- **SVR (Support Vector Regression)** estimates nonlinear corrections to ARIMA residuals and also predicts returns directly.
- **XGBoost** independently estimates next-session returns from lagged returns, volatility, RSI, MACD, volume changes and residual lags.

The primary continuous-return ensemble is a fixed 50/50 blend of the ARIMA+SVR estimate and XGBoost estimate. Additional comparison blends include ARIMA+XGBoost, SVR+XGBoost and an equal-weight all-model hybrid. SVC supplies a separate directional classification and is evaluated independently; it is not treated as a continuous price regressor.

Validation uses a chronological holdout with expanding-window, one-step-ahead ARIMA forecasts. The other models are fitted only on observations before the holdout and evaluated on the later window. Reported backtests are historical out-of-sample evaluations, not guarantees of future performance.

Yahoo Finance data can be delayed, incomplete or rate-limited. GitHub Actions schedules are not real-time and can be delayed by GitHub.

For research and education only. Not investment advice.
