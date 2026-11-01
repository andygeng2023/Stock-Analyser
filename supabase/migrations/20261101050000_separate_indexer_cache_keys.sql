-- Allow the same ticker/history/horizon to be cached independently by each indexer.
alter table public.market_index
  add column if not exists indexer text not null default 'rapidIndex';

alter table public.market_index
  drop constraint if exists market_index_pkey;
alter table public.market_index
  add constraint market_index_pkey primary key (ticker, period, horizon, indexer);

-- Distinguish simultaneous queued jobs that use different save destinations.
drop index if exists public.analysis_jobs_one_active_key_idx;
create unique index analysis_jobs_one_active_key_idx
  on public.analysis_jobs (job_type, ticker, period, horizon, scan_source, save_to_indexer)
  where status in ('queued', 'running');

create index if not exists market_index_expiry_idx on public.market_index(indexed_at);
