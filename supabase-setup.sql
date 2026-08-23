-- Run once in Supabase: SQL Editor → New query → paste → Run

create table if not exists budget_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table budget_states enable row level security;

create policy "Users read own budget"
  on budget_states for select
  using (auth.uid() = user_id);

create policy "Users insert own budget"
  on budget_states for insert
  with check (auth.uid() = user_id);

create policy "Users update own budget"
  on budget_states for update
  using (auth.uid() = user_id);

-- Optional: a second login that can only edit notes. Run supabase-household.sql
-- after this file if you want a spouse notes-only account.