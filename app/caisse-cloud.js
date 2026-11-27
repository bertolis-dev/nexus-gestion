/**
 * Caisse en mode connecté : appels aux fonctions de la base (migration 0037) et conversion des lignes
 * en objets de l'application. Les ventes passent par la base (numéro, montants et paiement carte
 * contrôlés), pas par la file d'envoi ; leurs écritures comptables, elles, suivent la file habituelle.
 */

import * as cloud from './cloud.js?v=d9f2509';
import { parisDate } from '../core/pos/sale.js?v=d9f2509';

const missing = (err) => ['42P01', 'PGRST205', 'PGRST202', '42883'].includes(err?.code);

export const saleFromRow = (r) => ({
  id: r.id,
  number: r.number,
  registerId: r.register_id,
  sessionId: r.session_id,
  cashier: r.cashier,
  at: r.at,
  date: parisDate(r.at),
  mode: r.mode,
  lines: r.lines,
  totals: r.totals,
  payments: r.payments,
  invoiceId: r.invoice_id,
  hash: r.hash,
});
export const returnFromRow = (r, sales) => ({
  id: r.id,
  number: r.number,
  saleId: r.sale_id,
  saleNumber: sales.find((s) => s.id === r.sale_id)?.number || '',
  registerId: sales.find((s) => s.id === r.sale_id)?.registerId,
  sessionId: r.session_id,
  at: r.at,
  date: parisDate(r.at),
  mode: r.mode,
  user: r.author,
  reason: r.reason,
  lines: r.lines,
  totals: r.totals,
  refund: { method: r.refund_method, amount: Number(r.totals.totalTtc), status: r.refund_status, refundId: r.refund_id },
});
export const sessionFromRow = (r) => ({
  id: r.id,
  registerId: r.register_id,
  mode: r.mode,
  openedAt: r.opened_at,
  openedBy: r.opened_by,
  openingFloat: Number(r.opening_float),
  closedAt: r.closed_at,
  closedBy: r.closed_by,
  countedCash: r.counted_cash == null ? null : Number(r.counted_cash),
  expectedCash: r.expected_cash == null ? null : Number(r.expected_cash),
  gap: r.gap == null ? null : Number(r.gap),
  summary: r.summary,
});
export const attemptFromRow = (r) => ({
  id: r.id,
  registerId: r.register_id,
  saleRef: r.sale_ref,
  mode: r.mode,
  amount: Number(r.amount),
  cart: r.cart,
  status: r.status,
  paymentIntentId: r.payment_intent_id,
  error: r.error,
  saleId: r.sale_id,
});

/** Données de caisse du dossier ; vide si la migration 0037 n'est pas appliquée. */
export async function loadPos(structureId, fiscalYearStart) {
  // Début d'exercice à minuit à Paris : marge de 2 h en UTC, puis tri par jour de Paris.
  const since = new Date(Date.parse(`${fiscalYearStart}T00:00:00Z`) - 2 * 3600e3).toISOString();
  try {
    const [registers, sessions, sales, returns, attempts, stripe] = await Promise.all([
      cloud.rows('pos_registers', structureId, (q) => q.order('created_at')),
      cloud.rows('pos_sessions', structureId, (q) => q.order('opened_at')),
      cloud.rows('pos_sales', structureId, (q) => q.gte('at', since).order('at')),
      cloud.rows('pos_returns', structureId, (q) => q.gte('at', since).order('at')),
      cloud.rows('pos_card_attempts', structureId, (q) => q.in('status', ['pending', 'unknown', 'succeeded']).is('sale_id', null)),
      cloud.rpc('pos_stripe_status', { p_structure: structureId }),
    ]);
    const s = sales.map(saleFromRow).filter((x) => x.date >= fiscalYearStart);
    return {
      available: true,
      registers: registers.map((r) => ({ id: r.id, name: r.name, readerId: r.reader_id, mode: r.mode, active: r.active })),
      sessions: sessions.map(sessionFromRow),
      sales: s,
      returns: returns.map((r) => returnFromRow(r, s)).filter((r) => r.date >= fiscalYearStart),
      attempts: attempts.map(attemptFromRow),
      stripe: stripe || { test: false, live: false },
    };
  } catch (err) {
    if (missing(err)) return { available: false, registers: [], sessions: [], sales: [], returns: [], attempts: [], stripe: { test: false, live: false } };
    throw err;
  }
}

export const saveRegister = (structureId, { id = null, name, readerId, mode, active = true }) =>
  cloud.rpc('pos_register_save', { p_structure: structureId, p_id: id, p_name: name, p_reader: readerId || null, p_mode: mode, p_active: active });
export const checkReader = (registerId) => cloud.rpc('pos_reader_check', { p_register: registerId });
export const configureStripe = (structureId, key) => cloud.rpc('pos_stripe_configure', { p_structure: structureId, p_key: key });
export const openSession = async (registerId, float) => sessionFromRow(await cloud.rpc('pos_session_open', { p_register: registerId, p_float: float }));
export const closeSession = async (sessionId, counted) => sessionFromRow(await cloud.rpc('pos_session_close', { p_session: sessionId, p_counted: counted }));
export const finalizeSale = async ({ id, sessionId, lines, payments }) =>
  saleFromRow(await cloud.rpc('pos_finalize_sale', { p_id: id, p_session: sessionId, p_lines: lines, p_payments: payments }));
export const cardStart = async (registerId, saleRef, lines) =>
  attemptFromRow(await cloud.rpc('pos_card_start', { p_register: registerId, p_sale_ref: saleRef, p_cart: lines }));
export const cardStatus = async (attemptId) => attemptFromRow(await cloud.rpc('pos_card_status', { p_attempt: attemptId }));
export const cardCancel = async (attemptId) => attemptFromRow(await cloud.rpc('pos_card_cancel', { p_attempt: attemptId }));
export const cardSimulate = async (attemptId, declined) => attemptFromRow(await cloud.rpc('pos_card_simulate', { p_attempt: attemptId, p_declined: declined }));
export const recordReturn = (p) =>
  cloud.rpc('pos_record_return', { p_id: p.id, p_sale: p.saleId, p_wanted: p.wanted, p_reason: p.reason, p_method: p.refundMethod });
export const refundStart = (returnId) => cloud.rpc('pos_refund_start', { p_return: returnId });
export const linkInvoice = (saleId, invoiceId) => cloud.rpc('pos_link_invoice', { p_sale: saleId, p_invoice: invoiceId });
export const payoutDetail = (structureId, payoutId) => cloud.rpc('pos_payout_detail', { p_structure: structureId, p_payout: payoutId });
