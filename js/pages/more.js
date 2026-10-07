import { el } from '../utils.js';
import { icon } from '../icons.js';
import { NAV_ITEMS, bottomTabIds, buildSyncChip, showNotesPopup } from '../components/layout.js';

/** iOS-style "More" list screen (mobile). Navigation only — no data changes. */
export function renderMore(container) {
  container.innerHTML = '';
  const tabs = bottomTabIds();
  container.appendChild(el('div', { className: 'page-header' }, el('h2', {}, 'More')));

  const row = (ic, label, onClick, trailing) => el('button', {
    type: 'button', className: 'list-row list-row-button', onClick,
  },
    el('span', { className: 'list-row__icon' }, icon(ic, 22)),
    el('span', { className: 'list-row__title' }, label),
    trailing || el('span', { className: 'list-row__chev' }, icon('chevron', 18)),
  );

  container.appendChild(el('div', { className: 'list-group section', role: 'list' },
    ...NAV_ITEMS.filter(i => !tabs.has(i.id)).map(i =>
      row(i.icon, i.label, () => window.appNavigate(i.id))),
  ));

  container.appendChild(el('div', { className: 'list-group section' },
    row('note', 'Quick notes', () => showNotesPopup()),
  ));

  const sync = buildSyncChip();
  sync.classList.add('more-sync-chip');
  sync.removeAttribute('id');
  container.appendChild(el('div', { className: 'list-group section' },
    el('div', { className: 'list-row' },
      el('span', { className: 'list-row__icon' }, icon('sync', 22)),
      el('span', { className: 'list-row__title' }, 'Cloud sync'),
      sync,
    ),
  ));

  const build = window.FigPig?.APP_BUILD || document.querySelector('meta[name="app-build"]')?.content || '';
  container.appendChild(el('p', { className: 'hint more-about' }, `FigPig Financial · Build ${build}`));
}
