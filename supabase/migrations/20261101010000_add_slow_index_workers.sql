-- Add independent persistent rotation for the long-horizon indexer.
alter table public.market_index_catalog
  add column if not exists last_slow_indexed_at timestamptz;

-- SlowIndex stores full-history models with a one-year (252 trading-session) forecast.
alter table public.analysis_jobs drop constraint if exists analysis_jobs_horizon_check;
alter table public.analysis_jobs add constraint analysis_jobs_horizon_check
  check (horizon between 1 and 504);
alter table public.market_index drop constraint if exists market_index_horizon_check;
alter table public.market_index add constraint market_index_horizon_check
  check (horizon between 1 and 504);

-- Keep RapidIndex's short-lived cache at eight hours, but retain the much
-- more expensive SlowIndex results for thirty days.
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
     and created_at < now() - interval '8 hours';
  get diagnostics expired_jobs = row_count;

  return jsonb_build_object('expired_index_rows', expired_index, 'expired_completed_jobs', expired_jobs);
end;
$$;
revoke all on function public.cleanup_expired_analysis_cache() from public, anon, authenticated;
grant execute on function public.cleanup_expired_analysis_cache() to service_role;
