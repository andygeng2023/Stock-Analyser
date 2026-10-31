-- Run once in the Supabase SQL Editor for the Stock Analyser project.
create table if not exists public.analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  ticker text not null check (ticker ~ '^[A-Z0-9.^=-]{1,20}$'),
  period text not null check (period in ('1y','2y','5y','10y','max')),
  horizon smallint not null check (horizon between 1 and 60),
  status text not null default 'queued' check (status in ('queued','running','completed','failed')),
  result jsonb,
  error text,
  client_ip_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists analysis_jobs_ip_created_idx
  on public.analysis_jobs (client_ip_hash, created_at desc);
create index if not exists analysis_jobs_status_created_idx
  on public.analysis_jobs (status, created_at desc);

alter table public.analysis_jobs enable row level security;
revoke all on table public.analysis_jobs from anon, authenticated;
grant all on table public.analysis_jobs to service_role;

-- No public policies are intentionally created. Only the Edge Functions and
-- GitHub Actions worker access rows using the server-side service-role secret.
