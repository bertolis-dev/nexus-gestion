/**
 * Écran « settings ».
 */

import * as cloud from '../cloud.js?v=ab27222';
import { render } from '../render.js?v=ab27222';
import { cloudState, frDate, today, ui, ws } from '../state.js?v=ab27222';
import { save, toast } from '../store.js?v=ab27222';
import { forgetRule } from '../../core/categorization.js?v=ab27222';

/** Actions « settings » : data-action → fonction. */
export const actionsTable = {
  'reminder-templates-reset': async () => {
    delete ws.company.reminderTemplates;
    save();
    render();
    toast('Modèles de Nexus rétablis.');
  },
  'category-rule-forget': async ({ id, index }) => {
    ws.company.categoryRules = forgetRule(ws.company.categoryRules, id, index);
    save();
    render();
    toast('Règle oubliée.');
  },
  'logo-remove': async () => {
    delete ws.company.logo;
    save();
    render();
    toast('Logo retiré.');
  },
  'invite-member': async () => {
    const email = document.querySelector('[data-invite-email]').value.trim();
    const role = document.querySelector('[data-invite-role]').value;
    if (!email) return toast('Indiquez l’adresse e-mail.', true);
    try {
      // Réponse identique qu'un compte existe ou non (la base ne révèle pas les adresses inscrites).
      const message = await cloud.inviteMember(cloudState.meta.structureId, email, role);
      ui.members = await cloud.listMembers(cloudState.meta.structureId);
      render();
      toast(message);
    } catch (err) {
      toast(cloud.friendly(err), true);
    }
    return;
  },
  'mfa-add': async () => {
    try {
      ui.security = { ...ui.security, adding: await cloud.mfaEnroll(`Appareil de secours ${frDate(today())}`) };
    } catch (err) {
      toast(cloud.friendly(err), true);
    }
    return render();
  },
  'mfa-remove': async ({ id }) => {
    if (!confirm('Retirer cette application d’authentification ? Elle ne permettra plus d’ouvrir votre comptabilité.')) return;
    try {
      await cloud.mfaRemove(id);
      ui.security = null;
      render();
      toast('Application retirée.');
    } catch (err) {
      toast(cloud.friendly(err), true);
    }
    return;
  },
  'remove-member': async ({ id }) => {
    const m = (ui.members || []).find((x) => x.user_id === id);
    if (!confirm(`Retirer l’accès de ${m?.email || 'ce membre'} à votre comptabilité ?`)) return;
    try {
      await cloud.removeMember(cloudState.meta.structureId, id);
      ui.members = await cloud.listMembers(cloudState.meta.structureId);
      render();
      toast('Accès retiré.');
    } catch (err) {
      toast(cloud.friendly(err), true);
    }
    return;
  },
};
