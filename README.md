# Stock Analyser

A responsive stock research dashboard using Yahoo Finance data and a walk-forward-tested ARIMA, SVM, SVR and XGBoost forecasting ensemble.

## Target architecture

- **GitHub Pages** serves the static frontend.
- **TiDB Cloud PostgreSQL-compatible Starter** is the sole application database.
- **GitHub Actions** runs analysis, RapidIndex, SlowIndex, WatchIndex, background scanning and cache maintenance workers. Long-running workers hand off to successor runs before the runner time limit; schedules provide recovery starts.
- **Yahoo Finance** supplies quotes, historical data and symbol search.

No old indexed data is migrated. The TiDB schema is created cleanly and indexes are rebuilt from Yahoo Finance.

## Required repository secret

- \`DATABASE_URL\`: the PostgreSQL connection string from the TiDB Connect panel.

## Background workers

The Actions workflows start on a schedule and can also be dispatched manually:

- Analysis queue: every 5 minutes.
- RapidIndex and SlowIndex: every 6 hours, split across four workers.
- Background market scanning: every 6 hours.
- WatchIndex: every 6 hours.
- Cache cleanup: every 6 hours.

Each long-running worker uses a 5-hour-45-minute runtime and hands off to a successor before the GitHub runner's job timeout.

## Local development

\`\`\`bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
\`\`\`

## Forecasting model

The forecasting system combines ARIMA, SVC, SVR and XGBoost. The primary continuous-return ensemble is a fixed 50/50 blend of the ARIMA+SVR estimate and XGBoost estimate. SVC supplies a separate directional classification.

Validation uses chronological out-of-sample testing. Forecasts are estimates, not guarantees of future performance.

For research and education only. Not investment advice.
