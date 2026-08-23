import { signIn, signUp, joinHousehold } from '../cloud-sync.js';
import { store } from '../store.js';

export function showCloudAuthScreen(onComplete) {
  const overlay = document.createElement('div');
  overlay.className = 'lock-screen cloud-auth-screen';

  const card = document.createElement('div');
  card.className = 'lock-card';
  card.style.maxWidth = '420px';

  card.innerHTML = `
    <h2>☁️ Cloud Sync</h2>
    <p style="color:var(--text-muted);font-size:0.9rem;line-height:1.5">
      Main account: sign in as usual. Notes-only (spouse): create her own email login, then enter the household code from Settings.
    </p>
    <div class="form-group">
      <label>Email</label>
      <input type="email" id="cloud-email" placeholder="you@example.com" autocomplete="username" />
    </div>
    <div class="form-group">
      <label>Password</label>
      <input type="password" id="cloud-pw" placeholder="Password" autocomplete="current-password" />
    </div>
    <div class="form-group">
      <label>Household code (notes-only, optional)</label>
      <input type="text" id="cloud-join" placeholder="ABC123" autocomplete="off" style="text-transform:uppercase;letter-spacing:0.08em" />
    </div>
    <p id="cloud-auth-error" style="color:var(--negative);font-size:0.8rem;display:none;margin-bottom:0.75rem"></p>
    <button class="btn btn-primary" style="width:100%;margin-bottom:0.5rem" id="cloud-signin">Sign In</button>
    <button class="btn btn-secondary" style="width:100%;margin-bottom:0.5rem" id="cloud-signup">Create Account</button>
    <button class="btn btn-secondary btn-sm" style="width:100%" id="cloud-offline">Continue offline (this device only)</button>
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