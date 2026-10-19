# Envelopes API: balances, snapshots, restore, reset (dry-run default)

Two Netlify functions. Both read/write only the owner's `budget_states` row
(`FIGPIG_OWNER_USER_ID`) server-side with the service key; the key never leaves Netlify.

| Function | Routes | Token |
|---|---|---|
| `netlify/functions/envelopes.mjs` | `GET /api/envelopes`, `GET /api/envelopes/snapshots` | `FIGPIG_BILLS_READ_TOKEN` (existing read token) |
| `netlify/functions/envelopes-write.mjs` | `POST /api/envelopes/snapshot`, `POST /api/envelopes/snapshots/:id/restore`, `POST /api/envelopes/reset` | `FIGPIG_ENVELOPE_WRITE_TOKEN` (**new**) |

## Env vars (Netlify → Site configuration → Environment variables)

| Name | Notes |
|---|---|
| `FIGPIG_ENVELOPE_WRITE_TOKEN` | **New.** Random secret, **≥ 24 chars**, used only by the three write routes. Must differ from every other FigPig token (`FIGPIG_BILLS_READ_TOKEN`, `FIGPIG_SPLIT_WRITE_TOKEN`, `FIGPIG_TX_SPLIT_TOKEN`, `FIGPIG_TX_WRITE_TOKEN`, `FIGPIG_INGEST_SECRET`); unset, short or reused → **503** (fails closed). |
| `FIGPIG_BILLS_READ_TOKEN` | Existing read token for the two GETs (≥ 24 chars or 503). The write token does **not** work on GETs, and the read token does not work on writes. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FIGPIG_OWNER_USER_ID` | Existing. Missing or non-https URL → 503. |

**Token on the box:** `/home/box/.secrets/figpig/envelope_write_token` (mode 600, one line).
David (or CoS, with David's yes) generates it, e.g. `openssl rand -hex 32`, puts the same value in
Netlify, and writes it to that file. It is never committed to git and this repo never mints it.

Auth header: `Authorization: Bearer <token>` (alt for writes: `x-figpig-envelope-write-token`;
alt for reads: `x-figpig-bills-token`). Tokens are compared in constant time.
Rate limits per client IP, counted before auth: reads 30/min, writes 10/min → 429.

## Model (what the numbers mean)

All numbers come from the app's own store getters for the **current month** — the same ones the
Budget page uses. Nothing here re-implements budget or snowball math.

| Field | Source |
|---|---|
| `allocated` | `store.getCategoryBudgeted` — monthly budget (+ any one-month snowball plan extra) |
| `spent` | `store.getCategorySpent` |
| `remaining` | `store.getCategoryRemaining` — allocated + carry-over + envelope moves + bonus − spent |
| `bill_id` | id of the bill linked to the envelope (`bill.categoryId`; unpaid preferred), else `null` |
| `checking_balance` | `state.balances.checking` |
| `total_allocated` | `store.getTotalBudgeted` (top-level envelopes only) |
| `unallocated` | `checking_balance − total_allocated`; **negative = over-allocated** |
| `newest_transaction_date` | latest `YYYY-MM-DD` across transactions (feed freshness) |
| `state_hash` | sha256 over the fields above plus each envelope's raw plan/carry. Pass it back as `expected_state_hash`. |

A reset sets **allocations** (`monthlyBudget`, the field the Edit Envelope modal writes). It does
not change carry-over, envelope moves, bonus allocations, snowball plan extras, transactions,
checking, bills or debts. `remaining` after a reset is therefore `target + carry + moves + bonus − spent`;
the dry-run table shows both columns so you can see this before applying.
Only top-level envelopes are reset targets; sub-envelopes are listed (with `group`) but untouched.

## GET /api/envelopes

```bash
curl -s https://hernandez-finops.netlify.app/api/envelopes \
  -H "Authorization: Bearer $(cat /home/box/.secrets/figpig/bills_read_token)"
```

```json
{ "ok": true, "month": "2026-10", "checking_balance": 4000, "total_allocated": 5979.49,
  "unallocated": -1979.49, "newest_transaction_date": "2026-10-16",
  "state_hash": "<64 hex>",
  "envelopes": [
    {"id":"…","name":"Mortgage","allocated":3219.49,"spent":0,"remaining":3219.49,"bill_id":"…"},
    {"id":"…","name":"Groceries","allocated":1400,"spent":212.44,"remaining":1187.56,"bill_id":null},
    {"id":"…","name":"Christmas","sinkingFund":true,"allocated":500,"spent":0,"remaining":500,"bill_id":null},
    {"id":"…","name":"Sub","group":"Parent","allocated":0,"spent":0,"remaining":0,"bill_id":null}
  ] }
```

No notes, transaction rows, bill names/amounts, debts or raw plan fields.

## POST /api/envelopes/reset

```bash
TOKEN="$(cat /home/box/.secrets/figpig/envelope_write_token)"
HASH="$(curl -s https://hernandez-finops.netlify.app/api/envelopes \
  -H "Authorization: Bearer $(cat /home/box/.secrets/figpig/bills_read_token)" | jq -r .state_hash)"

# 1) Dry run (the default when dry_run is missing): writes nothing
curl -s -X POST https://hernandez-finops.netlify.app/api/envelopes/reset \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"expected_state_hash\":\"$HASH\",
       \"targets\":[{\"envelope\":\"Groceries\",\"amount\":1000},{\"envelope\":\"Mortgage\",\"amount\":3219.49}],
       \"default_amount\":0, \"note\":\"Clean reset\"}"

# 2) Apply — only after David's OK on the dry-run table
curl -s -X POST https://hernandez-finops.netlify.app/api/envelopes/reset \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"dry_run\":false,\"expected_state_hash\":\"$HASH\",
       \"targets\":[{\"envelope\":\"Groceries\",\"amount\":1000},{\"envelope\":\"Mortgage\",\"amount\":3219.49}],
       \"default_amount\":0, \"note\":\"Clean reset\"}"
```

Body (unknown keys → 400):

| Key | Rules |
|---|---|
| `dry_run` | boolean, default **`true`** |
| `expected_state_hash` | **required**, 64 hex from GET. Mismatch → **409 `stale_state`** (+ current `state_hash`). |
| `targets` | 0–100 × `{envelope, amount}`; envelope = top-level name (case-insensitive, once each); amount ≥ 0, ≤ 1,000,000, ≤ 2 decimals |
| `default_amount` | optional, same amount rules; applied to every top-level envelope **not** in `targets`. **Omit it to leave untargeted envelopes unchanged.** |
| `note` | optional string ≤ 200 |

At least one of `targets` / `default_amount` is required. Unknown envelope → **400
`unknown_envelope`** with `validEnvelopes`. Envelopes are never created or deleted.

Real run (`dry_run:false`):
1. Re-checks the hash, then saves an automatic snapshot (`reason:"pre_reset"`) as its **own write**.
2. Applies the allocations on the row that holds that snapshot (budget_states `updated_at` CAS, one retry;
   the hash and the snapshot's presence are re-checked on retry).
3. Appends an audit entry to `state.envelopeResetAudit` (last 200):
   `{at, actor:"CoS", action:"reset", snapshot_id, before:[{categoryId,monthlyBudget,carryOver}], after:[…], note?}`
   (changed envelopes only).
Only those envelope fields plus `envelopeSnapshots` / `envelopeResetAudit` are written back; the rest of
the row is saved exactly as loaded.

Response (dry run and real run share the shape):

```json
{ "ok": true, "status": "dry_run" | "applied", "dry_run": true,
  "snapshot": {"id":"snap_…","at":"…","reason":"pre_reset","month":"2026-10","state_hash":"…"},  // real run only
  "state_hash_before": "…", "state_hash_after": "…",
  "totals": { "total_allocated_before": 5979.49, "total_allocated_after": 4359.49, "total_allocated_change": -1620,
              "unallocated_before": -1979.49, "unallocated_after": -359.49, "unallocated_change": 1620 },
  "changes": [ {"id":"…","envelope":"Groceries","allocated_before":1400,"allocated_after":1000,
                "remaining_before":1187.56,"remaining_after":787.56,"changed":true}, … ] }
```

## Snapshots

```bash
# Manual snapshot
curl -s -X POST https://hernandez-finops.netlify.app/api/envelopes/snapshot \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"note":"before review"}'

# List (read token), newest first; no per-envelope amounts
curl -s https://hernandez-finops.netlify.app/api/envelopes/snapshots \
  -H "Authorization: Bearer $(cat /home/box/.secrets/figpig/bills_read_token)"

# Restore (dry run by default; add "dry_run":false to apply)
curl -s -X POST https://hernandez-finops.netlify.app/api/envelopes/snapshots/snap_0123456789abcdef/restore \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"expected_state_hash\":\"$HASH\",\"dry_run\":false}"
```

- A snapshot stores, in `state.envelopeSnapshots` (last 30), `{id, at, actor:"CoS", reason, month,
  state_hash, total_allocated, categories:[{id,name,monthlyBudget,carryOver}], note?}`. `reason` is
  `manual`, `pre_reset` or `pre_restore`. The body takes only `note`.
- Restore: body `{expected_state_hash, dry_run?=true, note?}`. Hash CAS (409 `stale_state`), 404 unknown id,
  **409 `snapshot_month_mismatch`** if the snapshot is from another month (carry has rolled since),
  **409 `envelopes_changed`** if envelopes were added/removed since. Sets each envelope's
  `monthlyBudget` and `carryOver` back; snapshots taken before a restore (`pre_restore`) make the restore
  itself undoable. Restoring a `pre_reset` snapshot returns the exact pre-reset `state_hash`.
- Snapshots live in the budget JSON. A device pushing a stale full state over the row can drop them,
  like any other server-side edit; the reset refuses to apply if its own snapshot is gone.

## Errors

| Status | `error` |
|---|---|
| 400 | `invalid_body` (+`message`), `unknown_envelope` (+`envelope`, `validEnvelopes`) |
| 401 | `unauthorized` |
| 404 | `not_found` (route or snapshot) |
| 409 | `stale_state` (+`state_hash`), `conflict`, `no_budget`, `snapshot_month_mismatch`, `envelopes_changed`, `state_not_normalized` |
| 405 / 413 / 415 / 429 | wrong method / body > 16 KB / not JSON / `rate_limited` |
| 500 | `write_refused` (planned value did not land; nothing saved) |
| 502 | `upstream_error`: any Supabase failure (5xx, 4xx, bad body, network) |
| 503 | `not_configured` |

Tests: `npm run test:envelopes` (fake data, Supabase mocked, no network). Also part of `npm run test:import`.
