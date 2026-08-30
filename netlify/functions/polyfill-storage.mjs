/** FigPig's store expects localStorage. Netlify Functions do not have it. */
if (typeof globalThis.localStorage === 'undefined') {
  const mem = Object.create(null);
  globalThis.localStorage = {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null;
    },
    setItem(key, value) {
      mem[key] = String(value);
    },
    removeItem(key) {
      delete mem[key];
    },
    clear() {
      for (const k of Object.keys(mem)) delete mem[k];
    },
  };
}
