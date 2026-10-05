/**
 * Écran « index ».
 */

/** Table de toutes les actions (clics sur un élément data-action), réparties par domaine. */
import { actionsTable as site } from './site.js?v=ab27222';
import { actionsTable as shell } from './shell.js?v=ab27222';
import { actionsTable as sales } from './sales.js?v=ab27222';
import { actionsTable as expenses } from './expenses.js?v=ab27222';
import { actionsTable as bank } from './bank.js?v=ab27222';
import { actionsTable as compta } from './compta.js?v=ab27222';
import { actionsTable as vat } from './vat.js?v=ab27222';
import { actionsTable as closing } from './closing.js?v=ab27222';
import { actionsTable as micro } from './micro.js?v=ab27222';
import { actionsTable as settings } from './settings.js?v=ab27222';

const ACTIONS = { ...site, ...shell, ...sales, ...expenses, ...bank, ...compta, ...vat, ...closing, ...micro, ...settings };

/** Exécute l'action demandée par un clic ; sans effet si elle est inconnue. */
export function runAction(action, ctx) {
  return ACTIONS[action]?.(ctx);
}
