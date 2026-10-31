-- Shared eight-hour cache support and live progress for analysis jobs.
alter table public.analysis_jobs
  add column if not exists progress integer not null default 0
    check (progress between 0 and 100),
  add column if not exists stage text;

create index if not exists analysis_jobs_cache_lookup_idx
  on public.analysis_jobs (job_type, ticker, period, horizon, scan_source, status, created_at desc);

create unique index if not exists analysis_jobs_one_active_key_idx
  on public.analysis_jobs (job_type, ticker, period, horizon, scan_source)
  where status in ('queued', 'running');
