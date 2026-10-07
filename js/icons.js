/**
 * One inline SVG line-icon set (24px grid, 1.75 stroke, currentColor).
 * Purely presentational: every icon is aria-hidden.
 */
const P = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  log: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  budget: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  bills: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  income: '<rect x="2.5" y="6" width="19" height="13" rx="2"/><path d="M2.5 10h19"/><path d="M16 15h2"/>',
  debt: '<path d="M3 17 9 11l4 4 8-8"/><path d="M15 7h6v6"/>',
  notes: '<path d="M5 3h10l4 4v14H5z"/><path d="M15 3v4h4"/><path d="M8 12h8M8 16h5"/>',
  reports: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  advisor: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.5"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  note: '<path d="M4 4h16v11l-5 5H4z"/><path d="M15 20v-5h5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  bank: '<path d="m3 9 9-5 9 5"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.5-4.5L3 9"/><path d="M3 4v5h5"/><path d="M4 13a8 8 0 0 0 14.5 4.5L21 15"/><path d="M21 20v-5h-5"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
};

export function iconSvg(name, size = 24) {
  const body = P[name] || P.more;
  return `<svg class="ico ico-${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** DOM node wrapping an icon (use as an el() child). */
export function icon(name, size = 24, className = '') {
  const span = document.createElement('span');
  span.className = `ico-wrap${className ? ` ${className}` : ''}`;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = iconSvg(name, size);
  return span;
}
