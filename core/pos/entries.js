/**
 * Écritures des ventes de caisse : recette du jour au crédit des ventes (707 biens, 706 services) et
 * de la TVA collectée, au débit de la caisse (530, espèces) ou des cartes à l'encaissement (5115,
 * versement du prestataire à venir). Retours en sens inverse. Versement du prestataire : banque et
 * commissions contre 5115. Écart de clôture : 658 (manque) ou 758 (excédent).
 */

import { sum } from '../money.js?v=151777b';
import { htByNature, parisDate } from './sale.js?v=151777b';

export const CASH_ACCOUNT = '530000';
export const CARD_ACCOUNT = '511500';
export const FEES_ACCOUNT = '627000';

function revenueLines(doc, sign) {
  const ht = htByNature(doc.lines, doc.totals);
  const lines = [];
  const credit = (account, amount, label) => {
    if (!amount) return;
    lines.push(sign > 0 ? { account, label, debit: 0, credit: amount } : { account, label, debit: amount, credit: 0 });
  };
  credit('707000', ht.biens, 'Ventes de marchandises (caisse)');
  credit('706000', ht.services, 'Prestations (caisse)');
  credit('445710', doc.totals.totalVat, 'TVA collectée (caisse)');
  return lines;
}

/** Écriture d'une vente encaissée (espèces et/ou carte). */
export function posSaleEntry(sale) {
  const label = `Caisse ticket ${sale.number}`;
  const cash = sum(sale.payments.filter((p) => p.method === 'cash').map((p) => p.amount));
  const card = sum(sale.payments.filter((p) => p.method === 'card').map((p) => p.amount));
  const lines = [];
  if (cash) lines.push({ account: CASH_ACCOUNT, label, debit: cash, credit: 0 });
  if (card) lines.push({ account: CARD_ACCOUNT, label, debit: card, credit: 0 });
  lines.push(...revenueLines(sale, 1));
  return { journal: 'VE', date: sale.date, label, pieceRef: sale.number, pieceDate: sale.date, source: { kind: 'pos-sale', id: sale.id }, lines };
}

/** Écriture d'un retour remboursé (espèces rendues, ou remboursement carte imputé sur le prochain versement). */
export function posReturnEntry(ret) {
  const label = `Caisse retour ${ret.number} (ticket ${ret.saleNumber})`;
  const account = ret.refund.method === 'card' ? CARD_ACCOUNT : CASH_ACCOUNT;
  return {
    journal: 'VE',
    date: ret.date,
    label,
    pieceRef: ret.number,
    pieceDate: ret.date,
    source: { kind: 'pos-return', id: ret.id },
    lines: [...revenueLines(ret, -1), { account, label, debit: 0, credit: ret.totals.totalTtc }],
  };
}

/** Versement du prestataire : montant net reçu en banque, commissions en charge, 5115 soldé du brut. */
export function payoutEntry({ id, date, bankAccount = '512000', net, fees, gross, label }) {
  if (gross !== net + fees) throw new Error('Versement : brut ≠ net + commissions.');
  const lines = [{ account: bankAccount, label, debit: net, credit: 0 }];
  if (fees > 0) lines.push({ account: FEES_ACCOUNT, label: `Commissions ${label}`, debit: fees, credit: 0 });
  if (fees < 0) lines.push({ account: FEES_ACCOUNT, label: `Commissions ${label}`, debit: 0, credit: -fees });
  lines.push({ account: CARD_ACCOUNT, label, debit: 0, credit: gross });
  return { journal: 'BQ', date, label, pieceRef: id, pieceDate: date, source: { kind: 'pos-payout', id }, lines };
}

/** Écart de caisse constaté à la clôture. */
export function closingGapEntry(session) {
  if (!session.gap) return null;
  const date = parisDate(session.closedAt); // clôture à 0 h 30 le 1er janvier : jour (et exercice) de Paris
  const label = `Écart de caisse ${date}`;
  const amount = Math.abs(session.gap);
  const lines =
    session.gap < 0
      ? [
          { account: '658000', label, debit: amount, credit: 0 },
          { account: CASH_ACCOUNT, label, debit: 0, credit: amount },
        ]
      : [
          { account: CASH_ACCOUNT, label, debit: amount, credit: 0 },
          { account: '758000', label, debit: 0, credit: amount },
        ];
  return { journal: 'OD', date, label, pieceRef: `Z-${session.id}`, pieceDate: date, source: { kind: 'pos-closing', id: session.id }, lines };
}
