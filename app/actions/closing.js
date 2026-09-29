/**
 * Écran « closing ».
 */

import { allocationProposal } from '../../core/closing.js?v=e64ad2c';
import { parseEuros } from '../../core/money.js?v=e64ad2c';
import { render } from '../render.js?v=e64ad2c';
import { today, ui, ws } from '../state.js?v=e64ad2c';
import { save, toast } from '../store.js?v=e64ad2c';
import { closeYearFlow } from '../views/closing.js?v=e64ad2c';

/** Actions « closing » : data-action → fonction. */
export const actionsTable = {
  'inventory-add': async () => {
    const f = ui.inventoryForm || { type: 'prepaid' };
    const form = Object.fromEntries([...document.querySelectorAll('[data-inv]')].map((e) => [e.dataset.inv, e.value]));
    try {
      const amount = parseEuros(form.amount || '');
      ws.addInventory({
        type: form.type || f.type,
        account: form.account,
        aux: form.aux,
        amount,
        vatRateBp: Number(form.vatRateBp || 0),
        label: form.label?.trim() || undefined,
      });
      ui.inventoryForm = { type: form.type };
      save();
      render();
      toast('Écriture d’inventaire ajoutée.');
    } catch (err) {
      toast(err.message.startsWith('Montant invalide') ? 'Le montant saisi n’est pas valide.' : err.message, true);
    }
    return;
  },
  'inventory-delete': async ({ id }) => {
    ws.ledger.deleteDraft(id);
    save();
    return render();
  },
  'depreciation-book': async () => {
    try {
      ws.bookDepreciation();
      save();
      render();
      toast('Dotations aux amortissements passées.');
    } catch (err) {
      toast(err.message, true);
    }
    return;
  },
  'is-book': async ({ el }) => {
    try {
      ws.bookCorporateTax(Number(el.dataset.tax));
      save();
      render();
      toast('Impôt sur les sociétés comptabilisé.');
    } catch (err) {
      toast(err.message, true);
    }
    return;
  },
  'allocate-result': async () => {
    const { result } = allocationProposal(ws.ledger, ws.company);
    const read = (k) => {
      const e = document.querySelector(`[data-alloc="${k}"]`);
      return e && e.value ? parseEuros(e.value) : 0;
    };
    try {
      const parts =
        ws.company.legalForm === 'EI'
          ? { owner: result }
          : {
              legalReserve: read('legalReserve'),
              otherReserves: read('otherReserves'),
              dividends: read('dividends'),
              retained: result < 0 ? -Math.abs(read('retained')) : read('retained'),
            };
      const fy = ws.company.fiscalYear;
      ws.allocateResult(parts, today() < fy.start ? fy.start : today() > fy.end ? fy.end : today());
      ui.allocationForm = null;
      save();
      render();
      toast('Affectation du résultat enregistrée.');
    } catch (err) {
      toast(err.message.startsWith('Montant invalide') ? 'Un des montants n’est pas valide.' : err.message, true);
    }
    return;
  },
  'close-year': async () => {
    return closeYearFlow();
  },
};
