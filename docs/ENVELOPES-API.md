# Envelopes API: balances, snapshots, restore, reset, overage cover (dry-run default)

Two Netlify functions. Both read/write only the owner's `budget_states` row
(`FIGPIG_OWNER_USER_ID`) server-side with the service key; the key never leaves Netlify.

| Function | Routes | Token |
|---|---|---|
| `netlify/functions/envelopes.mjs` | `GET /api/envelopes`, `GET /api/envelopes/snapshots` | `FIGPIG_BILLS_READ_TOKEN` (existing read token) |
| `netlify/functions/envelopes-write.mjs` | `POST /api/envelopes/snapshot`, `POST /api/envelopes/snapshots/:id/restore`, `POST /api/envelopes/reset`, `POST /api/envelopes/overage` | `FIGPIG_ENVELOPE_WRITE_TOKEN` (**new**) |

## Env vars (Netlify → Site configuration → Environment variables)

| Name | Notes |
|---|---|
| `FIGPIG_ENVELOPE_WRITE_TOKEN` | **New.** Random secret, **≥ 24 chars**, used only by the four write routes. Must differ from every other FigPig token (`FIGPIG_BILLS_READ_TOKEN`, `FIGPIG_SPLIT_WRITE_TOKEN`, `FIGPIG_TX_SPLIT_TOKEN`, `FIGPIG_TX_WRITE_TOKEN`, `FIGPIG_INGEST_SECRET`); unset, short or reused → **503** (fails closed). |
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
| `bonus_available` | `store.getBonusAvailable` — the free bonus pot (Budget page "Bonus available"): this month's cleared Bonus Income deposits not earmarked, minus bonus already assigned. Unmatched income (refunds, extra deposits) lands here. |
| `kind` (top-level only) | `store.getEnvelopeKind`: `bill` (a Bills-page bill with an amount is linked), `debt` (an active debt is linked), `sinking`, `spend` |
| `newest_transaction_date` | latest `YYYY-MM-DD` across transactions (feed freshness) |
| `state_hash` | sha256 over the fields above (including `bonus_available`) plus each envelope's raw plan/carry. Pass it back as `expected_state_hash`. |

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
  "unallocated": -1979.49, "bonus_available": 0, "newest_transaction_date": "2026-10-16",
  "state_hash": "<64 hex>",
  "envelopes": [
    {"id":"…","name":"Mortgage","kind":"bill","allocated":3219.49,"spent":0,"remaining":3219.49,"bill_id":"…"},
    {"id":"…","name":"Groceries","kind":"spend","allocated":1400,"spent":212.44,"remaining":1187.56,"bill_id":null},
    {"id":"…","name":"Christmas","sinkingFund":true,"kind":"sinking","allocated":500,"spent":0,"remaining":500,"bill_id":null},
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

## POST /api/envelopes/overage

David's rule (verbatim): *"if I go over, I want the overage to affect either a selected or all envelopes
equally (minus bills) with a forced split, unless there is unused bonus funds, then it will draw from there first."*

How it works (current month, integer cents, helpers in `js/envelope-overage.js`):

1. **Overage** = a top-level envelope with `remaining < 0` that is not a bill, debt or pass-through
   (Work travel) envelope. Bill/debt envelopes going over are "extra toward a bill" in the app and are never split.
2. **Bonus first.** Take up to `bonus_available` from the free bonus pot (the same pot as the Budget page
   "Assign bonus"). Several overspent envelopes are filled biggest overage first (then name).
3. **Forced equal split** of whatever bonus did not cover, across the target set:
   - `targets: "all"` — every top-level envelope **except** bills, debts, pass-through, the overspent
     envelopes and any other envelope already below $0; sinking funds included unless
     `include_sinking_funds:false`.
   - `targets: ["Name", …]` — exactly those (case-insensitive). A bill/debt/pass-through name → 400
     `protected_envelope`. An overspent name is dropped and listed in `excluded`.
4. **Pennies:** shares are `floor(rest / n)`; the leftover pennies go one each to targets in name order
   (then id). Debits always sum to the split total exactly.
5. **When an equal share would push a target below $0** (`negative_rule`):
   - `"cascade"` (**default**): a target gives at most what it has left; the excess is re-split equally
     across the targets that still have room (water-fill). Only when every target is drained is the residue
     forced equally across all targets (they go negative, `went_negative:true`, `forced_below_zero` > 0,
     and a `warnings` line). Envelopes at $0 are never pushed negative while another target has room.
   - `"allow"`: strict equal shares; a target may go negative (flagged the same way).
   Either way every covered envelope ends at exactly **$0**.

What it writes (month-only, the app's own record shapes — **no schema change**, `monthlyBudget` and
`carryOver` untouched, so next month's plan is unchanged):
- bonus draw → `state.monthBonusAllocations[month]` rows `{id, categoryId, amount, note, at, overageBatchId}`
  (like **Assign bonus**; shows as "Bonus allocated" with **Undo** in envelope activity);
- split → `state.monthEnvelopeMoves[month]` rows `{id, fromId, toId, amount, note, at, coverBatchId, overageBatchId}`
  (like **Cover overspend**; each has **Undo** under "This month’s moves" in the Budget Move dialog) plus
  `state.overspendCoverIous`, so **Repay cover from bonus** offers to refill the targets when bonus lands later;
- audit → `state.envelopeResetAudit` `{at, actor:"CoS", action:"overage", snapshot_id, batch_id, month, total,
  from_bonus, split_total, negative_rule, bonus:[{allocationId,categoryId,amount}], moves:[{moveId,fromId,toId,amount}], note?}`.

A real run saves a `pre_overage` snapshot first (own write), like reset. **Note:** snapshots hold
`monthlyBudget`/`carryOver` only, so restoring `pre_overage` does **not** undo an overage; undo it with the
per-row Undo buttons in the app (or reverse the rows listed in the audit entry).

### Budget page: "Cover overage" button (build 20261019a)

Shown in the "overspent" banner (and under **More budget actions**) when any non-bill, non-debt,
non-pass-through envelope is below $0 this month, for logins that can write the budget.
The panel shows what the bonus pot covers, a target picker (**All envelopes (minus bills)** or
**Pick envelopes** — a checklist where the overspent envelope and bill/debt/pass-through envelopes
are disabled), an **Include sinking funds** toggle (default on), a live preview of each debit with
before → after and a "goes below $0" flag, and **Confirm**, which applies and refreshes the page.

**Auth / write path:** the browser does **not** call this endpoint and holds **no token**. Like
**Cover overspend** and **Assign bonus**, it runs the same planner (`js/envelope-overage.js`:
`overageOptions`, `planOverage`, `coverOverageInStore`) on the live store and saves through the store's
own path (`store.update`/`save` → localStorage + the signed-in household's cloud sync). Confirm re-plans
and refuses if the plan differs from the preview (client-side compare-and-swap; the preview refreshes),
then reads the result back through the store getters and only saves if every number landed (fails closed).
The panel uses the default `cascade` rule. `FIGPIG_ENVELOPE_WRITE_TOKEN` stays server-side for bots (CoS).

```bash
# Dry run (default): writes nothing
curl -s -X POST https://hernandez-finops.netlify.app/api/envelopes/overage \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"expected_state_hash\":\"$HASH\",\"targets\":\"all\"}"

# Selected targets, strict equal shares, apply — only after David's OK on the dry run
curl -s -X POST https://hernandez-finops.netlify.app/api/envelopes/overage \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"dry_run\":false,\"expected_state_hash\":\"$HASH\",
       \"targets\":[\"Eating Out / Fast Food\",\"Entertainment\",\"Clothing\"],\"note\":\"Groceries over\"}"
```

Body (unknown keys → 400):

| Key | Rules |
|---|---|
| `expected_state_hash` | **required**, from GET. Mismatch (including a new bonus deposit) → **409 `stale_state`** |
| `targets` | **required**: `"all"` or 1–100 top-level envelope names |
| `envelopes` | optional 1–100 names: only cover these overspent envelopes (default: every overspent non-bill envelope). Not over → 409 `not_overspent`; bill/debt → 400 `protected_envelope` |
| `include_sinking_funds` | boolean, default `true`; only affects `targets:"all"` |
| `negative_rule` | `"cascade"` (default) or `"allow"` |
| `dry_run` | boolean, default **`true`** |
| `note` | optional string ≤ 200 (appended to row notes and the audit) |

Response (fake data; dry run and real run share the shape; a real run adds `snapshot` and `batch_id`):

```json
{ "ok": true, "status": "dry_run", "dry_run": true,
  "state_hash_before": "…", "state_hash_after": "…",
  "overage": { "month": "2026-10", "total": 100.01, "from_bonus": 40, "split_total": 60.01, "forced_below_zero": 0,
               "bonus_available_before": 40, "bonus_available_after": 0, "target_mode": "selected",
               "negative_rule": "cascade", "include_sinking_funds": true, "target_count": 3 },
  "overspent": [ {"id":"…","envelope":"Groceries","remaining_before":-100.01,"from_bonus":40,"from_split":60.01,"remaining_after":0} ],
  "debits": [ {"id":"…","envelope":"Clothing","kind":"spend","remaining_before":50,"debit":20.01,"remaining_after":29.99,"went_negative":false},
              {"id":"…","envelope":"Eating Out / Fast Food","kind":"spend","remaining_before":300,"debit":20,"remaining_after":280,"went_negative":false},
              {"id":"…","envelope":"Entertainment","kind":"spend","remaining_before":100,"debit":20,"remaining_after":80,"went_negative":false} ],
  "excluded": [],
  "moves": [ {"from":"Clothing","to":"Groceries","amount":20.01}, {"from":"Eating Out / Fast Food","to":"Groceries","amount":20},
             {"from":"Entertainment","to":"Groceries","amount":20} ],
  "warnings": [],
  "totals": { "total_allocated_change": 0, "unallocated_change": 0, "…": "…" } }
```

`excluded` lists `{id, envelope, reason}` with reason `bill`, `debt`, `pass_through`, `overspent` or `sinking_fund`.
Errors beyond the common ones: 409 `no_overage` (nothing over), 409 `no_targets` (bonus short and no eligible
target; includes `overage`, `from_bonus`), 409 `not_overspent`, 400 `protected_envelope` (+`envelope`, `reason`).

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
  `manual`, `pre_reset`, `pre_restore` or `pre_overage`. The body takes only `note`.
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
| 400 | `invalid_body` (+`message`), `unknown_envelope` (+`envelope`, `validEnvelopes`), `protected_envelope` |
| 401 | `unauthorized` |
| 404 | `not_found` (route or snapshot) |
| 409 | `stale_state` (+`state_hash`), `conflict`, `no_budget`, `snapshot_month_mismatch`, `envelopes_changed`, `state_not_normalized`, `no_overage`, `no_targets`, `not_overspent` |
| 405 / 413 / 415 / 429 | wrong method / body > 16 KB / not JSON / `rate_limited` |
| 500 | `write_refused` (planned value did not land; nothing saved) |
| 502 | `upstream_error`: any Supabase failure (5xx, 4xx, bad body, network) |
| 503 | `not_configured` |

Tests: `npm run test:envelopes` and `npm run test:overage` (fake data, Supabase mocked, no network). Both are part of `npm run test:import`.

## Start fresh — `POST /api/envelopes/start-fresh` (build 20261020c)

Plain reset only sets `monthlyBudget`; last month's carry-over stays, so "zeroed" envelopes
still show leftovers. Start fresh zeroes **both** allocation (`monthlyBudget`) and carry-over
(`carryOver`).

Same auth as reset (`FIGPIG_ENVELOPE_WRITE_TOKEN`), same 10 writes/min limit, same hash CAS.

```json
{ "expected_state_hash": "<64 hex from GET /api/envelopes>",
  "envelopes": "all",            // or ["Groceries", "Utilities"] — REQUIRED, no implicit all
  "dry_run": true,                // default true
  "note": "optional, <=200" }
```

- `"all"`: every envelope including sub-envelopes. Named: those top-level envelopes and their sub-envelopes.
- Real run: automatic snapshot first (`reason: "pre_start_fresh"`, own write), then apply; audit `action: "start_fresh"`.
- Response rows now include `carry_before` / `carry_after`.
- Undo: `POST /api/envelopes/snapshots/<snapshot.id>/restore` restores both `monthlyBudget` and `carryOver`
  for every envelope (round-trips to the exact pre-start-fresh `state_hash`).
- Not touched: transactions, checking, bills, debts, month bonus rows / envelope moves / overspend IOUs.
  Month moves and bonus allocations still count toward `remaining` after start fresh.

## Carry-only reset — `POST /api/envelopes/reset-carry`

Sets `carryOver = 0` for named top-level envelopes. Never touches allocation or sub-envelopes.

```json
{ "expected_state_hash": "<64 hex>",
  "targets": [{ "envelope": "Groceries", "expected_carry": 123.45 }],
  "dry_run": true, "note": "optional" }
```

- `expected_carry` must equal the envelope's current carry (`carry` in GET /api/envelopes), else
  **409 `carry_mismatch`** with `mismatches: [{envelope, expected_carry, actual_carry}]`, nothing written.
- Real run: snapshot first (`reason: "pre_carry_reset"`), audit `action: "reset_carry"`; undo via restore.

GET /api/envelopes now also returns `carry` (opening carry for the current month) per envelope.
