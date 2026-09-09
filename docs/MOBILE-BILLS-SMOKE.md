# Mobile bills smoke (~390px)

Local SPA check after FigPig mobile P0 (CSS + Edit in activity). No deploy required.

## Pass criteria
1. Bill card shows **name + amount** (`.tx-card-top` visible on `.bill-card`).
2. **Mark Paid** and **⋯** (Edit/Delete) visible on the card (≥44px targets). Transaction cards may still hide `.tx-card-actions`.
3. Tap card → activity sheet → **Edit** opens `openBillForm` (desktop edit fields).
4. Flow: **Add Bill** → edit amount/due → Mark Paid → Delete via ⋯.
5. Recurring next-due advance unchanged after Mark Paid.
6. Debt cards: Pay/⋯ + top row visible (chrome only; no snowball math).

## Cheap P1 in same change
- Bills summary `grid-4` is 2×2 on ≤768px.
- Tab chips shorten on narrow (`Month · N late`, `Paid (N)`).
