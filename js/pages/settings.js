import { el, formatCurrency } from '../utils.js';
import { store } from '../store.js';
import { showToast, confirmDialog } from '../components/modal.js';
import { hashPassword } from '../utils.js';
import { PALETTES, applyTheme } from '../themes.js';
import { exportForGoogleSheets } from '../sheets-export.js';
import { buildRuleLabel } from '../category-rules.js';
import {
  isCloudConfigured, getUserEmail, getSyncStatus, signOut,
  createHouseholdInvite, listHouseholdInvites, isNotesOnlyRole,
} from '../cloud-sync.js';

/**
 * Keep Settings panels open across appRefresh (delete rule, save password, etc.).
 * Only true panels get the open attribute — never open="false" (HTML treats that as open).
 */
const settingsOpenPanels = {
  appearance: true,
  snowball: true,
  security: false,
  cloud: false,
  data: false,
  advisor: false,
  rules: false,
  install: false,
  about: false,
};

function settingsAcc(id, title, ...bodyChildren) {
  const det = el('details', { className: 'settings-acc section' },
    el('summary', {}, title),
    el('div', { className: 'settings-acc-body' }, ...bodyChildren),
  );
  det.open = !!settingsOpenPanels[id];
  det.addEventListener('toggle', () => {
    settingsOpenPanels[id] = det.open;
  });
  return det;
}

export async function renderSettings(container) {
  const state = store.getState();
  const cloudOn = isCloudConfigured();
  const cloudEmail = cloudOn ? await getUserEmail() : null;
  const syncInfo = getSyncStatus();

  container.innerHTML = '';
  container.appendChild(el('div', { className: 'page-header' },
    el('h2', {}, 'Settings'),
    el('p', {}, 'Customize your FigPig Financial experience')
  ));

  const currentPalette = state.settings.palette || 'forest';

  const bufferVal = state.settings.surplusCashBuffer != null
    ? Number(state.settings.surplusCashBuffer)
    : 50;
  const bufferIn = el('input', {
    type: 'number',
    step: '1',
    min: '0',
    value: String(Number.isFinite(bufferVal) ? bufferVal : 50),
  });

  container.appendChild(settingsAcc('appearance', 'Appearance & mode',
    el('p', { style: 'font-size:0.85rem;color:var(--text-muted);margin-bottom:0.5rem' }, 'Color palette'),
    paletteSelector(currentPalette),
    toggleRow('Dark Mode', state.settings.darkMode, val => {
      store.update(s => { s.settings.darkMode = val; });
      applyTheme({ ...store.getState().settings, darkMode: val });
    }),
    toggleRow('Larger text', !!state.settings.largeText, val => {
      store.update(s => { s.settings.largeText = val; });
      applyTheme(store.getState().settings);
      showToast(val ? 'Larger text on' : 'Larger text off');
    }),
    toggleRow('Reduce motion', !!state.settings.reduceMotion, val => {
      store.update(s => { s.settings.reduceMotion = val; });
      applyTheme(store.getState().settings);
    }),
    toggleRow('Dave Ramsey Mode (soft zero-based)', state.settings.daveRamseyMode, val => {
      store.update(s => { s.settings.daveRamseyMode = val; });
      showToast(val
        ? 'On: warns when To Allocate ≠ $0 and before overspending an envelope'
        : 'Dave Ramsey soft warnings off');
    }),
    el('p', {
      className: 'tx-form-hint',
      style: 'margin-top:0.5rem;margin-bottom:0',
    }, 'Soft only — never blocks spending.'),
  ));

  container.appendChild(settingsAcc('snowball', 'Snowball cash safety',
    el('p', { style: 'font-size:0.85rem;color:var(--text-muted);margin-bottom:1rem;line-height:1.6' },
      'Safe snowball surplus never spends checking below: unpaid bills due by next paycheck + this cushion. Default $50.',
    ),
    el('div', { className: 'form-group' },
      el('label', {}, 'Cushion left in checking after bills ($)'),
      bufferIn,
    ),
    el('button', {
      type: 'button',
      className: 'btn btn-primary btn-sm',
      onClick: () => {
        const n = Math.max(0, Number(bufferIn.value) || 0);
        store.update(s => { s.settings.surplusCashBuffer = Math.round(n * 100) / 100; });
        showToast(`Snowball cushion set to ${formatCurrency(n)}`);
        window.appRefresh();
      },
    }, 'Save cushion'),
  ));

  const daysSinceBackup = daysSince(state.settings.lastBackupAt);
  if (daysSinceBackup == null || daysSinceBackup >= 30) {
    container.appendChild(el('div', { className: 'banner banner-warning section' },
      el('div', { className: 'banner-icon' }, '💾'),
      el('div', { className: 'banner-text' },
        el('h3', {}, 'Backup recommended'),
        el('p', {},
          daysSinceBackup == null
            ? 'You have not exported a JSON backup yet. Download one for peace of mind.'
            : `Last backup was ${daysSinceBackup} days ago. Export a fresh copy when you can.`,
        ),
      ),
      el('button', {
        className: 'btn btn-secondary btn-sm',
        style: 'margin-left:auto;align-self:center',
        onClick: () => downloadJsonBackup(),
      }, 'Export Backup'),
    ));
  }

  container.appendChild(settingsAcc('security', 'Security',
    el('p', { style: 'font-size:0.85rem;color:var(--text-muted);margin-bottom:1rem' },
      'Optional app lock on this device. Not bank-grade encryption — use cloud sign-in for real multi-device privacy.',
    ),
    el('div', { className: 'form-group' },
      el('label', { for: 'pw-input' }, state.settings.passwordHash ? 'New password' : 'Set password'),
      el('input', { type: 'password', id: 'pw-input', placeholder: 'Enter password', autocomplete: 'new-password' }),
    ),
    el('div', { className: 'form-group' },
      el('label', { for: 'pw-confirm' }, 'Confirm password'),
      el('input', { type: 'password', id: 'pw-confirm', placeholder: 'Re-enter password', autocomplete: 'new-password' }),
    ),
    el('button', {
      className: 'btn btn-primary btn-sm',
      onClick: async () => {
        const pw = document.getElementById('pw-input').value;
        const conf = document.getElementById('pw-confirm').value;
        if (!pw) {
          showToast('Enter a password', 'info');
          return;
        }
        if (pw !== conf) {
          showToast('Passwords do not match', 'info');
          return;
        }
        if (pw.length < 4) {
          showToast('Use at least 4 characters', 'info');
          return;
        }
        const hash = await hashPassword(pw);
        store.update(s => { s.settings.passwordHash = hash; });
        document.getElementById('pw-input').value = '';
        document.getElementById('pw-confirm').value = '';
        showToast('Password set!');
        window.appRefresh();
      },
    }, 'Save Password'),
    state.settings.passwordHash ? el('button', {
      className: 'btn btn-secondary btn-sm', style: 'margin-left:0.5rem',
      onClick: () => {
        confirmDialog(
          'Remove app password?',
          'Anyone with this browser profile can open the budget without a password.',
          () => {
            store.update(s => { s.settings.passwordHash = null; });
            showToast('Password removed');
            window.appRefresh();
          },
        );
      },
    }, 'Remove Password') : null,
  ));

  container.appendChild(settingsAcc('cloud', 'Cloud Sync',
    cloudOn
      ? el('div', {},
        cloudEmail
          ? el('p', { style: 'font-size:0.85rem;margin-bottom:0.75rem' },
            `Signed in as ${cloudEmail}`,
            syncInfo.lastSyncedAt
              ? el('span', { style: 'display:block;color:var(--text-muted);font-size:0.8rem;margin-top:0.25rem' },
                `Last synced: ${syncInfo.lastSyncedAt.toLocaleString()}`)
              : null,
          )
          : el('p', { style: 'font-size:0.85rem;color:var(--text-muted);margin-bottom:0.75rem' },
            'Not signed in — reload the app to sign in and sync across devices.',
          ),
        el('div', { className: 'btn-group' },
          el('button', {
            className: 'btn btn-secondary btn-sm',
            onClick: async () => {
              try {
                await store.forcePullFromCloud();
                showToast('Downloaded budget from cloud');
                window.location.reload();
              } catch (e) {
                showToast(e.message || 'Pull failed', 'info');
              }
            },
          }, 'Pull from Cloud'),
          el('button', {
            className: 'btn btn-secondary btn-sm',
            onClick: async () => {
              try {
                await store.pushToCloud({ force: true });
                showToast('Synced to cloud!');
                window.appRefresh();
              } catch (e) {
                showToast(e.message || 'Sync failed', 'info');
              }
            },
          }, 'Sync Now'),
          cloudEmail ? el('button', {
            className: 'btn btn-secondary btn-sm',
            onClick: async () => {
              await signOut();
              showToast('Signed out');
              window.location.reload();
            },
          }, 'Sign Out') : null,
        ),
        el('p', { className: 'tx-form-hint', style: 'margin-top:0.75rem' },
          isNotesOnlyRole()
            ? 'You are on a notes-only login. Stickies sync to the household. Money edits stay on the main account.'
            : 'Your login owns the budget. Create a notes-only code so your spouse can add stickies on her own account without changing transactions.',
        ),
        await householdSharePanel(cloudEmail),
      )
      : el('p', { style: 'font-size:0.85rem;color:var(--text-muted);line-height:1.6' },
        'Cloud sync is not configured on this deploy. See DEPLOY.md to connect Supabase.',
      ),
  ));

  container.appendChild(settingsAcc('data', 'Data Management',
    el('p', { style: 'font-size:0.85rem;color:var(--text-muted);margin-bottom:1rem;line-height:1.6' },
      'Export a snapshot for Google Sheets, or back up / restore your full dataset. ',
      'CSV bank imports on the Transactions page remain the best way to add new activity.',
    ),
    el('div', { className: 'btn-group' },
      el('button', {
        className: 'btn btn-accent',
        onClick: () => {
          const count = exportForGoogleSheets();
          showToast(`Downloading ${count} CSV files for Google Sheets…`, 'success', 5000);
        },
      }, 'Export for Google Sheets'),
      el('button', {
        className: 'btn btn-secondary',
        onClick: () => downloadJsonBackup(),
      }, 'Export Backup (JSON)'),
      state.settings.lastBackupAt
        ? el('p', {
          className: 'tx-form-hint',
          style: 'width:100%;margin-top:0.5rem',
        }, `Last JSON backup: ${new Date(state.settings.lastBackupAt).toLocaleString()}`)
        : null,
      el('button', {
        className: 'btn btn-secondary',
        onClick: () => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = '.json';
          input.onchange = e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
              try {
                const data = JSON.parse(ev.target.result);
                if (!data || typeof data !== 'object') throw new Error('bad');
                const txCount = Array.isArray(data.transactions) ? data.transactions.length : 0;
                const billCount = Array.isArray(data.bills) ? data.bills.length : 0;
                const debtCount = Array.isArray(data.debts) ? data.debts.length : 0;
                confirmDialog(
                  'Replace all local data?',
                  `This fully replaces your current budget with the backup (${txCount} transactions, ${billCount} bills, ${debtCount} debts). Current data on this device will be overwritten.`,
                  async () => {
                    try {
                      store.replaceStateFromBackup(data);
                      applyTheme(store.getState().settings);
                      try {
                        await store.pushToCloud({ force: true });
                      } catch {
                        // Local restore still saved; cloud push can retry after reload
                      }
                      showToast('Backup restored — reloading…');
                      window.location.reload();
                    } catch {
                      showToast('Could not restore backup', 'info');
                    }
                  },
                );
              } catch {
                showToast('Invalid backup file', 'info');
              }
            };
            reader.readAsText(file);
          };
          input.click();
        },
      }, 'Restore Backup'),
      (() => {
        const n = store.countFundedEnvelopeTransfers();
        if (!n) return null;
        return el('button', {
          className: 'btn btn-secondary',
          onClick: () => {
            confirmDialog(
              'Clean up old Fund transfers?',
              `Found ${n} “Funded envelope: …” transfer(s) from the old Fund button that reduced checking incorrectly. Delete them and put that money back into checking?`,
              () => {
                const removed = store.cleanupFundedEnvelopeTransfers();
                showToast(`Removed ${removed} transfer${removed === 1 ? '' : 's'} — checking restored`, 'success');
                window.appRefresh();
              },
            );
          },
        }, `Clean up old Fund transfers (${n})`);
      })(),
      el('button', {
        className: 'btn btn-danger',
        onClick: () => {
          confirmDialog('Reset All Data', 'This will erase everything and restart setup. Are you sure?', () => {
            store.reset();
            window.location.reload();
          });
        },
      }, 'Reset All Data'),
    ),
  ));

  const rules = [...(state.categoryRules || [])]
    .sort((a, b) => String(a.pattern).localeCompare(String(b.pattern)));
  const rulesHost = el('div', { className: 'rules-list-host' });
  const rulesSearch = el('input', {
    type: 'search',
    placeholder: 'Filter rules by merchant…',
    className: 'rules-search',
  });

  const rulesSummaryLabel = { current: `Category Rules (${rules.length})` };

  function liveRules() {
    return [...(store.getState().categoryRules || [])]
      .sort((a, b) => String(a.pattern).localeCompare(String(b.pattern)));
  }

  const clearAllRulesBtn = el('button', {
    type: 'button',
    className: 'btn btn-secondary btn-sm',
    style: 'margin-top:0.75rem',
    onClick: () => {
      confirmDialog('Delete all category rules?', 'You can recreate them when categorizing imports.', () => {
        store.update(s => { s.categoryRules = []; });
        showToast('All rules cleared');
      });
    },
  }, 'Clear all rules');

  function paintRules(query = rulesSearch.value || '') {
    const list = liveRules();
    rulesSummaryLabel.current = `Category Rules (${list.length})`;
    const sum = rulesHost.closest('details')?.querySelector('summary');
    if (sum) sum.textContent = rulesSummaryLabel.current;
    clearAllRulesBtn.hidden = list.length === 0;

    const q = query.trim().toLowerCase();
    const filtered = q
      ? list.filter(r => String(r.pattern).includes(q) || buildRuleLabel(r, store.getState().categories).toLowerCase().includes(q))
      : list;
    rulesHost.innerHTML = '';
    if (!filtered.length) {
      rulesHost.appendChild(el('p', { style: 'color:var(--text-muted);font-size:0.9rem' },
        list.length ? 'No rules match that filter.' : 'No rules yet — categorize a transaction and toggle "Remember for future imports".',
      ));
      return;
    }
    filtered.forEach(rule => {
      rulesHost.appendChild(el('div', { className: 'rule-card' },
        el('div', { className: 'rule-card-main' },
          el('strong', { className: 'rule-pattern' }, `"${rule.pattern}"`),
          el('div', { className: 'rule-maps' }, buildRuleLabel(rule, store.getState().categories)),
          rule.createdAt
            ? el('div', { className: 'rule-meta' }, `Added ${rule.createdAt}`)
            : null,
        ),
        el('div', { className: 'btn-group' },
          el('button', {
            type: 'button',
            className: 'btn btn-sm btn-secondary',
            onClick: () => {
              const next = window.prompt('Edit merchant pattern (lowercase match text)', rule.pattern);
              if (next == null) return;
              const key = next.trim().toLowerCase();
              if (!key) return;
              store.update(s => {
                const r = (s.categoryRules || []).find(x => x.id === rule.id);
                if (!r) return;
                s.categoryRules = s.categoryRules.filter(x => x.id !== rule.id && x.pattern !== key);
                r.pattern = key;
                s.categoryRules.push(r);
              });
              showToast('Rule updated');
            },
          }, 'Edit'),
          el('button', {
            type: 'button',
            className: 'btn btn-sm btn-danger',
            onClick: () => {
              store.removeCategoryRule(rule.id);
              showToast('Rule removed');
            },
          }, 'Delete'),
        ),
      ));
    });
  }

  rulesSearch.addEventListener('input', () => paintRules(rulesSearch.value));

  // Advisor envelope aliases
  const cats = (state.categories || []).filter(c => !c.parentId)
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const aliases = state.settings.advisorAliases || { dining: null, vacation: null, christmas: null };

  function aliasSelect(key, label, hint) {
    const sel = el('select', {
      id: `alias-${key}`,
      onChange: (e) => {
        const val = e.target.value || null;
        store.update(s => {
          if (!s.settings.advisorAliases) {
            s.settings.advisorAliases = { dining: null, vacation: null, christmas: null };
          }
          s.settings.advisorAliases[key] = val || null;
        });
        showToast(`${label} alias saved`);
      },
    },
      el('option', { value: '' }, 'Auto-match by name'),
      ...cats.map(c => el('option', {
        value: c.id,
        selected: aliases[key] === c.id ? true : undefined,
      }, `${c.icon || '✉️'} ${c.name}${c.isSinkingFund ? ' (sinking)' : ''}`)),
    );
    if (aliases[key]) sel.value = aliases[key];
    else sel.value = '';
    return el('div', { className: 'form-group' },
      el('label', {}, label),
      sel,
      el('p', { className: 'tx-form-hint', style: 'margin-top:0.35rem;margin-bottom:0' }, hint),
    );
  }

  container.appendChild(settingsAcc('advisor', 'Advisor envelopes',
    el('p', {
      style: 'font-size:0.85rem;color:var(--text-muted);margin-bottom:1rem;line-height:1.6',
    },
      'Pin which envelopes Advisor uses for dining, vacation, and Christmas. Auto-match works until you rename them — then set a pin here. (Dining is the default pick for “what if we cut ___ %?” until you choose another.)',
    ),
    aliasSelect('dining', 'Dining / eating out', 'Default envelope for cut-% scenarios and affordability cushions.'),
    aliasSelect('vacation', 'Vacation fund', 'Used for affordability and sinking-fund priority.'),
    aliasSelect('christmas', 'Christmas fund', 'Used for holiday vs vacation priority and surplus split.'),
    el('button', {
      type: 'button',
      className: 'btn btn-secondary btn-sm',
      onClick: () => {
        store.update(s => {
          s.settings.advisorAliases = { dining: null, vacation: null, christmas: null };
        });
        showToast('Aliases reset to auto-match');
        window.appRefresh();
      },
    }, 'Reset to auto-match'),
  ));

  container.appendChild(settingsAcc('rules', rulesSummaryLabel.current,
    el('p', { style: 'font-size:0.85rem;color:var(--text-muted);margin-bottom:1rem;line-height:1.6' },
      'Saved when you check "Remember for future imports" on a transaction. Rules match merchant text in the description. ',
      'Longer patterns win — e.g. “ingles gas” beats a broad “ingles”, so store groceries and pump gas can go to different envelopes. Edit patterns here if a rule is too vague.',
    ),
    rulesSearch,
    rulesHost,
    clearAllRulesBtn,
  ));
  paintRules();

  container.appendChild(settingsAcc('install', 'Install App',
    el('p', { style: 'font-size:0.85rem;color:var(--text-muted);margin-bottom:1rem;line-height:1.6' },
      'Install to your phone or desktop for quick access. In Chrome/Edge: menu → Install app. On iPhone Safari: Share → Add to Home Screen.',
    ),
    el('p', { style: 'font-size:0.8rem;color:var(--text-muted)' }, 'Works offline for viewing; data saves locally.'),
  ));

  container.appendChild(settingsAcc('about', 'About',
    el('p', { style: 'line-height:1.7;color:var(--text-muted)' },
      'FigPig Financial helps you follow Dave Ramsey\'s Total Money Makeover — Baby Steps, zero-based envelope budgeting, and the debt snowball. ',
      cloudOn
        ? 'Data syncs to your Supabase account when signed in, with a local copy in your browser for speed.'
        : 'Data is stored locally in your browser until cloud sync is configured.',
    ),
    el('p', { style: 'margin-top:0.5rem;font-size:0.8rem;color:var(--text-muted)' },
      'Household of ' + (state.settings.familySize || 7)
      + ' · Build 20260812i'
      + (cloudOn ? ' · Cloud on' : ' · Local only'),
    ),
  ));
}

function paletteSelector(currentId) {
  const grid = el('div', { className: 'palette-grid' });

  PALETTES.forEach(palette => {
    const btn = el('button', {
      type: 'button',
      className: `palette-option${palette.id === currentId ? ' active' : ''}`,
      onClick: () => {
        store.update(s => { s.settings.palette = palette.id; });
        applyTheme(store.getState().settings);
        showToast(`${palette.name} palette applied!`);
        window.appRefresh();
      },
    },
      el('div', { className: 'palette-swatches' },
        ...palette.swatches.map(color =>
          el('span', { className: 'palette-swatch', style: `background:${color}` })
        )
      ),
      el('span', { className: 'palette-name' }, palette.name),
      el('span', { className: 'palette-desc' }, palette.description),
    );
    grid.appendChild(btn);
  });

  return grid;
}

async function householdSharePanel(signedIn) {
  if (!signedIn) return null;
  if (isNotesOnlyRole()) {
    return el('p', { className: 'tx-form-hint', style: 'margin-top:0.5rem' },
      'Household role: notes only.',
    );
  }

  const box = el('div', { className: 'household-share', style: 'margin-top:1rem' });
  const codeEl = el('p', { className: 'household-code', style: 'font-size:1.4rem;font-weight:700;letter-spacing:0.12em;margin:0.5rem 0' }, '');
  const hint = el('p', { className: 'tx-form-hint', style: 'margin:0' }, '');

  async function paintInvite() {
    const invites = await listHouseholdInvites();
    const live = invites[0];
    if (live) {
      codeEl.textContent = live.code;
      hint.textContent = `She signs up with her own email, then enters this code. Expires ${new Date(live.expires_at).toLocaleDateString()}.`;
    } else {
      codeEl.textContent = '';
      hint.textContent = 'Create a code, then have her make her own login and join with it.';
    }
  }
  await paintInvite();

  box.appendChild(el('h3', { style: 'font-size:0.95rem;margin:0 0 0.35rem' }, 'Notes-only account (spouse)'));
  box.appendChild(el('p', {
    style: 'font-size:0.82rem;color:var(--text-muted);line-height:1.45;margin:0 0 0.5rem',
  }, 'First run supabase-household.sql in the Supabase SQL editor. Then create a code. She will see the budget and can add notes, not transactions.'));
  box.appendChild(codeEl);
  box.appendChild(hint);
  box.appendChild(el('button', {
    type: 'button',
    className: 'btn btn-sm btn-primary',
    style: 'margin-top:0.65rem',
    onClick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const inv = await createHouseholdInvite();
        codeEl.textContent = inv.code;
        hint.textContent = 'Give her this code. It lasts 7 days.';
        showToast('Household code ready', 'success');
      } catch (err) {
        showToast(err.message || 'Could not create code', 'info', 7000);
      } finally {
        btn.disabled = false;
      }
    },
  }, 'Create household code'));
  return box;
}

function daysSince(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24));
}

function downloadJsonBackup() {
  const data = JSON.stringify(store.getState(), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 10);
  a.download = `figpig-financial-backup-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  store.update(s => { s.settings.lastBackupAt = new Date().toISOString(); });
  showToast('Backup downloaded!');
  window.appRefresh();
}

function toggleRow(label, value, onChange) {
  const toggle = el('input', { type: 'checkbox' });
  if (value) toggle.checked = true;
  toggle.addEventListener('change', () => onChange(toggle.checked));

  return el('div', {
    style: 'display:flex;justify-content:space-between;align-items:center;padding:0.75rem 0;border-bottom:1px solid var(--border)'
  },
    el('span', {}, label),
    el('label', { className: 'toggle-switch' },
      toggle,
      el('span', { className: 'toggle-slider' }),
    )
  );
}