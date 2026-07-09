import { el, formatCurrency, formatDate, todayISO } from '../utils.js';
import { store } from '../store.js';
import { showModal, showToast } from './modal.js';
import {
  normalizePaySchedule,
  getChecksForYear,
} from '../pay-schedule.js';
import { isBonusIncomeSource } from '../income-sources.js';

export function openPayScheduleEditor(source) {
  if (isBonusIncomeSource(source)) {
    showToast('Bonus income has no pay schedule — it is logged when deposits arrive.');
    return;
  }
  const sched = normalizePaySchedule(source.paySchedule);
  let mode = sched.mode;
  let year = String(new Date().getFullYear());

  function currentYears() {
    return store.getPayCalendarYears(store.getState().incomeSources.find(s => s.id === source.id) || source);
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
  const datesList = el('div', { className: 'pay-dates-list' });
  const newDateIn = el('input', { type: 'date', value: todayISO() });
  const newAmtIn = el('input', { type: 'number', step: '0.01', min: 0, placeholder: 'Optional' });

  function renderYearTabs() {
    yearTabs.innerHTML = '';
    currentYears().forEach(y => {
      yearTabs.appendChild(el('button', {
        type: 'button',
        className: `pay-year-tab${y === year ? ' active' : ''}`,
        onClick: () => { year = y; renderDatesList(); },
      }, y));
    });
  }

  function renderDatesList() {
    const src = store.getState().incomeSources.find(s => s.id === source.id) || source;
    const checks = getChecksForYear(src, year);
    datesList.innerHTML = '';
    if (!checks.length) {
      datesList.appendChild(el('p', { className: 'pay-dates-empty' },
        Number(year) === new Date().getFullYear() + 1
          ? 'Federal FY pay dates publish each October — add 2027 checks then.'
          : `No pay dates for ${year} yet.`
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
            source.paySchedule = store.getState().incomeSources.find(s => s.id === source.id).paySchedule;
            renderDatesList();
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
  renderDatesList();

  datesPanel.appendChild(el('p', { className: 'tx-form-hint' },
    'Enter the exact deposit dates from your pay stub or federal schedule. Amount is optional if it matches your usual check.'
  ));
  datesPanel.appendChild(yearTabs);
  datesPanel.appendChild(datesList);
  datesPanel.appendChild(el('div', { className: 'pay-add-date' },
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
        renderYearTabs();
        renderDatesList();
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
}