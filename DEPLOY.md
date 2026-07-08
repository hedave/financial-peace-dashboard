# Host on Netlify + Sync with Supabase

## Part 1 — Supabase (database + login)

1. Go to [supabase.com](https://supabase.com) → **Start your project** → sign up (free).
2. **New project** → name it `financial-peace` → set a DB password (save it somewhere) → region closest to you → **Create**.
3. Wait ~2 minutes for the project to finish provisioning.
4. **SQL Editor** → **New query** → open `supabase-setup.sql` from this folder → paste → **Run**.
5. **Authentication** → **Providers** → **Email**:
   - **Email** must be **ON / Enabled**
   - **Allow new users to sign up** must be **ON**
   - Turn **OFF** “Confirm email” (easier for personal/family use)
   - **Save**
   - You do **not** need to enable **Anonymous** sign-ins
6. **Project Settings** → **API** (or **API Keys**) → copy:
   - **Project URL** (e.g. `https://abcdefgh.supabase.co`)
   - **Publishable key** (`sb_publishable_...`) — this replaced the old name "anon key"
   - If you only see legacy keys: **anon public** (`eyJ...`) works too

## Part 2 — Configure the app

1. Open `js/config.js` in this folder.
2. Paste your URL and anon key:

```javascript
export const SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJ...your-anon-key...';
export const CLOUD_SYNC_ENABLED = true;
```

3. Save the file.

## GitHub + Netlify auto-deploy (recommended)

One-time setup; then `git push` updates the live site automatically.

### A — Install Git

[git-scm.com/download/win](https://git-scm.com/download/win) → install → restart terminal.

### B — Create a private GitHub repo

[github.com/new](https://github.com/new) → name `financial-peace-dashboard` → **Private** → create (no README).

### C — Push from your PC

```powershell
cd C:\Users\deher\financial-peace-dashboard
git init
git add .
git commit -m "Initial commit: Financial Peace Dashboard"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/financial-peace-dashboard.git
git push -u origin main
```

### D — Connect Netlify to GitHub

1. Netlify → your site → **Site configuration** → **Build & deploy** → **Link repository** (or import from GitHub)
2. Build command: `node scripts/generate-config.js` · Publish: `.`
3. **Environment variables**:

| Key | Value |
|-----|--------|
| `SUPABASE_URL` | your Supabase project URL |
| `SUPABASE_ANON_KEY` | publishable or legacy anon key |
| `CLOUD_SYNC_ENABLED` | `true` |

4. Deploy. Future pushes to `main` auto-deploy.

### E — Daily workflow

```powershell
git add .
git commit -m "What you changed"
git push
```

Keep `js/config.js` locally for dev (gitignored). Netlify builds it from env vars.

---

## Part 3 — Netlify (manual drag-and-drop hosting)

1. Go to [app.netlify.com](https://app.netlify.com) → sign up (free).
2. Open [app.netlify.com/drop](https://app.netlify.com/drop).
3. Drag the entire `financial-peace-dashboard` folder onto the page.
4. Wait for deploy → you get a URL like `https://random-words-123.netlify.app`.
5. Optional: **Site configuration** → **Domain management** → **Edit site name** → e.g. `deher-finpeace.netlify.app`.

## Part 4 — First use on the live site

1. Open your Netlify URL on your PC.
2. **Cloud Sync** screen → **Create Account** with your email + password.
   - Your current local data (if any) uploads on first sign-up.
3. On your phone: open the same URL → **Sign In** with the same email/password.
4. Optional: **Add to Home Screen** for an app-like icon.
5. **Settings** → set an app password (optional extra lock).
6. **Settings** → **Export Backup (JSON)** monthly as a safety net.

## Part 5 — Updates after you change the code

1. Edit `js/config.js` if needed (keep sync enabled).
2. Drag the folder to Netlify again (**Deploys** → manual deploy, or use Drop again).
3. Your cloud data is **not** wiped by redeploys — it lives in Supabase.

## Family sharing

Use **one account** on every device (you + your wife). Same email/password everywhere.

## Troubleshooting

| Problem | Fix |
|--------|-----|
| “Anonymous sign-ins are disabled” | Enable **Email** provider (below). Try the **legacy anon** key (`eyJ...`) in `config.js` instead of publishable key. Hard-refresh (Ctrl+F5). |
| Sign up says check email | Disable “Confirm email” in Supabase → Authentication → Email |
| Sync failed | Settings → Sync Now; check browser console (F12) |
| Empty budget on new device | On your **main PC** (with data): Settings → **Sync Now**. Then on the other device: Sign Out → Sign In again. Or Settings → Restore Backup. |
| Wife's Mac shows all zeros | Cloud was empty when she signed in. Push from PC first (Sync Now). Do not rely on a blank device to populate the cloud. |
| Old localhost data missing | On PC localhost: export JSON backup → live site → Restore Backup, or sign up once from localhost with config enabled |