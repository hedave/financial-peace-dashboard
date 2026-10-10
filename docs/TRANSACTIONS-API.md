# FigPig add-only `/api/transactions` (bank sync)

Write path for CoS / the finance connector. Add-only: new rows go through FigPig’s existing import (`store.importTransactions`) for **dedupe**, **pending settle**, **checking math**, and **merchant categorization rules** (same as a manual CSV import). A row lands uncategorized only when no rule matches. David assigns envelopes and pays bills himself.

Does **not** run bill auto-match, auto-pay, or envelope assignment from bank labels / payload hints. Does **not** use `FIGPIG_INGEST_SECRET` or `FIGPIG_BILLS_READ_TOKEN`. Does **not** delete or edit existing manual transactions.

Optional top-level `checkingBalance` (finite number, `0` to `1e7`) is applied **after** import: `state.balances.checking` is set to that exact number. It is not recomputed from the posted rows. Omit the field and checking stays on import math, as today.

## Endpoint

`POST https://hernandez-finops.netlify.app/api/transactions`

(After Netlify env is set and this function is deployed.)

## Auth

Header (preferred):

```http
Authorization: Bearer <FIGPIG_TX_WRITE_TOKEN>
```

Alternate:

```http
x-figpig-tx-write-token: <FIGPIG_TX_WRITE_TOKEN>
```

Missing/wrong → `401`. Not configured → `503`. Rate limit (~10 calls/min) → `429`.

## Netlify env (site settings — never commit)

| Variable | Purpose |
| --- | --- |
| `FIGPIG_TX_WRITE_TOKEN` | Long random secret for CoS transaction writes only |
| `SUPABASE_URL` | Already used by ingest |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only — never in SPA |
| `FIGPIG_OWNER_USER_ID` | Already used by ingest |

David must set **`FIGPIG_TX_WRITE_TOKEN`** in Netlify. Do not reuse the ingest or bills-read secrets.

## Secret on the box (CoS / David place it)

```text
/home/box/.secrets/figpig/tx_write_token
```

`chmod 600`. Do not invent or commit. Distinct from `/home/box/.secrets/figpig/ingest_token` and `/home/box/.secrets/figpig/bills_read_token`.

## Body

Only this shape. Unknown keys on the object or on a row → `400`. Max 200 rows per call.

```json
{
  "checkingBalance": 2532.05,
  "rows": [
    {
      "date": "YYYY-MM-DD",
      "amount": -12.34,
      "description": "merchant as shown",
      "pending": false,
      "externalId": "plaid-txn-id"
    }
  ]
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `checkingBalance` | no | Finite number, `0` to `1e7`. After import, sets `state.balances.checking` to this exact value (USAA available). Non-finite, negative, or above `1e7` → `400` |
| `date` | yes | `YYYY-MM-DD` |
| `amount` | yes | Non-zero number. Negative = money out, positive = money in |
| `description` | yes | Merchant text |
| `pending` | no | Boolean. Pending purchases still hit checking once; a later posted twin with the same `externalId` (or date+amount+description) settles in place |
| `externalId` | no | Connector / Plaid id. Preferred duplicate key when present |

## Example curl

```bash
TOKEN=$(cat /home/box/.secrets/figpig/tx_write_token)
curl -sS -X POST https://hernandez-finops.netlify.app/api/transactions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"rows":[{"date":"2026-09-28","amount":-5.66,"description":"Chick-fil-A","pending":false,"externalId":"plaid-txn-id"}]}'
```

Unauthorized check:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" \
  -X POST https://hernandez-finops.netlify.app/api/transactions \
  -H "Content-Type: application/json" \
  -d '{"rows":[{"date":"2026-09-28","amount":-5.66,"description":"Chick-fil-A"}]}'
# expect 401 (or 503 before env is set)
```

## Response shape

Counts only. No transaction bodies.

```json
{
  "added": 1,
  "duplicates": 0,
  "settledPending": 0,
  "skipped": 0,
  "checkingAfter": 987.66
}
```

| Field | Meaning |
| --- | --- |
| `added` | New rows inserted |
| `duplicates` | Existing rows left as-is (same `externalId`, or same date+amount+description) |
| `settledPending` | Pending rows updated in place when the posted twin arrived |
| `skipped` | Rows the existing importer refused |
| `checkingAfter` | Checking after this call. When `checkingBalance` was sent, this is that exact number. When omitted, this is import math |

If a saved merchant rule matches, the row gets that rule’s category. Otherwise it stays uncategorized (no bill/debt link, no envelope from bank labels). A matching auto-pay bill stays unpaid until David marks it.

`409` if there is no cloud budget yet (open FigPig once and Sync Now), or if the cloud row changed during apply (retry the same payload).

---

# Receipt split `/api/transactions/split` (existing bank rows)

Puts a receipt split (e.g. Sam's Club → Groceries + Household / Misc) onto a bank transaction that **already exists** (the 3×/day bank sync usually got there first). `/api/ingest-bank` drops splits on duplicates and `/api/transactions` is bank-sync only, so this is the only API path that splits an existing row.

**Splits only.** It never changes the amount, date, description, pay status, bill link or checking. It sets `splits`, `receiptId`, `categorySource: "receipt"`, and `memo` (only if the memo was empty, so linked-note memo text is never rewritten).

## Endpoint and auth

`POST https://hernandez-finops.netlify.app/api/transactions/split` (after the env is set and this is deployed)

```http
Authorization: Bearer <FIGPIG_TX_SPLIT_TOKEN>
Content-Type: application/json
```

Alternate header: `x-figpig-tx-split-token`. Its own secret: never reuse `FIGPIG_TX_WRITE_TOKEN`, `FIGPIG_INGEST_SECRET` or `FIGPIG_BILLS_READ_TOKEN`.

| Status | When |
| --- | --- |
| `503 not_configured` | `FIGPIG_TX_SPLIT_TOKEN` (min 24 chars), `SUPABASE_URL` (https), `SUPABASE_SERVICE_ROLE_KEY` or `FIGPIG_OWNER_USER_ID` unset: fails closed |
| `401 unauthorized` | Missing / wrong token (constant-time compare) |
| `429 rate_limited` | > 20 calls/min per client IP, counted **before** auth (best effort per function instance) |
| `415` / `413` / `400 invalid_body` | Not JSON, body > 64 KB, or strict validation failed (unknown keys rejected everywhere) |

### Netlify env (site settings — never commit)

| Variable | Purpose |
| --- | --- |
| `FIGPIG_TX_SPLIT_TOKEN` | **New.** Long random secret (≥ 24 chars) for receipt splits only |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `FIGPIG_OWNER_USER_ID` | Already set for ingest / transactions |

Box copy for CoS: `/home/box/.secrets/figpig/tx_split_token` (`chmod 600`, never commit).

## Apply a split

```json
{
  "match": { "externalId": "plaid-txn-id" },
  "splits": [
    { "envelope": "Groceries", "amount": 80.00 },
    { "envelope": "Household / Misc", "amount": 40.00 }
  ],
  "receiptId": "sams-2026-10-05-0001",
  "memo": "Sam's Club receipt",
  "dryRun": false
}
```

or match by `{ "date": "YYYY-MM-DD", "amount": -120.00, "merchant": "Sams Club" }` (all three together). `externalId` wins when it is found.

| Field | Rules |
| --- | --- |
| `match` | `externalId` (≤128) and/or `date` + `amount` (sign ignored) + `merchant` (≤120) |
| `splits` | 1–12 lines `{envelope, amount}`; envelope = name or id; amount > 0, ≤ 2 decimals. Repeated envelopes are merged; at least **2** different envelopes after merging |
| `receiptId` | Required, `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. Idempotency key |
| `memo` | Optional, ≤ 200 chars. Written only when the memo is empty |
| `dryRun` | Optional boolean. Returns the candidate + proposal, writes nothing |

FigPig finds exactly one candidate: an **expense**, `|amount|` within **$0.03**, date within **±3 days**, merchant similarity **≥ 0.6**, and **not already split**.

Then:

- Splits must equal the **bank** amount within **$0.03** (the same window used to pick the row). Any gap up to 3¢ goes on the largest split so the stored splits equal the bank amount exactly; the response then carries `adjustment` (e.g. `"+3¢ on Groceries to match bank"`), and Receipts to review shows the same note before Approve.
- An existing single envelope is replaced only if it is **Groceries**, **Household / Misc**, missing, or was set by a merchant rule (`categorySource: "rule"`; any manual edit in the Log clears that tag).
- `receiptId` already on a transaction → **never re-applied**. FigPig stores a fingerprint (row id + split cents) with it:
  - same row and same split cents → `200 {"status":"unchanged"}`
  - different row or different split cents → `409 receipt_conflict`
  - David removed the split since → `200 {"status":"removed_by_user"}` (stop; do not resend)
  - David changed the split since → `200 {"status":"changed_by_user"}` (stop; do not resend)
- Saved with the `budget_states.updated_at` optimistic-concurrency check. On conflict FigPig reloads, re-plans and retries **once**; a second conflict → `409 conflict` (retry the same payload).

### Responses (trimmed: nothing else from the budget)

```json
{
  "ok": true,
  "status": "applied",
  "receiptId": "sams-2026-10-05-0001",
  "candidate": { "id": "tx-id", "date": "2026-10-05", "amount": 120, "description": "SAMS CLUB #0000" },
  "splits": [ { "envelope": "Groceries", "amount": 80.03 }, { "envelope": "Household / Misc", "amount": 40 } ],
  "adjustment": { "envelope": "Groceries", "amount": 0.03, "note": "+3¢ on Groceries to match bank" },
  "memoSet": true
}
```

`status`: `applied`, `dry_run`, `unchanged` (idempotent), `removed_by_user`, or `changed_by_user`. `adjustment` appears only when the split was nudged to match the bank amount.

| Error (`{"ok":false,"error":…}`) | HTTP | Meaning |
| --- | --- | --- |
| `no_match` | 404 | No bank row fits |
| `multiple_matches` | 409 | More than one fits (`count` only). Send it to review |
| `sum_mismatch` | 422 | Splits off from the bank amount by more than 3¢ (`bankAmount`, `splitsTotal`) |
| `receipt_conflict` | 409 | `receiptId` already used for a different row or different split cents |
| `already_split` | 409 | Row already split by something else |
| `category_conflict` | 409 | Row has another envelope set by hand |
| `not_expense` | 409 | `externalId` points at a non-expense |
| `unknown_envelope` / `invalid_splits` | 422 | Envelope not found / fewer than 2 envelopes |
| `conflict` | 409 | Cloud changed twice while saving (real `updated_at` mismatch only) |
| `upstream_error` | 502 | Supabase load/save failed (4xx/5xx/bad body). Not a conflict; safe to retry later |
| `no_budget` | 409 | No cloud budget yet |

## Send a receipt to "Receipts to review"

When FigPig refuses (or the bot isn't sure), queue the receipt for David instead. Same endpoint, same token:

```json
{
  "review": true,
  "receipt": {
    "receiptId": "sams-2026-10-05-0001",
    "store": "Sam's Club",
    "date": "2026-10-05",
    "total": 120.00,
    "proposedSplits": [
      { "envelope": "Groceries", "amount": 80.00 },
      { "envelope": "Household / Misc", "amount": 40.00 }
    ],
    "items": [
      { "desc": "Bananas", "amount": 1.48, "bucket": "Groceries", "confidence": 0.95 }
    ],
    "reason": "multiple_matches"
  }
}
```

- `proposedSplits` must add up to `total` (±$0.01). `items` optional (≤ 100; `bucket` = envelope name/id; `confidence` 0–1). `reason`: `no_match`, `multiple_matches`, `sum_mismatch`, `already_split`, `category_conflict`, `low_confidence` (default).
- `candidates` and `status` are computed by FigPig, never accepted (unknown key → 400).
- Idempotent by `receiptId`: a pending item is refreshed (`updated`); an applied/dismissed one, or a receipt already on a transaction, stays put (`unchanged`). Max 50 pending (`review_full`).
- Response: `{"ok":true,"status":"queued"|"updated"|"unchanged"|"dry_run","receiptId":"…","candidates":2,"pending":3}`.

David sees it on **Log → Receipts to review** (Log tab badge counts it): **Approve** on one of the listed bank rows (only those rows are accepted) applies the same checks as the API, including the ≤3¢ adjustment shown on the row, **Edit** moves receipt items between envelopes (tax/coupons shared by each envelope's share), **Dismiss** drops it.
