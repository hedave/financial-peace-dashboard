export const PALETTES = [
  {
    id: 'forest',
    name: 'Forest',
    description: 'Calm teal & blue',
    swatches: ['#145246', '#1e6b5c', '#3b82c4'],
  },
  {
    id: 'lavender',
    name: 'Lavender',
    description: 'Soft purple & lilac',
    swatches: ['#5b4b8a', '#8b7ec8', '#a78bfa'],
  },
  {
    id: 'rose',
    name: 'Rose',
    description: 'Warm pink & mauve',
    swatches: ['#9d174d', '#db7093', '#f472b6'],
  },
  {
    id: 'sunset',
    name: 'Sunset',
    description: 'Coral & golden warmth',
    swatches: ['#c2410c', '#ea580c', '#f59e0b'],
  },
  {
    id: 'ocean',
    name: 'Ocean',
    description: 'Classic blues',
    swatches: ['#1e40af', '#2563eb', '#38bdf8'],
  },
  {
    id: 'sage',
    name: 'Sage',
    description: 'Earthy green & cream',
    swatches: ['#4d6a51', '#6b8f71', '#a3b18a'],
  },
  {
    id: 'slate',
    name: 'Slate',
    description: 'Neutral gray & steel',
    swatches: ['#334155', '#64748b', '#94a3b8'],
  },
  {
    id: 'wine',
    name: 'Wine',
    description: 'Deep burgundy & gold',
    swatches: ['#6b2141', '#9f1239', '#d97706'],
  },
];

export function applyTheme(settings = {}) {
  const root = document.documentElement;
  root.setAttribute('data-theme', settings.darkMode ? 'dark' : 'light');
  root.setAttribute('data-palette', settings.palette || 'forest');
  root.setAttribute('data-large-text', settings.largeText ? 'true' : 'false');
  root.setAttribute('data-reduce-motion', settings.reduceMotion ? 'true' : 'false');
}

export function getPalette(id) {
  return PALETTES.find(p => p.id === id) || PALETTES[0];
}