/**
 * Écran « Caisse » : recherche et douchette à gauche, panier à droite, total TTC et boutons
 * d'encaissement sous le total. Le ticket, l'historique, les retours et la clôture sont dans
 * caisse-docs.js ; les actions dans actions/caisse.js.
 */

import { cartTotals, lineTtc, unitTtcOf } from '../../core/pos/cart.js?v=d9f2509';
import { field, html, raw } from '../html.js?v=d9f2509';
import { eur, ui, ws } from '../state.js?v=d9f2509';
import { badge, icon, viewHeader } from '../ui/common.js?v=d9f2509';
import { isPosManager, posState, posRegister, parkedCarts } from '../caisse-state.js?v=d9f2509';
import { viewTicket, viewHistory, viewClosing } from './caisse-docs.js?v=d9f2509';

const pctTxt = (bp) => `${String(bp / 100).replace('.', ',')} %`;
const qtyTxt = (q) => String(q).replace('.', ',');

export function viewCaisse(arg) {
  if (arg === 'historique') return viewHistory();
  if (arg === 'cloture') return viewClosing();
  if (arg?.startsWith('ticket-')) return viewTicket(arg.slice(7));
  const st = posState();
  const reg = posRegister();
  const nav = html`<a class="btn btn-secondary" href="#/caisse/historique">${icon('clipboard', 14)} Historique</a
    >${reg && ws.currentSession(reg.id) ? html`<a class="btn btn-secondary" href="#/caisse/cloture">${icon('lock', 14)} Clôture</a>` : ''}`;
  const header = viewHeader(
    'Caisse',
    reg ? html`${reg.name}${reg.mode === 'test' ? html` ${badge('Mode test : sans effet réel', 'warning')}` : ''}` : 'Ventes au comptoir',
    nav,
  );
  if (!ui.demo && st.available === false)
    return html`${header}
      <div class="card">
        <p style="margin:0">Le module Caisse n’est pas encore activé sur le serveur : la mise à jour de la base (migration 0037) doit être appliquée.</p>
      </div>`;
  if (!reg) return html`${header}${chooseRegister()}`;
  const session = ws.currentSession(reg.id);
  if (!session) return html`${header}${openForm(reg)}`;
  return html`${header} ${pendingFinalizations(reg)}
    <div class="pos-layout">
      <section class="pos-left" aria-label="Recherche et articles">${scanPanel()}${favorites()}</section>
      <section class="pos-right" aria-label="Panier">${cartPanel(reg)}</section>
    </div>
    ${st.cash ? cashDialog() : ''} ${st.card ? cardDialog(reg) : ''}`;
}

function chooseRegister() {
  const regs = (ws.pos.registers || []).filter((r) => r.active);
  return html`<div class="card">
    <h2>Quelle caisse sur ce poste ?</h2>
    ${
      regs.length
        ? html`<p class="text-muted">Choisissez la caisse (et son terminal de paiement) utilisée sur cet ordinateur ou cette tablette.</p>
            <div class="pos-choices">
              ${regs.map((r) => html`<button type="button" class="btn btn-secondary pos-big" data-action="pos-use-register" data-id="${r.id}">${r.name}${r.mode === 'test' ? ' (test)' : ''}</button>`)}
            </div>`
        : html`<p class="text-muted" style="margin:0">
            Aucune caisse n’est encore créée.
            ${isPosManager() ? html`Créez-la dans <a href="#/parametres/caisse">Paramètres › Caisse</a>.` : 'Le dirigeant la crée dans Paramètres › Caisse.'}
          </p>`
    }
  </div>`;
}

function openForm(reg) {
  return html`<form class="card" data-form="pos-open" style="display:flex;flex-direction:column;gap:12px;max-width:520px">
    <h2>Ouvrir la caisse « ${reg.name} »</h2>
    <p class="text-muted" style="margin:0">
      Comptez le fonds de caisse (les espèces présentes au départ) : il sert au calcul des espèces attendues à la clôture.
    </p>
    ${field('Fonds de caisse (€)', html`<input class="input" name="float" inputmode="decimal" placeholder="Ex. : 150" />`)}
    <div><button class="btn btn-primary pos-big" type="submit">Ouvrir la caisse</button></div>
  </form>`;
}

/** Carte payée chez le prestataire mais vente non enregistrée (coupure) : à finaliser sans réencaisser. */
function pendingFinalizations(reg) {
  const todo = (posState().attempts || []).filter((a) => a.registerId === reg.id && a.status === 'succeeded' && !a.saleId);
  if (!todo.length) return '';
  return html`<div class="notice-gold" role="alert" style="margin-bottom:14px">
    <strong>Paiement par carte confirmé, vente non enregistrée</strong> (coupure pendant l’encaissement). Finalisez-la : la carte ne sera pas débitée une
    seconde fois.
    ${todo.map((a) => html` <button type="button" class="btn btn-gold btn-sm" data-action="pos-finalize-attempt" data-id="${a.id}">Finaliser la vente de ${eur(a.amount)}</button>`)}
  </div>`;
}

function scanPanel() {
  const st = posState();
  const locked = Boolean(st.card);
  const results = st.query ? searchCatalog(st.query) : [];
  return html`<form class="card pos-scan" data-form="pos-scan" autocomplete="off">
    <label for="pos-scan-input" class="pos-scan-label">Scanner ou rechercher un article</label>
    <div class="pos-scan-row">
      <input
        class="input pos-scan-input"
        id="pos-scan-input"
        name="code"
        placeholder="Code-barres (douchette) ou nom de l’article, puis Entrée"
        value="${st.query || ''}"
        ${locked ? raw('disabled') : ''}
        data-pos-scan
      />
      <button class="btn btn-primary" type="submit" ${locked ? raw('disabled') : ''}>Ajouter</button>
    </div>
    ${st.unknown ? unknownCode(st.unknown) : ''}
    ${
      results.length
        ? html`<ul class="pos-results" aria-label="Articles trouvés">
            ${results.map(
              (i) =>
                html`<li>
                  <button type="button" class="pos-result" data-action="${st.unknown && isPosManager() ? 'pos-link-barcode' : 'pos-add'}" data-id="${i.id}">
                    <span>${i.label}${i.barcode ? html` <span class="text-muted mono">${i.barcode}</span>` : ''}</span
                    ><strong>${eur(unitTtcOf(i, franchise()))}</strong>
                  </button>
                </li>`,
            )}
          </ul>`
        : st.query && !st.unknown
          ? html`<p class="text-muted" style="margin:8px 0 0">Aucun article ne correspond à « ${st.query} ».</p>`
          : ''
    }
  </form>`;
}

function unknownCode(code) {
  return html`<div class="pos-unknown" role="alert">
    <strong>Code inconnu : <span class="mono">${code}</span></strong>
    <p style="margin:4px 0">
      ${isPosManager() ? 'Tapez le nom de l’article ci-dessus, puis choisissez-le pour lui associer ce code : il sera ajouté au panier.' : 'Recherchez l’article par son nom ; le responsable pourra lui associer ce code.'}
    </p>
    <button type="button" class="btn-link" data-action="pos-unknown-clear">Fermer</button>
  </div>`;
}

const franchise = () => ({ franchise: ws.company.vatRegime === 'franchise' });

export function searchCatalog(query) {
  const q = String(query || '')
    .trim()
    .toLocaleLowerCase('fr')
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  if (!q) return [];
  const norm = (s) =>
    String(s || '')
      .toLocaleLowerCase('fr')
      .normalize('NFD')
      .replace(/\p{M}/gu, '');
  return (ws.company.catalog || []).filter((i) => norm(i.label).includes(q) || (i.barcode || '').startsWith(query.trim())).slice(0, 12);
}

function favorites() {
  const cat = ws.company.catalog || [];
  const favs = cat.filter((i) => i.favorite);
  const list = (favs.length ? favs : cat).slice(0, 16);
  if (!list.length)
    return html`<div class="card">
      <p class="text-muted" style="margin:0">
        Le catalogue est vide : ajoutez vos articles dans <a href="#/parametres/catalogue">Paramètres › Prestations et articles</a>.
      </p>
    </div>`;
  const locked = Boolean(posState().card);
  return html`<div class="card">
    <h2 style="margin-top:0">${favs.length ? 'Articles favoris' : 'Articles'}</h2>
    <div class="pos-favs">
      ${list.map(
        (i) =>
          html`<button type="button" class="pos-fav" data-action="pos-add" data-id="${i.id}" ${locked ? raw('disabled') : ''}>
            <span class="pos-fav-label">${i.label}</span><span class="pos-fav-price">${eur(unitTtcOf(i, franchise()))}</span>
          </button>`,
      )}
    </div>
  </div>`;
}

function cartPanel(reg) {
  const st = posState();
  const lines = st.cart.lines;
  const totals = cartTotals(lines);
  const locked = Boolean(st.card);
  const manager = isPosManager();
  const parked = parkedCarts();
  return html`<div class="card pos-cart">
    <div class="pos-cart-head">
      <h2 style="margin:0">Panier</h2>
      ${lines.length ? html`<button type="button" class="btn-link" data-action="pos-clear" ${locked ? raw('disabled') : ''}>Vider</button>` : ''}
    </div>
    ${
      lines.length
        ? html`<ul class="pos-lines">
              ${lines.map(
                (l, i) =>
                  html`<li class="pos-line ${st.flash === i ? 'pos-flash' : ''}" ${st.flash === i ? raw('aria-live="polite"') : ''}>
                    <div class="pos-line-main">
                      <span class="pos-line-label">${l.label}</span>
                      <span class="text-muted pos-line-unit"
                        >${eur(l.unitTtc)} × ${qtyTxt(l.qty)}${l.discountBp ? ` − ${pctTxt(l.discountBp)}` : ''} · TVA ${pctTxt(l.vatRateBp)}</span
                      >
                    </div>
                    <div class="pos-line-ctrl">
                      <button
                        type="button"
                        class="btn btn-secondary pos-step"
                        data-action="pos-qty-step"
                        data-index="${i}"
                        data-value="-1"
                        aria-label="Diminuer la quantité de ${l.label}"
                        ${locked ? raw('disabled') : ''}
                      >
                        −
                      </button>
                      <input
                        class="input pos-qty"
                        data-pos-qty="${i}"
                        value="${qtyTxt(l.qty)}"
                        inputmode="decimal"
                        aria-label="Quantité de ${l.label}"
                        ${locked ? raw('disabled') : ''}
                      />
                      <button
                        type="button"
                        class="btn btn-secondary pos-step"
                        data-action="pos-qty-step"
                        data-index="${i}"
                        data-value="1"
                        aria-label="Augmenter la quantité de ${l.label}"
                        ${locked ? raw('disabled') : ''}
                      >
                        +
                      </button>
                      ${manager ? html`<input class="input pos-disc" data-pos-discount="${i}" value="${l.discountBp ? String(l.discountBp / 100).replace('.', ',') : ''}" placeholder="Remise %" inputmode="decimal" aria-label="Remise sur ${l.label} (%)" ${locked ? raw('disabled') : ''} />` : ''}
                      <strong class="pos-line-total">${eur(lineTtc(l))}</strong>
                      <button
                        type="button"
                        class="btn-icon"
                        data-action="pos-remove"
                        data-index="${i}"
                        aria-label="Retirer ${l.label} du panier"
                        ${locked ? raw('disabled') : ''}
                      >
                        ${icon('close', 16)}
                      </button>
                    </div>
                  </li>`,
              )}
            </ul>
            <dl class="pos-vat">
              ${totals.byRate.map(
                (r) =>
                  html`<div>
                    <dt>TVA ${pctTxt(r.rateBp)} sur ${eur(r.ht)} HT</dt>
                    <dd>${eur(r.vat)}</dd>
                  </div>`,
              )}
            </dl>`
        : html`<p class="text-muted">Scannez un article ou choisissez-le à gauche.</p>`
    }
    <div class="pos-total" aria-live="polite"><span>Total TTC</span><strong>${eur(totals.totalTtc)}</strong></div>
    <div class="pos-pay">
      <button type="button" class="btn btn-primary pos-big" data-action="pos-card" ${!lines.length || locked || !reg.readerId ? raw('disabled') : ''}>
        ${icon('card', 18)} Encaisser par carte
      </button>
      <button type="button" class="btn btn-secondary pos-big" data-action="pos-cash" ${!lines.length || locked ? raw('disabled') : ''}>
        ${icon('coin', 18)} Espèces
      </button>
    </div>
    ${!reg.readerId ? html`<p class="form-hint">Aucun terminal associé à cette caisse : paiement carte indisponible (Paramètres › Caisse).</p>` : ''}
    <div class="pos-park">
      <button type="button" class="btn-link" data-action="pos-park" ${!lines.length || locked ? raw('disabled') : ''}>Mettre le panier en attente</button>
      ${parked.map(
        (p) =>
          html`<button type="button" class="btn btn-secondary btn-sm" data-action="pos-unpark" data-id="${p.id}" ${locked ? raw('disabled') : ''}>
            Reprendre ${p.label} (${eur(cartTotals(p.lines).totalTtc)})
          </button>`,
      )}
    </div>
  </div>`;
}

function cashDialog() {
  const st = posState();
  const total = cartTotals(st.cart.lines).totalTtc;
  const given = st.cash.given;
  const ok = Number.isSafeInteger(given) && given >= total;
  return html`<div class="pos-modal" role="dialog" aria-modal="true" aria-labelledby="pos-cash-title">
    <form class="card pos-modal-card" data-form="pos-cash">
      <h2 id="pos-cash-title">Paiement en espèces : ${eur(total)}</h2>
      ${field('Somme remise par le client (€)', html`<input class="input pos-big-input" name="given" id="pos-given" inputmode="decimal" value="${st.cash.text || ''}" data-pos-given autofocus />`)}
      <div class="pos-quick">
        ${[total, ...[500, 1000, 2000, 5000, 10000, 20000].map((u) => Math.ceil(total / u) * u)]
          .filter((v, i, a) => (i === 0 || v > total) && a.indexOf(v) === i)
          .slice(0, 4)
          .map((v) => html`<button type="button" class="btn btn-secondary" data-action="pos-cash-quick" data-value="${v}">${eur(v)}</button>`)}
      </div>
      <p class="pos-change" aria-live="polite">
        ${ok ? html`Monnaie à rendre : <strong>${eur(given - total)}</strong>` : given ? html`<span class="text-danger">Somme insuffisante : il manque ${eur(total - (given || 0))}</span>` : ''}
      </p>
      <div class="pos-pay">
        <button class="btn btn-primary pos-big" type="submit" ${ok ? '' : raw('disabled')}>Valider le paiement</button>
        <button type="button" class="btn btn-secondary" data-action="pos-cash-cancel">Annuler</button>
      </div>
    </form>
  </div>`;
}

const CARD_TEXT = {
  starting: ['Envoi du montant au terminal…', 'info'],
  pending: ['Le terminal attend le client : carte présentée, insérée ou code saisi.', 'info'],
  succeeded: ['Paiement confirmé par Stripe. Enregistrement de la vente…', 'success'],
  failed: ['Paiement refusé ou interrompu.', 'danger'],
  canceled: ['Paiement annulé.', 'muted'],
  unknown: ['Résultat à vérifier : ne relancez pas de paiement avant la vérification.', 'warning'],
};

function cardDialog(reg) {
  const c = posState().card;
  const [text, kind] = CARD_TEXT[c.status] || CARD_TEXT.pending;
  const final = ['failed', 'canceled'].includes(c.status);
  return html`<div class="pos-modal" role="dialog" aria-modal="true" aria-labelledby="pos-card-title">
    <div class="card pos-modal-card">
      <h2 id="pos-card-title">Paiement par carte : ${eur(c.amount)}</h2>
      <p class="pos-card-status pos-card-${kind}" role="status" aria-live="polite">${text}</p>
      ${c.error ? html`<p class="text-muted" style="margin:0">${c.error}</p>` : ''}
      <div class="pos-pay">
        ${c.status === 'pending' || c.status === 'starting' ? html`<button type="button" class="btn btn-secondary" data-action="pos-card-cancel">Annuler au terminal</button>` : ''}
        ${c.status === 'unknown' ? html`<button type="button" class="btn btn-primary" data-action="pos-card-check">Vérifier auprès de Stripe</button>` : ''}
        ${final ? html`<button type="button" class="btn btn-primary" data-action="pos-card">Réessayer</button><button type="button" class="btn btn-secondary" data-action="pos-card-close">Fermer</button>` : ''}
      </div>
      ${
        (reg.mode === 'test' || reg.demo) && c.status === 'pending'
          ? html`<div class="pos-test-tools">
              <span class="text-muted">${reg.demo ? 'Démonstration (terminal simulé)' : 'Mode test'} :</span>
              <button type="button" class="btn btn-secondary btn-sm" data-action="pos-card-simulate">Simuler une carte acceptée</button>
              <button type="button" class="btn btn-secondary btn-sm" data-action="pos-card-simulate" data-value="declined">Simuler une carte refusée</button>
            </div>`
          : ''
      }
    </div>
  </div>`;
}
