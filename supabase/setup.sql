-- Canonical, idempotent schema bootstrap for Stock Analyser.
-- Safe to run on a fresh Supabase project. Existing rows are preserved.

create extension if not exists pgcrypto;

create table if not exists public.analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  ticker text not null check (ticker ~ '^[A-Z0-9.^=-]{1,20}$'),
  period text not null check (period in ('1y','2y','5y','10y','max')),
  horizon smallint not null check (horizon between 1 and 504),
  job_type text not null default 'analysis'
    check (job_type in ('analysis','scan','index')),
  scan_source text not null default 'both'
    check (scan_source in ('yfinance','nasdaq','both')),
  save_to_indexer text not null default 'rapidIndex'
    check (save_to_indexer in ('rapidIndex','SlowIndex','none')),
  status text not null default 'queued'
    check (status in ('queued','running','completed','failed')),
  result jsonb,
  error text,
  client_ip_hash text not null default 'legacy',
  attempts smallint not null default 0 check (attempts between 0 and 3),
  progress integer not null default 0 check (progress between 0 and 100),
  stage text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.analysis_jobs
  add column if not exists job_type text not null default 'analysis',
  add column if not exists scan_source text not null default 'both',
  add column if not exists save_to_indexer text not null default 'rapidIndex',
  add column if not exists attempts smallint not null default 0,
  add column if not exists progress integer not null default 0,
  add column if not exists stage text;

alter table public.analysis_jobs
  drop constraint if exists analysis_jobs_job_type_check,
  add constraint analysis_jobs_job_type_check
    check (job_type in ('analysis','scan','index')),
  drop constraint if exists analysis_jobs_horizon_check,
  add constraint analysis_jobs_horizon_check check (horizon between 1 and 504),
  drop constraint if exists analysis_jobs_scan_source_check,
  add constraint analysis_jobs_scan_source_check check (scan_source in ('yfinance','nasdaq','both')),
  drop constraint if exists analysis_jobs_save_to_indexer_check,
  add constraint analysis_jobs_save_to_indexer_check check (save_to_indexer in ('rapidIndex','SlowIndex','none'));

create index if not exists analysis_jobs_status_created_idx
  on public.analysis_jobs (status, created_at);
create index if not exists analysis_jobs_type_status_created_idx
  on public.analysis_jobs (job_type, status, created_at desc);
create index if not exists analysis_jobs_cache_lookup_idx
  on public.analysis_jobs (job_type, ticker, period, horizon, scan_source, status, created_at desc);
create index if not exists analysis_jobs_ip_created_idx
  on public.analysis_jobs (client_ip_hash, created_at desc);

drop index if exists public.analysis_jobs_one_active_key_idx;
create unique index analysis_jobs_one_active_key_idx
  on public.analysis_jobs (job_type, ticker, period, horizon, scan_source, save_to_indexer)
  where status in ('queued','running');

create table if not exists public.market_index (
  ticker text not null check (ticker ~ '^[A-Z0-9.^=-]{1,20}$'),
  period text not null check (period in ('1y','2y','5y','10y','max')),
  horizon smallint not null check (horizon between 1 and 504),
  indexer text not null default 'rapidIndex'
    check (indexer in ('rapidIndex','SlowIndex')),
  result jsonb not null,
  source_job_id uuid references public.analysis_jobs(id) on delete set null,
  indexed_at timestamptz not null default now(),
  market_cap numeric,
  avg_dollar_volume numeric,
  priority numeric not null default 0,
  constraint market_index_pkey primary key (ticker,period,horizon,indexer)
);

alter table public.market_index
  add column if not exists indexer text not null default 'rapidIndex';
alter table public.market_index
  drop constraint if exists market_index_horizon_check,
  add constraint market_index_horizon_check check (horizon between 1 and 504),
  drop constraint if exists market_index_indexer_check,
  add constraint market_index_indexer_check check (indexer in ('rapidIndex','SlowIndex')),
  drop constraint if exists market_index_pkey;
alter table public.market_index
  add constraint market_index_pkey primary key (ticker,period,horizon,indexer);

create index if not exists market_index_expiry_idx on public.market_index(indexed_at);
create index if not exists market_index_lookup_idx
  on public.market_index (ticker,indexer,period,horizon,indexed_at desc);

create table if not exists public.market_index_catalog (
  ticker text primary key check (ticker ~ '^[A-Z0-9.^=-]{1,20}$'),
  market_cap numeric,
  avg_dollar_volume numeric,
  priority numeric not null default 0,
  last_indexed_at timestamptz,
  last_slow_indexed_at timestamptz,
  rapid_attempted_at timestamptz,
  rapid_retry_after timestamptz,
  rapid_last_error text,
  slow_attempted_at timestamptz,
  slow_retry_after timestamptz,
  slow_last_error text,
  updated_at timestamptz not null default now()
);

alter table public.market_index_catalog
  add column if not exists last_slow_indexed_at timestamptz,
  add column if not exists rapid_attempted_at timestamptz,
  add column if not exists rapid_retry_after timestamptz,
  add column if not exists rapid_last_error text,
  add column if not exists slow_attempted_at timestamptz,
  add column if not exists slow_retry_after timestamptz,
  add column if not exists slow_last_error text;

create index if not exists market_index_catalog_priority_idx
  on public.market_index_catalog(last_indexed_at asc nulls first, market_cap desc nulls last, avg_dollar_volume desc nulls last);

create or replace function public.claim_next_analysis_job()
returns setof public.analysis_jobs
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  claimed public.analysis_jobs;
begin
  update public.analysis_jobs
     set status = 'queued',
         error = 'Recovered after an interrupted worker.',
         updated_at = now()
   where status = 'running'
     and updated_at < now() - interval '90 minutes'
     and attempts < 3;

  update public.analysis_jobs
     set status = 'failed',
         error = 'Worker stopped repeatedly before completing this analysis.',
         updated_at = now()
   where status = 'running'
     and updated_at < now() - interval '90 minutes'
     and attempts >= 3;

  select * into claimed
    from public.analysis_jobs
   where status = 'queued'
   order by created_at
   limit 1
   for update skip locked;

  if not found then return; end if;

  update public.analysis_jobs
     set status = 'running',
         attempts = attempts + 1,
         error = null,
         updated_at = now()
   where id = claimed.id
   returning * into claimed;

  return next claimed;
end;
$$;

revoke all on function public.claim_next_analysis_job() from public, anon, authenticated;
grant execute on function public.claim_next_analysis_job() to service_role;

create or replace function public.cleanup_expired_analysis_cache()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  expired_index integer;
  expired_jobs integer;
begin
  delete from public.market_index
   where (indexer = 'SlowIndex' and indexed_at < now() - interval '30 days')
      or (indexer <> 'SlowIndex' and indexed_at < now() - interval '8 hours');
  get diagnostics expired_index = row_count;

  delete from public.analysis_jobs
   where status = 'completed'
     and ((save_to_indexer = 'SlowIndex' and created_at < now() - interval '30 days')
       or (save_to_indexer <> 'SlowIndex' and created_at < now() - interval '8 hours'));
  get diagnostics expired_jobs = row_count;

  return jsonb_build_object('expired_index_rows', expired_index, 'expired_completed_jobs', expired_jobs);
end;
$$;

revoke all on function public.cleanup_expired_analysis_cache() from public, anon, authenticated;
grant execute on function public.cleanup_expired_analysis_cache() to service_role;

create table if not exists public.watchlist_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null check (ticker ~ '^[A-Z0-9.^=-]{1,20}$'),
  created_at timestamptz not null default now(),
  constraint watchlist_items_user_ticker_key unique (user_id,ticker)
);

create index if not exists watchlist_items_ticker_created_idx
  on public.watchlist_items (ticker,created_at);
create index if not exists watchlist_items_user_created_idx
  on public.watchlist_items (user_id,created_at desc);

alter table public.analysis_jobs enable row level security;
alter table public.market_index enable row level security;
alter table public.market_index_catalog enable row level security;
alter table public.watchlist_items enable row level security;

revoke all on public.analysis_jobs from anon, authenticated;
revoke all on public.market_index from anon, authenticated;
revoke all on public.market_index_catalog from anon, authenticated;
revoke all on public.watchlist_items from anon;

grant all on public.analysis_jobs to service_role;
grant all on public.market_index to service_role;
grant all on public.market_index_catalog to service_role;
grant select on public.watchlist_items to service_role;
grant select, insert, delete on public.watchlist_items to authenticated;

drop policy if exists "Users can read their own watchlist" on public.watchlist_items;
create policy "Users can read their own watchlist"
  on public.watchlist_items for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists "Users can add to their own watchlist" on public.watchlist_items;
create policy "Users can add to their own watchlist"
  on public.watchlist_items for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists "Users can remove from their own watchlist" on public.watchlist_items;
create policy "Users can remove from their own watchlist"
  on public.watchlist_items for delete to authenticated
  using ((select auth.uid()) = user_id);
