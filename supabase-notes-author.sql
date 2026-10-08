-- FigPig: sticky-note author tag (createdBy) for the notes-only login.
-- MANUAL STEP: run once in the Supabase SQL Editor AFTER supabase-household.sql.
-- Safe to re-run. Not applied automatically. The app works without it
-- (stickies created by the notes login are then tagged by the client only).
--
-- What it changes: replaces update_household_notes(text, text, jsonb) — same
-- signature, same auth/role checks, same three keys written (notes,
-- notesUpdatedAt, noteBoards) — and adds:
--   * createdBy on every sticky, decided by the SERVER:
--       - sticky id already stored in the owner's state -> keeps its stored
--         createdBy (the notes login cannot re-tag owner or legacy notes)
--       - sticky id not stored yet -> 'notes'
--   * input validation (array/object shapes, string ids, size caps); fails closed
--   * archive fields on stickies (build 20261008b): `archived` must be a JSON
--     boolean and `archivedAt` an ISO-8601 timestamp string (<= 40 chars) or
--     null, when present. Any other type is rejected. (The first version of this
--     file already passed these keys through untouched; this only tightens types.)
--   * row lock (FOR UPDATE) so read-modify-write is atomic
--   * notesUpdatedAt = null is stored as JSON null (the old body hit the
--     state NOT NULL constraint because jsonb_set(..., null) returns null)
-- It does NOT touch transactions, memos, noteLinks, or any money field.
-- RLS on budget_states is unchanged; this stays SECURITY DEFINER with a fixed
-- search_path and checks household_members itself.
--
-- NOTE: re-running supabase-household.sql restores the older function body;
-- run this file again afterwards if you do that.

create or replace function update_household_notes(
  p_notes text,
  p_notes_updated_at text,
  p_note_boards jsonb
) returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  oid uuid;
  cur jsonb;
  prior jsonb := '{}'::jsonb;       -- sticky id -> stored createdBy (json value)
  boards_in jsonb;
  boards_out jsonb := '[]'::jsonb;
  stickies_out jsonb;
  b jsonb;
  s jsonb;
  sid text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;

  select owner_id into oid
  from household_members
  where user_id = auth.uid() and role = 'notes';

  if oid is null then
    raise exception 'Not a notes member';
  end if;

  -- ---- validate input (fail closed) ----
  boards_in := coalesce(p_note_boards, '[]'::jsonb);
  if jsonb_typeof(boards_in) <> 'array' then
    raise exception 'Invalid note boards';
  end if;
  if octet_length(boards_in::text) > 1000000 then
    raise exception 'Notes too large';
  end if;
  if octet_length(coalesce(p_notes, '')) > 1000000 then
    raise exception 'Notes too large';
  end if;
  if p_notes_updated_at is not null and length(p_notes_updated_at) > 64 then
    raise exception 'Invalid notes timestamp';
  end if;
  if jsonb_array_length(boards_in) > 200 then
    raise exception 'Too many note pages';
  end if;

  select state into cur
  from budget_states
  where user_id = oid
  for update;

  if not found then
    raise exception 'No budget';
  end if;
  cur := coalesce(cur, '{}'::jsonb);

  -- ---- authors already stored on the server ----
  if jsonb_typeof(cur -> 'noteBoards') = 'array' then
    for b in select value from jsonb_array_elements(cur -> 'noteBoards') loop
      if jsonb_typeof(b) = 'object' and jsonb_typeof(b -> 'stickies') = 'array' then
        for s in select value from jsonb_array_elements(b -> 'stickies') loop
          if jsonb_typeof(s) = 'object' and jsonb_typeof(s -> 'id') = 'string' then
            sid := s ->> 'id';
            if not (prior ? sid) then
              prior := prior || jsonb_build_object(
                sid,
                case when s -> 'createdBy' in ('"owner"'::jsonb, '"notes"'::jsonb)
                  then s -> 'createdBy' else 'null'::jsonb end
              );
            end if;
          end if;
        end loop;
      end if;
    end loop;
  end if;

  -- ---- rebuild incoming boards with server-decided createdBy ----
  for b in select value from jsonb_array_elements(boards_in) loop
    if jsonb_typeof(b) <> 'object' then
      raise exception 'Invalid note page';
    end if;
    if b ? 'stickies' and coalesce(jsonb_typeof(b -> 'stickies'), '') not in ('array', 'null') then
      raise exception 'Invalid stickies';
    end if;
    stickies_out := '[]'::jsonb;
    if jsonb_typeof(b -> 'stickies') = 'array' then
      if jsonb_array_length(b -> 'stickies') > 2000 then
        raise exception 'Too many stickies';
      end if;
      for s in select value from jsonb_array_elements(b -> 'stickies') loop
        if jsonb_typeof(s) <> 'object'
          or coalesce(jsonb_typeof(s -> 'id'), '') <> 'string'
          or coalesce(length(s ->> 'id'), 0) = 0
          or length(s ->> 'id') > 200 then
          raise exception 'Invalid sticky';
        end if;
        -- Archive fields (build 20261008b+): strict types when present.
        if s ? 'archived' and coalesce(jsonb_typeof(s -> 'archived'), '') <> 'boolean' then
          raise exception 'Invalid sticky archive flag';
        end if;
        if s ? 'archivedAt' and coalesce(jsonb_typeof(s -> 'archivedAt'), '') <> 'null' and (
             coalesce(jsonb_typeof(s -> 'archivedAt'), '') <> 'string'
             or length(s ->> 'archivedAt') > 40
             or (s ->> 'archivedAt') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}:?[0-9]{2})$'
           ) then
          raise exception 'Invalid sticky archive time';
        end if;
        sid := s ->> 'id';
        if prior ? sid then
          s := s || jsonb_build_object('createdBy', prior -> sid);
        else
          s := s || jsonb_build_object('createdBy', 'notes');
        end if;
        stickies_out := stickies_out || jsonb_build_array(s);
      end loop;
    end if;
    boards_out := boards_out || jsonb_build_array(b || jsonb_build_object('stickies', stickies_out));
  end loop;

  update budget_states
    set state = cur
          || jsonb_build_object(
               'notes', coalesce(p_notes, ''),
               'notesUpdatedAt', p_notes_updated_at,  -- SQL null -> JSON null
               'noteBoards', boards_out
             ),
        updated_at = now()
    where user_id = oid;

  if not found then
    raise exception 'No budget';
  end if;

  return now();
end;
$$;

revoke all on function update_household_notes(text, text, jsonb) from public;
revoke all on function update_household_notes(text, text, jsonb) from anon;
grant execute on function update_household_notes(text, text, jsonb) to authenticated;
