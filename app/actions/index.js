/**
 * Écran « index ».
 */

/** Table de toutes les actions (clics sur un élément data-action), réparties par domaine. */
import { actionsTable as site } from './site.js?v=151777b';
import { actionsTable as shell } from './shell.js?v=151777b';
import { actionsTable as sales } from './sales.js?v=151777b';
import { actionsTable as expenses } from './expenses.js?v=151777b';
import { actionsTable as bank } from './bank.js?v=151777b';
import { actionsTable as compta } from './compta.js?v=151777b';
import { actionsTable as vat } from './vat.js?v=151777b';
import { actionsTable as closing } from './closing.js?v=151777b';
import { actionsTable as micro } from './micro.js?v=151777b';
import { actionsTable as settings } from './settings.js?v=151777b';
import { actionsTable as clients } from './clients.js?v=151777b';
import { actionsTable as pilotage } from './pilotage.js?v=151777b';
import { actionsTable as rebill } from '../views/rebill.js?v=151777b';
import { actionsTable as caisse } from './caisse.js?v=151777b';
import { actionsTable as caisseSettings } from '../views/caisse-settings.js?v=151777b';
import { actionsTable as caissePayout } from '../views/caisse-payout.js?v=151777b';

const ACTIONS = {
  ...site,
  ...shell,
  ...sales,
  ...expenses,
  ...bank,
  ...compta,
  ...vat,
  ...closing,
  ...micro,
  ...settings,
  ...clients,
  ...pilotage,
  ...rebill,
  ...caisse,
  ...caisseSettings,
  ...caissePayout,
};

import { ui } from '../state.js?v=151777b';

/** Exécute l'action demandée par un clic ; sans effet si elle est inconnue. */
export function runAction(action, ctx) {
  // Après le rendu, le focus revient sur le même bouton (même action, même élément) s'il existe encore.
  const d = ctx.el?.dataset || {};
  ui.refocus = { action, id: d.id, index: d.index, tab: d.tab, value: d.value };
  return ACTIONS[action]?.(ctx);
}
