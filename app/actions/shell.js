/**
 * Écran « shell ».
 */

import * as cloud from '../cloud.js?v=c52829b';
import { removeDemo } from '../demo-store.js?v=c52829b';
import { $, render, renderApp } from '../render.js?v=c52829b';
import { cloudState, freshOnboarding, setWs, today, ui, ws } from '../state.js?v=c52829b';
import { download, setTheme, toast } from '../store.js?v=c52829b';
import { openStructure, openStructureAndShow } from '../sync-ui.js?v=c52829b';

/** Actions « shell » : data-action → fonction. */
export const actionsTable = {
  'forecast-toggle': async () => {
    ui.forecastOpen = !ui.forecastOpen;
    return render();
  },
  'toggle-nav': async ({ el }) => {
    const open = $('sidebar-nav').classList.toggle('open');
    el.setAttribute('aria-expanded', String(open));
    return;
  },
  'user-menu': async ({ el }) => {
    const open = $('user-menu-panel').classList.toggle('open');
    el.setAttribute('aria-expanded', String(open));
    return;
  },
  theme: async ({ el }) => {
    setTheme(el.dataset.value);
    return renderApp();
  },
  reload: async () => {
    return location.reload();
  },
  print: async () => {
    return window.print();
  },
  backup: async () => {
    return download(`nexus-gestion-${today()}.json`, JSON.stringify(ws.toJSON(), null, 2), 'application/json');
  },
  'demo-exit': async () => {
    removeDemo();
    setWs(null);
    ui.demo = false;
    ui.screen = 'landing';
    $('app-shell').dataset.ready = '';
    location.hash = '';
    return render();
  },
  'structure-open': async ({ id }) => {
    try {
      await openStructureAndShow(id);
    } catch (err) {
      toast(cloud.friendly(err), true);
    }
  },
  'structure-switch': async () => {
    if (cloudState.status.pending && !confirm('Des modifications ne sont pas encore enregistrées. Changer d’entreprise quand même ?')) return;
    setWs(null);
    ui.picking = true;
    ui.screen = 'login';
    location.hash = '';
    return render();
  },
  'sign-out': async () => {
    const pending = Math.max(cloudState.status.pending || 0, cloud.pendingEverywhere());
    if (
      pending &&
      !confirm(
        `${pending} modification(s) ne sont pas encore enregistrées (cette entreprise ou une autre). Se déconnecter les effacera de ce navigateur. Continuer ?`,
      )
    )
      return;
    await cloud.signOut();
    Object.assign(cloudState, { session: null, meta: null, outbox: null, synced: null, status: { pending: 0, error: null } });
    setWs(null);
    ui.mfa = null;
    // Rien de la session précédente ne reste affichable (membres, appareils).
    ui.security = null;
    ui.members = null;
    ui.structures = null;
    ui.picking = false;
    ui.ob = freshOnboarding();
    ui.screen = 'login';
    ui.auth = { view: 'login', error: '', info: '', busy: false, email: ui.auth.email };
    $('app-shell').dataset.ready = '';
    location.hash = '';
    return render();
  },
  'sync-retry': async () => {
    return cloudState.outbox?.flush();
  },
  'sync-reload': async () => {
    if (!confirm('Recharger depuis la base ? Les modifications non enregistrées de ce navigateur seront abandonnées.')) return;
    cloudState.outbox.clear();
    await openStructure(cloudState.meta.structureId);
    cloudState.status = { pending: 0, error: null };
    render();
    return toast('Données rechargées depuis la base.');
  },
};
