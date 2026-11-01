-- Persist independent retry cooldowns for RapidIndex and SlowIndex.
alter table public.market_index_catalog
  add column if not exists rapid_attempted_at timestamptz,
  add column if not exists rapid_retry_after timestamptz,
  add column if not exists rapid_last_error text,
  add column if not exists slow_attempted_at timestamptz,
  add column if not exists slow_retry_after timestamptz,
  add column if not exists slow_last_error text;

comment on column public.market_index_catalog.rapid_attempted_at is
  'Most recent RapidIndex attempt, whether it succeeded or failed.';
comment on column public.market_index_catalog.rapid_retry_after is
  'RapidIndex retry is deferred until this timestamp after a failure or interrupted attempt.';
comment on column public.market_index_catalog.rapid_last_error is
  'Most recent RapidIndex failure, truncated by the worker.';
comment on column public.market_index_catalog.slow_attempted_at is
  'Most recent SlowIndex attempt, whether it succeeded or failed.';
comment on column public.market_index_catalog.slow_retry_after is
  'SlowIndex retry is deferred until this timestamp after a failure or interrupted attempt.';
comment on column public.market_index_catalog.slow_last_error is
  'Most recent SlowIndex failure, truncated by the worker.';
