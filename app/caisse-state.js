/**
 * État de l'écran Caisse : panier en cours, caisse de ce poste (mémorisée sur l'appareil), paniers
 * en attente, rôle du caissier. La caisse de démonstration a un terminal simulé (aucun prestataire).
 */

import { newCart } from '../core/pos/cart.js?v=151777b';
import { cloudState, ui, ws } from './state.js?v=151777b';

const POSTE_KEY = 'nexus_caisse_poste_';
const PARKED_KEY = 'nexus_caisse_attente_';
const CART_KEY = 'nexus_caisse_panier_';
export const DEMO_REGISTER = { id: 'demo-register', name: 'Caisse de démonstration', readerId: 'tmr_DEMO', mode: 'live', active: true, demo: true };

const scope = () => (ui.demo ? 'demo' : cloudState.meta?.structureId || 'local');
const read = (k, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(k) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // stockage indisponible : réglage gardé pour la session seulement
  }
};

export const newSaleRef = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export function posState() {
  if (!ui.pos || ui.pos.scope !== scope()) {
    // Panier en cours retrouvé après un rechargement de la page (même poste).
    const saved = read(CART_KEY + scope(), null);
    const cart = saved?.id && Array.isArray(saved.lines) ? saved : newCart(newSaleRef());
    ui.pos = { scope: scope(), cart, flash: null, query: '', unknown: null, cash: null, card: null, attempts: [] };
  }
  return ui.pos;
}

/** Panier en cours gardé sur l'appareil. */
export const keepCart = () => write(CART_KEY + scope(), { id: posState().cart.id, lines: posState().cart.lines });

/** Responsable (remises, retours, clôture, terminaux) : dirigeant ou expert-comptable ; tout en démonstration. */
export const isPosManager = () => ui.demo || ['dirigeant', 'expert'].includes(cloudState.role || 'dirigeant');

export function registers() {
  if (ui.demo) return [DEMO_REGISTER];
  return (ws.pos.registers || []).filter((r) => r.active);
}

/** Caisse utilisée sur ce poste (choisie une fois sur l'appareil). */
export function posRegister() {
  const regs = registers();
  if (ui.demo) return regs[0];
  const id = read(POSTE_KEY + scope(), null);
  return regs.find((r) => r.id === id) || (regs.length === 1 ? regs[0] : null);
}
export const useRegister = (id) => write(POSTE_KEY + scope(), id);

export const parkedCarts = () => read(PARKED_KEY + scope(), []);
export const saveParked = (list) => write(PARKED_KEY + scope(), list);
