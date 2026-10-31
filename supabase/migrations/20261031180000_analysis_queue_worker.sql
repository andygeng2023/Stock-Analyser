alter table public.analysis_jobs
  add column if not exists attempts smallint not null default 0
  check (attempts between 0 and 3);

create index if not exists analysis_jobs_status_created_idx
  on public.analysis_jobs (status, created_at);

create or replace function public.claim_next_analysis_job()
returns setof public.analysis_jobs
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  claimed public.analysis_jobs;
begin
  -- Recover work left running by a terminated worker. Normal analysis should
  -- finish well before this lease; attempts cap repeated crash/retry loops.
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

  if not found then
    return;
  end if;

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
