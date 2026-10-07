import { signIn, signUp, joinHousehold } from '../cloud-sync.js';
import { store } from '../store.js';

export function showCloudAuthScreen(onComplete) {
  const overlay = document.createElement('div');
  overlay.className = 'lock-screen cloud-auth-screen';

  const card = document.createElement('div');
  card.className = 'lock-card';
  card.style.maxWidth = '420px';

  card.innerHTML = `
    <img src="icons/icon-192.png" alt="" width="64" height="64" class="auth-app-icon" />
    <h2>Sign in to FigPig</h2>
    <p class="auth-sub">Your budget syncs across your devices.</p>
    <div class="form-group">
      <label for="cloud-email">Email</label>
      <input type="email" id="cloud-email" placeholder="you@example.com" autocomplete="username" inputmode="email" />
    </div>
    <div class="form-group">
      <label for="cloud-pw">Password</label>
      <input type="password" id="cloud-pw" autocomplete="current-password" />
    </div>
    <details class="auth-join">
      <summary>Joining a household? Enter code</summary>
      <div class="form-group">
        <label for="cloud-join">Household code</label>
        <input type="text" id="cloud-join" placeholder="ABC123" autocomplete="off" autocapitalize="characters" class="input-code" />
        <p class="hint">Have a household code? Enter it to join with notes-only access.</p>
      </div>
    </details>
    <p id="cloud-auth-error" class="form-error" role="alert" style="display:none"></p>
    <button class="btn btn-primary btn-lg btn-block" id="cloud-signin">Sign in</button>
    <button class="btn btn-secondary btn-lg btn-block" id="cloud-signup">Create account</button>
    <button class="btn btn-tertiary btn-block" id="cloud-offline">Continue offline (this device only)</button>
  `;

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const emailIn = card.querySelector('#cloud-email');
  const pwIn = card.querySelector('#cloud-pw');
  const joinIn = card.querySelector('#cloud-join');
  const errEl = card.querySelector('#cloud-auth-error');

  function showError(msg) {
    errEl.textContent = msg;
    errEl.style.display = msg ? 'block' : 'none';
  }

  function validateCredentials() {
    const email = emailIn.value.trim();
    const password = pwIn.value;
    if (!email) return 'Enter your email address.';
    if (!password) return 'Enter a password.';
    if (password.length < 6) return 'Password must be at least 6 characters.';
    return '';
  }

  async function handleSignIn() {
    showError('');
    const validationError = validateCredentials();
    if (validationError) {
      showError(validationError);
      return;
    }
    try {
      await signIn(emailIn.value.trim(), pwIn.value);
      const joinCode = joinIn.value.trim();
      if (joinCode) {
        await joinHousehold(joinCode);
        await store.forcePullFromCloud();
        overlay.remove();
        window.location.reload();
        return;
      }
      const pull = await store.pullFromCloud();
      if (!pull.hadRemote && store.hasMeaningfulLocalData()) {
        await store.pushToCloud({ force: true });
      } else if (!pull.hadRemote && !store.hasMeaningfulLocalData()) {
        showError('No budget found. Sync from the main login, or enter a household code above for notes-only.');
        return;
      } else if (pull.hadRemote && !pull.applied && store.hasMeaningfulLocalData()) {
        await store.pushToCloud();
      }
      overlay.remove();
      window.location.reload();
    } catch (e) {
      showError(friendlyAuthError(e));
    }
  }

  function friendlyAuthError(err) {
    const msg = err?.message || '';
    if (msg.includes('anonymous sign-ins are disabled') || err?.code === 'anonymous_provider_disabled') {
      return 'Email sign-up may not be enabled in Supabase, or the API key may be wrong. '
        + 'In Supabase: Authentication → Providers → Email → Enable. '
        + 'Try the legacy anon key (eyJ...) in config.js instead of the publishable key.';
    }
    if (err?.code === 'email_provider_disabled') {
      return 'Email sign-up is disabled in Supabase. Enable it under Authentication → Providers → Email.';
    }
    return msg || 'Request failed';
  }

  async function handleSignUp() {
    showError('');
    const validationError = validateCredentials();
    if (validationError) {
      showError(validationError);
      return;
    }
    try {
      await signUp(emailIn.value.trim(), pwIn.value);
      await signIn(emailIn.value.trim(), pwIn.value);
      const joinCode = joinIn.value.trim();
      if (joinCode) {
        await joinHousehold(joinCode);
        await store.forcePullFromCloud();
      } else {
        await store.pushToCloud({ force: true });
      }
      overlay.remove();
      window.location.reload();
    } catch (e) {
      showError(friendlyAuthError(e));
    }
  }

  card.querySelector('#cloud-signin').addEventListener('click', handleSignIn);
  card.querySelector('#cloud-signup').addEventListener('click', handleSignUp);
  card.querySelector('#cloud-offline').addEventListener('click', () => {
    overlay.remove();
    onComplete();
  });
  pwIn.addEventListener('keydown', e => { if (e.key === 'Enter') handleSignIn(); });
}