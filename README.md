# Stock Analyser

A responsive stock research dashboard using Yahoo Finance data and a Python ARIMA–SVR hybrid forecasting model.

## Architecture

- **GitHub Pages** serves the static dashboard.
- **Supabase Edge Functions** validate requests, apply basic rate limiting, queue jobs and return job status.
- **GitHub Actions** runs the Python worker on demand using `yfinance`, pandas, statsmodels and scikit-learn.
- **Supabase PostgreSQL** stores queued jobs and completed analysis JSON.
- **Supabase Auth + PostgreSQL** provides email accounts, secure per-user watchlists and the shared RapidIndex cache.

This avoids requiring a continuously running Python server while retaining the actual Python `yfinance` package and scientific Python stack.

## Setup

See [Supabase setup instructions](supabase/README.md). The database schema is in `supabase/setup.sql`.

1. Create a dedicated Supabase project and run the SQL setup script.
2. Deploy `request-analysis`, `analysis-status` and `watchlist` Edge Functions.
3. Set Supabase Edge Function secrets and GitHub Actions secrets as documented.
4. Add GitHub Actions repository variables `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`.
5. Set GitHub Pages → Build and deployment → Source to **GitHub Actions**.
6. Merge to `main`; the Pages workflow publishes the frontend. The analysis workflow is triggered for each accepted ticker request.

The repository is public. GitHub documents standard hosted runner usage as free for public repositories. Private repositories instead use the account's included Actions quota and may incur charges if exceeded.

## Indexing profiles

- **rapidIndex** indexes five years of price history and a 30-trading-day forecast.
- **SlowIndex** indexes the maximum available history and a 252-trading-day (approximately one-year) forecast.
- Detailed stock analysis and Hard rerun use these same profiles. Custom reruns can select a different history period, forecast horizon (up to 504 trading days), and independent save destination.
- Results are cached separately by ticker, history period, forecast horizon, and destination indexer, so custom results cannot overwrite RapidIndex or SlowIndex entries.

## Accounts, Watchlist and WatchIndex

Email/password accounts are provided by Supabase Auth. A user's watchlist is stored in `public.watchlist_items` in the same Supabase PostgreSQL project, keyed to `auth.users.id` and protected by row-level security. Users can sign up, confirm their email, sign in, reset their password and sign out. The same account can access its watchlist across browsers and devices.

The `watch-index.yml` workflow keeps one WatchIndex worker active. It reads all distinct tickers from all authenticated users' watchlists, skips any ticker already indexed by RapidIndex in the previous six hours, and writes newly computed results to the shared RapidIndex cache. No separate SQLite/Turso service is used.

See [Supabase setup instructions](supabase/README.md#email-authentication-and-watchlist).

## Local Python server

For local development only:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Open http://127.0.0.1:8000. API documentation: /docs.

## Model

ARIMA models daily log returns. An RBF-kernel Support Vector Regressor models nonlinear ARIMA residual corrections using lagged returns, rolling volatility, RSI, MACD, volume changes and residual lags. The forecast combines the ARIMA return estimate with the SVR residual correction.

Validation is chronological. Forecast bands are approximate residual-dispersion bands, not calibrated prediction intervals. Business-day offsets do not account for exchange holidays. Yahoo Finance data can be delayed, incomplete or rate-limited.

## Security

Never put the Supabase service-role key or GitHub token in frontend files. Only the Supabase publishable key belongs in the browser. Keep the GitHub token restricted to this repository and grant only Actions read/write permission. The analysis endpoints apply a basic per-IP hourly cap; this is a small personal-project safeguard, not a substitute for production-grade abuse prevention.

For research and education only. Not investment advice.
