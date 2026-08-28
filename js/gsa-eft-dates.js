/**
 * GSA / NFC federal EFT (direct deposit) dates — the purple cells on
 * https://www.gsa.gov/.../payroll-calendars/{year}-payroll-calendar
 * Official paycheck dates (pink) are usually a few days later; FigPig
 * uses EFT because that's when USAA checking actually moves.
 */
const GSA_EFT_BY_YEAR = {
  2026: [
    '2026-01-02', '2026-01-16', '2026-01-30',
    '2026-02-13', '2026-02-27',
    '2026-03-13', '2026-03-27',
    '2026-04-10', '2026-04-24',
    '2026-05-08', '2026-05-22',
    '2026-06-05', '2026-06-18',
    '2026-07-02', '2026-07-17', '2026-07-31',
    '2026-08-14', '2026-08-28',
    '2026-09-11', '2026-09-25',
    '2026-10-09', '2026-10-23',
    '2026-11-06', '2026-11-20',
    '2026-12-04', '2026-12-18', '2026-12-31',
  ],
  2027: [
    '2027-01-15', '2027-01-29',
    '2027-02-12', '2027-02-26',
    '2027-03-12', '2027-03-26',
    '2027-04-09', '2027-04-23',
    '2027-05-07', '2027-05-21',
    '2027-06-04', '2027-06-17',
    '2027-07-02', '2027-07-16', '2027-07-30',
    '2027-08-13', '2027-08-27',
    '2027-09-10', '2027-09-24',
    '2027-10-08', '2027-10-22',
    '2027-11-05', '2027-11-19',
    '2027-12-03', '2027-12-17', '2027-12-30',
  ],
};

export function getGsaEftYears() {
  return Object.keys(GSA_EFT_BY_YEAR).map(Number).sort((a, b) => a - b);
}

export function getGsaEftDates(year) {
  const y = Number(year);
  return (GSA_EFT_BY_YEAR[y] || []).slice();
}

export function isGsaEftDate(iso) {
  const y = Number(String(iso || '').slice(0, 4));
  return (GSA_EFT_BY_YEAR[y] || []).includes(String(iso).slice(0, 10));
}

export function gsaEftDateSet(year) {
  return new Set(getGsaEftDates(year));
}
