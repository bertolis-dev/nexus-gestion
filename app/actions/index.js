/**
 * Écran « index ».
 */

/** Table de toutes les actions (clics sur un élément data-action), réparties par domaine. */
import { actionsTable as site } from './site.js?v=f9f52cc';
import { actionsTable as shell } from './shell.js?v=f9f52cc';
import { actionsTable as sales } from './sales.js?v=f9f52cc';
import { actionsTable as expenses } from './expenses.js?v=f9f52cc';
import { actionsTable as bank } from './bank.js?v=f9f52cc';
import { actionsTable as compta } from './compta.js?v=f9f52cc';
import { actionsTable as vat } from './vat.js?v=f9f52cc';
import { actionsTable as closing } from './closing.js?v=f9f52cc';
import { actionsTable as micro } from './micro.js?v=f9f52cc';
import { actionsTable as settings } from './settings.js?v=f9f52cc';

const ACTIONS = { ...site, ...shell, ...sales, ...expenses, ...bank, ...compta, ...vat, ...closing, ...micro, ...settings };

/** Exécute l'action demandée par un clic ; sans effet si elle est inconnue. */
export function runAction(action, ctx) {
  return ACTIONS[action]?.(ctx);
}
