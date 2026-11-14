# Stock Analyser

A responsive stock research dashboard using Yahoo Finance data and a walk-forward-tested ARIMA, SVM, SVR and XGBoost forecasting ensemble.


## Architecture

- **GitHub Pages** hosts the static dashboard.
- **Vercel Functions** hosts the HTTPS API. It keeps the database URL and admin token server-side.
- **TiDB Cloud PostgreSQL-compatible Starter** stores accounts, sessions, analysis jobs, market indexes, the catalogue, rate limits and watchlists.
- **GitHub Actions** runs the Python analysis and maintenance workers, connecting to the API and TiDB-backed queue.
- **Yahoo Finance** supplies quotes, historical data and symbol search.

Cloudflare D1 is retained only as the temporary source for the one-time migration. It is not used by the new runtime.

## Required configuration

1. Create a Vercel project by importing this GitHub repository. Use the repository root and the default Node.js runtime. The API is provided by `api/[...path].js`.
2. In Vercel Project Settings → Environment Variables, add:
   - `DATABASE_URL`: the PostgreSQL connection string from TiDB Cloud.
   - `ADMIN_API_TOKEN`: a new high-entropy secret. Use the same value in GitHub Actions; do not commit it or put it in frontend configuration.
3. In GitHub repository Settings → Secrets and variables → Actions → Secrets, add:
   - `DATABASE_URL`: the same TiDB PostgreSQL connection string.
   - `ADMIN_API_TOKEN`: the same application admin secret configured in Vercel.
   - Keep `CLOUDFLARE_ADMIN_API_TOKEN` temporarily; it is used only by the one-time D1 export workflow.
4. In GitHub repository Settings → Secrets and variables → Actions → Variables, add `STOCK_ANALYSER_API_URL` with the production Vercel URL (for example, `https://stock-analyser-api.vercel.app`, without a trailing slash).
5. Run the **Migrate existing data to TiDB** workflow from the Actions tab. It is safe to rerun: rows are upserted, not duplicated.
6. After the API and data migration have been verified, the D1 export secret and old Cloudflare Worker can be retired.

The API is deployed automatically when Vercel is connected to this repository. GitHub Pages remains the frontend host. Do not expose `DATABASE_URL` or `ADMIN_API_TOKEN` in the browser.

## Indexing profiles

- **RapidIndex** indexes five years of price history and a 30-trading-day forecast.
- **SlowIndex** indexes the maximum available history and a 252-trading-day forecast.
- Detailed stock analysis and Hard rerun use these same profiles. Custom reruns can select a different history period, forecast horizon (up to 504 trading days), and independent save destination.
- Results are cached separately by ticker, history period, forecast horizon, and destination indexer.

## Accounts, Watchlist and WatchIndex

Watchlists are stored in D1 and are scoped to the authenticated account. WatchIndex reads all distinct watchlist tickers, skips tickers with a RapidIndex result from the previous six hours, and writes newly computed results to the shared RapidIndex cache.

## Local Python server

For local development only:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

The local FastAPI server is separate from the deployed Cloudflare API. API documentation: `/docs`.

## Model

The forecasting system combines four components:

- **ARIMA** models daily log returns and supplies the statistical time-series baseline.
- **SVC (Support Vector Classification)** predicts the next session's direction.
- **SVR (Support Vector Regression)** estimates nonlinear corrections to ARIMA residuals and also predicts returns directly.
- **XGBoost** independently estimates next-session returns from lagged returns, volatility, RSI, MACD, volume changes and residual lags.

The primary continuous-return ensemble is a fixed 50/50 blend of the ARIMA+SVR estimate and XGBoost estimate. Additional comparison blends include ARIMA+XGBoost, SVR+XGBoost and an equal-weight all-model hybrid. SVC supplies a separate directional classification and is evaluated independently; it is not treated as a continuous price regressor.

Validation uses a chronological holdout with expanding-window, one-step-ahead ARIMA forecasts. The other models are fitted only on observations before the holdout and evaluated on the later window. Reported backtests are historical out-of-sample evaluations, not guarantees of future performance.

## Free-tier limits and reliability

Cloudflare Free has daily D1 row-read and row-write limits and a finite database storage allowance. The application uses bounded queries, indexed filters and scheduled batches, but a large indexing universe or unusually high traffic can exhaust those limits. When a free-tier limit is reached, D1 queries can fail until the daily reset. Monitor D1 row metrics in the Cloudflare dashboard.

Yahoo Finance data can be delayed, incomplete or rate-limited. GitHub Actions schedules are not real-time and can be delayed by GitHub.

For research and education only. Not investment advice.
