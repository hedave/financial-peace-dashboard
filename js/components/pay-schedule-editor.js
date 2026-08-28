import { el, formatCurrency, formatDate, todayISO } from '../utils.js';
import { store } from '../store.js';
import { showModal, showToast } from './modal.js';
import {
  normalizePaySchedule,
  getChecksForYear,
} from '../pay-schedule.js';
import { isBonusIncomeSource } from '../income-sources.js';
import { getGsaEftDates, getGsaEftYears, gsaEftDateSet } from '../gsa-eft-dates.js';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export function openPayScheduleEditor(source) {
  if (isBonusIncomeSource(source)) {
    showToast('Bonus income has no pay schedule — it is logged when deposits arrive.');
    return;
  }
  const sched = normalizePaySchedule(source.paySchedule);
  let mode = sched.mode;
  let year = String(new Date().getFullYear());

  function currentYears() {
    const years = new Set(
      store.getPayCalendarYears(store.getState().incomeSources.find(s => s.id === source.id) || source),
    );
    getGsaEftYears().forEach(y => years.add(String(y)));
    return [...years].sort();
  }

  const modeDates = el('input', { type: 'radio', name: 'pay-mode', value: 'dates' });
  const modeRecurring = el('input', { type: 'radio', name: 'pay-mode', value: 'recurring' });
  if (mode === 'dates') modeDates.checked = true;
  else modeRecurring.checked = true;

  const perCheckIn = el('input', {
    type: 'number', step: '0.01', min: 0,
    placeholder: 'Auto from CSV deposits',
    value: sched.perCheckAmount || '',
  });

  const matchTermsIn = el('textarea', {
    rows: 2,
    placeholder: 'e.g. public employee retirement system',
    style: 'min-height:3rem',
  });
  matchTermsIn.value = (source.matchTerms || []).join('\n');

  const freqSelect = el('select',
    el('option', { value: 'monthly' }, 'Monthly'),
    el('option', { value: 'twice_monthly' }, 'Twice per month'),
    el('option', { value: 'biweekly' }, 'Biweekly (estimate)'),
  );
  freqSelect.value = sched.recurring.frequency || 'monthly';
  const day1In = el('input', { type: 'number', min: 1, max: 31, value: sched.recurring.day1 || 1 });
  const day2In = el('input', { type: 'number', min: 1, max: 31, value: sched.recurring.day2 || '', placeholder: '2nd' });

  const datesPanel = el('div', { className: 'pay-editor-dates' });
  const recurringPanel = el('div', { className: 'pay-editor-recurring' });

  const yearTabs = el('div', { className: 'pay-year-tabs' });
  const calWrap = el('div', { className: 'pay-cal-year' });
  const datesList = el('div', { className: 'pay-dates-list' });
  const newDateIn = el('input', { type: 'date', value: todayISO() });
  const newAmtIn = el('input', { type: 'number', step: '0.01', min: 0, placeholder: 'Optional' });

  function liveSource() {
    return store.getState().incomeSources.find(s => s.id === source.id) || source;
  }

  function refreshAfterDateChange() {
    source.paySchedule = liveSource().paySchedule;
    renderYearTabs();
    renderCalendar();
    renderDatesList();
  }

  function selectYear(y) {
    year = String(y);
    renderYearTabs();
    renderCalendar();
    renderDatesList();
    fillGsaBtn.textContent = `Add all GSA EFT (purple) ${year}`;
  }

  function renderYearTabs() {
    yearTabs.innerHTML = '';
    currentYears().forEach(y => {
      yearTabs.appendChild(el('button', {
        type: 'button',
        className: `pay-year-tab${String(y) === String(year) ? ' active' : ''}`,
        onClick: () => selectYear(y),
      }, y));
    });
  }

  function monthGrid(y, month, selected, gsa) {
    const pad = String(month).padStart(2, '0');
    const iso = (d) => `${y}-${pad}-${String(d).padStart(2, '0')}`;
    const first = new Date(y, month - 1, 1).getDay();
    const nDays = new Date(y, month, 0).getDate();
    const grid = el('div', { className: 'pay-cal-grid' });
    DOW.forEach(d => grid.appendChild(el('span', { className: 'pay-cal-dow' }, d)));
    for (let i = 0; i < first; i++) grid.appendChild(el('span', { className: 'pay-cal-pad' }));
    for (let d = 1; d <= nDays; d++) {
      const date = iso(d);
      const on = selected.has(date);
      const eft = gsa.has(date);
      grid.appendChild(el('button', {
        type: 'button',
        className: `pay-cal-day${on ? ' selected' : ''}${eft ? ' gsa' : ''}`,
        title: eft ? `${date} · GSA EFT (purple)` : date,
        onClick: () => {
          const amt = perCheckIn.value ? Number(perCheckIn.value) : null;
          store.togglePayCheck(source.id, date, amt);
          refreshAfterDateChange();
        },
      }, String(d)));
    }
    return el('div', { className: 'pay-cal-month' },
      el('div', { className: 'pay-cal-month-name' }, MONTH_NAMES[month - 1]),
      grid,
    );
  }

  function renderCalendar() {
    calWrap.innerHTML = '';
    const y = Number(year);
    const selected = new Set(getChecksForYear(liveSource(), year).map(c => c.date));
    const gsa = gsaEftDateSet(year);
    for (let m = 1; m <= 12; m++) {
      calWrap.appendChild(monthGrid(y, m, selected, gsa));
    }
  }

  function renderDatesList() {
    const checks = getChecksForYear(liveSource(), year);
    datesList.innerHTML = '';
    if (!checks.length) {
      datesList.appendChild(el('p', { className: 'pay-dates-empty' },
        getGsaEftDates(year).length
          ? `No dates for ${year} yet — tap purple EFT days, or add all GSA EFT dates.`
          : `No pay dates for ${year} yet. Tap a day to add it.`,
      ));
      return;
    }
    checks.forEach(check => {
      datesList.appendChild(el('div', { className: 'pay-date-row' },
        el('span', { className: 'pay-date-label' }, formatDate(check.date)),
        el('span', { className: 'pay-date-amt' }, formatCurrency(check.amount)),
        el('button', {
          type: 'button',
          className: 'btn btn-sm btn-danger',
          onClick: () => {
            store.removePayCheck(source.id, check.date);
            refreshAfterDateChange();
            showToast('Date removed');
          },
        }, '×'),
      ));
    });
  }

  function syncPanels() {
    mode = modeDates.checked ? 'dates' : 'recurring';
    datesPanel.style.display = mode === 'dates' ? '' : 'none';
    recurringPanel.style.display = mode === 'recurring' ? '' : 'none';
    day2In.style.display = freqSelect.value === 'twice_monthly' ? '' : 'none';
  }

  modeDates.addEventListener('change', syncPanels);
  modeRecurring.addEventListener('change', syncPanels);
  freqSelect.addEventListener('change', syncPanels);
  syncPanels();
  renderYearTabs();
  renderCalendar();
  renderDatesList();

  datesPanel.appendChild(el('p', { className: 'tx-form-hint' },
    'Tap a day to add or remove it. Purple outline = GSA EFT (when the deposit hits checking). Pink official paycheck dates are not used — USAA follows EFT.'
  ));
  const fillGsaBtn = el('button', {
    type: 'button',
    className: 'btn btn-sm btn-primary',
    onClick: () => {
      const dates = getGsaEftDates(year);
      if (!dates.length) {
        showToast(`No GSA EFT list for ${year} yet`, 'info');
        return;
      }
      const n = store.addPayChecks(
        source.id,
        dates,
        perCheckIn.value ? Number(perCheckIn.value) : null,
      );
      refreshAfterDateChange();
      showToast(n
        ? `Added ${n} GSA EFT date${n === 1 ? '' : 's'} for ${year}`
        : `All GSA EFT dates for ${year} were already on the calendar`);
    },
  }, `Add all GSA EFT (purple) ${year}`);

  datesPanel.appendChild(yearTabs);
  datesPanel.appendChild(el('div', { className: 'pay-cal-actions' },
    fillGsaBtn,
    el('span', { className: 'pay-cal-legend' },
      el('span', { className: 'pay-cal-swatch gsa' }), ' GSA EFT',
      el('span', { className: 'pay-cal-swatch selected', style: 'margin-left:0.75rem' }), ' On your calendar',
    ),
  ));
  datesPanel.appendChild(calWrap);
  datesPanel.appendChild(datesList);
  datesPanel.appendChild(el('div', { className: 'pay-add-date' },
    el('p', { className: 'tx-form-hint', style: 'margin-bottom:0.5rem' },
      'Odd date (not on the GSA calendar):',
    ),
    el('div', { className: 'input-row' },
      el('div', { className: 'form-group' }, el('label', {}, 'Pay date'), newDateIn),
      el('div', { className: 'form-group' }, el('label', {}, 'Amount (optional)'), newAmtIn),
    ),
    el('button', {
      type: 'button',
      className: 'btn btn-sm btn-primary',
      onClick: () => {
        if (!newDateIn.value) return;
        store.addPayCheck(source.id, newDateIn.value, newAmtIn.value || null);
        year = newDateIn.value.slice(0, 4);
        fillGsaBtn.textContent = `Add all GSA EFT (purple) ${year}`;
        refreshAfterDateChange();
        newAmtIn.value = '';
        showToast('Pay date added');
      },
    }, '+ Add date'),
  ));

  recurringPanel.appendChild(el('p', { className: 'tx-form-hint' },
    'Good for fixed deposits on the same calendar day every month (e.g. the 1st).'
  ));
  recurringPanel.appendChild(el('div', { className: 'input-row' },
    el('div', { className: 'form-group' }, el('label', {}, 'Pattern'), freqSelect),
    el('div', { className: 'form-group' }, el('label', {}, 'Pay day'), day1In),
    el('div', { className: 'form-group' }, el('label', {}, '2nd day'), day2In),
  ));

  const modal = showModal({
    title: `Pay Schedule — ${source.name}`,
    body: el('div', { className: 'pay-schedule-editor' },
      el('div', { className: 'pay-mode-picker' },
        el('label', { className: 'pay-mode-option' }, modeDates, ' Exact pay dates'),
        el('label', { className: 'pay-mode-option' }, modeRecurring, ' Recurring (same day/month)'),
      ),
      el('div', { className: 'form-group' },
        el('label', {}, 'Typical check amount (optional)'),
        perCheckIn,
        el('p', { style: 'font-size:0.75rem;color:var(--text-muted);margin-top:0.25rem' },
          'Usually filled automatically when CSV deposits import.'
        ),
      ),
      el('div', { className: 'form-group' },
        el('label', {}, 'CSV description match (one per line)'),
        matchTermsIn,
        el('p', { style: 'font-size:0.75rem;color:var(--text-muted);margin-top:0.25rem' },
          'Add phrases that appear on bank CSV deposits for this source (one per line). Unmatched deposits go to Bonus Income.'
        ),
      ),
      datesPanel,
      recurringPanel,
    ),
    footer: [
      el('button', { type: 'button', className: 'btn btn-secondary', onClick: () => modal.close() }, 'Cancel'),
      el('button', {
        type: 'button',
        className: 'btn btn-primary',
        onClick: () => {
          const current = normalizePaySchedule(source.paySchedule);
          const next = {
            mode: modeDates.checked ? 'dates' : 'recurring',
            checks: current.checks,
            recurring: {
              frequency: freqSelect.value,
              day1: Number(day1In.value) || 1,
              day2: freqSelect.value === 'twice_monthly' ? (Number(day2In.value) || null) : null,
            },
            perCheckAmount: perCheckIn.value ? Number(perCheckIn.value) : null,
          };
          const matchTerms = matchTermsIn.value
            .split(/\n/)
            .map(t => t.trim())
            .filter(Boolean);
          store.update(s => {
            const src = s.incomeSources.find(i => i.id === source.id);
            if (src) {
              src.paySchedule = normalizePaySchedule(next);
              src.matchTerms = matchTerms;
              store.syncSourceAmountFromSchedule(src);
            }
          });
          showToast('Pay schedule saved');
          modal.close();
          window.appRefresh();
        },
      }, 'Save'),
    ],
  });
  modal.modal.classList.add('modal-wide');
  modal.modal.classList.add('modal-scrollable');
}