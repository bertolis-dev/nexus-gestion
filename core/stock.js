/**
 * Stock simple des articles du catalogue suivis en stock (item.tracked) : stock de départ, entrées et
 * corrections saisies (company.stockMoves), moins les quantités vendues sur les factures émises
 * (rapprochées par la désignation de l'article), plus les retours sur avoir, moins les ventes de
 * caisse (rapprochées par l'identifiant de l'article).
 */

import { sum } from './money.js?v=d9f2509';

const key = (label) =>
  String(label || '')
    .trim()
    .toLocaleLowerCase('fr');

export class StockError extends Error {}

/** Quantités vendues par article (désignation), factures émises moins avoirs ; devis exclus. */
export function soldQuantities(invoices) {
  const sold = new Map();
  for (const inv of invoices) {
    // Facture liée à une vente de caisse : la sortie de stock a déjà été comptée par la vente.
    if (inv.status !== 'issued' || inv.type === 'quote' || inv.saleId) continue;
    const sign = inv.type === 'credit' ? -1 : 1;
    for (const l of inv.lines || []) sold.set(key(l.label), (sold.get(key(l.label)) || 0) + sign * Number(l.qty || 0));
  }
  return sold;
}

/**
 * Ventes de caisse réelles par identifiant d'article (le mode test ne touche pas le stock), moins les
 * retours déclarés revendables.
 */
export function posQuantities(sales = [], returns = []) {
  const out = new Map();
  const add = (id, q) => id && out.set(id, Math.round(((out.get(id) || 0) + q) * 1000) / 1000);
  for (const s of sales) if (s.mode === 'live') for (const l of s.lines) add(l.itemId, l.qty);
  for (const r of returns) if (r.mode === 'live') for (const l of r.lines) if (l.resellable) add(l.itemId, -l.qty);
  return out;
}

/** État du stock de chaque article suivi : { item, initial, moves, sold, level, low }. */
export function stockLevels(catalog = [], moves = [], invoices = [], pos = { sales: [], returns: [] }) {
  const sold = soldQuantities(invoices);
  const tills = posQuantities(pos.sales, pos.returns);
  return catalog
    .filter((i) => i.tracked)
    .map((item) => {
      const moved = sum(moves.filter((m) => m.itemId === item.id).map((m) => Math.round(m.qty * 1000))) / 1000;
      const out = Math.round(((sold.get(key(item.label)) || 0) + (tills.get(item.id) || 0)) * 1000) / 1000;
      const level = Math.round((Number(item.stockInitial || 0) + moved - out) * 1000) / 1000;
      return { item, initial: Number(item.stockInitial || 0), moves: moved, sold: out, level, low: item.stockAlert != null && level <= item.stockAlert };
    });
}

/** Mouvement de stock saisi (entrée de marchandise, casse, inventaire). */
export function stockMove({ id, date, itemId, qty, reason }) {
  const q = Number(String(qty).replace(',', '.'));
  if (!itemId) throw new StockError('Choisissez l’article.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new StockError('Indiquez la date.');
  if (!Number.isFinite(q) || q === 0 || Math.abs(q) > 1e6 || Math.round(q * 1000) !== q * 1000)
    throw new StockError('Quantité illisible : un nombre positif pour une entrée, négatif pour une sortie (3 décimales au plus).');
  return {
    id,
    date,
    itemId,
    qty: q,
    reason:
      String(reason || '')
        .trim()
        .slice(0, 120) || (q > 0 ? 'Entrée en stock' : 'Sortie de stock'),
  };
}
