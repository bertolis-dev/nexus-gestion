/**
 * Écran « index ».
 */

/** Table de toutes les actions (clics sur un élément data-action), réparties par domaine. */
import { actionsTable as site } from './site.js?v=214818f';
import { actionsTable as shell } from './shell.js?v=214818f';
import { actionsTable as sales } from './sales.js?v=214818f';
import { actionsTable as expenses } from './expenses.js?v=214818f';
import { actionsTable as bank } from './bank.js?v=214818f';
import { actionsTable as compta } from './compta.js?v=214818f';
import { actionsTable as vat } from './vat.js?v=214818f';
import { actionsTable as closing } from './closing.js?v=214818f';
import { actionsTable as micro } from './micro.js?v=214818f';
import { actionsTable as settings } from './settings.js?v=214818f';
import { actionsTable as clients } from './clients.js?v=214818f';

const ACTIONS = { ...site, ...shell, ...sales, ...expenses, ...bank, ...compta, ...vat, ...closing, ...micro, ...settings, ...clients };

/** Exécute l'action demandée par un clic ; sans effet si elle est inconnue. */
export function runAction(action, ctx) {
  return ACTIONS[action]?.(ctx);
}
