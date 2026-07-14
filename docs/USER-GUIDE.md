# Financial Peace Dashboard — User Guide

A practical guide for you and your spouse. Written for **how the app actually works**, not marketing copy.

This file is a local reference document (not an in-app help page). Keep a copy wherever you like; it does not need to be on the live website.

---

## Table of contents

1. [What this app is](#1-what-this-app-is)
2. [Core money model](#2-core-money-model)
3. [Main screens](#3-main-screens)
4. [Envelopes (budget categories)](#4-envelopes-budget-categories)
5. [Soft caps & sinking-fund goals](#5-soft-caps--sinking-fund-goals)
6. [New month: what happens automatically](#6-new-month-what-happens-automatically)
7. [New month checklist (recommended)](#7-new-month-checklist-recommended)
8. [Worked examples](#8-worked-examples)
9. [Transactions, pending vs cleared](#9-transactions-pending-vs-cleared)
10. [Bank import (CSV & PDF)](#10-bank-import-csv--pdf)
11. [Always-use-this-envelope rules](#11-always-use-this-envelope-rules)
12. [Bills](#12-bills)
13. [Debt snowball](#13-debt-snowball)
14. [Income & pay calendar](#14-income--pay-calendar)
15. [Returns / refunds to envelopes](#15-returns--refunds-to-envelopes)
16. [Sticky notes boards](#16-sticky-notes-boards)
17. [Cloud sync, backups, two devices](#17-cloud-sync-backups-two-devices)
18. [Phone / PWA tips](#18-phone--pwa-tips)
19. [Glossary](#19-glossary)
20. [Quick troubleshooting](#20-quick-troubleshooting)

---

## 1. What this app is

**Financial Peace Dashboard** is a household budgeting app inspired by Dave Ramsey’s **zero-based budgeting** and **debt snowball**:

- Every dollar of planned income should get a job (an envelope).
- Checking balance is the real bank number you maintain (or sync via imports).
- Envelopes are **virtual** — they track *where money is allowed to go*, not separate bank accounts.
- Debts are ordered smallest balance first (snowball).

It runs in the browser (and as a phone home-screen app). Data lives in **localStorage** on each device, and optionally in **Supabase cloud sync** so PC and phone stay aligned.

---

## 2. Core money model

Think of three layers:

| Layer | What it is | Example |
|--------|------------|---------|
| **Bank checking** | Real money at the bank | $3,240.18 |
| **Planned income** | What you expect this month from the pay calendar (+ bonus logged) | $6,000 |
| **Envelopes** | Jobs for those dollars | Groceries $900, Gas $400, … |

### Checking vs envelopes

- **Checking** goes up/down when cleared income/expenses hit the books (or when you edit the balance).
- **Envelopes** go up when you **Allocate** (assign budget) and down when you **spend** from that category.
- **Allocate does not move bank money.** It only changes the budget plan (“To Allocate” and each envelope’s budgeted amount).

### The magic formula for one envelope

```
Remaining = Monthly budget + Carry-over − Spent this month
```

- **Monthly budget** — how much you assigned to this envelope for the plan (can change mid-month with Allocate).
- **Carry-over** — leftovers (or overspend) rolled from prior months, plus some special restores (e.g. returns).
- **Spent** — expenses (and split portions) tagged to this envelope in the current month.

### “To Allocate” (zero-based leftover)

```
To Allocate = Planned monthly income (+ bonus logged) − sum of all envelopes’ Monthly budgets
```

- **$0** = every planned dollar has a job (goal in Ramsey mode).
- **Positive** = you still need to give dollars jobs (or send surplus to snowball).
- **Negative** = you budgeted more than planned income (over-assigned on paper).

**Carry-over is not part of To Allocate.** Leftover in envelopes is already “owned” by those envelopes; To Allocate only cares about income vs monthly budget assignments.

---

## 3. Main screens

| Screen | Use it for |
|--------|------------|
| **Dashboard** | Snapshot, review chips, snowball target, top spending, bills due, sync, month-close |
| **Budget** | Envelopes, allocate, soft caps/goals, attention filter |
| **Transactions** | Log/edit, import CSV/PDF, filters, pending, duplicates |
| **Bills** | Recurring bills, mark paid, link to bank activity |
| **Debt** | Snowball list, payments, payoff celebrations |
| **Income** | Pay sources, schedules, match terms |
| **Notes** | Sticky boards (Miro-like multi-page stickies) |
| **Reports** | History / comparisons (snapshots help here) |
| **Settings** | Theme, password, cloud sync, rules, backup import/export |

On phones, use the **bottom nav** for the main daily destinations.

---

## 4. Envelopes (budget categories)

### Types

1. **Regular envelopes** — monthly spending (Groceries, Gas, Eating Out, …).
2. **Sinking funds** — save over time for irregular costs (Christmas, Car Maintenance, Vacation). Same math; marked with a “Sinking Fund” tag.

### What you can do on an envelope card

- **Tap the card** → activity list (this month / 30 days / all time).
- **Allocate** → assign more of To Allocate into this envelope’s monthly budget.
- **Edit (✏️)** → name, icon, monthly budget, soft cap/goal, sinking toggle.
- **Delete** → removes category; transactions unlink (they don’t vanish).

### “Assign To Allocate evenly”

Budget tools → splits the current To Allocate amount across all top-level envelopes equally by increasing each monthly budget. Checking does not change.

### Copy last month’s budget

If a **snapshot** exists for last month (from rollover or month-close):

- Budget tools → **Copy Last Month** replaces **current monthly budget numbers** with last month’s snapshot.
- It does **not** wipe carry-over.
- It does **not** copy transactions.

### Linked items

Envelopes can show linked **debts** and **bills** so you see min payments / due amounts near the plan.

---

## 5. Soft caps & sinking-fund goals

Optional field on each envelope:

| Envelope type | Field meaning |
|---------------|----------------|
| Regular | **Soft cap** — max you *want* budgeted here |
| Sinking fund | **Savings goal** — target to save toward (e.g. Christmas $800) |

**Soft only:** the app **warns** if Allocate/edit would put monthly budget over the cap/goal. You can always confirm and continue. Nothing hard-blocks real spending.

On the card you’ll see progress (e.g. `$320 / $800 · 40%`). Over-cap envelopes show in:

- Budget → **Needs attention**
- Dashboard chips
- Month-close checklist

---

## 6. New month: what happens automatically

When the calendar rolls to a new month, the **first time you open the app** that month it runs **month rollover**.

### What rolls over

| Item | Rolls? | What happens |
|------|--------|--------------|
| **Envelope remaining** | Yes → **carry-over** | Leftover (or overspend) is *added* into that envelope’s carry-over |
| **Monthly budget amounts** | **Stay as-is** | Not zeroed; last month’s assignment numbers remain until you change them |
| **Budget snapshot of previous month** | Yes | Saved so you can **Copy Last Month** and for reports |
| **Transactions** | Stay forever | Filtered by date; old months still visible in history |
| **Pending transactions** | Stay | Still awaiting bank until matched or marked cleared |
| **Bills status** | Stay as paid/unpaid | You manage bill cycles; paid flags don’t auto-reset by themselves |
| **Debts / snowball order** | Stay | Balances only change when you pay |
| **Category rules** | Stay | Merchant → envelope forever until deleted |
| **Sticky notes** | Stay | Boards are not monthly |
| **Checking / EF balances** | Stay | Not recalculated by month rollover |
| **Income schedules** | Stay | Planned income recalculates from the pay calendar for the new month |

### The rollover formula (per envelope)

For the **previous** month:

```
remaining = monthlyBudget + carryOver − spent(previous month)
newCarryOver = oldCarryOver + remaining
```

Then the app marks the current calendar month as processed.

**Important implications:**

1. Money left in Groceries becomes **carry-over**, so it is still available next month **on top of** the same monthly budget number still sitting on the envelope.
2. If you overspent, remaining is **negative**, so carry-over drops (you “owe” that envelope).
3. **Monthly budget is not automatically set to match new income.** If income changes, adjust budgets or use Copy Last Month + edits.

### What does *not* auto-happen

- Does not re-zero To Allocate for you (depends on new month income vs existing budgets).
- Does not mark bills unpaid for the new cycle (handle on Bills page).
- Does not import bank data.
- Does not close the month for you (month-close is optional but recommended).

---

## 7. New month checklist (recommended)

Do this in the first few days of the month (Dashboard may show a “New month checklist” banner early in the month).

### Step-by-step

1. **Open the app** so rollover can run (carry-over applied once).
2. **Sync** (if using cloud) so both devices share the same state.
3. **Import last statement** (CSV or PDF) if you haven’t already — clear pending, catch missing spend.
4. **Review inbox**
   - Uncategorized → assign envelopes; leave **Always use this envelope** on for recurring merchants.
   - Pending → wait for bank match or mark cleared carefully.
   - Duplicates → delete true doubles; **Both unique** for two real same-amount purchases.
   - Bill matches → link when appropriate.
5. **Check To Allocate** on Budget
   - Positive: allocate to envelopes or plan snowball.
   - Negative: reduce some monthly budgets or fix income schedule.
6. **Review kids / seasonal envelopes** and **soft caps / goals**.
7. Optionally **Copy Last Month** if you want last month’s *budget numbers* as a starting point (only if a snapshot exists).
8. **Bills** — set up or reset what’s due this month; mark paid as they clear.
9. **Debt** — confirm snowball target; send surplus when ready.
10. **Month-close checklist** (Dashboard) when the month is truly done — saves snapshot, walks review steps.

### End-of-month close vs auto rollover

| | **Month-close (manual)** | **Rollover (automatic)** |
|--|--------------------------|---------------------------|
| When | You click through checklist / Close | First open in a new calendar month |
| Snapshot | Saves budget amounts for that month | Also snapshots previous month if needed |
| Carry-over | Not applied here | Applied here |
| Purpose | “We finished July cleanly” | “It’s August now — roll leftovers” |

You can close a month and still get rollover later; they complement each other.

---

## 8. Worked examples

### Example A — Clean leftover (most common)

**July setup — Groceries**

| Field | Amount |
|-------|--------|
| Monthly budget | $800 |
| Carry-over (start of July) | $0 |
| Spent in July | $720 |
| **Remaining end of July** | **$80** |

**First open in August (rollover):**

| Field | Amount |
|-------|--------|
| Monthly budget | still **$800** (unchanged) |
| Carry-over | **$80** |
| Spent in August so far | $0 |
| **Available in August** | **$880** |

To Allocate uses planned August income minus the **$800** (and other envelopes’ budgets), not the $80 leftover.

---

### Example B — Overspent envelope

**July — Eating Out**

| Field | Amount |
|-------|--------|
| Monthly budget | $200 |
| Carry-over | $0 |
| Spent | $260 |
| **Remaining** | **−$60** |

**August after rollover:**

| Field | Amount |
|-------|--------|
| Monthly budget | $200 |
| Carry-over | **−$60** |
| Available until you fix it | **$140** |

You’re effectively paying last month’s overspend out of this month’s assignment. Options: spend less, allocate more, or accept the tighter envelope.

---

### Example C — Sinking fund goal

**Christmas sinking fund**

| Field | Amount |
|-------|--------|
| Soft goal | $800 |
| Monthly budget (you assign $100/mo) | $100 |
| Carry-over after several months | $300 |
| Progress bar “pool” | budget + carry ≈ toward goal |

You assign $100 each month; leftovers stack in carry-over. Soft goal warns if you try to budget *more than $800* into monthly budget (not when carry alone is high). Use the progress display to see how close you are.

---

### Example D — New month income change

**July income (pay calendar):** $6,000  
**July total monthly budgets:** $6,000 → To Allocate $0  

**August income:** $5,500 (fewer paychecks)  
**Budgets still:** $6,000  

→ To Allocate = **−$500**  

You did nothing wrong; the plan is over-assigned. Fix by lowering some monthly budgets, or update the pay calendar if income was wrong.

---

### Example E — Allocate mid-month (does not touch checking)

Checking: $2,000  
To Allocate: $150  
Groceries budgeted: $800  

You **Allocate $150** to Groceries:

| | Before | After |
|--|--------|-------|
| Checking | $2,000 | **$2,000** (same) |
| Groceries monthly budget | $800 | **$950** |
| To Allocate | $150 | **$0** |

The bank only moves when a **cleared** expense/income posts (or you edit balances).

---

### Example F — Pending then CSV match

1. Tuesday: log **$54.20** Target as expense, envelope Household, **Post to checking = off** (pending).  
   - Envelope spent counts; checking unchanged.  
2. Friday: import bank CSV with the same Target charge.  
   - App matches pending → marks **cleared**, updates checking once, no duplicate row.

If no match ever appears, you can **Mark cleared** manually (then checking moves) or delete the pending log if it was a mistake.

---

### Example G — Soft cap warning

Gas soft cap: **$300**  
Currently budgeted: **$280**  
You try to Allocate **$50** → would become **$330**.

App asks: *Over soft cap — assign anyway?*  
- Cancel → nothing changes.  
- Confirm → budget becomes $330 (allowed).

---

## 9. Transactions, pending vs cleared

### Types

- **Expense** — spending (usually needs an envelope).
- **Income** — paychecks / deposits / bonus.
- **Debt payment** — pays down a debt and can hit checking.
- **Transfer** — movement (special cases; funded-envelope transfer text is treated carefully).
- **Celebration** — payoff markers (not normal cash flow).

### Pending vs cleared

| Status | Checking | Typical use |
|--------|----------|-------------|
| **Pending** | No change | Manual log before the bank shows it; or bill paid that already hit CSV |
| **Cleared** | Updates checking | Bank-confirmed or “post to checking now” |

**Default for new manual expense/income:** pending (safer — won’t double-count when CSV arrives).

Toggle **Post to checking now** when cash/check left the account outside import.

### Splits

One purchase can split across envelopes (e.g. Walmart = Groceries + Household). Split lines must sum to the total.

### Review inbox (Dashboard / Transactions)

- **Need categories** — expenses without an envelope.
- **Awaiting bank** — pending logs.
- **Possible duplicates** — same-ish amount/merchant; not always wrong.
- **Bill matches** — bank line looks like an unpaid bill.

---

## 10. Bank import (CSV & PDF)

### CSV

Transactions page → import bank CSV (USAA / common layouts supported). The app:

- Parses dates, amounts, descriptions.
- Skips true duplicates already in the log.
- Matches **pending** manual logs when possible.
- Applies **category rules** and bank-category heuristics.
- Flags bill matches and soft duplicate groups for review.

### PDF

Client-side PDF import (no upload to a server) for supported statement layouts. Same idea as CSV: get rows into your transaction list, then review.

**Never commit PDF statements to git** — they can contain account numbers. Local `.pdf` is gitignored.

### After every import

1. Read the toast summary (imported / pending matched / rules / skipped).  
2. Open **Review** for leftovers.  
3. Spot-check checking vs bank (reconciliation tools on Dashboard/Settings area).

---

## 11. Always-use-this-envelope rules

Rules store a **merchant text pattern** → envelope (or split).

### How to create

1. **Review uncategorized** → pick transactions → choose envelope → leave **Always use this envelope** ON → Assign.  
2. Or edit a transaction → **Always use this envelope** (defaults on for imports / uncategorized).  

Pattern is guessed from the description (noise like POS/DEBIT stripped when possible).

### How they apply

On future imports (and “Apply saved rules”), if description contains the pattern, the envelope is set automatically.

### Manage

**Settings → category rules** — filter, edit pattern, delete one or all.

---

## 12. Bills

- Track due dates, amounts, optional linked envelope, auto-pay flag.
- **Mark paid** can avoid double-hitting checking when the payment already appeared in CSV (`already in bank` behavior).
- Review inbox can **link** a bank transaction to an unpaid bill.

Bills are not fully automatic calendar subscriptions; treat the list as your household bill board and update statuses as life happens.

---

## 13. Debt snowball

- Debts sorted **smallest balance first** (classic snowball).
- **Minimums** should be covered in the budget (optionally linked to an envelope).
- **Surplus for snowball** comes from leftover To Allocate and/or cash-flow logic on the Dashboard.
- **Allocate surplus** pays the current target, reduces checking, logs a debt payment, and can celebrate payoffs.

When a debt hits $0 it archives; the next smallest becomes the target.

---

## 14. Income & pay calendar

### Sources

Typically Primary / Secondary / Tertiary jobs plus a **Bonus** source.

Each source has:

- Pay schedule (specific dates and/or recurring rules).
- Optional **match terms** so imported deposits link to the right source.

### Planned vs logged

- **Planned income** (To Allocate denominator base) = pay-calendar math for the month (non-bonus sources).
- **Bonus logged** = actual bonus income transactions this month (added into allocatable income).
- **Income received** (cash-flow views) = cleared/logged income transactions.

If no paychecks are logged yet, some surplus views fall back to planned income — read the Dashboard note under surplus.

---

## 15. Returns / refunds to envelopes

When **bonus** (or return-like) income is logged, the app can try to match a prior expense of the same amount:

- On a confident match, it **returns dollars to the envelope** by increasing **carry-over** (so Remaining goes back up without deleting the original purchase).
- If several candidates exist, you may be asked to pick.

This keeps envelope history honest: you still spent at Amazon; the return restores availability.

---

## 16. Sticky notes boards

**Notes** page = multi-page sticky boards (not infinite free-canvas Miro):

- **Tabs** = pages/boards (add, rename, delete).
- **Stickies** = title + body + color; add/delete freely.
- Sidebar **quick stickies** for glance access.
- Old single-blob notes (if any) migrate onto the first board as one sticky.

Use boards for: month checklist, agreement notes, shopping lists, snowball motivation, “ask spouse” items.

---

## 17. Cloud sync, backups, two devices

### Cloud (Supabase)

- Sign in with the same account on PC and phone.
- **Sync Now** in Settings (and Dashboard pill when configured).
- One shared budget state in the cloud — avoid editing heavily offline on two devices at once without syncing.

### JSON backup (belt and suspenders)

Settings → **Export Backup** downloads a full state file. Import restores it.

Do this:

- Before big experiments.
- Monthly, or when the app nags (~30 days).
- After major debt payoffs / month close.

Cloud sync is convenient; **local JSON** is recovery if an account or merge ever goes sideways.

### Google Sheets export

Optional multi-CSV export for spreadsheet nerds; day-to-day truth still lives in the app.

---

## 18. Phone / PWA tips

- Add to Home Screen for app-like use.
- After a production update, if the UI looks old: open **`/update.html`** once to clear stuck service worker caches, or hard-refresh.
- Bottom nav is the daily driver; full Settings still available from the menu/shell.
- Large text / reduce motion / dark mode live in Settings.

---

## 19. Glossary

| Term | Meaning |
|------|---------|
| **Envelope** | Budget category with budget, carry-over, spent, remaining |
| **Allocate / Fund** | Assign To Allocate dollars into an envelope’s monthly budget (no bank move) |
| **To Allocate** | Income plan minus sum of monthly budgets |
| **Carry-over** | Rolled leftover/overspend (and some refund restores) |
| **Soft cap / goal** | Optional target; warns, does not hard-block |
| **Pending** | Logged but not applied to checking yet |
| **Cleared** | Applied to checking |
| **Snowball** | Pay smallest debt first with intense focus |
| **Sinking fund** | Envelope for irregular future expenses |
| **Snapshot** | Saved monthly budget amounts for a past month |
| **Rollover** | Automatic new-month process for carry-over + snapshot |
| **Month-close** | Manual checklist + snapshot when you finish a month |
| **Category rule** | Merchant text → always this envelope |

---

## 20. Quick troubleshooting

| Symptom | Likely cause | What to try |
|---------|--------------|-------------|
| Checking doesn’t match bank | Pending not cleared, or double-cleared | Review pending; recon tools; fix with edit/delete carefully |
| To Allocate hugely negative | Budgets > planned income | Fix pay calendar or lower budgets |
| Envelope has huge available | Carry-over stacked + full monthly budget still set | Normal after thrifty months; lower budget if you don’t want that much room |
| Import created duplicates | Weak match / different days | Use duplicate review; Mark unique if both real |
| Phone shows old UI | Service worker cache | Visit `/update.html` or hard refresh |
| Spouse’s phone missing data | Not signed in / not synced | Same cloud login → Sync Now on both |
| Cap won’t stop me | Soft by design | Confirm only when intentional; or lower monthly budget |
| Notes feel empty | New board | Add board tab + stickies; check sidebar quick list |

---

## Appendix — Mental model cheat sheet

```
Bank checking  ── real cash (cleared txs + manual balance edits)
       │
       │  (CSV/PDF import keeps this honest)
       │
Envelopes ── virtual plan
       │     Remaining = Budget + Carry − Spent
       │     Allocate changes Budget only
       │
To Allocate ── Income plan − Σ Budgets   (want ≈ $0)
       │
Surplus ── extra that can attack the snowball
```

**New month in one sentence:**  
*Leftover (or overspend) folds into carry-over; budget numbers stay until you change them; income and spending start fresh for the new calendar month.*

---

*Guide version: 2026-07-13 — matches app behavior including sticky boards, PDF import, soft caps/goals, and always-use envelope rules.*
