/**
 * Banque › versement des paiements par carte (Stripe) : le virement reçu solde les ventes carte en
 * attente (compte 5115), les commissions passent en charge. Avec l'identifiant du versement (po_…),
 * le brut et les commissions sont lus chez Stripe ; sans lui, Nexus propose commissions = attendu − reçu.
 */

import { field, html } from '../html.js?v=151777b';
import { eur, frDate, ui, ws, cloudState } from '../state.js?v=151777b';
import { isPosManager } from '../caisse-state.js?v=151777b';
import * as caisse from '../caisse-cloud.js?v=151777b';
import { render } from '../render.js?v=151777b';
import { save, toast } from '../store.js?v=151777b';
import { parseEuros } from '../../core/money.js?v=151777b';

export function payoutNotice() {
  const balance = ws.cardBalance();
  if (balance <= 0 || !isPosManager()) return '';
  const candidates = ws.transactions.filter((t) => t.status === 'open' && t.amount > 0 && t.amount <= balance);
  if (!candidates.length) return '';
  const f = ui.posPayout || {};
  const tx = candidates.find((t) => t.id === f.txId);
  const sug = tx ? ws.payoutSuggestion(tx.id) : null;
  return html`<div class="card" style="margin-bottom:14px">
    <h2 style="margin-top:0">Versements des paiements par carte</h2>
    <p class="text-muted" style="margin-top:0">${eur(balance)} de ventes par carte attendent leur versement par Stripe. Choisissez le virement reçu :</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${candidates.slice(0, 6).map((t) => html`<button type="button" class="btn btn-secondary btn-sm" data-action="pos-payout-pick" data-id="${t.id}">${frDate(t.date)} · ${t.label} · ${eur(t.amount)}</button>`)}
    </div>
    ${
      tx
        ? html`<form class="form-grid" data-form="pospay-record" data-id="${tx.id}" style="margin-top:12px">
            ${field('Identifiant du versement Stripe (facultatif)', html`<input class="input mono" name="payout" value="${f.payout || ''}" placeholder="po_…" />`, { hint: 'Tableau de bord Stripe › Soldes › Versements : brut et commissions exacts.' })}
            ${field('Ventes carte couvertes (brut)', html`<input class="input" name="gross" inputmode="decimal" value="${f.gross ?? (sug ? (sug.gross / 100).toFixed(2).replace('.', ',') : '')}" />`)}
            ${field('Commissions Stripe', html`<input class="input" name="fees" inputmode="decimal" value="${f.fees ?? (sug ? (sug.fees / 100).toFixed(2).replace('.', ',') : '')}" />`)}
            <div style="display:flex;gap:8px;align-items:flex-end">
              ${ui.demo ? '' : html`<button type="button" class="btn btn-secondary" data-action="pos-payout-fetch" data-id="${tx.id}">Lire chez Stripe</button>`}
              <button class="btn btn-primary" type="submit">Rapprocher ${eur(tx.amount)}</button>
            </div>
          </form>`
        : ''
    }
  </div>`;
}

export const actionsTable = {
  'pos-payout-pick': async ({ id }) => {
    ui.posPayout = { txId: id };
    render();
  },
  'pos-payout-fetch': async ({ id }) => {
    const payout = document.querySelector('form[data-form="pospay-record"] [name="payout"]')?.value.trim();
    try {
      const d = await caisse.payoutDetail(cloudState.meta.structureId, payout);
      const tx = ws.transactions.find((t) => t.id === id);
      if (Number(d.net) !== tx.amount)
        toast(`Attention : Stripe indique un versement net de ${eur(Number(d.net))}, le virement reçu est de ${eur(tx.amount)}.`, true);
      ui.posPayout = {
        txId: id,
        payout,
        gross: (Number(d.gross) / 100).toFixed(2).replace('.', ','),
        fees: (Number(d.fees) / 100).toFixed(2).replace('.', ','),
      };
    } catch (err) {
      toast(err.message, true);
    }
    render();
  },
};

if (typeof document !== 'undefined')
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.dataset?.form !== 'pospay-record') return;
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    try {
      ws.recordPayout(form.dataset.id, { gross: parseEuros(f.gross), fees: parseEuros(f.fees || '0'), payoutId: f.payout || '' });
      ui.posPayout = null;
      save();
      toast('Versement des cartes rapproché : ventes soldées, commissions enregistrées.');
    } catch (err) {
      toast(err.message, true);
    }
    render();
  });
