-- Retain SlowIndex result jobs alongside their thirty-day index cache.
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
     and save_to_indexer <> 'SlowIndex'
     and created_at < now() - interval '8 hours';
  delete from public.analysis_jobs
   where status = 'completed'
     and save_to_indexer = 'SlowIndex'
     and created_at < now() - interval '30 days';
  get diagnostics expired_jobs = row_count;

  return jsonb_build_object('expired_index_rows', expired_index, 'expired_completed_jobs', expired_jobs);
end;
$$;
revoke all on function public.cleanup_expired_analysis_cache() from public, anon, authenticated;
grant execute on function public.cleanup_expired_analysis_cache() to service_role;
