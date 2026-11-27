/**
 * Actions de l'écran Caisse : scan et panier, espèces, carte (terminal Stripe, ou terminal simulé en
 * démonstration), reprise après coupure, retours, facture sur ticket, ouverture et clôture.
 */

import { findByBarcode, isValidBarcode, normalizeBarcode } from '../../core/pos/barcode.js?v=151777b';
import { addToCart, cartTotals, newCart, removeLine, setDiscount, setQty } from '../../core/pos/cart.js?v=151777b';
import { saveCatalogItem } from '../../core/catalog.js?v=151777b';
import { parseEuros } from '../../core/money.js?v=151777b';
import * as caisse from '../caisse-cloud.js?v=151777b';
import { isPosManager, keepCart, newSaleRef, parkedCarts, posRegister, posState, saveParked, useRegister } from '../caisse-state.js?v=151777b';
import { render } from '../render.js?v=151777b';
import { cloudState, ui, ws } from '../state.js?v=151777b';
import { save, toast } from '../store.js?v=151777b';
import { searchCatalog } from '../views/caisse.js?v=151777b';

const POLL_MS = 1500;
const nowIso = () => new Date().toISOString();
const franchise = () => ({ franchise: ws.company.vatRegime === 'franchise' });
const user = () => cloudState.session?.user?.id || 'demo';
const cents = (text) => {
  const v = String(text ?? '').trim();
  if (!v) return 0;
  try {
    return parseEuros(v);
  } catch {
    return NaN;
  }
};

/** Après chaque affichage de la caisse : le champ de scan reprend le focus (douchette prête). */
export function focusScan() {
  requestAnimationFrame(() => {
    if (!location.hash.startsWith('#/caisse')) return;
    const a = document.activeElement;
    const modal = document.querySelector('.pos-modal-card');
    // Dialogue ouvert : le focus y reste (premier champ, sinon premier bouton).
    if (modal) {
      if (!modal.contains(a)) (modal.querySelector('#pos-given') || modal.querySelector('button:not([disabled])'))?.focus();
      return;
    }
    // Focus perdu par le rendu (corps de page ou titre de l'écran) : retour au champ de scan, douchette prête.
    if (!a || a === document.body || a.tagName === 'H1') document.getElementById('pos-scan-input')?.focus();
  });
}
const show = () => {
  keepCart();
  render();
  focusScan();
};

function addItem(item, qty = 1) {
  const st = posState();
  if (st.card) return;
  addToCart(st.cart, item, { qty, ...franchise() });
  st.flash = st.cart.lines.findIndex((l) => l.itemId === item.id && !l.discountBp);
  st.query = '';
  st.unknown = null;
  show();
}

function resetCart() {
  const st = posState();
  st.cart = newCart(newSaleRef());
  st.flash = null;
  st.cash = null;
  st.card = null;
}

/** Vente confirmée par la base (ou locale en démonstration) puis écriture comptable par la file habituelle. */
async function finalize(payments, { lines, saleRef } = {}) {
  const st = posState();
  const reg = posRegister();
  const session = ws.currentSession(reg.id);
  const theLines = lines || st.cart.lines;
  const id = saleRef || st.cart.id;
  let sale;
  if (ui.demo) {
    sale = ws.recordSale({ id, registerId: reg.id, sessionId: session.id, cashier: user(), at: nowIso(), mode: reg.mode, lines: theLines, payments });
  } else {
    const row = await caisse.finalizeSale({ id, sessionId: session.id, lines: theLines, payments });
    sale = ws.recordSale({ ...row, lines: row.lines, payments: row.payments });
  }
  save();
  st.attempts = (st.attempts || []).filter((a) => a.saleRef !== id);
  st.lastSale = sale.id;
  resetCart();
  toast(`Vente ${sale.number} enregistrée : ${(sale.totals.totalTtc / 100).toFixed(2).replace('.', ',')} €.`);
  show();
  return sale;
}

// ------------------------------------------------------------------ carte

async function poll(id) {
  const st = posState();
  while (st.card?.id === id && st.card.status === 'pending') {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (posState().card?.id !== id) return;
    try {
      st.card = { ...st.card, ...(await caisse.cardStatus(id)) };
    } catch (err) {
      st.card = { ...st.card, status: 'unknown', error: `Connexion perdue (${err.message}) : vérifiez auprès de Stripe avant tout nouvel encaissement.` };
    }
    render();
  }
  if (st.card?.id === id && st.card.status === 'succeeded') await afterCardSuccess(st.card);
}

async function afterCardSuccess(attempt) {
  const st = posState();
  if (!st.attempts.some((a) => a.id === attempt.id)) st.attempts.push(attempt);
  try {
    await finalize([{ method: 'card', amount: attempt.amount, attemptId: attempt.id, paymentIntentId: attempt.paymentIntentId }], {
      lines: attempt.cart || st.cart.lines,
      saleRef: attempt.saleRef,
    });
  } catch (err) {
    // Carte débitée, vente pas encore enregistrée : le bandeau « Finaliser » la reprend sans réencaisser.
    st.card = null;
    toast(`Paiement confirmé, mais la vente n’a pas pu être enregistrée (${err.message}). Utilisez « Finaliser la vente ».`, true);
    show();
  }
}

/** Reprise après rechargement : une tentative en cours sur ce terminal est réaffichée et suivie. */
export function resumeCardAttempt() {
  const st = posState();
  const reg = posRegister();
  if (!reg || st.card) return;
  const open = (st.attempts || []).find((a) => a.registerId === reg.id && ['pending', 'unknown'].includes(a.status));
  if (!open) return;
  st.cart = { ...newCart(open.saleRef), lines: open.cart };
  st.card = open;
  if (open.status === 'pending') poll(open.id);
}

async function startCard() {
  const st = posState();
  const reg = posRegister();
  if (st.card && !['failed', 'canceled'].includes(st.card.status)) return; // double clic : tentative déjà en cours
  const amount = cartTotals(st.cart.lines).totalTtc;
  st.card = { status: 'starting', amount };
  render();
  if (ui.demo) {
    st.card = {
      id: newSaleRef(),
      saleRef: st.cart.id,
      registerId: reg.id,
      status: 'pending',
      amount,
      paymentIntentId: `pi_demo${Date.now()}`,
      cart: structuredClone(st.cart.lines),
    };
    return render();
  }
  st.cancelRequested = false;
  try {
    st.card = await caisse.cardStart(reg.id, st.cart.id, st.cart.lines);
  } catch (err) {
    st.card = { status: 'failed', amount, error: err.message };
    return render();
  }
  if (st.cancelRequested && st.card.status === 'pending') {
    st.cancelRequested = false;
    return actionsTable['pos-card-cancel']();
  }
  render();
  if (st.card.status === 'pending') return poll(st.card.id);
  if (st.card.status === 'succeeded') return afterCardSuccess(st.card);
}

// ------------------------------------------------------------------ actions (clics)

export const actionsTable = {
  'pos-use-register': async ({ id }) => {
    useRegister(id);
    show();
  },
  'pos-add': async ({ id }) => {
    const item = (ws.company.catalog || []).find((i) => i.id === id);
    if (item) addItem(item);
  },
  'pos-link-barcode': async ({ id }) => {
    const st = posState();
    if (!isPosManager() || !st.unknown) return;
    const item = ws.company.catalog.find((i) => i.id === id);
    try {
      ws.company.catalog = saveCatalogItem(ws.company.catalog, { ...item, barcode: st.unknown });
    } catch (err) {
      return toast(err.message, true);
    }
    save();
    toast(`Code ${st.unknown} associé à « ${item.label} ».`);
    addItem(ws.company.catalog.find((i) => i.id === id));
  },
  'pos-unknown-clear': async () => {
    posState().unknown = null;
    show();
  },
  'pos-qty-step': async ({ index, el }) => {
    const st = posState();
    const l = st.cart.lines[Number(index)];
    const next = Math.round((l.qty + Number(el.dataset.value)) * 1000) / 1000;
    if (next <= 0) removeLine(st.cart, Number(index));
    else l.qty = next;
    st.flash = null;
    show();
  },
  'pos-remove': async ({ index }) => {
    removeLine(posState().cart, Number(index));
    posState().flash = null;
    show();
  },
  'pos-clear': async () => {
    resetCart();
    show();
  },
  'pos-park': async () => {
    const st = posState();
    const list = parkedCarts();
    const at = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    saveParked([...list, { id: st.cart.id, label: `de ${at}`, lines: st.cart.lines }]);
    resetCart();
    toast('Panier mis en attente.');
    show();
  },
  'pos-unpark': async ({ id }) => {
    const st = posState();
    const list = parkedCarts();
    const p = list.find((x) => x.id === id);
    const rest = list.filter((x) => x.id !== id);
    const at = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    if (st.cart.lines.length) rest.push({ id: st.cart.id, label: `de ${at}`, lines: st.cart.lines });
    saveParked(rest);
    st.cart = { ...newCart(p.id), lines: p.lines };
    show();
  },
  'pos-cash': async () => {
    posState().cash = { text: '', given: null };
    show();
  },
  'pos-cash-quick': async ({ el }) => {
    const v = Number(el.dataset.value);
    posState().cash = { text: (v / 100).toFixed(2).replace('.', ','), given: v };
    render();
    requestAnimationFrame(() => document.querySelector('form[data-form="pos-cash"] [type="submit"]')?.focus());
  },
  'pos-cash-cancel': async () => {
    posState().cash = null;
    show();
  },
  'pos-card': startCard,
  'pos-card-cancel': async () => {
    const st = posState();
    if (!ui.demo && st.card?.status === 'starting') {
      st.cancelRequested = true; // la tentative n'a pas encore d'identifiant : annulée dès sa création
      return render();
    }
    if (ui.demo || !st.card?.id) {
      st.card = { ...st.card, status: 'canceled' };
      return render();
    }
    try {
      st.card = { ...st.card, ...(await caisse.cardCancel(st.card.id)) };
    } catch (err) {
      st.card = { ...st.card, status: 'unknown', error: err.message };
    }
    render();
    if (st.card.status === 'succeeded') await afterCardSuccess(st.card);
  },
  'pos-card-check': async () => {
    const st = posState();
    try {
      st.card = { ...st.card, ...(await caisse.cardStatus(st.card.id)) };
    } catch (err) {
      st.card = { ...st.card, error: err.message };
    }
    render();
    if (st.card.status === 'pending') poll(st.card.id);
    if (st.card.status === 'succeeded') await afterCardSuccess(st.card);
  },
  'pos-card-simulate': async ({ el }) => {
    const st = posState();
    if (st.card?.status !== 'pending') return;
    const declined = el.dataset.value === 'declined';
    if (ui.demo) {
      st.card = { ...st.card, status: declined ? 'failed' : 'succeeded', error: declined ? 'Carte refusée (simulation).' : null };
      render();
      if (!declined) await afterCardSuccess(st.card);
      return;
    }
    try {
      st.card = { ...st.card, ...(await caisse.cardSimulate(st.card.id, declined)) };
    } catch (err) {
      toast(err.message, true);
    }
    render();
  },
  'pos-card-close': async () => {
    posState().card = null;
    show();
  },
  'pos-finalize-attempt': async ({ id }) => {
    const a = posState().attempts.find((x) => x.id === id);
    if (a) await afterCardSuccess(a);
  },
};

// ------------------------------------------------------------------ formulaires

/** Formulaires de la caisse ; renvoie true si le formulaire a été traité. */
export async function caisseSubmit(kind, f, fd, form) {
  if (kind === 'pos-scan') {
    const st = posState();
    const raw = String(f.code || '').trim();
    if (!raw) return true;
    const item = findByBarcode(ws.company.catalog, raw);
    if (item) {
      addItem(item);
      return true;
    }
    const found = searchCatalog(raw);
    const code = normalizeBarcode(raw);
    if (found.length === 1 && !/^\d+$/.test(code) && !st.unknown) {
      addItem(found[0]);
      return true;
    }
    // Code lu par la douchette mais absent du catalogue : affiché, avec la recherche de l'article.
    if (/^\d{6,}$/.test(code) && isValidBarcode(code)) {
      st.unknown = code;
      st.query = '';
    } else st.query = raw;
    show();
    return true;
  }
  if (kind === 'pos-cash') {
    const st = posState();
    const total = cartTotals(st.cart.lines).totalTtc;
    const given = cents(f.given);
    if (!Number.isSafeInteger(given) || given < total) return toast('Somme remise insuffisante.', true) || true;
    if (given > Math.max(total * 20, total + 50000)) return toast('Somme remise anormalement élevée : vérifiez le montant saisi.', true) || true;
    try {
      await finalize([{ method: 'cash', amount: total, given, change: given - total }]);
    } catch (err) {
      toast(err.message, true);
    }
    return true;
  }
  if (kind === 'pos-open') {
    const float = cents(f.float);
    if (!Number.isSafeInteger(float) || float < 0) return toast('Fonds de caisse illisible (exemple : 150 ou 150,50).', true) || true;
    const reg = posRegister();
    try {
      if (ui.demo) ws.openSession({ registerId: reg.id, user: user(), at: nowIso(), openingFloat: float });
      else {
        const s = await caisse.openSession(reg.id, float);
        if (!ws.pos.sessions.some((x) => x.id === s.id)) ws.pos.sessions.push(s);
      }
      save();
      toast('Caisse ouverte.');
    } catch (err) {
      toast(err.message, true);
    }
    show();
    return true;
  }
  if (kind === 'pos-close') {
    const counted = cents(f.counted);
    if (!isPosManager()) return toast('La clôture est faite par le responsable.', true) || true;
    if (!Number.isSafeInteger(counted) || counted < 0) return toast('Montant compté illisible.', true) || true;
    const waiting = parkedCarts().length + (posState().cart.lines.length ? 1 : 0);
    if (
      !confirm(
        `${waiting ? `${waiting} panier${waiting > 1 ? 's' : ''} en cours ou en attente ne ${waiting > 1 ? 'seront' : 'sera'} pas encaissé${waiting > 1 ? 's' : ''}. ` : ''}La clôture est définitive. Clôturer la caisse ?`,
      )
    )
      return true;
    try {
      if (ui.demo) ws.closeRegister(form.dataset.id, { countedCash: counted, at: nowIso(), user: user() });
      else ws.applySessionClose(await caisse.closeSession(form.dataset.id, counted));
      save();
      toast('Caisse clôturée.');
    } catch (err) {
      toast(err.message, true);
    }
    render();
    return true;
  }
  if (kind === 'pos-return') {
    const saleId = form.dataset.id;
    const sale = ws.posSale(saleId);
    ui.posReturn = { saleId, values: { ...f, resell: sale.lines.map((_, i) => fd.has(`resell-${i}`)) } };
    const raw = sale.lines.map((_, i) => String(f[`qty-${i}`] || '').trim());
    const bad = raw.findIndex((v) => v && !(Number(v.replace(',', '.')) > 0));
    if (bad >= 0) {
      ui.posReturn.error = `« ${sale.lines[bad].label} » : quantité illisible (un nombre positif, exemple : 1).`;
      render();
      return true;
    }
    const wanted = sale.lines
      .map((_, i) => ({ lineIndex: i, qty: Number((raw[i] || '0').replace(',', '.')), resellable: fd.has(`resell-${i}`) }))
      .filter((w) => w.qty);
    if (!isPosManager()) {
      ui.posReturn.error = 'Les retours sont faits par le responsable.';
      render();
      return true;
    }
    try {
      const id = newSaleRef();
      let row = null;
      if (!ui.demo) row = await caisse.recordReturn({ id, saleId, wanted, reason: f.reason, refundMethod: f.method });
      const ret = ws.recordReturn(saleId, { id, number: row?.number, at: row?.at || nowIso(), user: user(), reason: f.reason, wanted, refundMethod: f.method });
      if (ret.refund.method === 'card') {
        if (ui.demo) ws.completeRefund(ret.id, { status: 'done', refundId: `re_demo${Date.now()}` });
        else {
          const r = await caisse.refundStart(ret.id);
          if (r.refund_status !== 'pending') ws.completeRefund(ret.id, { status: r.refund_status, refundId: r.refund_id });
        }
      }
      ui.posReturn = null;
      save();
      toast(
        ret.refund.status === 'pending' ? `Retour ${ret.number} enregistré : remboursement carte en cours chez Stripe.` : `Retour ${ret.number} enregistré.`,
      );
    } catch (err) {
      ui.posReturn.error = err.message;
    }
    render();
    return true;
  }
  if (kind === 'pos-invoice') {
    try {
      const draft = ws.invoiceFromSale(form.dataset.id, f.clientId, new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }));
      save();
      if (!ui.demo) await caisse.linkInvoice(form.dataset.id, draft.id);
      ui.draft = null;
      location.hash = `#/ventes/modifier-${draft.id}`;
      toast('Facture préparée à partir du ticket : vérifiez-la, puis émettez-la.');
    } catch (err) {
      toast(err.message, true);
    }
    render();
    return true;
  }
  if (kind === 'pos-history') {
    ui.posHistory = { date: f.date, text: f.text };
    render();
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ saisies et douchette

/** Quantité, remise et somme remise : mises à jour sans perdre le focus du champ. */
export function caisseInput(e) {
  const t = e.target;
  const st = posState();
  if (t.matches?.('[data-pos-given]')) {
    const total = cartTotals(st.cart.lines).totalTtc;
    const given = cents(t.value);
    st.cash = { text: t.value, given: Number.isSafeInteger(given) ? given : null };
    const box = document.querySelector('.pos-change');
    const ok = Number.isSafeInteger(given) && given >= total;
    if (box)
      box.innerHTML = ok
        ? `Monnaie à rendre : <strong>${((given - total) / 100).toFixed(2).replace('.', ',')} €</strong>`
        : given
          ? `<span class="text-danger">Somme insuffisante : il manque ${((total - given) / 100).toFixed(2).replace('.', ',')} €</span>`
          : '';
    const btn = t.form?.querySelector('[type="submit"]');
    if (btn) btn.disabled = !ok;
    return true;
  }
  return false;
}

export function caisseChange(e) {
  const t = e.target;
  const st = posState();
  try {
    if (t.matches?.('[data-pos-qty]')) setQty(st.cart, Number(t.dataset.posQty), t.value);
    else if (t.matches?.('[data-pos-discount]') && isPosManager()) setDiscount(st.cart, Number(t.dataset.posDiscount), t.value || '0');
    else return false;
  } catch (err) {
    toast(err.message, true);
  }
  st.flash = null;
  show();
  return true;
}

/**
 * Douchette USB (mode clavier) : hors d'un champ de saisie, les caractères tapés vont dans le champ de
 * scan et Entrée valide. Dans un champ (quantité, remise, somme remise), la saisie reste ordinaire.
 */
const BURST_MS = 40; // une douchette tape un caractère toutes les quelques millisecondes ; un humain, bien moins vite
let burst = { target: null, before: '', chars: '', last: 0 };

export function caisseKeydown(e) {
  if (!location.hash.startsWith('#/caisse') || location.hash.includes('/ticket-') || e.ctrlKey || e.metaKey || e.altKey) return;
  const st = posState();
  const t = e.target;
  const scan = document.getElementById('pos-scan-input');
  const now = performance.now();
  // Rafale dans un autre champ (quantité, remise, somme remise…) : c'est un scan, pas une saisie.
  if (t !== scan && t.matches?.('input')) {
    if (e.key.length === 1) {
      if (now - burst.last > BURST_MS || burst.target !== t) burst = { target: t, before: t.value, chars: '', last: now };
      burst.chars += e.key;
      burst.last = now;
      return;
    }
    if (e.key === 'Enter' && burst.target === t && burst.chars.length >= 6 && now - burst.last <= BURST_MS * 2) {
      e.preventDefault();
      e.stopPropagation();
      const code = burst.chars;
      t.value = burst.before; // la saisie en cours est rendue telle qu'elle était
      burst = { target: null, before: '', chars: '', last: 0 };
      if (st.cash || st.card) return toast('Paiement en cours : le scan est ignoré.', true);
      return caisseSubmit('pos-scan', { code });
    }
    return;
  }
  if (st.cash || st.card) return;
  if (t.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  if (!scan || scan.disabled) return;
  if (e.key.length === 1) {
    scan.value = ''; // reste d'une recherche précédente : le nouveau code ne s'y colle pas
    scan.focus();
  }
}

/** Dialogues de paiement : Tab reste dans le dialogue ; Échap annule les espèces ou ferme une carte terminée. */
function dialogKeys(e) {
  const modal = document.querySelector('.pos-modal-card');
  if (!modal) return;
  const st = posState();
  if (e.key === 'Escape') {
    if (st.cash) actionsTable['pos-cash-cancel']();
    else if (st.card && ['failed', 'canceled'].includes(st.card.status)) actionsTable['pos-card-close']();
    return;
  }
  if (e.key !== 'Tab') return;
  const items = [...modal.querySelectorAll('button:not([disabled]), input:not([disabled])')];
  if (!items.length) return;
  const [first, last] = [items[0], items.at(-1)];
  if (!modal.contains(document.activeElement)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// Écouteurs propres à la caisse (les autres formulaires restent dans events.js).
if (typeof document !== 'undefined') {
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!form.dataset?.form?.startsWith('pos-')) return;
    e.preventDefault();
    const fd = new FormData(form);
    caisseSubmit(form.dataset.form, Object.fromEntries(fd), fd, form);
  });
  document.addEventListener('input', caisseInput);
  document.addEventListener('change', caisseChange);
  document.addEventListener('keydown', caisseKeydown, true);
  document.addEventListener('keydown', dialogKeys);
}
