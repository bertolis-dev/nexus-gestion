/**
 * Workspace — refacturation d'une dépense à un client : brouillon de facture reprenant le libellé, la
 * date et le HT de la dépense (prix coûtant, marge facultative en % ou en euros), TVA de l'entreprise
 * qui facture (vente ordinaire, pas des débours). Le lien est gardé dans les deux sens : la facture
 * porte `rebillOf`, la dépense retrouve sa facture ; les dépenses marquées « à refacturer » sont
 * listées tant qu'aucune facture ne les reprend.
 * Méthodes installées sur Workspace.prototype (voir core/workspace.js).
 */

import { divRound, sum } from '../money.js?v=1f0ed9f';
import { categoryById } from '../pcg.js?v=1f0ed9f';
import { addDays } from '../dates.js?v=1f0ed9f';

export class RebillError extends Error {}

const frDate = (iso) => iso.split('-').reverse().join('/');

/**
 * Lignes de la facture : une par ligne de la dépense, au HT de la dépense, plus la marge (en % sur
 * chaque ligne, ou en euros répartis au prorata, le reste sur la dernière ligne).
 */
export function rebillLines(purchase, { marginPct = 0, marginAmount = 0, franchise = false } = {}) {
  if (purchase.type === 'credit') throw new RebillError('Un avoir fournisseur ne se refacture pas.');
  if (!(marginPct >= 0 && marginPct <= 1000)) throw new RebillError('Marge en % invalide (0 à 1 000 %).');
  if (!Number.isSafeInteger(marginAmount) || marginAmount < 0) throw new RebillError('Marge en euros invalide.');
  if (marginPct && marginAmount) throw new RebillError('Choisissez une marge en % ou en euros, pas les deux.');
  const totalHt = sum(purchase.lines.map((l) => l.ht));
  if (totalHt <= 0) throw new RebillError('Dépense sans montant hors taxe : rien à refacturer.');
  const ref = [purchase.supplier.name, purchase.number && `n° ${purchase.number}`, `du ${frDate(purchase.date)}`].filter(Boolean).join(' ');
  let left = marginAmount;
  return purchase.lines.map((l, i) => {
    const cat = categoryById(l.categoryId);
    const share = i === purchase.lines.length - 1 ? left : divRound(marginAmount * l.ht, totalHt);
    left -= share;
    const margin = marginPct ? divRound(l.ht * Math.round(marginPct * 100), 10000) : share;
    const what = l.label || cat?.label || 'Dépense';
    return {
      label: `Refacturation : ${what} — ${ref}`.slice(0, 200),
      qty: 1,
      unitPrice: l.ht + margin,
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
