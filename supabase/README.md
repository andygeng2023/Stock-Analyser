# Supabase Edge API

Supabase is used only to host the protected HTTPS API. TiDB is the sole application database.

Configure the `DATABASE_URL` and `TIDB_PASSWORD` Edge Function secrets, then deploy `stock-analyser-api`. The API uses the TiDB PostgreSQL-compatible endpoint directly; it does not query Supabase Postgres.
