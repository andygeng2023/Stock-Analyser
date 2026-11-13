# Stock Analyser

A responsive stock research dashboard using Yahoo Finance data and a walk-forward-tested ARIMA, SVM, SVR and XGBoost forecasting ensemble.

## Architecture

- **GitHub Pages** hosts the static dashboard.
- **Cloudflare Workers** provides the public API, authentication and request handling.
- **Cloudflare D1 (SQLite)** stores analysis jobs, RapidIndex/SlowIndex results, the market catalogue, accounts, sessions and watchlists.
- **GitHub Actions** runs the Python analysis worker, scheduled market indexing and WatchIndex.
- **Yahoo Finance** supplies quotes, historical data and symbol search.

Supabase is no longer part of the runtime architecture. The Worker uses a D1 binding; Python workers use a narrowly scoped internal API protected by a shared secret. The public frontend never receives that secret.

## Cloudflare resources

The migration branch is configured for:

- D1 database: `stock-analyser` (EU jurisdiction).
- Worker: `stock-analyser-api`.
- Worker URL: `https://stock-analyser-api.stock-analyser-2026.workers.dev`.

The D1 schema is maintained in `cloudflare/schema.sql`; the deployed API source is `cloudflare/worker.js`.

## Required configuration

Set these values before deploying the application:

1. In Cloudflare → Workers & Pages → `stock-analyser-api` → Settings → Variables and Secrets, add a secret named `ADMIN_API_TOKEN`. Use a newly generated, high-entropy random value (at least 32 random bytes).
2. In GitHub → repository Settings → Secrets and variables → Actions → Secrets, add `CLOUDFLARE_ADMIN_API_TOKEN` with exactly the same value.
3. Merge the migration branch into `main`. GitHub Pages and the scheduled workflows already contain the public Cloudflare API URL; no URL variable is required.

The `CLOUDFLARE_ADMIN_API_TOKEN` value is an application-to-application shared secret, not a Cloudflare account API token. Do not put it in frontend configuration or commit it to the repository.

## Zero-cost account limitations

The replacement account system stores salted PBKDF2 password hashes and hashed session tokens in D1. Sessions expire after 30 days. Users can sign up, sign in, change their password, update their display name and sign out sessions.

There is no transactional email provider in this zero-cost setup. Consequently, email verification, password-reset emails and email-address changes are unavailable. Users should keep access to their account and change their password while signed in. Do not use a password that is important elsewhere.

## Data migration

The new D1 database is currently initialised with an empty schema. The previous Supabase project was reporting exhausted egress/database connectivity errors, so existing indexed results, user accounts and watchlists have not been transferred. Once Supabase data becomes readable, a separate export/import can recover compatible records. Otherwise RapidIndex and SlowIndex will repopulate through the scheduled indexers, and users will need to recreate accounts and watchlists.

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
