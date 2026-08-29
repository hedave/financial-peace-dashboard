# Audit — FigPig / financial-peace-dashboard

Scoped inspection only. No app rewrite. Kalshi: not present in this repo.

## What is true

- Static vanilla JS app. `package.json` has **no** `dependencies` / `devDependencies` and **no** lockfile.
- Generated `js/config.js` is **gitignored** and was **absent** on a clean checkout. `js/cloud-sync.js` imports `./config.js`, so the app module graph does not load until install/build writes that file.
- This Cloud Agent run started on a default VM. `environment-info` reported a Personal environment for this repo only (`environmentJsonPath`: null; no finished builds). There was **no** `.cursor/environment.json` in the tree. This PR adds one. Do not reuse `my_first_rails_app` or `bot-ops` environments.
- Existing automated test command: `npm run test:import` → `scripts/test-import-reconcile.mjs`.

## Top issues (paths)

1. **Missing generated config blocks the app** — `js/cloud-sync.js` (import of `./config.js`); writer is `scripts/generate-config.js`; template is `js/config.example.js`; ignore rule in `.gitignore`. Fresh clone / agent VM has no `js/config.js` until `npm run build` / the environment `install` runs.

2. **`npm start` is Windows-only** — `package.json` script `start` calls `py -3`. Linux agents need `python3 -m http.server 8080 --bind 127.0.0.1`. `start.bat` already prefers a Node static server, then `py`.

3. **Snowball / budget math is a large unsplit surface** — `js/store.js` (~4100 lines) owns `getToAllocate`, `getCategoryRemaining`, `getSurplusForSnowball`, `getMonthEndSnowballForecast`, `getBankSurplusForSnowball`, import checking updates. UI callers: `js/pages/budget.js`, `js/pages/debt.js`, `js/pages/dashboard.js`, `js/advisor/context.js`, `js/advisor/engine.js`. `scripts/test-import-reconcile.mjs` covers import/reconcile and a few store cases (holds, travel leftover, GSA EFT), not a full math suite. **Do not change this math unless that existing test fails.**

4. **USAA paste fixture already in git** — `scripts/test-usaa-mobile-paste.mjs` embeds a long mobile-web paste (merchants, amounts, running balances, a `mobile.usaa.com` URL with `accountId=`). It is **not** in `package.json` scripts. Do not add more live pastes. Do not log into USAA to refresh it. Redaction is a later, explicit task.

5. **No `npm test` / thin coverage** — only `test:import`. No tests for `js/advisor/engine.js`, `js/pdf-import.js`, or most of `js/pages/*.js`. Parser probe `scripts/test-usaa-mobile-paste.mjs` is unwired.

6. **Runtime deps are CDNs, not install** — Chart.js in `index.html` (`cdn.jsdelivr.net`); Supabase client in `js/cloud-sync.js` (`esm.sh`). Offline or locked-down egress will break charts/sync even after a green install.

7. **No root README** — humans/agents get `DEPLOY.md` + `docs/USER-GUIDE.md` only. Install/test/run now live in `AGENTS.md`.

8. **Service worker cache name is static** — `sw.js` uses `CACHE = 'figpig-v1'` while `index.html` cache-busts assets with `?v=20260827i`. Precache list is only manifest + icons. Stale-shell risk if `CACHE` is not bumped when behavior changes.

9. **PWA / deploy assume generated config on Netlify** — `netlify.toml` build is `node scripts/generate-config.js`. Local/agent must do the same; do not commit the output.

## Out of scope (not done)

USAA login, scraping, moving money, large refactors, new features, merge, Kalshi, rewriting snowball/budget math.
