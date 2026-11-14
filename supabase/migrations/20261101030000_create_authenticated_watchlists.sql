create table if not exists public.watchlist_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null check (ticker ~ '^[A-Z0-9.^=-]{1,20}$'),
  created_at timestamptz not null default now(),
  constraint watchlist_items_user_ticker_key unique (user_id, ticker)
);

create index if not exists watchlist_items_ticker_created_idx
  on public.watchlist_items (ticker, created_at);
create index if not exists watchlist_items_user_created_idx
  on public.watchlist_items (user_id, created_at desc);

alter table public.watchlist_items enable row level security;
revoke all on public.watchlist_items from anon;
grant select, insert, delete on public.watchlist_items to authenticated;
grant select on public.watchlist_items to service_role;

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
