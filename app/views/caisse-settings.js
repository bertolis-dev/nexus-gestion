/**
 * Paramètres › Caisse : activation du module, caisses et terminaux du dossier (mode test ou
 * production, caisse utilisée sur ce poste, test de connexion), clé Stripe déposée par le dirigeant.
 * Actions et formulaires dans le même fichier (préfixe posset-).
 */

import { field, html, opt, raw } from '../html.js?v=151777b';
import { cloudState, ui, ws } from '../state.js?v=151777b';
import { badge } from '../ui/common.js?v=151777b';
import { isPosManager, posRegister, posState, registers, useRegister } from '../caisse-state.js?v=151777b';
import * as caisse from '../caisse-cloud.js?v=151777b';
import { render } from '../render.js?v=151777b';
import { save, toast } from '../store.js?v=151777b';

const owner = () => ui.demo || (cloudState.role || 'dirigeant') === 'dirigeant';

export function caisseSettingsTab() {
  const st = posState();
  const here = posRegister();
  const regs = ui.demo ? registers() : ws.pos.registers || [];
  const check = ui.posReaderCheck || {};
  return html`<div class="card" style="min-width:0">
      <h2>Module Caisse</h2>
      <p class="text-muted">
        Vente au comptoir : scan des articles, panier, encaissement en espèces ou par carte sur un terminal Stripe, ticket, retours et clôture de caisse.
      </p>
      <label class="form-field-checkbox" style="display:flex;gap:8px;align-items:center"
        ><input type="checkbox" data-action="posset-enable" ${ws.company.posEnabled ? raw('checked') : ''} ${owner() ? '' : raw('disabled')} />Afficher « Caisse
        » dans le menu</label
      >
      <p class="form-hint">
        Avant les ventes réelles d’un commerce redevable de la TVA, le logiciel de caisse doit être justifié conforme (CGI art. 286, I, 3° bis) : voir la page
        Conformité et votre expert-comptable.
      </p>
    </div>
    <div class="card table-card" style="min-width:0">
      <h2 style="padding:16px 16px 0">Caisses et terminaux</h2>
      ${
        regs.length
          ? html`<div class="table-scroll">
              <table class="table cards-mobile">
                <thead>
                  <tr>
                    <th>Caisse</th>
                    <th>Terminal</th>
                    <th>Mode</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${regs.map(
                    (r) =>
                      html`<tr>
                        <td data-label="Caisse">${r.name} ${here?.id === r.id ? badge('Ce poste', 'primary') : ''} ${r.active ? '' : badge('Désactivée')}</td>
                        <td data-label="Terminal" class="mono">
                          ${r.readerId || '—'}${check.id === r.id ? html`<br /><span class="${check.ok ? 'text-success' : 'text-danger'}">${check.text}</span>` : ''}
                        </td>
                        <td data-label="Mode">
                          ${r.demo ? badge('Démonstration', 'info') : r.mode === 'test' ? badge('Test', 'warning') : badge('Production', 'success')}
                        </td>
                        <td class="num">
                          <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
                            ${here?.id === r.id || ui.demo ? '' : html`<button type="button" class="btn btn-secondary btn-sm" data-action="posset-use" data-id="${r.id}">Utiliser sur ce poste</button>`}
                            ${r.readerId && !ui.demo ? html`<button type="button" class="btn btn-secondary btn-sm" data-action="posset-check" data-id="${r.id}">Tester la connexion</button>` : ''}
                            ${isPosManager() && !ui.demo ? html`<button type="button" class="btn-link" data-action="posset-edit" data-id="${r.id}">Modifier</button>` : ''}
                          </div>
                        </td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`
          : html`<p class="text-muted" style="padding:0 16px 16px">Aucune caisse pour l’instant.</p>`
      }
    </div>
    ${ui.demo ? html`<div class="card"><p class="text-muted" style="margin:0">En démonstration, la caisse utilise un terminal simulé : aucun prestataire n’est contacté.</p></div>` : ''}
    ${!ui.demo && isPosManager() ? registerForm() : ''} ${!ui.demo && owner() ? stripeKeyForm(st.stripe || {}) : ''}`;
}

function registerForm() {
  const r = (ws.pos.registers || []).find((x) => x.id === ui.posEditRegister) || {};
  return html`<form class="card" data-form="posset-register" style="display:flex;flex-direction:column;gap:12px;min-width:0">
    <h2 style="margin:0">${r.id ? `Modifier « ${r.name} »` : 'Ajouter une caisse'}</h2>
    <input type="hidden" name="id" value="${r.id || ''}" />
    <div class="form-grid">
      ${field('Nom de la caisse', html`<input class="input" name="name" required maxlength="60" value="${r.name || ''}" placeholder="Ex. : Comptoir" />`)}
      ${field('Identifiant du terminal Stripe', html`<input class="input mono" name="readerId" value="${r.readerId || ''}" placeholder="tmr_…" />`, {
        hint: 'Tableau de bord Stripe › Terminal › Lecteurs. En test, un lecteur simulé se crée avec le code d’appairage « simulated-wpe ».',
      })}
      ${field(
        'Mode',
        html`<select class="input" name="mode">
          ${opt('test', 'Test : environnement de test Stripe, sans effet sur le stock, les recettes ni la comptabilité', (r.mode || 'test') === 'test')}${opt('live', 'Production : vrais paiements', r.mode === 'live')}
        </select>`,
      )}
    </div>
    <label class="form-field-checkbox" style="display:flex;gap:8px;align-items:center"
      ><input type="checkbox" name="active" ${r.id && !r.active ? '' : raw('checked')} />Caisse active</label
    >
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary" type="submit">${r.id ? 'Enregistrer' : 'Ajouter la caisse'}</button
      >${r.id ? html`<button type="button" class="btn btn-secondary" data-action="posset-edit" data-id="">Annuler</button>` : ''}
    </div>
  </form>`;
}

function stripeKeyForm(status) {
  return html`<form class="card" data-form="posset-key" style="display:flex;flex-direction:column;gap:12px;min-width:0">
    <h2 style="margin:0">Clé Stripe</h2>
    <p class="text-muted" style="margin:0">
      Test : ${status.test ? badge('enregistrée', 'success') : badge('absente')} · Production :
      ${status.live ? badge('enregistrée', 'success') : badge('absente')}. La clé est gardée par la base, jamais réaffichée. Conseil : une clé restreinte (rk_…)
      limitée à Terminal, PaymentIntents et Refunds.
    </p>
    ${field('Clé secrète ou restreinte', html`<input class="input mono" name="key" type="password" autocomplete="off" required placeholder="sk_test_… ou rk_test_…" />`)}
    <div><button class="btn btn-primary" type="submit">Enregistrer la clé</button></div>
  </form>`;
}

export const actionsTable = {
  'posset-use': async ({ id }) => {
    useRegister(id);
    toast('Caisse associée à ce poste.');
    render();
  },
  'posset-edit': async ({ id }) => {
    ui.posEditRegister = id || null;
    render();
  },
  'posset-check': async ({ id }) => {
    try {
      const r = await caisse.checkReader(id);
      ui.posReaderCheck = { id, ok: r.ok, text: r.ok ? `En ligne${r.label ? ` (${r.label})` : ''}` : r.message || `Statut : ${r.status}` };
    } catch (err) {
      ui.posReaderCheck = { id, ok: false, text: err.message };
    }
    render();
  },
};

/** Case « Afficher Caisse dans le menu » (dirigeant). */
function onChange(e) {
  if (!e.target.matches?.('[data-action="posset-enable"]')) return;
  ws.company.posEnabled = e.target.checked;
  save();
  render();
}

async function onSubmit(e) {
  const form = e.target;
  const kind = form.dataset?.form;
  if (!kind?.startsWith('posset-')) return;
  e.preventDefault();
  const f = Object.fromEntries(new FormData(form));
  try {
    if (kind === 'posset-register') {
      const row = await caisse.saveRegister(cloudState.meta.structureId, {
        id: f.id || null,
        name: f.name,
        readerId: f.readerId,
        mode: f.mode,
        active: f.active === 'on',
      });
      const reg = { id: row.id, name: row.name, readerId: row.reader_id, mode: row.mode, active: row.active };
      ws.pos.registers = [...(ws.pos.registers || []).filter((r) => r.id !== reg.id), reg];
      ui.posEditRegister = null;
      toast(`Caisse « ${reg.name} » enregistrée.`);
    }
    if (kind === 'posset-key') {
      const mode = await caisse.configureStripe(cloudState.meta.structureId, f.key);
      posState().stripe = { ...(posState().stripe || {}), [mode]: true };
      form.reset();
      toast(`Clé Stripe de ${mode === 'test' ? 'test' : 'production'} enregistrée.`);
    }
  } catch (err) {
    toast(err.message, true);
  }
  render();
}

if (typeof document !== 'undefined') {
  document.addEventListener('change', onChange);
  document.addEventListener('submit', onSubmit);
}

// Champ « Code-barres » d'une fiche : la douchette valide par Entrée, ce qui ne doit pas envoyer la fiche incomplète.
if (typeof document !== 'undefined')
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches?.('[data-barcode-field]')) return;
    e.preventDefault();
    const fields = [...e.target.form.querySelectorAll('input:not([type="hidden"]), select')];
    fields[fields.indexOf(e.target) + 1]?.focus();
  });
