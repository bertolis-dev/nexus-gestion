/**
 * Panier de caisse : lignes rattachées à l'article par son identifiant stable, prix et taux figés au
 * moment de l'ajout. Les montants d'un ticket se calculent toutes taxes comprises (prix affichés en
 * magasin) : TVA extraite du TTC par taux, sur le total de chaque taux (pas ligne à ligne).
 */

import { divRound, sum, vatFromHt } from '../money.js?v=151777b';

export class CartError extends Error {}

/** Prix unitaire TTC d'un article : prix TTC saisi, sinon HT du catalogue + TVA. */
export function unitTtcOf(item, { franchise = false } = {}) {
  if (Number.isSafeInteger(item.priceTtc)) return item.priceTtc;
  return franchise ? item.unitPrice : item.unitPrice + vatFromHt(item.unitPrice, item.vatRateBp || 0);
}

export const newCart = (id) => ({ id, lines: [], createdAt: null, label: '' });

const qtyOk = (q) => Number.isFinite(q) && q > 0 && q <= 100000 && Math.round(q * 1000) === q * 1000;

/** Ajoute un article (ou augmente sa quantité s'il est déjà dans le panier, sans remise propre). */
export function addToCart(cart, item, { qty = 1, franchise = false } = {}) {
  if (!qtyOk(qty)) throw new CartError('Quantité illisible (3 décimales au plus).');
  const existing = cart.lines.find((l) => l.itemId === item.id && !l.discountBp);
  if (existing) {
    existing.qty = Math.round((existing.qty + qty) * 1000) / 1000;
    return existing;
  }
  const line = {
    itemId: item.id,
    label: item.label,
    barcode: item.barcode || '',
    unitTtc: unitTtcOf(item, { franchise }),
    vatRateBp: franchise ? 0 : item.vatRateBp || 0,
    nature: item.nature === 'biens' ? 'biens' : 'services',
    qty,
    discountBp: 0,
  };
  cart.lines.push(line);
  return line;
}

export function setQty(cart, index, qty) {
  const q = Number(String(qty).replace(',', '.'));
  if (!qtyOk(q)) throw new CartError('Quantité illisible : un nombre positif, 3 décimales au plus.');
  cart.lines[index].qty = q;
}

export function removeLine(cart, index) {
  cart.lines.splice(index, 1);
}

/** Remise en % sur une ligne (réservée au responsable, contrôlée par l'appelant). */
export function setDiscount(cart, index, pct) {
  const bp = Math.round(Number(String(pct).replace(',', '.')) * 100);
  if (!Number.isInteger(bp) || bp < 0 || bp > 10000) throw new CartError('Remise entre 0 et 100 %.');
  cart.lines[index].discountBp = bp;
}

/** Total TTC d'une ligne : prix × quantité, moins la remise, arrondis au centime. */
export function lineTtc(l) {
  const gross = divRound(Math.round(l.qty * 1000) * l.unitTtc, 1000);
  return gross - divRound(gross * (l.discountBp || 0), 10000);
}

/**
 * Totaux du ticket : TTC par taux, HT = TTC × 10 000 / (10 000 + taux), TVA = différence.
 * @returns {{ byRate: { rateBp, ttc, ht, vat }[], totalTtc, totalHt, totalVat }}
 */
export function cartTotals(lines) {
  const map = new Map();
  for (const l of lines) map.set(l.vatRateBp, (map.get(l.vatRateBp) || 0) + lineTtc(l));
  const byRate = [...map]
    .map(([rateBp, ttc]) => {
      const ht = divRound(ttc * 10000, 10000 + rateBp);
      return { rateBp, ttc, ht, vat: ttc - ht };
    })
    .sort((a, b) => b.rateBp - a.rateBp);
  return { byRate, totalTtc: sum(byRate.map((r) => r.ttc)), totalHt: sum(byRate.map((r) => r.ht)), totalVat: sum(byRate.map((r) => r.vat)) };
}

/** Monnaie à rendre sur un paiement en espèces ; erreur si la somme remise est insuffisante. */
export function cashChange(total, given) {
  if (!Number.isSafeInteger(given) || given < total) throw new CartError('Somme remise insuffisante.');
  return given - total;
}
