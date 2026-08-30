-- Bank-drop inbox: CoS Bot / Grok Build POSTs rows via the Netlify ingest
-- function (service role). The signed-in owner applies them in FigPig with
-- the existing import engine. Run once in the Supabase SQL editor.

create table if not exists import_inbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null default 'unknown',
  account text,
  note text,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'applied', 'rejected')),
  applied_at timestamptz,
  apply_stats jsonb,
  created_at timestamptz not null default now()
);

create index if not exists import_inbox_owner_pending
  on import_inbox (user_id, status, created_at);

alter table import_inbox enable row level security;

drop policy if exists "Owner reads inbox" on import_inbox;
create policy "Owner reads inbox"
  on import_inbox for select
  using (auth.uid() = user_id);

-- Logged-in owner marks rows applied/rejected. Inserts come from the
-- Netlify function using the service role (bypasses RLS).
drop policy if exists "Owner updates inbox" on import_inbox;
create policy "Owner updates inbox"
  on import_inbox for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
