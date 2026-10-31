alter table public.analysis_jobs drop constraint if exists analysis_jobs_job_type_check;
alter table public.analysis_jobs add constraint analysis_jobs_job_type_check
  check (job_type in ('analysis','scan','index'));

create table if not exists public.market_index_catalog (
  ticker text primary key check (ticker ~ '^[A-Z0-9.^=-]{1,20}$'),
  market_cap numeric,
  avg_dollar_volume numeric,
  priority numeric not null default 0,
  last_indexed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.market_index (
  ticker text not null,
  period text not null check (period in ('1y','2y','5y','10y','max')),
  horizon smallint not null check (horizon between 1 and 60),
  result jsonb not null,
  source_job_id uuid references public.analysis_jobs(id) on delete set null,
  indexed_at timestamptz not null default now(),
  market_cap numeric,
  avg_dollar_volume numeric,
  priority numeric not null default 0,
  primary key (ticker, period, horizon)
);
create index if not exists market_index_expiry_idx on public.market_index(indexed_at);
create index if not exists market_index_catalog_priority_idx
  on public.market_index_catalog(last_indexed_at asc nulls first, market_cap desc nulls last, avg_dollar_volume desc nulls last);

alter table public.market_index enable row level security;
alter table public.market_index_catalog enable row level security;
revoke all on public.market_index from anon, authenticated;
revoke all on public.market_index_catalog from anon, authenticated;
grant all on public.market_index to service_role;
grant all on public.market_index_catalog to service_role;

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
  delete from public.market_index where indexed_at < now() - interval '8 hours';
  get diagnostics expired_index = row_count;
  delete from public.analysis_jobs
   where status = 'completed'
     and created_at < now() - interval '8 hours';
  get diagnostics expired_jobs = row_count;
  return jsonb_build_object('expired_index_rows', expired_index, 'expired_completed_jobs', expired_jobs);
end;
$$;
revoke all on function public.cleanup_expired_analysis_cache() from public, anon, authenticated;
grant execute on function public.cleanup_expired_analysis_cache() to service_role;
