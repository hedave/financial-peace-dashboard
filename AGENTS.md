# FigPig Financial — agent notes

Static household budget + debt-snowball app (vanilla JS, no bundler). Repo: `financial-peace-dashboard`. Data lives in `localStorage` and optionally Supabase. This is **not** `my_first_rails_app` or `bot-ops`.

## Install

There are **no npm packages** in `package.json`. Do not invent a lockfile or add dependencies.

Real bootstrap (required): generate gitignored `js/config.js` so `js/cloud-sync.js` can import it.

```bash
node --version
node scripts/generate-config.js
test -f js/config.js
```

Same command is in `.cursor/environment.json` `install`. Cloud sync stays off unless `SUPABASE_URL` and `SUPABASE_ANON_KEY` are already in the environment. Copy `js/config.example.js` → `js/config.js` only for local secret-filled runs; **never commit** `js/config.js`, `.env`, cookies, or account numbers.

## Test

Existing test command (the one that exists today):

```bash
npm run test:import
```

That runs `node scripts/test-import-reconcile.mjs` (import/reconcile + a few store checks). There is no `npm test` script.

`scripts/test-usaa-mobile-paste.mjs` is a manual parser probe, **not** wired into `package.json`. Do not treat it as the suite. Do not paste live bank data into it.

## Run

`package.json` `"start"` is Windows-only (`py -3`). On this Linux VM / Cloud Agent:

```bash
python3 -m http.server 8080 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8080`. Windows local: `start.bat` (Node server first, then `py`).

`npm run build` is an alias for `node scripts/generate-config.js` (Netlify uses the same).

## Do not touch

- **No USAA login.** No bank passwords, MFA, cookies, or session reuse. Import is user-paste / local CSV / local PDF only (`js/csv-import.js`, `js/pdf-import.js`, `js/pages/transactions.js`).
- **No scraping** banks or any live financial site. Do not fetch `mobile.usaa.com` or similar.
- **No secrets** in git: `.env`, `js/config.js`, cookies, account/routing numbers, Supabase service keys.
- **Do not change snowball or budget math** in `js/store.js` (and callers in `js/pages/budget.js`, `js/pages/debt.js`, `js/pages/dashboard.js`, `js/advisor/`) unless an existing test already fails and the change is required to make that test green.
- **Do not change Kalshi** (this repo has none). Do not move money, merge this PR, or expand into features/refactors.

## Layout

| Path | Role |
|------|------|
| `index.html` | Shell; Chart.js from CDN |
| `js/store.js` | State + envelope/snowball math (do not casually edit) |
| `js/csv-import.js` | Bank CSV / USAA paste parse (local only) |
| `js/cloud-sync.js` | Supabase (needs `js/config.js`) |
| `scripts/generate-config.js` | Writes `js/config.js` from env |
| `scripts/test-import-reconcile.mjs` | Existing automated test |
| `DEPLOY.md` | Netlify + Supabase deploy |
| `docs/USER-GUIDE.md` | Product model |

See `AUDIT.md` for current issues. Failure policy: leave docs + what failed; do not rewrite the app.
