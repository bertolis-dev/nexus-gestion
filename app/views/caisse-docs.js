/**
 * Caisse — ticket imprimable, historique avec recherche, retours depuis le ticket d'origine, facture
 * demandée par le client, clôture de caisse avec récapitulatif par mode de paiement.
 */

import { issuerName } from '../../core/invoices.js?v=151777b';
import { returnedByLine } from '../../core/pos/sale.js?v=151777b';
import { field, html, opt, raw } from '../html.js?v=151777b';
import { eur, ui, ws } from '../state.js?v=151777b';
import { badge, icon, viewHeader } from '../ui/common.js?v=151777b';
import { isPosManager, posRegister } from '../caisse-state.js?v=151777b';

const pctTxt = (bp) => `${String(bp / 100).replace('.', ',')} %`;
const qtyTxt = (q) => String(q).replace('.', ',');
const time = (iso) => new Date(iso).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' });
const back = html`<a class="btn-link no-print" href="#/caisse">← Retour à la caisse</a>`;

export function viewTicket(id) {
  const sale = ws.posSale(id);
  if (!sale) return html`${back}${viewHeader('Ticket introuvable')}`;
  const c = ws.company;
  const returns = ws.pos.returns.filter((r) => r.saleId === sale.id);
  const cash = sale.payments.find((p) => p.method === 'cash');
  const inv = sale.invoiceId ? ws.book.invoices.find((i) => i.id === sale.invoiceId) : null;
  return html`${back}
    <div class="pos-ticket-layout">
      <article class="pos-ticket print-area" aria-label="Ticket ${sale.number}">
        ${sale.mode === 'test' ? html`<p class="pos-ticket-test">TICKET DE TEST — SANS VALEUR</p>` : ''}
        <p class="pos-ticket-head">
          <strong>${issuerName(c)}</strong><br />${c.address || ''}<br />SIREN ${c.siren}${c.vatNumber ? html`<br />TVA ${c.vatNumber}` : ''}
        </p>
        <p>Ticket <strong>${sale.number}</strong><br />${time(sale.at)}</p>
        <table class="pos-ticket-lines">
          <tbody>
            ${sale.lines.map(
              (l) =>
                html`<tr>
                  <td>${l.label}<br /><span>${qtyTxt(l.qty)} × ${eur(l.unitTtc)}${l.discountBp ? ` − ${pctTxt(l.discountBp)}` : ''}</span></td>
                  <td class="num">${eur(l.ttc)}</td>
                </tr>`,
            )}
          </tbody>
        </table>
        <p class="pos-ticket-total">TOTAL TTC <strong>${eur(sale.totals.totalTtc)}</strong></p>
        <table class="pos-ticket-vat">
          <thead>
            <tr>
              <th>TVA</th>
              <th class="num">HT</th>
              <th class="num">TVA</th>
              <th class="num">TTC</th>
            </tr>
          </thead>
          <tbody>
            ${sale.totals.byRate.map(
              (r) =>
                html`<tr>
                  <td>${pctTxt(r.rateBp)}</td>
                  <td class="num">${eur(r.ht)}</td>
                  <td class="num">${eur(r.vat)}</td>
                  <td class="num">${eur(r.ttc)}</td>
                </tr>`,
            )}
          </tbody>
        </table>
        <p>
          ${sale.payments.map((p) => html`${p.method === 'cash' ? 'Espèces' : 'Carte bancaire'} : ${eur(p.amount)}${p.paymentIntentId ? html` <span class="mono">(${p.paymentIntentId})</span>` : ''}<br />`)}
          ${cash?.given ? html`Remis : ${eur(cash.given)} · Rendu : ${eur(cash.given - cash.amount)}` : ''}
        </p>
        ${returns.length ? html`<p>${returns.map((r) => html`Retour ${r.number} du ${time(r.at)} : −${eur(r.totals.totalTtc)}${r.refund.status !== 'done' ? ` (${r.refund.status === 'pending' ? 'remboursement en attente' : 'remboursement refusé'})` : ''}<br />`)}</p>` : ''}
        <p class="pos-ticket-foot">Merci de votre visite</p>
      </article>
      <div class="no-print" style="display:flex;flex-direction:column;gap:12px;min-width:0">
        <div class="card">
          <h2 style="margin-top:0">Actions</h2>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-primary" data-action="print">${icon('printer', 14)} Imprimer le ticket</button>
            ${inv ? html`<a class="btn btn-secondary" href="#/ventes/${inv.status === 'draft' ? `modifier-${inv.id}` : inv.id}">Voir la facture ${inv.number || '(brouillon)'}</a>` : ''}
          </div>
        </div>
        ${!inv && sale.mode === 'live' ? invoiceCard(sale) : ''} ${isPosManager() ? returnCard(sale, returns) : ''}
      </div>
    </div>`;
}

function invoiceCard(sale) {
  return html`<form class="card" data-form="pos-invoice" data-id="${sale.id}" style="display:flex;flex-direction:column;gap:10px">
    <h2 style="margin:0">Le client demande une facture</h2>
    <p class="text-muted" style="margin:0">La facture reprend le ticket, déjà réglé : ni nouvelle recette ni nouvelle sortie de stock.</p>
    ${
      ws.clients.length
        ? html`${field(
              'Client',
              html`<select class="input" name="clientId">
                ${ws.clients.map((c) => opt(c.id, c.name, false))}
              </select>`,
            )}
            <div><button class="btn btn-secondary" type="submit">Préparer la facture</button></div>`
        : html`<p class="form-hint" style="margin:0">Créez d’abord le client dans l’écran Clients.</p>`
    }
  </form>`;
}

function returnCard(sale, returns) {
  const done = returnedByLine(sale, returns);
  const left = sale.lines.map((l, i) => Math.round((l.qty - (done[i]?.qty || 0)) * 1000) / 1000);
  if (left.every((q) => q <= 0)) return html`<div class="card"><p class="text-muted" style="margin:0">Tous les articles de ce ticket ont été rendus.</p></div>`;
  const card = sale.payments.some((p) => p.method === 'card');
  const f = ui.posReturn?.saleId === sale.id ? ui.posReturn : {};
  const v = f.values || {};
  return html`<form class="card" data-form="pos-return" data-id="${sale.id}" style="display:flex;flex-direction:column;gap:10px">
    <h2 style="margin:0">Retour d’articles</h2>
    ${sale.invoiceId ? html`<p class="form-hint" style="margin:0">Ce ticket a déjà une facture : après le retour, émettez aussi un avoir sur cette facture.</p>` : ''}
    ${f.error ? html`<div class="issues-box" role="alert">${f.error}</div>` : ''}
    <table class="table">
      <thead>
        <tr>
          <th>Article</th>
          <th class="num">Rendus</th>
          <th>Revendable</th>
        </tr>
      </thead>
      <tbody>
        ${sale.lines.map((l, i) =>
          left[i] > 0
            ? html`<tr>
                <td>${l.label}<br /><span class="text-muted">${qtyTxt(left[i])} au plus</span></td>
                <td class="num">
                  <input
                    class="input pos-qty"
                    name="qty-${i}"
                    inputmode="decimal"
                    placeholder="0"
                    value="${v[`qty-${i}`] || ''}"
                    aria-label="Quantité rendue de ${l.label}"
                  />
                </td>
                <td><input type="checkbox" name="resell-${i}" aria-label="${l.label} revendable" ${v.resell?.[i] ? raw('checked') : ''} /></td>
              </tr>`
            : '',
        )}
      </tbody>
    </table>
    ${field('Motif', html`<input class="input" name="reason" required maxlength="200" value="${v.reason || ''}" placeholder="Ex. : article défectueux" />`)}
    ${field(
      'Remboursement',
      html`<select class="input" name="method">
        ${card ? opt('card', 'Sur la carte du client (via le terminal)', true) : ''}${opt('cash', 'En espèces', !card)}
      </select>`,
    )}
    <div><button class="btn btn-secondary" type="submit">Enregistrer le retour</button></div>
  </form>`;
}

export function viewHistory() {
  const q = ui.posHistory || {};
  const text = (q.text || '').trim().toLowerCase();
  const amount = Math.round(Number(String(q.text || '').replace(',', '.')) * 100);
  const list = [...ws.pos.sales]
    .reverse()
    .filter((s) => !q.date || s.date === q.date)
    .filter(
      (s) =>
        !text ||
        s.number.toLowerCase().includes(text) ||
        s.payments.some((p) => (p.paymentIntentId || '').toLowerCase().includes(text)) ||
        (Number.isFinite(amount) && amount > 0 && s.totals.totalTtc === amount),
    )
    .slice(0, 200);
  return html`${back}${viewHeader('Historique de caisse', 'Tickets, retours et factures liées.')}
    <form class="card pos-history-search" data-form="pos-history" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
      ${field('Jour', html`<input class="input" type="date" name="date" value="${q.date || ''}" />`)}
      ${field('N° de ticket, montant ou référence de paiement', html`<input class="input" name="text" value="${q.text || ''}" placeholder="Ex. : T2026-000012, 12,90 ou pi_…" />`)}
      <button class="btn btn-secondary" type="submit">Rechercher</button>
    </form>
    <div class="card table-card">
      ${
        list.length
          ? html`<div class="table-scroll">
              <table class="table cards-mobile">
                <thead>
                  <tr>
                    <th>Ticket</th>
                    <th>Date</th>
                    <th>Règlement</th>
                    <th class="num">Total TTC</th>
                    <th>Suivi</th>
                  </tr>
                </thead>
                <tbody>
                  ${list.map((s) => {
                    const rets = ws.pos.returns.filter((r) => r.saleId === s.id);
                    return html`<tr class="clickable-row" data-href="#/caisse/ticket-${s.id}">
                      <td data-label="Ticket"><a class="doc-link mono" href="#/caisse/ticket-${s.id}">${s.number}</a></td>
                      <td data-label="Date">${time(s.at)}</td>
                      <td data-label="Règlement">${s.payments.map((p) => (p.method === 'cash' ? 'Espèces' : 'Carte')).join(' + ')}</td>
                      <td class="num" data-label="Total TTC">${eur(s.totals.totalTtc)}</td>
                      <td data-label="Suivi">
                        ${s.mode === 'test' ? badge('Test', 'warning') : ''}${rets.length ? badge(`${rets.length} retour${rets.length > 1 ? 's' : ''}`, 'info') : ''}${s.invoiceId ? badge('Facturé', 'success') : ''}
                      </td>
                    </tr>`;
                  })}
                </tbody>
              </table>
            </div>`
          : html`<p class="text-muted" style="padding:16px">Aucun ticket ne correspond.</p>`
      }
    </div>`;
}

export function viewClosing() {
  const reg = posRegister();
  const session = reg && ws.currentSession(reg.id);
  const closed = [...ws.pos.sessions]
    .filter((s) => s.closedAt && (!reg || s.registerId === reg.id))
    .slice(-5)
    .reverse();
  return html`${back}${viewHeader('Clôture de caisse', reg ? reg.name : '')}
  ${session ? openSummary(session) : html`<div class="card"><p style="margin:0">Aucune caisse ouverte sur ce poste.</p></div>`}
  ${closed.map((s) => closedSummary(s))}`;
}

function summaryTable(sum, extra = '') {
  return html`<table class="table" style="max-width:560px">
    <tbody>
      <tr>
        <td>Tickets</td>
        <td class="num">${sum.tickets}</td>
      </tr>
      <tr>
        <td>Ventes TTC (dont TVA ${eur(sum.salesVat)})</td>
        <td class="num">${eur(sum.salesTtc)}</td>
      </tr>
      <tr>
        <td>Espèces encaissées</td>
        <td class="num">${eur(sum.cash)}</td>
      </tr>
      <tr>
        <td>Cartes encaissées</td>
        <td class="num">${eur(sum.card)}</td>
      </tr>
      <tr>
        <td>Remboursements en espèces</td>
        <td class="num">${sum.refundsCash ? `−${eur(sum.refundsCash)}` : eur(0)}</td>
      </tr>
      <tr>
        <td>Remboursements sur carte</td>
        <td class="num">${sum.refundsCard ? `−${eur(sum.refundsCard)}` : eur(0)}</td>
      </tr>
      ${extra}
    </tbody>
  </table>`;
}

function openSummary(session) {
  const sum = ws.sessionSummary(session.id);
  return html`<div class="card">
      <h2 style="margin-top:0">Caisse ouverte le ${time(session.openedAt)}</h2>
      ${summaryTable(
        sum,
        html`<tr>
            <td>Fonds de caisse</td>
            <td class="num">${eur(session.openingFloat)}</td>
          </tr>
          <tr>
            <td><strong>Espèces attendues</strong></td>
            <td class="num"><strong>${eur(sum.expectedCash)}</strong></td>
          </tr>`,
      )}
    </div>
    ${
      isPosManager()
        ? html`<form class="card" data-form="pos-close" data-id="${session.id}" style="display:flex;flex-direction:column;gap:10px;max-width:560px">
            <h2 style="margin:0">Clôturer</h2>
            <p class="text-muted" style="margin:0">Comptez les espèces du tiroir. L’écart avec l’attendu est enregistré ; la clôture est définitive.</p>
            ${field('Espèces comptées (€)', html`<input class="input" name="counted" inputmode="decimal" required placeholder="0,00" />`)}
            <div><button class="btn btn-primary" type="submit">Clôturer la caisse</button></div>
          </form>`
        : html`<p class="form-hint">La clôture est faite par le responsable (dirigeant ou expert-comptable).</p>`
    }`;
}

function closedSummary(s) {
  return html`<div class="card print-area pos-closing-print">
    <h2 style="margin-top:0">Clôture du ${time(s.closedAt)}</h2>
    ${summaryTable(
      s.summary,
      html`<tr>
          <td>Espèces attendues</td>
          <td class="num">${eur(s.expectedCash)}</td>
        </tr>
        <tr>
          <td>Espèces comptées</td>
          <td class="num">${eur(s.countedCash)}</td>
        </tr>
        <tr>
          <td><strong>Écart</strong></td>
          <td class="num"><strong>${s.gap > 0 ? '+' : ''}${eur(s.gap)}</strong></td>
        </tr>`,
    )}
    <button type="button" class="btn btn-secondary no-print" data-action="print">${icon('printer', 14)} Imprimer</button>
  </div>`;
}
