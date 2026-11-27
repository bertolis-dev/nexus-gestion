/**
 * Workspace — refacturation d'une dépense à un client : brouillon de facture reprenant le libellé, la
 * date et le HT de la dépense (prix coûtant, marge facultative en % ou en euros), TVA de l'entreprise
 * qui facture (vente ordinaire, pas des débours). Le lien est gardé dans les deux sens : la facture
 * porte `rebillOf`, la dépense retrouve sa facture ; les dépenses marquées « à refacturer » sont
 * listées tant qu'aucune facture ne les reprend.
 * Méthodes installées sur Workspace.prototype (voir core/workspace.js).
 */

import { divRound, sum, vatFromHt } from '../money.js?v=151777b';
import { categoryById } from '../pcg.js?v=151777b';
import { addDays } from '../dates.js?v=151777b';

export class RebillError extends Error {}

const frDate = (iso) => iso.split('-').reverse().join('/');

/**
 * Lignes de la facture : une par ligne de la dépense, à son coût réel (HT + TVA non récupérable), plus la
 * marge (en % sur chaque ligne, ou en euros répartis au prorata, au plus fort reste).
 */
export function rebillLines(purchase, { marginPct = 0, marginAmount = 0, franchise = false } = {}) {
  const reverse = (purchase.supplier?.country || 'FR') !== 'FR' || purchase.reverseCharge === true;
  if (purchase.type === 'credit') throw new RebillError('Un avoir fournisseur ne se refacture pas.');
  if (!(marginPct >= 0 && marginPct <= 1000)) throw new RebillError('Marge en % invalide (0 à 1 000 %).');
  if (!Number.isSafeInteger(marginAmount) || marginAmount < 0) throw new RebillError('Marge en euros invalide.');
  if (marginPct && marginAmount) throw new RebillError('Choisissez une marge en % ou en euros, pas les deux.');
  // Coût réel de chaque ligne : HT + TVA non récupérable (franchise, catégories à déduction partielle),
  // comme la charge passée en 6xx par purchaseEntry.
  const costs = purchase.lines.map((l) => {
    const vat = reverse ? vatFromHt(l.ht, l.vatRateBp ?? 2000) : Number.isSafeInteger(l.vat) ? l.vat : divRound(l.ht * (l.vatRateBp || 0), 10000);
    const pct = franchise ? 0 : (categoryById(l.categoryId)?.vatDeductiblePct ?? 100);
    return l.ht + (vat - divRound(vat * pct, 100));
  });
  const totalCost = sum(costs);
  if (totalCost <= 0) throw new RebillError('Dépense sans montant hors taxe : rien à refacturer.');
  const ref = [purchase.supplier.name, purchase.number && `n° ${purchase.number}`, `du ${frDate(purchase.date)}`].filter(Boolean).join(' ');
  // Marge en euros répartie au plus fort reste : chaque part ≥ 0, total exact.
  const exact = costs.map((c) => (marginAmount * c) / totalCost);
  const shares = exact.map(Math.floor);
  let rest = marginAmount - sum(shares);
  exact
    .map((x, i) => [x - Math.floor(x), i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .forEach(([, i]) => {
      if (rest > 0) {
        shares[i] += 1;
        rest -= 1;
      }
    });
  return purchase.lines.map((l, i) => {
    const cat = categoryById(l.categoryId);
    const margin = marginPct ? divRound(costs[i] * Math.round(marginPct * 100), 10000) : shares[i];
    const what = l.label || cat?.label || 'Dépense';
    return {
      label: `Refacturation : ${what} — ${ref}`.slice(0, 200),
      qty: 1,
      unitPrice: costs[i] + margin,
      // TVA de l'entreprise qui refacture : taux de la dépense s'il y en a un, sinon 20 % ; 0 en franchise.
      vatRateBp: franchise ? 0 : l.vatRateBp || 2000,
      nature: l.nature || cat?.nature || 'services',
    };
  });
}

export const rebillMethods = {
  /** Facture (brouillon ou émise) qui refacture cette dépense, ou null. */
  rebilledBy(purchaseId) {
    return this.book.invoices.find((i) => i.rebillOf?.purchaseId === purchaseId && i.type !== 'quote') || null;
  },

  /** Dépenses marquées « à refacturer » et pas encore reprises sur une facture. */
  toRebill() {
    const marked = new Set(this.company.toRebill || []);
    return this.purchases.filter((p) => marked.has(p.id) && !this.rebilledBy(p.id));
  },

  markToRebill(purchaseId, on = true) {
    const set = new Set(this.company.toRebill || []);
    if (on) set.add(purchaseId);
    else set.delete(purchaseId);
    this.company.toRebill = [...set];
  },

  /** Brouillon de facture au client à partir de la dépense ; refusé si une facture la reprend déjà. */
  rebillPurchase(purchaseId, { clientId, today, marginPct = 0, marginAmount = 0, attachReceipt = false }) {
    const p = this.purchases.find((x) => x.id === purchaseId);
    if (!p) throw new RebillError('Dépense introuvable.');
    const already = this.rebilledBy(purchaseId);
    if (already) throw new RebillError(`Cette dépense est déjà refacturée sur ${already.number || 'un brouillon de facture'}.`);
    const client = this.clients.find((c) => c.id === clientId);
    if (!client) throw new RebillError('Choisissez le client.');
    const lines = rebillLines(p, { marginPct, marginAmount, franchise: this.company.vatRegime === 'franchise' });
    const draft = this.book.createDraft({
      client: structuredClone(client),
      issueDate: today,
      dueDate: addDays(today, this.company.paymentTermsDays || 30),
      lines,
      rebillOf: { purchaseId: p.id, supplier: p.supplier.name, number: p.number || '', date: p.date },
      ...(attachReceipt ? { attachReceipt: true } : {}),
    });
    // La marque « à refacturer » reste : la dépense sort du filtre dès qu'une facture la reprend (et y revient si
    // le brouillon est supprimé), sans modifier un réglage réservé au dirigeant.
    return draft;
  },
};
