/**
 * Dépenses › refacturation à un client : bouton sur chaque dépense, formulaire (client, marge, pièce
 * jointe), état « À refacturer » / « Refacturée sur F-… », filtre des dépenses à refacturer.
 * Actions et formulaire dans le même fichier.
 */

import { field, html, opt, raw } from '../html.js?v=151777b';
import { cloudState, eur, today, ui, ws } from '../state.js?v=151777b';
import { badge } from '../ui/common.js?v=151777b';
import { render } from '../render.js?v=151777b';
import { save, toast } from '../store.js?v=151777b';
import { parseEuros, sum } from '../../core/money.js?v=151777b';

/** Pièce justificative enregistrée pour la dépense (ou pour son paiement en banque). */
export function hasReceipt(p) {
  if (ui.demo) return Boolean(p.documentName);
  const paidBy = new Set((p.payments || []).map((x) => x.ref));
  return cloudState.documents.some(
    (d) => (d.linked_entity === 'purchase' && d.linked_id === p.id) || (d.linked_entity === 'transaction' && paidBy.has(d.linked_id)),
  );
}

/** Marquer « à refacturer » : réglage de l'entreprise, réservé au dirigeant (merge_structure_settings). */
export const canMarkRebill = () => ui.demo || (cloudState.role || 'dirigeant') === 'dirigeant';

/** Badges et bouton de la colonne « Statut » d'une dépense. */
export function rebillCell(p) {
  // Avoir, indemnités kilométriques ou note de frais d'un salarié : rien à refacturer à un client.
  if (p.type === 'credit' || ['dirigeant', 'salarie'].includes(p.supplier.kind)) return '';
  const inv = ws.rebilledBy(p.id);
  if (inv)
    return html`<a class="badge badge-success" href="#/ventes/${inv.status === 'draft' ? `modifier-${inv.id}` : inv.id}"
      >Refacturée sur ${inv.number || 'un brouillon'}</a
    >`;
  const marked = (ws.company.toRebill || []).includes(p.id);
  const who = `${p.supplier.name}${p.number ? ` ${p.number}` : ''}`;
  return html`${marked ? badge('À refacturer', 'warning') : ''}<button
      type="button"
      class="btn-link"
      data-action="rebill-open"
      data-id="${p.id}"
      aria-label="Refacturer ${who} à un client"
    >
      Refacturer à un client</button
    >${marked && canMarkRebill() ? html`<button type="button" class="btn-link" data-action="rebill-unmark" data-id="${p.id}" aria-label="Retirer ${who} de la liste à refacturer">Retirer de la liste</button>` : ''}`;
}

/** Onglets de filtre au-dessus de la liste des dépenses. */
export function rebillFilter() {
  const n = ws.toRebill().length;
  if (!n && !ui.rebillOnly) return '';
  return html`<div class="tabs" style="margin:0 0 10px" role="group" aria-label="Filtrer les dépenses">
    <button type="button" class="tab ${ui.rebillOnly ? '' : 'active'}" data-action="rebill-filter" data-value="">Toutes</button>
    <button type="button" class="tab ${ui.rebillOnly ? 'active' : ''}" data-action="rebill-filter" data-value="1">À refacturer (${n})</button>
  </div>`;
}

export function filterPurchases(list) {
  // Plus rien à refacturer : retour à toutes les dépenses (pas de faux « Aucune dépense enregistrée »).
  if (ui.rebillOnly && !ws.toRebill().length) ui.rebillOnly = false;
  return ui.rebillOnly ? list.filter((p) => ws.toRebill().includes(p)) : list;
}

/** Formulaire de refacturation de la dépense choisie. */
export function rebillPanel() {
  const p = ws.purchases.find((x) => x.id === ui.rebillFor);
  if (!p) return '';
  const f = ui.rebillForm || {};
  const ht = sum(p.lines.map((l) => l.ht));
  const receipt = hasReceipt(p);
  return html`<form class="card" data-form="rebill" data-id="${p.id}" style="display:flex;flex-direction:column;gap:12px" aria-labelledby="rebill-title">
    <h2 id="rebill-title" tabindex="-1" style="margin:0">Refacturer « ${p.supplier.name}${p.number ? ` n° ${p.number}` : ''} » (${eur(ht)} HT)</h2>
    <p class="text-muted" style="margin:0">
      Un brouillon de facture, daté du jour, reprend le libellé, la date et le montant de la dépense, à son coût réel (HT, plus la TVA que vous ne récupérez
      pas). La TVA est celle de votre entreprise : c’est une vente ordinaire, pas des débours.
    </p>
    ${f.error ? html`<div class="issues-box" role="alert">${f.error}</div>` : ''}
    ${
      ws.clients.length
        ? html`<div class="form-grid">
              ${field(
                'Client',
                html`<select class="input" name="clientId">
                  ${ws.clients.map((c) => opt(c.id, c.name, c.id === f.clientId))}
                </select>`,
              )}
              ${field(
                'Marge',
                html`<select class="input" name="marginType">
                  ${opt('none', 'Aucune : prix coûtant', !f.marginType || f.marginType === 'none')}${opt('pct', 'En %', f.marginType === 'pct')}${opt('eur', 'En euros HT', f.marginType === 'eur')}
                </select>`,
              )}
              ${field('Valeur de la marge', html`<input class="input" name="margin" inputmode="decimal" value="${f.margin || ''}" placeholder="Ex. : 10" />`)}
            </div>
            <label class="form-field-checkbox" style="display:flex;gap:8px;align-items:center"
              ><input type="checkbox" name="attachReceipt" ${receipt ? '' : raw('disabled')} ${f.attachReceipt ? raw('checked') : ''} />Joindre le justificatif
              de la dépense au PDF de la facture${receipt ? '' : ' (aucun justificatif enregistré pour cette dépense)'}</label
            >
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="btn btn-primary" type="submit">Préparer la facture</button>
              <button type="button" class="btn btn-secondary" data-action="rebill-close">Annuler</button>
            </div>`
        : html`<p class="form-hint" style="margin:0">Ajoutez d’abord le client dans l’écran Clients.</p>`
    }
  </form>`;
}

/** Mention sur la facture : dépense d'origine. */
export function rebillNotice(inv) {
  if (!inv.rebillOf) return '';
  const r = inv.rebillOf;
  return html`<p class="form-hint" style="margin:0 0 10px">
    Refacturation de la dépense ${r.supplier}${r.number ? ` n° ${r.number}` : ''} du
    ${r.date.split('-').reverse().join('/')}${inv.attachReceipt ? ', justificatif joint au PDF' : ''}.
  </p>`;
}

export const actionsTable = {
  'rebill-open': async ({ id }) => {
    ui.rebillFor = id;
    ui.rebillForm = null;
    ui.focusTarget = '#rebill-title';
    render();
    document.querySelector('form[data-form="rebill"]')?.scrollIntoView({ block: 'start' });
  },
  'rebill-close': async () => {
    ui.focusTarget = `[data-action="rebill-open"][data-id="${ui.rebillFor}"]`;
    ui.rebillFor = null;
    render();
  },
  'rebill-unmark': async ({ id }) => {
    ws.markToRebill(id, false);
    save();
    render();
  },
  'rebill-filter': async ({ el }) => {
    ui.rebillOnly = Boolean(el.dataset.value);
    render();
  },
};

if (typeof document !== 'undefined')
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.dataset?.form !== 'rebill') return;
    e.preventDefault();
    const fd = new FormData(form);
    const f = Object.fromEntries(fd);
    ui.rebillForm = { ...f, attachReceipt: fd.has('attachReceipt') };
    try {
      const value = String(f.margin || '').trim();
      let marginPct = 0;
      let marginAmount = 0;
      if (f.marginType === 'none' && value)
        throw new Error('Choisissez le type de marge (en % ou en euros), ou videz la valeur pour facturer au prix coûtant.');
      if (f.marginType === 'pct') {
        marginPct = Number(value.replace(/[\s\u00a0\u202f%]/g, '').replace(',', '.'));
        if (!value || !(marginPct >= 0)) throw new Error('Indiquez la marge en % (exemple : 10).');
      }
      if (f.marginType === 'eur') {
        try {
          marginAmount = parseEuros(value);
        } catch {
          throw new Error('Indiquez la marge en euros HT (exemple : 25 ou 1 000,50).');
        }
      }
      const draft = ws.rebillPurchase(form.dataset.id, {
        clientId: f.clientId,
        today: today(),
        marginPct,
        marginAmount,
        attachReceipt: fd.has('attachReceipt'),
      });
      ui.rebillFor = null;
      ui.rebillForm = null;
      ui.draft = null;
      save();
      location.hash = `#/ventes/modifier-${draft.id}`;
      toast('Brouillon de facture préparé : vérifiez-le, puis émettez-le.');
    } catch (err) {
      ui.rebillForm.error = err.message;
    }
    render();
  });
