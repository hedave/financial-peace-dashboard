---
name: figpig-usaa-sync
description: Pull live USAA transactions from the Grok finance connector and POST them to FigPig’s bank-drop ingest API, which applies them to the cloud budget. Use when the user says sync USAA, import bank to FigPig, or drop checking activity into the budget app.
---

# FigPig USAA sync

## When to use

User wants recent USAA activity in FigPig without pasting CSV and without opening the site.

## Steps

1. `finance_list_accounts` — use the cash account named **USAA Checking** (do not sync savings unless asked).
2. `finance_query_account_transactions` for that `account_id`, `date_from` default last 14 days, `limit` 200. Page with `cursor` if needed.
3. Map each CSV row to ingest JSON:
   - `date` = `date`
   - `amount` = CSV `amount` (already signed: positive in, negative out)
   - `description` = `merchant_name` or `name`
   - `pending` = CSV `pending` true/false
   - `category` = parse JSON `category.primary` if present
4. POST to env `FIGPIG_INGEST_URL` (fallback `https://<figpig-host>/api/ingest-bank`) with `Authorization: Bearer $FIGPIG_INGEST_SECRET`.
5. Body:

```json
{
  "source": "usaa_connector",
  "account": "checking",
  "apply": true,
  "note": "Grok Build finance sync",
  "transactions": []
}
```

6. Read `applied` and `stats` from the response. If `applied` is true, FigPig’s cloud budget is already updated — do **not** tell the user to open a browser. Report imported / duplicates / skipped.

## Guardrails

- Never print the ingest secret.
- Never open FigPig, Netlify, or Supabase in a browser on the user’s behalf.
- Never write `budget_states` with a raw PATCH; only POST `/api/ingest-bank`.
- Redact account numbers if they appear in descriptions.
- Skip zero-amount rows.
- If `FIGPIG_INGEST_SECRET` is missing, stop and ask them to set Netlify + local env.
