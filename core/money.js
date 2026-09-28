/**
 * Montants : toujours des centimes entiers (§6 du cahier des charges — jamais de nombre à virgule
 * flottante dans un calcul comptable). Les taux de TVA sont en points de base (2000 = 20 %).
 */

export function assertCents(value, label = 'montant') {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} doit être un nombre entier de centimes (reçu : ${value})`);
  }
  return value;
}

/** "1 234,56" | "1234.56" | "-12" → centimes. Refuse plus de 2 décimales plutôt que d'arrondir en silence. */
export function parseEuros(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new TypeError(`Montant invalide : ${input}`);
    return Math.round(input * 100);
  }
  const s = String(input)
    .trim()
    .replace(/[\s\u00A0\u202F€]/g, '')
    .replace(',', '.');
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new TypeError(`Montant invalide : « ${input} »`);
  const cents = Number(m[2]) * 100 + Number((m[3] || '').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

const euroFmt = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

export function formatEuros(cents) {
  assertCents(cents);
  return euroFmt.format(cents / 100);
}

/** Format décimal à virgule sans séparateur de milliers, utilisé par le FEC ("1234,56"). */
export function formatDecimalComma(cents) {
  assertCents(cents);
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? '-' : ''}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}

/** Arrondi commercial (demi vers le haut en valeur absolue) de numerateur / denominateur, en entiers. */
export function divRound(numerator, denominator) {
  const sign = Math.sign(numerator) * Math.sign(denominator);
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  return sign * Math.floor((2 * n + d) / (2 * d));
}

/** TVA d'un montant HT : ht × taux (points de base) / 10 000, arrondi au centime. */
export function vatFromHt(htCents, rateBp) {
  assertCents(htCents, 'HT');
  return divRound(htCents * rateBp, 10000);
}

/** Décompose un TTC en HT + TVA (cas des tickets et factures d'achat saisies TTC). */
export function splitTtc(ttcCents, rateBp) {
  assertCents(ttcCents, 'TTC');
  const ht = divRound(ttcCents * 10000, 10000 + rateBp);
  return { ht, tva: ttcCents - ht };
}

export function sum(values) {
  return values.reduce((acc, v) => acc + assertCents(v), 0);
}
