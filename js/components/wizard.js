import { el, formatCurrency } from '../utils.js';
import { store } from '../store.js';
import { BABY_STEPS } from '../defaults.js';
import { showToast } from './modal.js';

const STEPS = ['welcome', 'income', 'balances', 'debts', 'budget', 'done'];

export function renderWizard(onComplete) {
  let step = 0;
  const data = {
    incomeSources: store.getState().incomeSources,
    balances: { checking: 0, emergencyFund: 0, savings: [] },
    debts: [],
    categories: store.getState().categories.map(c => ({ ...c, monthlyBudget: 0 })),
    babyStep: 1,
  };

  const overlay = el('div', { className: 'wizard-overlay', id: 'wizard' });

  function render() {
    overlay.innerHTML = '';
    const container = el('div', { className: 'wizard-container' });

    const progress = el('div', { className: 'wizard-progress' },
      ...STEPS.map((_, i) => el('div', {
        className: `wizard-step-dot${i < step ? ' done' : ''}${i === step ? ' active' : ''}`
      }))
    );
    container.appendChild(progress);

    const card = el('div', { className: 'wizard-card' });
    const pages = [welcomeStep, incomeStep, balancesStep, debtsStep, budgetStep, doneStep];
    pages[step](card, data, {
      next: () => { if (step < STEPS.length - 1) { step++; render(); } },
      back: () => { if (step > 0) { step--; render(); } },
      finish: () => finish(),
    });
    container.appendChild(card);
    overlay.appendChild(container);
  }

  function finish() {
    store.completeSetup({
      incomeSources: data.incomeSources.filter(i => i.name),
      balances: data.balances,
      debts: data.debts,
      categories: data.categories,
      babyStep: data.babyStep,
    });
    overlay.remove();
    showToast('Welcome to financial peace! 🎉', 'celebration', 5000);
    onComplete();
  }

  document.body.appendChild(overlay);
  render();
}

function welcomeStep(card, data, nav) {
  card.appendChild(el('h2', {}, 'Welcome to Financial Peace'));
  card.appendChild(el('p', { className: 'subtitle' }, 'Let\'s set up your Total Money Makeover in just a few minutes. We\'ll walk through your income, balances, debts, and budget envelopes.'));
  card.appendChild(el('div', { className: 'banner banner-motivation', style: 'margin-bottom:1.5rem' },
    el('div', { className: 'banner-text' },
      el('p', {}, '"A budget is telling your money where to go instead of wondering where it went." — Dave Ramsey')
    )
  ));

  const bsGroup = el('div', { className: 'form-group' });
  bsGroup.appendChild(el('label', {}, 'Which Baby Step are you on?'));
  const select = el('select', { id: 'baby-step' });
  BABY_STEPS.forEach(bs => {
    select.appendChild(el('option', { value: String(bs.step) }, `Step ${bs.step}: ${bs.title}`));
  });
  select.addEventListener('change', () => { data.babyStep = Number(select.value); });
  bsGroup.appendChild(select);
  card.appendChild(bsGroup);

  card.appendChild(el('div', { className: 'btn-group', style: 'margin-top:1.5rem;justify-content:flex-end' },
    el('button', { className: 'btn btn-primary', onClick: nav.next }, 'Get Started →')
  ));
}

function incomeStep(card, data, nav) {
  card.appendChild(el('h2', {}, 'Monthly Income'));
  card.appendChild(el('p', { className: 'subtitle' }, 'Enter your expected monthly take-home income from all sources.'));

  const list = el('div', { id: 'income-list' });

  function renderIncome() {
    list.innerHTML = '';
    data.incomeSources.forEach((src, i) => {
      const entry = el('div', { className: 'income-entry' });
      entry.appendChild(el('div', { className: 'input-row' },
        formField('Source Name', 'text', src.name, v => { src.name = v; }),
        formField('Amount', 'number', src.amount, v => { src.amount = Number(v); }, { step: '0.01', min: '0' }),
        formField('Type', 'select', src.type, v => { src.type = v; }, {
          options: [
            { value: 'job', label: 'Job / Salary' },
            { value: 'va', label: 'Disability' },
            { value: 'retirement', label: 'Retirement / Pension' },
            { value: 'side', label: 'Side Income' },
            { value: 'other', label: 'Other' },
          ]
        }),
      ));
      if (data.incomeSources.length > 1) {
        entry.appendChild(el('button', {
          className: 'btn btn-sm btn-danger', style: 'margin-top:0.5rem',
          onClick: () => { data.incomeSources.splice(i, 1); renderIncome(); }
        }, 'Remove'));
      }
      list.appendChild(entry);
    });
  }

  renderIncome();
  card.appendChild(list);
  card.appendChild(el('button', {
    className: 'btn btn-secondary', style: 'margin:0.75rem 0',
    onClick: () => {
      data.incomeSources.push({ id: crypto.randomUUID(), name: '', amount: 0, type: 'other' });
      renderIncome();
    }
  }, '+ Add Income Source'));

  card.appendChild(navButtons(nav));
}

function balancesStep(card, data, nav) {
  card.appendChild(el('h2', {}, 'Account Balances'));
  card.appendChild(el('p', { className: 'subtitle' }, 'Enter your current checking, emergency fund, and any savings account balances.'));

  card.appendChild(formField('Checking Account Balance', 'number', data.balances.checking, v => {
    data.balances.checking = Number(v);
  }, { step: '0.01' }));

  card.appendChild(formField('Emergency Fund Balance', 'number', data.balances.emergencyFund, v => {
    data.balances.emergencyFund = Number(v);
  }, { step: '0.01' }));

  const efNote = el('p', { style: 'font-size:0.8rem;color:var(--text-muted);margin:-0.5rem 0 1rem' },
    data.babyStep === 1 ? 'Baby Step 1 target: $1,000 starter emergency fund' : 'Baby Step 3 target: 3–6 months of expenses'
  );
  card.appendChild(efNote);

  card.appendChild(navButtons(nav));
}

function debtsStep(card, data, nav) {
  card.appendChild(el('h2', {}, 'Your Debts'));
  card.appendChild(el('p', { className: 'subtitle' }, 'List all non-mortgage debts from smallest to largest balance. The snowball starts with the smallest!'));

  const list = el('div', { id: 'debt-list' });

  function renderDebts() {
    list.innerHTML = '';
    if (!data.debts.length) {
      list.appendChild(el('p', { style: 'color:var(--text-muted);margin-bottom:1rem' }, 'No debts? That\'s amazing! Skip ahead if you\'re debt-free.'));
    }
    data.debts.forEach((d, i) => {
      const entry = el('div', { className: 'debt-entry' });
      entry.appendChild(el('div', { className: 'input-row' },
        formField('Debt Name', 'text', d.name, v => { d.name = v; }),
        formField('Balance', 'number', d.balance, v => { d.balance = Number(v); }, { step: '0.01' }),
      ));
      entry.appendChild(el('div', { className: 'input-row' },
        formField('Min Payment', 'number', d.minPayment, v => { d.minPayment = Number(v); }, { step: '0.01' }),
        formField('Interest Rate %', 'number', d.interestRate, v => { d.interestRate = Number(v); }, { step: '0.01' }),
      ));
      entry.appendChild(el('button', {
        className: 'btn btn-sm btn-danger', style: 'margin-top:0.5rem',
        onClick: () => { data.debts.splice(i, 1); renderDebts(); }
      }, 'Remove'));
      list.appendChild(entry);
    });
  }

  renderDebts();
  card.appendChild(list);
  card.appendChild(el('button', {
    className: 'btn btn-secondary', style: 'margin:0.75rem 0',
    onClick: () => {
      data.debts.push({
        id: crypto.randomUUID(), name: '', balance: 0,
        minPayment: 0, interestRate: 0, dueDate: '', notes: '', archived: false,
      });
      renderDebts();
    }
  }, '+ Add Debt'));

  card.appendChild(navButtons(nav));
}

function budgetStep(card, data, nav) {
  card.appendChild(el('h2', {}, 'Fund Your Envelopes'));
  card.appendChild(el('p', { className: 'subtitle' }, 'Assign a monthly budget to each category. Income minus budgets should equal zero!'));

  const totalIncome = data.incomeSources.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const totalBudget = () => data.categories.reduce((s, c) => s + (Number(c.monthlyBudget) || 0), 0);

  const summary = el('div', { className: 'card', style: 'margin-bottom:1rem;padding:0.75rem 1rem' });
  function updateSummary() {
    const remaining = totalIncome - totalBudget();
    summary.innerHTML = '';
    summary.appendChild(el('div', { style: 'display:flex;justify-content:space-between' },
      el('span', {}, `Income: ${formatCurrency(totalIncome)}`),
      el('span', {}, `Budgeted: ${formatCurrency(totalBudget())}`),
      el('strong', { style: remaining === 0 ? 'color:var(--positive)' : 'color:var(--negative)' },
        `Remaining: ${formatCurrency(remaining)}`
      ),
    ));
  }

  const list = el('div', { style: 'max-height:400px;overflow-y:auto' });
  data.categories.forEach(cat => {
    const row = el('div', { className: 'input-row', style: 'align-items:flex-end;margin-bottom:0.5rem' });
    const label = el('div', { className: 'form-group', style: 'flex:2' },
      el('label', {}, `${cat.icon || ''} ${cat.name}`)
    );
    const input = el('input', { type: 'number', step: '0.01', min: '0', value: cat.monthlyBudget || 0 });
    input.addEventListener('input', () => {
      cat.monthlyBudget = Number(input.value);
      updateSummary();
    });
    const fg = el('div', { className: 'form-group', style: 'flex:1' },
      el('label', {}, 'Monthly Budget'),
      input
    );
    row.appendChild(label);
    row.appendChild(fg);
    list.appendChild(row);
  });

  updateSummary();
  card.appendChild(summary);
  card.appendChild(list);
  card.appendChild(navButtons(nav, true));
}

function doneStep(card, data, nav) {
  card.appendChild(el('h2', {}, 'You\'re All Set! 🎉'));
  card.appendChild(el('p', { className: 'subtitle' }, 'Your Financial Peace Dashboard is ready. Remember: give every dollar a job, attack the smallest debt first, and celebrate every win along the way.'));

  const totalIncome = data.incomeSources.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const totalDebt = data.debts.reduce((s, d) => s + (Number(d.balance) || 0), 0);

  card.appendChild(el('div', { className: 'grid grid-2', style: 'margin:1.5rem 0' },
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, 'Monthly Income'),
      el('div', { className: 'card-value accent' }, formatCurrency(totalIncome))
    ),
    el('div', { className: 'card' },
      el('div', { className: 'card-title' }, 'Total Debt'),
      el('div', { className: 'card-value' }, formatCurrency(totalDebt))
    ),
  ));

  card.appendChild(el('button', {
    className: 'btn btn-primary', style: 'width:100%;padding:0.85rem',
    onClick: nav.finish
  }, 'Launch My Dashboard →'));
}

function formField(label, type, value, onChange, opts = {}) {
  const group = el('div', { className: 'form-group' });
  group.appendChild(el('label', {}, label));
  if (type === 'select') {
    const sel = el('select');
    (opts.options || []).forEach(o => sel.appendChild(el('option', { value: o.value }, o.label)));
    sel.value = value || '';
    sel.addEventListener('change', () => onChange(sel.value));
    group.appendChild(sel);
  } else {
    const input = el('input', { type, value: value ?? '', ...opts });
    input.addEventListener('input', () => onChange(type === 'number' ? input.value : input.value));
    group.appendChild(input);
  }
  return group;
}

function navButtons(nav, isLast = false) {
  return el('div', { className: 'btn-group', style: 'margin-top:1.5rem;justify-content:space-between' },
    el('button', { className: 'btn btn-secondary', onClick: nav.back }, '← Back'),
    el('button', { className: 'btn btn-primary', onClick: nav.next }, isLast ? 'Review & Finish →' : 'Continue →')
  );
}