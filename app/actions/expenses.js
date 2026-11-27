/**
 * Écran « expenses ».
 */

import { purchaseLinesFrom } from '../../core/einvoice-in.js?v=d9f2509';
import * as cloud from '../cloud.js?v=d9f2509';
import { render } from '../render.js?v=d9f2509';
import { eur, ui, ws } from '../state.js?v=d9f2509';
import { save, toast } from '../store.js?v=d9f2509';
import { attachReceipt } from '../views/expenses.js?v=d9f2509';
import { saveNexusRhImport } from '../views/nexusrh-import.js?v=d9f2509';

/** Actions « expenses » : data-action → fonction. */
/** Lignes de la facture d'acompte importée du même fournisseur dont le TTC égale l'acompte déduit (sinon null). */
function depositLinesFor(inv) {
  if (!inv.prepaid || inv.type === 'deposit') return null;
  const dep = ws.purchases.find((p) => p.einvoice?.deposit && p.supplier.name === inv.seller.name && p.totalTtc === inv.prepaid);
  return dep ? dep.lines : null;
}

export const actionsTable = {
  'nexusrh-save': () => saveNexusRhImport(),
  'nexusrh-cancel': async () => {
    ui.nexusRh = null;
    return render();
  },
  'purchase-force': async () => {
    const res = ws.addPurchase(ui.pendingPurchase.data, { force: true });
    const pendingFile = ui.pendingPurchase.file;
    if (res.purchase && ui.pendingPurchase.form?.toRebill) ws.markToRebill(res.purchase.id);
    ui.pendingPurchase = null;
    if (res.purchase) attachReceipt(res.purchase, pendingFile);
    save();
    render();
    return toast(res.purchase ? 'Dépense enregistrée.' : 'Enregistrement impossible.', !res.purchase);
  },
  'purchase-cancel': async () => {
    ui.pendingPurchase = null;
    return render();
  },
  'expenses-tab': async ({ el }) => {
    ui.expensesTab = el.dataset.tab;
    return render();
  },
  'einvoice-in-save': async () => {
    const { inv, file, duplicates } = ui.pendingEinvoice;
    const categoryId = document.querySelector('[data-einvoice-cat]').value;
    const data = {
      supplier: { name: inv.seller.name, siren: inv.seller.siren, country: inv.seller.country },
      date: inv.issueDate,
      number: inv.number,
      documentName: file.name,
      lines: purchaseLinesFrom(inv, categoryId, depositLinesFor(inv)),
      type: inv.type === 'credit' ? 'credit' : 'invoice',
      einvoice: { format: inv.format, totalTtc: inv.totalTtc, ...(inv.type === 'deposit' ? { deposit: true } : {}) },
    };
    const res = ws.addPurchaseLines(data, { force: Boolean(duplicates?.length) });
    if (!res.purchase) {
      ui.pendingEinvoice.duplicates = res.duplicates;
      return render();
    }
    ui.pendingEinvoice = ui.pendingEinvoices.shift() || null;
    save();
    render();
    if (inv.prepaid && inv.type !== 'deposit')
      toast(`Facture finale : l’acompte déjà facturé (${eur(inv.prepaid)}) est retiré pour ne pas le compter deux fois.`);
    else if (res.purchase.totalTtc !== inv.totalTtc)
      toast(
        `Dépense enregistrée, mais le total recalculé (${eur(res.purchase.totalTtc)}) diffère de la facture (${eur(inv.totalTtc)}) : vérifiez la catégorie.`,
        true,
      );
    else toast('Facture électronique enregistrée en dépense.');
    attachReceipt(res.purchase, file);
    return;
  },
  'einvoice-in-cancel': async () => {
    ui.pendingEinvoice = ui.pendingEinvoices.shift() || null;
    return render();
  },
  'receipt-open': async ({ el }) => {
    try {
      window.open(await cloud.receiptUrl(el.dataset.path), '_blank', 'noopener');
    } catch (err) {
      toast(`Justificatif indisponible : ${cloud.friendly(err)}`, true);
    }
    return;
  },
};
