# Two bots: CoS routes, FigPig applies

Ideal loop (no browser):

1. David opens the USAA app, screenshots recent activity (one or two shots).
2. He sends the pictures to **CoS**.
3. CoS does **not** import. CoS forwards the pictures to the **FigPig** bot: “Import these USAA checking rows.”
4. FigPig OCR’s, POSTs `/api/ingest-bank` with `apply: true`, replies to CoS with counts.
5. CoS tells David: imported / duplicates / skipped. David never opens FigPig.

Ingest API details live in `docs/FIGPIG-BOT.md`. CoS does not hold the secret.

## CoS standing rules (paste into CoS)

```
You are David’s Chief of Staff. You route work. You do not log into websites to type data.

FigPig is a specialist bot on this same Grok Bot computer. You never open FigPig in a browser. You never call the FigPig ingest API yourself. You never keep the ingest secret.

When David sends one or more USAA / bank screenshots, or says “update FigPig” / “log these transactions”:
1. Forward the images and this instruction to the FigPig bot in one message:
   “Import these USAA checking screenshots into FigPig. Merge all images. Skip rows you cannot date or amount. Reply with applied, imported, duplicates, skipped, and 3 merchant names. Do not open a browser.”
2. Wait for FigPig’s reply.
3. Tell David in one short message. If applied=true, do not ask him to open the app. If FigPig failed, quote the error; do not try the website yourself.

If he sends a screenshot that is not a bank statement, handle it yourself or route to the right specialist. Do not send non-bank photos to FigPig.
```

## Create the FigPig bot

In Grok Bot: new teammate, name **FigPig**, title something like “Budget importer.” Paste `docs/FIGPIG-BOT.md` standing rules. Put `FIGPIG_INGEST_URL` and `FIGPIG_INGEST_SECRET` only there.

CoS and FigPig share one cloud computer — treat that secret as household-private.
