/**
 * Dates civiles françaises. Une date comptable est une date à Paris, pas en UTC :
 * `new Date().toISOString().slice(0, 10)` renvoie la veille entre minuit et 1 h (2 h en été).
 * Les dates sont des chaînes « AAAA-MM-JJ » ; l'arithmétique se fait en UTC sur ces chaînes,
 * sans dépendre du fuseau de la machine ni des changements d'heure.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PARIS = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Date civile à Paris d'un instant (par défaut : maintenant). */
export function todayParis(now = new Date()) {
  const p = Object.fromEntries(PARIS.formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Date civile à Paris d'un horodatage ISO (ex. date de validation d'une écriture) ; '' si absent. */
export function parisDateOf(timestamp) {
  return timestamp ? todayParis(new Date(timestamp)) : '';
}

/** Date civile + n jours. */
export function addDays(isoDate, days) {
  if (!ISO_DATE.test(isoDate || '')) throw new Error(`Date invalide : ${isoDate}`);
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
