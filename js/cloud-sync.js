import { SUPABASE_URL, SUPABASE_ANON_KEY, CLOUD_SYNC_ENABLED } from './config.js';

let client = null;
let pushTimer = null;
let lastSyncedAt = null;
let syncStatus = 'idle'; // idle | syncing | error | ok
/** @type {{ role: 'owner' | 'notes', ownerId: string | null, userId: string | null }} */
let household = { role: 'owner', ownerId: null, userId: null };

export function isCloudConfigured() {
  return CLOUD_SYNC_ENABLED && SUPABASE_URL && SUPABASE_ANON_KEY
    && !SUPABASE_URL.includes('YOUR_PROJECT');
}

export function getSyncStatus() {
  return { status: syncStatus, lastSyncedAt };
}

async function getClient() {
  if (!isCloudConfigured()) return null;
  if (!client) {
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.49.1');
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return client;
}

export async function getSession() {
  const sb = await getClient();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session;
}

export async function getUserEmail() {
  const session = await getSession();
  return session?.user?.email || null;
}

export async function signUp(email, password) {
  const sb = await getClient();
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) throw error;
  return data;
}

export async function signIn(email, password) {
  const sb = await getClient();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const sb = await getClient();
  if (sb) await sb.auth.signOut();
  client = null;
  lastSyncedAt = null;
  syncStatus = 'idle';
  household = { role: 'owner', ownerId: null, userId: null };
}

export function getHousehold() {
  return household;
}

export function isNotesOnlyRole() {
  return household.role === 'notes';
}

function inviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export async function refreshHousehold() {
  const sb = await getClient();
  const session = await getSession();
  if (!sb || !session) {
    household = { role: 'owner', ownerId: null, userId: null };
    return household;
  }
  const userId = session.user.id;
  const { data, error } = await sb
    .from('household_members')
    .select('owner_id, role')
    .eq('user_id', userId)
    .maybeSingle();
  if (error && (error.code === '42P01' || /household_members/i.test(error.message || ''))) {
    household = { role: 'owner', ownerId: userId, userId };
    return household;
  }
  if (error) {
    console.warn('Household lookup failed', error);
    household = { role: 'owner', ownerId: userId, userId };
    return household;
  }
  if (data?.owner_id) {
    household = {
      role: data.role === 'notes' ? 'notes' : 'owner',
      ownerId: data.owner_id,
      userId,
    };
  } else {
    household = { role: 'owner', ownerId: userId, userId };
  }
  return household;
}

async function budgetOwnerId() {
  if (!household.ownerId) await refreshHousehold();
  const session = await getSession();
  return household.ownerId || session?.user?.id || null;
}

export async function createHouseholdInvite() {
  const sb = await getClient();
  const session = await getSession();
  if (!sb || !session) throw new Error('Sign in first');
  const ownerId = session.user.id;
  await sb.from('household_members').upsert({
    user_id: ownerId,
    owner_id: ownerId,
    role: 'owner',
  }, { onConflict: 'user_id' });
  await sb.from('household_invites').delete().eq('owner_id', ownerId);
  const code = inviteCode();
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await sb.from('household_invites').insert({
    code,
    owner_id: ownerId,
    role: 'notes',
    expires_at: expires,
  });
  if (error) {
    if (error.code === '42P01' || /household_invites/i.test(error.message || '')) {
      throw new Error('Run supabase-household.sql in the Supabase SQL editor first.');
    }
    throw error;
  }
  await refreshHousehold();
  return { code, expiresAt: expires };
}

export async function joinHousehold(code) {
  const sb = await getClient();
  const session = await getSession();
  if (!sb || !session) throw new Error('Sign in first');
  const trimmed = String(code || '').trim().toUpperCase();
  if (trimmed.length < 4) throw new Error('Enter the 6-letter household code.');
  const { data, error } = await sb.rpc('join_household', { invite_code: trimmed });
  if (error) {
    if (/join_household|does not exist|42P01/i.test(error.message || '')) {
      throw new Error('Run supabase-household.sql in the Supabase SQL editor first.');
    }
    throw error;
  }
  await refreshHousehold();
  return data;
}

export async function listHouseholdInvites() {
  const sb = await getClient();
  const session = await getSession();
  if (!sb || !session) return [];
  const { data, error } = await sb
    .from('household_invites')
    .select('code, expires_at, role')
    .eq('owner_id', session.user.id)
    .gt('expires_at', new Date().toISOString());
  if (error) return [];
  return data || [];
}

/** True if this looks like a fresh install with no real budget data */
export function isBlankBudgetState(state) {
  if (!state || typeof state !== 'object') return true;
  if (!state.setupComplete) return true;
  const hasActivity =
    (state.transactions?.length || 0) > 0
    || (state.bills?.length || 0) > 0
    || (state.debts?.length || 0) > 0
    || (state.incomeSources || []).some(s => Number(s.amount) > 0)
    || (state.categories || []).some(c => Number(c.monthlyBudget) > 0);
  return !hasActivity;
}

/**
 * Author tag for stickies, mirroring update_household_notes (supabase-notes-author.sql):
 * a sticky already in `priorBoards` keeps its stored createdBy (cannot be re-tagged);
 * a sticky not seen before gets `author`. Returns new board objects; input is not mutated.
 */
export function stampNoteAuthors(nextBoards, priorBoards, author) {
  const prior = new Map();
  (Array.isArray(priorBoards) ? priorBoards : []).forEach(b => {
    (Array.isArray(b?.stickies) ? b.stickies : []).forEach(n => {
      if (n && n.id && !prior.has(n.id)) prior.set(n.id, n.createdBy ?? null);
    });
  });
  return (Array.isArray(nextBoards) ? nextBoards : []).map(b => {
    if (!b || typeof b !== 'object') return b;
    const stickies = Array.isArray(b.stickies) ? b.stickies : [];
    return {
      ...b,
      stickies: stickies.map(n => {
        if (!n || typeof n !== 'object') return n;
        const createdBy = n.id && prior.has(n.id) ? prior.get(n.id) : author;
        return { ...n, createdBy };
      }),
    };
  });
}

function notesSlice(state) {
  return {
    notes: state?.notes || '',
    notesUpdatedAt: state?.notesUpdatedAt || null,
    noteBoards: Array.isArray(state?.noteBoards) ? state.noteBoards : [],
  };
}

/** Document uploaded to Supabase. The app password stays on this device. */
export function stateForCloud(state) {
  if (!state || typeof state !== 'object') return state;
  const settings = state.settings && typeof state.settings === 'object'
    ? { ...state.settings, passwordHash: null }
    : state.settings;
  return { ...state, settings };
}

export async function loadRemoteState() {
  const sb = await getClient();
  const session = await getSession();
  if (!sb || !session) return null;
  await refreshHousehold();
  const ownerId = await budgetOwnerId();
  if (!ownerId) return null;

  const { data, error } = await sb
    .from('budget_states')
    .select('state, updated_at')
    .eq('user_id', ownerId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  lastSyncedAt = data.updated_at ? new Date(data.updated_at) : new Date();
  syncStatus = 'ok';
  return { state: data.state, updated_at: data.updated_at };
}

export async function pushState(state) {
  const sb = await getClient();
  const session = await getSession();
  if (!sb || !session) return false;
  await refreshHousehold();
  const ownerId = await budgetOwnerId();
  if (!ownerId) return false;

  syncStatus = 'syncing';
  let payload = stateForCloud(state);

  if (household.role === 'notes') {
    // createdBy: new stickies from this login carry 'notes' (set in store.addStickyNote).
    // With supabase-notes-author.sql applied, the server re-stamps authoritatively.
    const noteArgs = {
      p_notes: state?.notes || '',
      p_notes_updated_at: state?.notesUpdatedAt || null,
      p_note_boards: Array.isArray(state?.noteBoards) ? state.noteBoards : [],
    };
    const rpc = await sb.rpc('update_household_notes', noteArgs);
    const missingRpc = rpc.error && (
      rpc.error.code === 'PGRST202'
      || /update_household_notes|does not exist|42883/i.test(rpc.error.message || '')
    );
    if (!rpc.error) {
      lastSyncedAt = new Date();
      syncStatus = 'ok';
      return true;
    }
    if (!missingRpc) {
      syncStatus = 'error';
      throw rpc.error;
    }
    const { data, error: readErr } = await sb
      .from('budget_states')
      .select('state, updated_at')
      .eq('user_id', ownerId)
      .maybeSingle();
    if (readErr) {
      syncStatus = 'error';
      throw readErr;
    }
    const remote = data?.state && typeof data.state === 'object' ? data.state : {};
    const slice = notesSlice(state);
    // Same author rule as the server function: new stickies are 'notes', existing keep theirs.
    slice.noteBoards = stampNoteAuthors(slice.noteBoards, remote.noteBoards, 'notes');
    payload = stateForCloud({ ...remote, ...slice });
    const stamp = new Date().toISOString();
    const upd = await sb.from('budget_states')
      .update({ state: payload, updated_at: stamp })
      .eq('user_id', ownerId)
      .eq('updated_at', data?.updated_at || '')
      .select('user_id');
    if (upd.error) {
      syncStatus = 'error';
      throw upd.error;
    }
    if (!upd.data || !upd.data.length) {
      syncStatus = 'error';
      return false;
    }
    lastSyncedAt = new Date();
    syncStatus = 'ok';
    return true;
  }

  const stamp = new Date().toISOString();
  let error;
  {
    const row = { user_id: ownerId, state: payload, updated_at: stamp };
    const up = await sb.from('budget_states').upsert(row, { onConflict: 'user_id' });
    error = up.error;
  }
  if (error) {
    syncStatus = 'error';
    throw error;
  }

  lastSyncedAt = new Date();
  syncStatus = 'ok';
  return true;
}

export function schedulePush(pushFn, delayMs = 800) {
  if (!isCloudConfigured()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushFn().catch(err => {
      console.warn('Cloud sync failed', err);
      syncStatus = 'error';
    });
  }, delayMs);
}

function isMissingInboxTable(error) {
  const msg = String(error?.message || '');
  return error?.code === '42P01' || /import_inbox/i.test(msg);
}

/** Pending CoS / Grok bank drops for the budget owner. Empty if table not created yet. */
export async function listPendingBankInbox() {
  const sb = await getClient();
  const session = await getSession();
  if (!sb || !session) return [];
  const ownerId = await budgetOwnerId();
  if (!ownerId) return [];

  const { data, error } = await sb
    .from('import_inbox')
    .select('id, source, account, note, payload, created_at, status')
    .eq('user_id', ownerId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true });

  if (error) {
    if (isMissingInboxTable(error)) return [];
    throw error;
  }
  return data || [];
}

export async function markBankInbox(id, status, stats = null) {
  const sb = await getClient();
  const session = await getSession();
  if (!sb || !session || !id) return false;

  const { error } = await sb
    .from('import_inbox')
    .update({
      status,
      applied_at: status === 'pending' ? null : new Date().toISOString(),
      apply_stats: stats,
    })
    .eq('id', id);

  if (error) {
    if (isMissingInboxTable(error)) return false;
    throw error;
  }
  return true;
}