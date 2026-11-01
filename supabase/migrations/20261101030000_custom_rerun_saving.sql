-- Record which indexer a user-requested analysis is saved into.
alter table public.analysis_jobs
  add column if not exists save_to_indexer text not null default 'rapidIndex';
alter table public.analysis_jobs
  drop constraint if exists analysis_jobs_save_to_indexer_check;
alter table public.analysis_jobs
  add constraint analysis_jobs_save_to_indexer_check
  check (save_to_indexer in ('rapidIndex', 'SlowIndex', 'none'));

alter table public.market_index
  add column if not exists indexer text not null default 'rapidIndex';
update public.market_index
   set indexer = 'SlowIndex'
 where period = 'max' and horizon = 504;
