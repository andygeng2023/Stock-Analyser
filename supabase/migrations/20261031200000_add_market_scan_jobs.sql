alter table public.analysis_jobs
  add column if not exists job_type text not null default 'analysis'
  check (job_type in ('analysis', 'scan'));

create index if not exists analysis_jobs_type_status_created_idx
  on public.analysis_jobs (job_type, status, created_at desc);
