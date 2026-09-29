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
