/**
 * Ventes de caisse : ticket figé (lignes, prix et taux appliqués, totaux, règlements), retours liés
 * au ticket d'origine, ouverture et clôture de caisse. Une vente n'est jamais modifiée : une
 * correction est un retour (opération en moins) rattaché à la vente.
 */

import { divRound, sum } from '../money.js?v=d9f2509';
import { cartTotals, lineTtc } from './cart.js?v=d9f2509';

export class SaleError extends Error {}

const pad = (n, w) => String(n).padStart(w, '0');
/** Jour de l'opération à l'heure de Paris (une vente à 23 h 30 reste sur sa journée). */
export const parisDate = (iso) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });

/** Numéro de ticket ou de retour : T2026-000001 / R2026-000001 (TEST- devant en mode test). */
export const ticketNumber = (prefix, year, n, mode = 'live') => `${mode === 'test' ? 'TEST-' : ''}${prefix}${year}-${pad(n, 6)}`;

/**
 * Vente prête à enregistrer, à partir des lignes du panier et des règlements confirmés.
 * @param {{ lines, payments: { method: 'cash'|'card', amount, given?, change?, attemptId?, paymentIntentId?, card? }[] }} p
 */
export function buildSale({ id, number, registerId, sessionId, cashier, at, mode = 'live', lines, payments }) {
  if (!lines.length) throw new SaleError('Le panier est vide.');
  const totals = cartTotals(lines);
  if (!totals.totalTtc) throw new SaleError('Le total du ticket est nul.');
  const paid = sum(payments.map((p) => p.amount));
  if (paid !== totals.totalTtc) throw new SaleError(`Règlements (${paid / 100} €) différents du total (${totals.totalTtc / 100} €).`);
  for (const p of payments) {
    if (p.method === 'card' && !p.paymentIntentId) throw new SaleError('Paiement par carte sans confirmation du prestataire.');
    if (!['cash', 'card'].includes(p.method)) throw new SaleError('Mode de règlement inconnu.');
  }
  return {
    id,
    number,
    registerId,
    sessionId,
    cashier,
    at,
    date: parisDate(at),
    mode,
    lines: lines.map((l) => ({ ...l, ttc: lineTtc(l) })),
    totals,
    payments: structuredClone(payments),
    invoiceId: null,
  };
}

/** Quantités et montants déjà rendus par ligne de la vente : { [lineIndex]: { qty, ttc } }. */
export function returnedByLine(sale, returns = []) {
  const out = {};
  for (const r of returns.filter((x) => x.saleId === sale.id)) {
    for (const l of r.lines) {
      const o = (out[l.lineIndex] ||= { qty: 0, ttc: 0 });
      o.qty = Math.round((o.qty + l.qty) * 1000) / 1000;
      o.ttc += l.ttc;
    }
  }
  return out;
}

/**
 * Retour (complet ou partiel) sur un ticket : quantités contrôlées contre ce qui reste à rendre ;
 * le dernier retour d'une ligne reprend exactement le reste de son montant (pas d'écart d'arrondi).
 * @param {{ lineIndex: number, qty: number, resellable: boolean }[]} wanted
 */
export function buildReturn(sale, previous, { id, number, at, user, reason, wanted, refundMethod }) {
  if (sale.mode !== 'live' && sale.mode !== 'test') throw new SaleError('Vente inconnue.');
  const motive = String(reason || '').trim();
  if (!motive) throw new SaleError('Indiquez le motif du retour.');
  const done = returnedByLine(sale, previous);
  const lines = [];
  const asked = wanted.filter((w) => Number(w.qty));
  if (new Set(asked.map((w) => w.lineIndex)).size !== asked.length) throw new SaleError('Une même ligne apparaît deux fois dans le retour.');
  for (const w of wanted) {
    const line = Number.isInteger(w.lineIndex) && w.lineIndex >= 0 ? sale.lines[w.lineIndex] : null;
    if (!line) throw new SaleError('Ligne de ticket inconnue.');
    const qty = Number(w.qty);
    if (!qty) continue;
    const already = done[w.lineIndex] || { qty: 0, ttc: 0 };
    const left = Math.round((line.qty - already.qty) * 1000) / 1000;
    if (!(qty > 0) || qty > left)
      throw new SaleError(
        `« ${line.label} » : ${String(left).replace('.', ',')} au plus ${left > 1 ? 'peuvent encore être rendus' : 'peut encore être rendu'}.`,
      );
    const ttc = qty === left ? line.ttc - already.ttc : Math.min(lineTtc({ ...line, qty }), line.ttc - already.ttc);
    lines.push({
      lineIndex: w.lineIndex,
      itemId: line.itemId,
      label: line.label,
      qty,
      ttc,
      vatRateBp: line.vatRateBp,
      nature: line.nature,
      resellable: Boolean(w.resellable),
    });
  }
  if (!lines.length) throw new SaleError('Choisissez au moins un article à rendre.');
  const totals = returnTotals(lines);
  const cardPaid = sum(sale.payments.filter((p) => p.method === 'card').map((p) => p.amount));
  const cardRefunded = sum(previous.filter((r) => r.saleId === sale.id && r.refund.method === 'card').map((r) => r.refund.amount));
  if (refundMethod === 'card' && totals.totalTtc > cardPaid - cardRefunded)
    throw new SaleError('Le remboursement sur carte dépasse ce qui reste du paiement par carte de ce ticket.');
  return {
    id,
    number,
    saleId: sale.id,
    saleNumber: sale.number,
    registerId: sale.registerId,
    at,
    date: parisDate(at),
    mode: sale.mode,
    user,
    reason: motive.slice(0, 200),
    lines,
    totals,
    refund: { method: refundMethod === 'card' ? 'card' : 'cash', amount: totals.totalTtc, status: refundMethod === 'card' ? 'pending' : 'done' },
  };
}

/** Totaux d'un retour, même méthode que le ticket (TVA extraite du TTC par taux). */
export function returnTotals(lines) {
  const t = cartTotals(lines.map((l) => ({ ...l, unitTtc: l.ttc, qty: 1, discountBp: 0 })));
  return t;
}

/**
 * Récapitulatif d'une session de caisse : ventes et retours par mode, espèces attendues
 * (fonds initial + ventes en espèces − remboursements en espèces).
 */
export function sessionSummary(session, sales, returns) {
  const mine = sales.filter((s) => s.sessionId === session.id);
  const back = returns.filter((r) => mine.some((s) => s.id === r.saleId) || r.sessionId === session.id);
  const by = (method) => sum(mine.flatMap((s) => s.payments.filter((p) => p.method === method).map((p) => p.amount)));
  const refunded = (method) => sum(back.filter((r) => r.refund.method === method && r.refund.status === 'done').map((r) => r.refund.amount));
  const cash = by('cash');
  const cashOut = refunded('cash');
  return {
    tickets: mine.length,
    salesTtc: sum(mine.map((s) => s.totals.totalTtc)),
    salesHt: sum(mine.map((s) => s.totals.totalHt)),
    salesVat: sum(mine.map((s) => s.totals.totalVat)),
    cash,
    card: by('card'),
    refundsCash: cashOut,
    refundsCard: refunded('card'),
    returns: back.length,
    expectedCash: (session.openingFloat || 0) + cash - cashOut,
  };
}

/** Clôture : espèces comptées, écart avec l'attendu. */
export function closeSession(session, summary, { countedCash, at, user }) {
  if (session.closedAt) throw new SaleError('Cette caisse est déjà clôturée.');
  if (!Number.isSafeInteger(countedCash) || countedCash < 0) throw new SaleError('Montant compté illisible.');
  return { ...session, closedAt: at, closedBy: user, countedCash, expectedCash: summary.expectedCash, gap: countedCash - summary.expectedCash, summary };
}

/** Répartition du HT d'un taux entre biens et services, au prorata du TTC (reste sur la dernière nature). */
export function htByNature(lines, totals) {
  const out = { biens: 0, services: 0 };
  for (const r of totals.byRate) {
    const ofRate = lines.filter((l) => l.vatRateBp === r.rateBp);
    const ttcRate = sum(ofRate.map((l) => l.ttc));
    const biens = sum(ofRate.filter((l) => l.nature === 'biens').map((l) => l.ttc));
    const htBiens = ttcRate ? divRound(r.ht * biens, ttcRate) : 0;
    out.biens += htBiens;
    out.services += r.ht - htBiens;
  }
  return out;
}
