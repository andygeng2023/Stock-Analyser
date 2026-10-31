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
  attempts smallint not null default 0 check (attempts between 0 and 3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.analysis_jobs
  add column if not exists attempts smallint not null default 0;

create index if not exists analysis_jobs_ip_created_idx
  on public.analysis_jobs (client_ip_hash, created_at desc);
create index if not exists analysis_jobs_status_created_idx
  on public.analysis_jobs (status, created_at desc);

-- Atomically claim one queued job. SKIP LOCKED allows safe parallel workers
-- if concurrency is increased later. Interrupted jobs are retried up to three times.
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
     and updated_at < now() - interval '45 minutes'
     and attempts < 3;

  update public.analysis_jobs
     set status = 'failed',
         error = 'Worker stopped repeatedly before completing this analysis.',
         updated_at = now()
   where status = 'running'
     and updated_at < now() - interval '45 minutes'
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

alter table public.analysis_jobs enable row level security;
revoke all on table public.analysis_jobs from anon, authenticated;
grant all on table public.analysis_jobs to service_role;

-- No public policies are intentionally created. Only the Edge Functions and
-- Python worker access rows using the server-side service-role secret.
