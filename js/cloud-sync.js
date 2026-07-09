import { SUPABASE_URL, SUPABASE_ANON_KEY, CLOUD_SYNC_ENABLED } from './config.js';

let client = null;
let pushTimer = null;
let lastSyncedAt = null;
let syncStatus = 'idle'; // idle | syncing | error | ok

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

export async function loadRemoteState() {
  const sb = await getClient();
  const session = await getSession();
  if (!sb || !session) return null;

  const { data, error } = await sb
    .from('budget_states')
    .select('state, updated_at')
    .eq('user_id', session.user.id)
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

  syncStatus = 'syncing';
  const row = {
    user_id: session.user.id,
    state,
    updated_at: new Date().toISOString(),
  };

  const { error } = await sb.from('budget_states').upsert(row, { onConflict: 'user_id' });
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