/**
 * Écran « bank ».
 */

import { INCOME_CATEGORIES, OUTFLOW_CATEGORIES } from '../../core/workspace.js?v=66361b9';
import { $, render } from '../render.js?v=66361b9';
import { ui, ws } from '../state.js?v=66361b9';
import { dataVersion, save, toast } from '../store.js?v=66361b9';
import { suggestionsCache } from '../views/bank.js?v=66361b9';

/** Actions « bank » : data-action → fonction. */
export const actionsTable = {
  'tx-match': async ({ id, index }) => {
    const s = (suggestionsCache.version === dataVersion && suggestionsCache.map.get(id)) || ws.suggestionsFor(id);
    const chosen = s[Number(index)];
    ws.matchTransaction(
      id,
      chosen.docs.map((doc, i) => ({ doc, amount: chosen.amounts[i] })),
    );
    save();
    render();
    return toast('Transaction associée.');
  },
  'tx-categorize': async ({ id }) => {
    const cat = document.querySelector(`[data-cat="${id}"]`).value;
    if (!cat) return toast('Choisissez une catégorie.', true);
    const vat = Number(document.querySelector(`[data-vat="${id}"]`)?.value || 0);
    const hasReceipt = document.querySelector(`[data-receipt="${id}"]`)?.checked || false;
    ws.categorizeTransaction(id, { categoryId: cat, vatRateBp: vat, hasReceipt });
    save();
    render();
    return toast(
      hasReceipt || [...INCOME_CATEGORIES, ...OUTFLOW_CATEGORIES].some((c) => c.id === cat)
        ? 'Transaction justifiée.'
        : 'Transaction classée. Pensez à ajouter le justificatif.',
    );
  },
  'tx-ignore': async ({ id }) => {
    ws.ignoreTransaction(id);
    save();
    return render();
  },
  'bank-page': async ({ index }) => {
    ui.bankPage = (ui.bankPage || 0) + Number(index);
    render();
    return $('bank-open')?.scrollIntoView({ block: 'start' });
  },
  'bank-account-new': async () => {
    ui.addingBank = true;
    return render();
  },
  'bank-account-cancel': async () => {
    ui.addingBank = false;
    return render();
  },
  'bank-import-dismiss': async () => {
    ui.bankImport = null;
    return render();
  },
};
