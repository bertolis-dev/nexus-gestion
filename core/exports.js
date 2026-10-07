/**
 * Exports des états comptables (§3.7 « exports Excel et PDF de chaque état »).
 * Format CSV lisible directement par Excel en France : séparateur « ; », virgule décimale, BOM
 * UTF-8 (sans lui, Excel affiche mal les accents), fin de ligne CRLF. Le PDF passe par l'impression
 * du navigateur (feuille de style d'impression de l'application).
 */

import { trialBalance, generalLedger, journalReport } from './reports.js?v=66361b9';
import { JOURNALS } from './ledger.js?v=66361b9';
import { formatDecimalComma } from './money.js?v=66361b9';

/**
 * Cellule CSV. Un texte commençant par =, +, -, @, une tabulation ou un retour chariot serait
 * interprété comme une formule par le tableur (injection) : il est préfixé d'une apostrophe. Les
 * montants (« -12,50 ») restent des nombres.
 */
const cell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(,\d+)?$/.test(s)) s = `'${s}`;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const money = (cents) => (cents ? formatDecimalComma(cents) : '');
const frDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

export function toCsv(header, rows) {
  return `\uFEFF${[header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n')}\r\n`;
}

export function trialBalanceCsv(ledger, opts) {
  const tb = trialBalance(ledger, opts);
  const rows = tb.rows.map((r) => [r.account, r.label, money(r.debit), money(r.credit), money(r.soldeDebiteur), money(r.soldeCrediteur)]);
  rows.push(['', 'Total', money(tb.totals.debit), money(tb.totals.credit), money(tb.totals.soldeDebiteur), money(tb.totals.soldeCrediteur)]);
  return toCsv(['Compte', 'Libellé', 'Débit', 'Crédit', 'Solde débiteur', 'Solde créditeur'], rows);
}

export function generalLedgerCsv(ledger, opts) {
  const rows = [];
  for (const block of generalLedger(ledger, opts)) {
    for (const l of block.lines) {
      rows.push([
        block.account,
        block.label,
        frDate(l.date),
        l.journal,
        l.number ?? '',
        l.pieceRef,
        l.label,
        l.aux,
        money(l.debit),
        money(l.credit),
        formatDecimalComma(l.runningBalance),
        l.letter,
      ]);
    }
  }
  return toCsv(['Compte', 'Libellé du compte', 'Date', 'Journal', 'N° écriture', 'Pièce', 'Libellé', 'Tiers', 'Débit', 'Crédit', 'Solde', 'Lettrage'], rows);
}

export function journalsCsv(ledger, opts) {
  const rows = [];
  for (const code of Object.keys(JOURNALS)) {
    for (const e of journalReport(ledger, code, opts)) {
      for (const l of e.lines)
        rows.push([code, JOURNALS[code], e.number ?? 'brouillon', frDate(e.date), e.pieceRef, l.account, l.aux, l.label, money(l.debit), money(l.credit)]);
    }
  }
  return toCsv(['Journal', 'Libellé du journal', 'N° écriture', 'Date', 'Pièce', 'Compte', 'Tiers', 'Libellé', 'Débit', 'Crédit'], rows);
}
