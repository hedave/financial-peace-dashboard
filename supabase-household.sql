-- Run in Supabase SQL Editor (once) so a second login can share the household budget.
-- Notes-only members can read/update the owner's budget_states row.
-- The app only writes note boards for that role.

create table if not exists household_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'notes' check (role in ('owner', 'notes')),
  created_at timestamptz not null default now()
);

create table if not exists household_invites (
  code text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'notes' check (role in ('notes')),
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now()
);

alter table household_members enable row level security;
alter table household_invites enable row level security;

drop policy if exists "Read own membership" on household_members;
create policy "Read own membership"
  on household_members for select
  using (auth.uid() = user_id or auth.uid() = owner_id);

drop policy if exists "Owner inserts self" on household_members;
create policy "Owner inserts self"
  on household_members for insert
  with check (auth.uid() = user_id and auth.uid() = owner_id and role = 'owner');

drop policy if exists "Owner deletes members" on household_members;
create policy "Owner deletes members"
  on household_members for delete
  using (auth.uid() = owner_id);

drop policy if exists "Owner creates invites" on household_invites;
create policy "Owner creates invites"
  on household_invites for insert
  with check (auth.uid() = owner_id);

drop policy if exists "Owner reads own invites" on household_invites;
create policy "Owner reads own invites"
  on household_invites for select
  using (auth.uid() = owner_id);

drop policy if exists "Owner deletes own invites" on household_invites;
create policy "Owner deletes own invites"
  on household_invites for delete
  using (auth.uid() = owner_id);

-- Replace budget_states policies so members can use the owner's row
drop policy if exists "Users read own budget" on budget_states;
drop policy if exists "Users insert own budget" on budget_states;
drop policy if exists "Users update own budget" on budget_states;
drop policy if exists "Owner or member can read" on budget_states;
drop policy if exists "Owner or member can update" on budget_states;
drop policy if exists "Users insert own budget v2" on budget_states;

create policy "Owner or member can read"
  on budget_states for select
  using (
    auth.uid() = user_id
    or exists (
      select 1 from household_members m
      where m.user_id = auth.uid() and m.owner_id = budget_states.user_id
    )
  );

create policy "Users insert own budget v2"
  on budget_states for insert
  with check (auth.uid() = user_id);

create policy "Owner or member can update"
  on budget_states for update
  using (
    auth.uid() = user_id
    or exists (
      select 1 from household_members m
      where m.user_id = auth.uid() and m.owner_id = budget_states.user_id
    )
  );

create or replace function join_household(invite_code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  inv household_invites%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  select * into inv
  from household_invites
  where upper(code) = upper(trim(invite_code));

  if not found then
    raise exception 'Invalid household code';
  end if;
  if inv.expires_at < now() then
    raise exception 'That code expired — ask for a new one';
  end if;

  insert into household_members (user_id, owner_id, role)
  values (auth.uid(), inv.owner_id, inv.role)
  on conflict (user_id) do update
    set owner_id = excluded.owner_id,
        role = excluded.role;

  delete from household_invites where code = inv.code;

  return json_build_object('owner_id', inv.owner_id, 'role', inv.role);
end;
$$;

grant execute on function join_household(text) to authenticated;
