# Supabase setup

This project uses Supabase for the job queue and result storage. The Python analysis itself runs in a GitHub Actions hosted runner, because Supabase Edge Functions have a 2-second CPU-time limit on the Free plan and are not a Python runtime.

## 1. Create a dedicated Supabase project

Do not reuse a different application's production database. Run `setup.sql` once in this project's Supabase SQL Editor.

## 2. Configure Edge Function secrets

Set these secrets in Supabase Edge Function secrets:

- `SUPABASE_SERVICE_ROLE_KEY`: server-side service role key. Never put this in frontend code.
- `STOCK_ANALYSER_GITHUB_TOKEN`: fine-grained GitHub token restricted to this repository with Actions: Read and write.
- `GITHUB_OWNER`: `andygeng2023`
- `GITHUB_REPOSITORY`: `Stock-Analyser`
- `GITHUB_ANALYSIS_WORKFLOW`: `analyze-stock.yml`
- `RATE_LIMIT_SALT`: a random private value used to hash requester IP addresses.

Deploy both functions:

- `request-analysis` with JWT verification disabled (public endpoint with server-side rate limiting).
- `analysis-status` with JWT verification disabled (job UUID acts as an unguessable read token).
- `watchlist` with JWT verification disabled (the browser supplies a random profile UUID; the function stores the list in Turso and never exposes its database token).

The functions validate inputs, enforce a per-IP hourly cap and never return or expose server secrets. The status function only returns the result associated with the supplied random job UUID.

## Watchlist SQLite setup

The watchlist uses Turso's managed SQLite-compatible database. A local SQLite file inside GitHub Actions disappears when a runner exits, so the list database must persist outside the runner and be reachable by both the Edge Function and WatchIndex. The Turso engine supports concurrent writes and multi-user access.

1. Create a Turso account and a database named `stock-analyser-watchlist` using the Turso engine.
2. Copy the database URL (usually starts with `libsql://`) and create a database-scoped SQL auth token with read/write permissions.
3. In Supabase Dashboard → Project → Edge Functions → Secrets, add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.
4. In GitHub → Stock-Analyser → Settings → Secrets and variables → Actions → Secrets, add the same two secrets.
5. The `watchlist` Edge Function and WatchIndex worker create the `watchlist_items` table and index automatically on first use. The scheduled WatchIndex workflow then begins polling all unique tickers in all users' lists.

Do not use a Turso organization API token in place of the database SQL auth token, and do not put either value in `app/static/config.js` or frontend code.

The current dashboard has no sign-in system. Each browser profile gets a random local watchlist identity, so its list is tied to that browser profile and is not synced between devices. Account sign-in would be needed for cross-device syncing.

## 3. Configure GitHub Actions secrets

In GitHub repository Settings → Secrets and variables → Actions → Secrets, add:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The workflow needs these only on the server-side runner to save the completed result.

## 4. Configure GitHub Pages variables

In GitHub repository Settings → Secrets and variables → Actions → Variables, add:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`

The publishable key is designed to be exposed in a browser. Never use the service role key here.

## 5. Enable Pages

In GitHub repository Settings → Pages → Build and deployment, select **GitHub Actions**. Push to main to deploy the site.

## Request flow

Browser → Supabase `request-analysis` → insert queued job → dispatch GitHub Actions workflow → Python/yfinance + ARIMA/SVR → save JSON result in Supabase → browser polls `analysis-status`.

The GitHub Actions workflow must exist on the repository's default branch before GitHub's workflow-dispatch API can trigger it. Merge the implementation PR to main after reviewing it.
