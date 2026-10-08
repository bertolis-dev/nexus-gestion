/**
 * Écran « index ».
 */

/** Table de toutes les actions (clics sur un élément data-action), réparties par domaine. */
import { actionsTable as site } from './site.js?v=a60350d';
import { actionsTable as shell } from './shell.js?v=a60350d';
import { actionsTable as sales } from './sales.js?v=a60350d';
import { actionsTable as expenses } from './expenses.js?v=a60350d';
import { actionsTable as bank } from './bank.js?v=a60350d';
import { actionsTable as compta } from './compta.js?v=a60350d';
import { actionsTable as vat } from './vat.js?v=a60350d';
import { actionsTable as closing } from './closing.js?v=a60350d';
import { actionsTable as micro } from './micro.js?v=a60350d';
import { actionsTable as settings } from './settings.js?v=a60350d';
import { actionsTable as clients } from './clients.js?v=a60350d';

const ACTIONS = { ...site, ...shell, ...sales, ...expenses, ...bank, ...compta, ...vat, ...closing, ...micro, ...settings, ...clients };

/** Exécute l'action demandée par un clic ; sans effet si elle est inconnue. */
export function runAction(action, ctx) {
  return ACTIONS[action]?.(ctx);
}
