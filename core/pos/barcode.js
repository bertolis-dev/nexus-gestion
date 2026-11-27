/**
 * Codes-barres des articles du catalogue : texte (jamais un nombre, pour garder les zéros de tête),
 * unique dans le dossier. La clé de contrôle EAN-8 / EAN-13 / UPC-A est vérifiée pour avertir d'une
 * faute de frappe, sans bloquer (codes internes, codes de balance).
 */

export class BarcodeError extends Error {}

/** Code lu ou saisi : espaces retirés, chiffres et lettres gardés tels quels (zéros de tête compris). */
export function normalizeBarcode(raw) {
  return String(raw ?? '')
    .replace(/\s+/g, '')
    .toUpperCase();
}

/** Code accepté : 4 à 48 caractères parmi chiffres, lettres, tiret, point (Code 128 courant). */
export function isValidBarcode(code) {
  return /^[0-9A-Z.-]{4,48}$/.test(code);
}

/** Clé de contrôle GTIN (EAN-8, UPC-A, EAN-13, GTIN-14) correcte ; null si le code n'est pas un GTIN. */
export function gtinCheckOk(code) {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) return null;
  const digits = [...code].map(Number);
  const check = digits.pop();
  const total = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (total % 10)) % 10 === check;
}

/** Article dont le code-barres correspond exactement, ou null. */
export function findByBarcode(catalog = [], raw) {
  const code = normalizeBarcode(raw);
  return (code && catalog.find((i) => i.barcode === code)) || null;
}

/** Contrôle d'un code pour un article : forme, et aucun autre article du dossier ne le porte déjà. */
export function checkBarcode(catalog = [], raw, { itemId = null } = {}) {
  const code = normalizeBarcode(raw);
  if (!code) return '';
  if (!isValidBarcode(code)) throw new BarcodeError('Code-barres illisible : 4 à 48 chiffres ou lettres, sans espace.');
  const other = catalog.find((i) => i.barcode === code && i.id !== itemId);
  if (other) throw new BarcodeError(`Ce code-barres est déjà celui de « ${other.label} ».`);
  return code;
}
