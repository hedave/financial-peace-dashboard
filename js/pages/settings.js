import { el } from '../utils.js';
import { store } from '../store.js';
import { showToast, confirmDialog } from '../components/modal.js';
import { hashPassword } from '../utils.js';
import { PALETTES, applyTheme } from '../themes.js';
import { exportForGoogleSheets } from '../sheets-export.js';
import { buildRuleLabel } from '../category-rules.js';
import {
  isCloudConfigured, getUserEmail, getSyncStatus, signOut,
} from '../cloud-sync.js';

export async function renderSettings(container) {
  const state = store.getState();
  const cloudOn = isCloudConfigured();
  const cloudEmail = cloudOn ? await getUserEmail() : null;
  const syncInfo = getSyncStatus();

  container.innerHTML = '';
  container.appendChild(el('div', { className: 'page-header' },
    el('h2', {}, 'Settings'),
    el('p', {}, 'Customize your Financial Peace experience')
  ));

  const currentPalette = state.settings.palette || 'forest';

  container.appendChild(el('div', { className: 'card section' },
    el('div', { className: 'section-title' }, 'Appearance'),
    el('p', { style: 'font-size:0.85rem;color:var(--text-muted);margin-bottom:0.5rem' }, 'Color palette'),
    paletteSelector(currentPalette),
    toggleRow('Dark Mode', state.settings.darkMode, val => {
      store.update(s => { s.settings.darkMode = val; });
      applyTheme({ ...store.getState().settings, darkMode: val });
    }),
    toggleRow('Dave Ramsey Mode (strict zero-based)', state.settings.daveRamseyMode, val => {
      store.update(s => { s.settings.daveRamseyMode = val; });
    }),
  ));

  container.appendChild(el('div', { className: 'card section' },
    el('div', { className: 'section-title' }, 'Security'),
    el('p', { style: 'font-size:0.85rem;color:var(--text-muted);margin-bottom:1rem' },
      'Optional password protection keeps your financial data private on shared devices.'
    ),
    el('div', { className: 'form-group' },
      el('label', {}, state.settings.passwordHash ? 'Change Password' : 'Set Password'),
      el('input', { type: 'password', id: 'pw-input', placeholder: 'Enter password' }),
    ),
    el('button', {
      className: 'btn btn-primary btn-sm',
      onClick: async () => {
        const pw = document.getElementById('pw-input').value;
        if (!pw) return;
        const hash = await hashPassword(pw);
        store.update(s => { s.settings.passwordHash = hash; });
        showToast('Password set!');
      }
    }, 'Save Password'),
    state.settings.passwordHash ? el('button', {
      className: 'btn btn-secondary btn-sm', style: 'margin-left:0.5rem',
      onClick: () => {
        store.update(s => { s.settings.passwordHash = null; });
        showToast('Password removed');
        window.appRefresh();
      }
    }, 'Remove Password') : null,
  ));

  container.appendChild(el('div', { className: 'card section' },
    el('div', { className: 'section-title' }, 'Cloud Sync'),
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
            'Not signed in — reload the app to sign in and sync across devices.'
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
          'Share one login with your wife so you both see the same budget. Changes save automatically.'
        ),
      )
      : el('p', { style: 'font-size:0.85rem;color:var(--text-muted);line-height:1.6' },
        'Cloud sync is not configured on this deploy. See DEPLOY.md to connect Supabase.'
      ),
  ));

  container.appendChild(el('div', { className: 'card section' },
    el('div', { className: 'section-title' }, 'Data Management'),
    el('p', { style: 'font-size:0.85rem;color:var(--text-muted);margin-bottom:1rem;line-height:1.6' },
      'Export a snapshot for Google Sheets, or back up / restore your full dataset. ',
      'CSV bank imports on the Transactions page remain the best way to add new activity.'
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
        onClick: () => {
          const data = JSON.stringify(store.getState(), null, 2);
          const blob = new Blob([data], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'financial-peace-backup.json';
          a.click();
          URL.revokeObjectURL(url);
          showToast('Backup downloaded!');
        }
      }, 'Export Backup (JSON)'),
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
                store.update(s => { Object.assign(s, data); });
                applyTheme(store.getState().settings);
                showToast('Backup restored!');
                window.location.reload();
              } catch {
                showToast('Invalid backup file', 'info');
              }
            };
            reader.readAsText(file);
          };
          input.click();
        }
      }, 'Restore Backup'),
      el('button', {
        className: 'btn btn-danger',
        onClick: () => {
          confirmDialog('Reset All Data', 'This will erase everything and restart setup. Are you sure?', () => {
            store.reset();
            window.location.reload();
          });
        }
      }, 'Reset All Data'),
    ),
  ));

  const rules = state.categoryRules || [];
  container.appendChild(el('div', { className: 'card section' },
    el('div', { className: 'section-title' }, 'Category Rules'),
    el('p', { style: 'font-size:0.85rem;color:var(--text-muted);margin-bottom:1rem;line-height:1.6' },
      'Saved when you check "Remember for future imports" on a transaction. Rules auto-categorize CSV imports.'
    ),
    rules.length
      ? el('div', { className: 'table-wrap' },
        el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, 'Merchant pattern'), el('th', {}, 'Maps to'), el('th', {}, ''),
          )),
          el('tbody', {},
            ...rules.map(rule => el('tr', {},
              el('td', {}, `"${rule.pattern}"`),
              el('td', {}, buildRuleLabel(rule, state.categories)),
              el('td', {},
                el('button', {
                  className: 'btn btn-sm btn-danger',
                  onClick: () => {
                    store.removeCategoryRule(rule.id);
                    showToast('Rule removed');
                    window.appRefresh();
                  },
                }, 'Delete'),
              ),
            )),
          ),
        ),
      )
      : el('p', { style: 'color:var(--text-muted);font-size:0.9rem' }, 'No rules yet — categorize a transaction and toggle "Remember for future imports".'),
  ));

  container.appendChild(el('div', { className: 'card section' },
    el('div', { className: 'section-title' }, 'Install App'),
    el('p', { style: 'font-size:0.85rem;color:var(--text-muted);margin-bottom:1rem;line-height:1.6' },
      'Install to your phone or desktop for quick access. In Chrome/Edge: menu → Install app. On iPhone Safari: Share → Add to Home Screen.'
    ),
    el('p', { style: 'font-size:0.8rem;color:var(--text-muted)' }, 'Works offline for viewing; data saves locally.'),
  ));

  container.appendChild(el('div', { className: 'card section' },
    el('div', { className: 'section-title' }, 'About'),
    el('p', { style: 'line-height:1.7;color:var(--text-muted)' },
      'Financial Peace Dashboard helps you follow Dave Ramsey\'s Total Money Makeover — Baby Steps, zero-based envelope budgeting, and the debt snowball. ',
      cloudOn
        ? 'Data syncs to your Supabase account when signed in, with a local copy in your browser for speed.'
        : 'Data is stored locally in your browser until cloud sync is configured.'
    ),
    el('p', { style: 'margin-top:0.5rem;font-size:0.8rem;color:var(--text-muted)' },
      'Family size: ' + (state.settings.familySize || 7) + ' · Version 1.0'
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