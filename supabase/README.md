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

Deploy the functions:

- `request-analysis` with JWT verification disabled (public endpoint with server-side rate limiting).
- `analysis-status` with JWT verification disabled (job UUID acts as an unguessable read token).
- `watchlist` with JWT verification enabled (only a verified signed-in user can access their own PostgreSQL watchlist).

The analysis endpoints validate inputs and never return or expose server secrets. The status function returns the result associated with the supplied random job UUID. The `watchlist` endpoint requires a valid signed-in user and applies a 100-item per-account limit.

## Email authentication and Watchlist

The app uses Supabase Auth email/password accounts. Watchlists are stored in `public.watchlist_items` in this project's PostgreSQL database. The migration `20261101030000_create_authenticated_watchlists.sql` creates the table, indexes, grants and ownership-based RLS policies. It has already been applied to the connected project.

In Supabase Dashboard → Authentication → Sign In / Providers:

1. Enable the **Email** provider.
2. Ensure **Allow new users to sign up** is enabled.
3. Keep email confirmation enabled so new accounts must verify ownership of their email address.

In Authentication → URL Configuration:

- Set **Site URL** to `https://andygeng2023.github.io/Stock-Analyser/`.
- Add `https://andygeng2023.github.io/Stock-Analyser/**` to the Redirect URLs allow list.
- If developing locally, also add the exact local development URL you use.

The frontend sends confirmation and password-reset links back to the GitHub Pages app. Supabase's built-in email sender is restricted and rate-limited; on a new project it may only deliver to project organisation members. To let the public receive signup and password-reset emails, configure a custom SMTP provider in Authentication → SMTP Settings. Keep email confirmation enabled for a public deployment. Free-tier projects using the built-in sender also cannot freely customise Auth email templates; custom SMTP is required for branded templates.

The account dialog supports sign-up, sign-in, sign-out, password-reset email and setting a new password from the recovery link. Browsing and analysis requests remain available without signing in; adding to or viewing a saved watchlist requires a verified signed-in session.

The watchlist Edge Function validates the access token with Supabase Auth and uses the caller's JWT for all watchlist table operations. Row-level security restricts reads, inserts and deletes to rows whose `user_id` equals `auth.uid()`. The service-role key is used only server-side to read shared market-index results. The browser never receives it.

## 3. Configure GitHub Actions secrets

In GitHub repository Settings → Secrets and variables → Actions → Secrets, add:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The analysis and WatchIndex workflows need these only on the server-side runner to save completed results and read all watchlist tickers.

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
