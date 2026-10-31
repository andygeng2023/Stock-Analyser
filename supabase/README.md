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

The functions validate inputs, enforce a per-IP hourly cap and never return or expose server secrets. The status function only returns the result associated with the supplied random job UUID.

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
