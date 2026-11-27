/**
 * Workspace — contrôles d'un avoir avant émission : il suit la nature (biens ou services) de la facture
 * qu'il corrige, pour que sa TVA prenne le même chemin (à la facturation ou à l'encaissement), et il ne
 * dépasse, taux par taux, ni la base ni la TVA qui restent à créditer sur cette facture.
 * Méthodes installées sur Workspace.prototype (voir core/workspace.js).
 */

import { computeTotals, isVatExempt } from '../invoices.js?v=d9f2509';

const pct = (bp) => `${String(bp / 100).replace('.', ',')} %`;
const euros = (c) => `${(c / 100).toFixed(2).replace('.', ',')} €`;

export const creditMethods = {
  _prepareCreditNote(id) {
    const draft = this.book.get(id);
    if (draft.type !== 'credit' || draft.status !== 'draft') return;
    const original = this.book.invoices.find((i) => i.status === 'issued' && i.type !== 'credit' && i.type !== 'quote' && i.number === draft.creditOf);
    if (!original) throw new Error(`L’avoir doit corriger une facture émise : facture ${draft.creditOf || '(non indiquée)'} introuvable.`);
    // Facture de biens seulement, ou de services seulement : l'avoir prend sa nature.
    if (['biens', 'services'].includes(original.operationNature) && draft.lines.some((l) => l.nature !== original.operationNature))
      this.book.updateDraft(id, { lines: draft.lines.map((l) => ({ ...l, nature: original.operationNature })) });
    const credits = this.book.invoices.filter((i) => i.status === 'issued' && i.type === 'credit' && i.creditOf === original.number);
    const left = new Map(original.totals.vatBreakdown.map((v) => [v.rateBp, { base: v.base, vat: v.vat }]));
    for (const c of credits)
      for (const v of c.totals.vatBreakdown) {
        const o = left.get(v.rateBp) || { base: 0, vat: 0 };
        left.set(v.rateBp, { base: o.base - v.base, vat: o.vat - v.vat });
      }
    // Facture émise avec TVA, entreprise passée depuis en franchise : l'avoir reprend la TVA de la facture.
    if (this.company.vatRegime === 'franchise' && original.totals.totalVat > 0 && !draft.keepVat) this.book.updateDraft(id, { keepVat: true });
    const current = this.book.get(id);
    const t = computeTotals(current, { franchise: isVatExempt(current, this.company) });
    for (const v of t.vatBreakdown) {
      const o = left.get(v.rateBp) || { base: 0, vat: 0 };
      if (v.base > o.base || v.vat > o.vat)
        throw new Error(
          left.has(v.rateBp)
            ? `L’avoir dépasse, au taux de ${pct(v.rateBp)}, ce qui reste à créditer sur la facture ${original.number} (${euros(Math.max(0, o.base))} HT).`
            : `La facture ${original.number} n’a rien à créditer au taux de ${pct(v.rateBp)} : utilisez le taux de la facture.`,
        );
    }
  },
};
