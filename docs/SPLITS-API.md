# Splits API: list envelopes + edit an applied split

Two Netlify functions. Both read/write only the owner's `budget_states` row
(`FIGPIG_OWNER_USER_ID`) server-side with the service key; the key never leaves Netlify.

## Env vars (Netlify → Site configuration → Environment variables)

| Name | Used by | Notes |
|---|---|---|
| `FIGPIG_SPLIT_WRITE_TOKEN` | `PATCH /api/transactions/:id/split` | **New.** Random secret, **≥ 24 chars**. Own token: `FIGPIG_TX_SPLIT_TOKEN`, `FIGPIG_TX_WRITE_TOKEN` and the read token do not work here. Unset/short → 503. |
| `FIGPIG_BILLS_READ_TOKEN` | `GET /api/envelopes` | Existing read token. This endpoint also needs it to be ≥ 24 chars (fails closed with 503 otherwise). |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FIGPIG_OWNER_USER_ID` | both | Existing. Missing or non-https URL → 503. |

**Token on the box:** `/home/box/.secrets/figpig/split_write_token` (mode 600, one line, no newline
needed). David (or CoS, with David's yes) generates it, e.g. `openssl rand -hex 32`, puts the
same value in Netlify, and writes it to that file. It is never committed to git and this repo
never mints it.

## GET /api/envelopes

```bash
curl -s https://hernandez-finops.netlify.app/api/envelopes \
  -H "Authorization: Bearer $(cat /home/box/.secrets/figpig/bills_read_token)"
```

Since the envelope reset API this also returns current-month balances (`allocated`, `spent`,
`remaining`, `bill_id`, top-level `kind` per envelope, plus `checking_balance`, `total_allocated`, `unallocated`,
`bonus_available`, `newest_transaction_date`, `state_hash`). Shape and rules: **`docs/ENVELOPES-API.md`**.
Still no notes or plan internals. Alt header: `x-figpig-bills-token`. 30 req/min per IP.

## PATCH /api/transactions/:id/split

Compare-and-swap edit of a split that is already applied on one transaction.

```bash
curl -s -X PATCH https://hernandez-finops.netlify.app/api/transactions/66a1b58e/split \
  -H "Authorization: Bearer $(cat /home/box/.secrets/figpig/split_write_token)" \
  -H "Content-Type: application/json" \
  -d '{
    "expected": [{"envelope":"Groceries","amount":136.88},{"envelope":"Household / Misc","amount":44.95}],
    "split":    [{"envelope":"Clothing","amount":26.71},{"envelope":"Household / Misc","amount":19.77},{"envelope":"Groceries","amount":135.35}],
    "note": "Receipt re-sort"
  }'
```

`:id` is the FigPig transaction id (full id; 1–128 chars of letters, digits, `. _ : -`).
Alt auth header: `x-figpig-split-write-token`.

Rules
- Body keys: `expected`, `split`, optional `note` (≤ 200). Anything else → 400.
- `expected` and `split`: 1–10 lines of `{envelope, amount}`; amount > 0, ≤ 1,000,000, ≤ 2 decimals.
  Envelope names match top-level envelopes case-insensitively; an envelope may appear once.
- `expected` must equal the stored split (order-independent, to the cent) or → **409 `stale_expected`**
  with `current`. Re-read and retry with the current split.
- `split` must add up to the transaction amount **exactly** → otherwise **400 `sum_mismatch`**.
- Unknown envelope → **400 `unknown_envelope`** with `validEnvelopes`. Envelopes are never created.
- Writes through the UI's own `store.updateTransaction` path: only `splits` changes. No new rows;
  amount, checking, debts/snowball untouched.
- Audit: appended to `state.splitEditAudit` (last 200): `{at, actor:"CoS", txId, before, after, note?}`.
- 10 writes/min per IP (counted before auth).

Responses

| Status | Body |
|---|---|
| 200 | `{ok, status:"updated"\|"unchanged", transaction:{id,date,amount,description}, before:[…], split:[…]}` |
| 400 | `invalid_body`, `sum_mismatch` (+`transactionAmount`,`splitTotal`), `unknown_envelope` (+`envelope`,`validEnvelopes`) |
| 401 | `unauthorized` |
| 404 | `not_found` |
| 409 | `stale_expected` (+`current`), `not_split`, `conflict` (cloud changed twice while saving), `no_budget` |
| 413 / 415 / 405 / 429 | body too large / not JSON / wrong method / `rate_limited` |
| 502 | `upstream_error`: any Supabase failure (5xx, 4xx, bad body, network). Never reported as a conflict. |
| 503 | `not_configured` |

Tests: `npm run test:split-edit` (fake data, Supabase mocked, no network).
