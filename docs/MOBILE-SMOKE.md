# FigPig mobile smoke (~390–430px)

Local SPA checks after mobile UI polish (Kern P1–P2 + Critiquito R2). No deploy required. Use DevTools phone or a real device ≤430px wide.

**Build stamp:** `20260909a` (`index.html` `?v=` + `APP_BUILD`). Hard-refresh if chrome looks stale.

## Pass criteria by area

### Chrome / shared
1. Bottom nav: Home / Log / Budget / Bills / More — all tappable (≥44px).
2. Modals/sheets: keyboard does not hide primary Save/footer; safe-area padding on footer.
3. Desktop table paths (bills/debt/tx) still work ≥769px — not broken by phone CSS.
4. ⋯ menus ≥44×44; open **downward** on phone; not clipped by list overflow; `stopPropagation` so ⋯ ≠ open activity/edit.

### Home (dashboard)
- [ ] Loads; summary strip readable (checking hero + metrics).
- [ ] Scroll; primary quick actions reachable above bottom nav / FAB clearance.

### Log (Transactions)
- [ ] List loads; tap card → edit form (`openTransactionForm`).
- [ ] **More · Import** → Import bank data reachable (page-tools; secondary Import buttons hidden on phone).
- [ ] Filters & sort toggle opens filter fields.
- [ ] Tx card ⋯ in `.tx-card-side` still works; `.tx-card-actions` stay hidden on tx cards.

### Budget / Envelopes
- [ ] Summary strip is crush-resistant **2×2** (not a single crushed column).
- [ ] Filter chips shortened on narrow (All / ★ Favs / Kids / Attention); horizontal scroll OK.
- [ ] **+ Add Category** primary; **More budget actions** opens page-tools (Sinking Fund, Move, holds, etc.).
- [ ] Envelope header stays a **horizontal** row (★ + ⋯) — does not stack Edit/Delete full-width.
- [ ] Envelope ⋯ → Edit / Delete; tap card body → activity (⋯ does not open activity).
- [ ] Add / edit / delete envelope works, or note gap below.

### Bills
- [ ] Card shows **name + amount**; **Mark Paid**, labeled **Edit**, and ⋯ visible (≥44px).
- [ ] Tap card → activity → **Edit** opens form; Mark Paid path OK.
- [ ] Card **Edit** opens form without opening activity (`stopPropagation`).
- [ ] ⋯ → Edit / Delete; first-row ⋯ not clipped under sticky chrome.
- [ ] Flow: Add Bill → edit amount/due → Mark Paid → Delete via ⋯.
- [ ] Long list (≥4 bills): sticky **+ Add Bill** above bottom nav.
- [ ] Summary 2×2; tab chips shortened (`Month · N late`, `Paid (N)`).
- [ ] No Bills FAB (sticky Add is enough).

### Debt (via More)
- [ ] Page loads; summary **2×2**; snowball target card readable above fold (left accent / subtle tint).
- [ ] **Pay** / **Resume**, labeled **Edit**, and ⋯ visible on cards.
- [ ] Tap card → activity → **Edit** → `openDebtForm` (R2-P0); Make payment when not paused.
- [ ] ⋯ → Edit / Hold / Mark paid off / Delete — chrome only; **no snowball math verification**.
- [ ] Desktop debt table path still OK.

### Gaps / deferred
| Item | Reason |
| --- | --- |
| Bill/debt DOM rebuild to `tx-card-main` / `tx-card-side` | Prefer CSS exceptions; P0 restores kept; optional refactor deferred |
| Bills FAB | Sticky Add covers long-list Add without clutter |
| Bottom nav IA swap (Log↔Debt) | Preference call — not guessed |
| Envelope footer tuck (Move/Assign/Reset → More) | P2; header ⋯ shipped this round |
| Modal footer collapse when >2 secondary | P2 |

## Quick regression
- [ ] `npm run test:import` PASS
- [ ] No changes to snowball/budget math or `/api/bills` auth
