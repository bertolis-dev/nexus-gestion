/**
 * Écran « index ».
 */

/** Table de toutes les actions (clics sur un élément data-action), réparties par domaine. */
import { actionsTable as site } from './site.js?v=e8e3fd1';
import { actionsTable as shell } from './shell.js?v=e8e3fd1';
import { actionsTable as sales } from './sales.js?v=e8e3fd1';
import { actionsTable as expenses } from './expenses.js?v=e8e3fd1';
import { actionsTable as bank } from './bank.js?v=e8e3fd1';
import { actionsTable as compta } from './compta.js?v=e8e3fd1';
import { actionsTable as vat } from './vat.js?v=e8e3fd1';
import { actionsTable as closing } from './closing.js?v=e8e3fd1';
import { actionsTable as micro } from './micro.js?v=e8e3fd1';
import { actionsTable as settings } from './settings.js?v=e8e3fd1';
import { actionsTable as clients } from './clients.js?v=e8e3fd1';
import { actionsTable as pilotage } from './pilotage.js?v=e8e3fd1';
import { actionsTable as rebill } from '../views/rebill.js?v=e8e3fd1';

const ACTIONS = { ...site, ...shell, ...sales, ...expenses, ...bank, ...compta, ...vat, ...closing, ...micro, ...settings, ...clients, ...pilotage, ...rebill };

import { ui } from '../state.js?v=e8e3fd1';

/** Exécute l'action demandée par un clic ; sans effet si elle est inconnue. */
export function runAction(action, ctx) {
  // Après le rendu, le focus revient sur le même bouton (même action, même élément) s'il existe encore.
  const d = ctx.el?.dataset || {};
  ui.refocus = { action, id: d.id, index: d.index, tab: d.tab, value: d.value };
  return ACTIONS[action]?.(ctx);
}
