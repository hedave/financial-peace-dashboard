# FigPig read-only `/api/bills` (CoS bill-watch)

Read-only. Does **not** use `FIGPIG_INGEST_SECRET`. No write path.

## Endpoint

`GET https://hernandez-finops.netlify.app/api/bills`

(After Netlify env is set and this function is deployed.)

## Auth

Header (preferred):

```http
Authorization: Bearer <FIGPIG_BILLS_READ_TOKEN>
```

Alternate:

```http
x-figpig-bills-token: <FIGPIG_BILLS_READ_TOKEN>
```

Missing/wrong → `401`. Not configured → `503`. Rate limit → `429`.

## Netlify env (site settings — never commit)

| Variable | Purpose |
| --- | --- |
| `FIGPIG_BILLS_READ_TOKEN` | Long random secret for CoS reads only |
| `SUPABASE_URL` | Already used by ingest |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only — never in SPA |
| `FIGPIG_OWNER_USER_ID` | Already used by ingest |

## Secret on the box (CoS / David place it)

```text
/home/box/.secrets/figpig/bills_read_token
```

`chmod 600`. Do not invent or commit. Distinct from `/home/box/.secrets/figpig/ingest_token`.

## Example curl

```bash
TOKEN=$(cat /home/box/.secrets/figpig/bills_read_token)
curl -sS -H "Authorization: Bearer $TOKEN" \
  https://hernandez-finops.netlify.app/api/bills
```

Unauthorized check:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" \
  https://hernandez-finops.netlify.app/api/bills
# expect 401 (or 503 before env is set)
```

## Response shape

```json
{
  "bills": [
    {
      "id": "…",
      "name": "Power",
      "amount": 120.5,
      "dueDate": "2026-09-15",
      "status": "unpaid",
      "paidDate": null,
      "recurring": true
    }
  ],
  "count": 1,
  "updated_at": "2026-09-09T…"
}
```

Trimmed fields only. No transactions, envelopes, or snowball internals.
