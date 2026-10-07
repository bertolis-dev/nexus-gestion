/**
 * Assistant de raccordement URSSAF (sans l'API de tierce déclaration, pas encore ouverte à Nexus) :
 * SIRET vérifié dans l'annuaire des entreprises, espace autoentrepreneur.urssaf.fr, numéro de compte
 * cotisant complété à 18 chiffres. Les données sont prêtes pour le raccordement (connecteur
 * core/connectors/urssaf.js, même interface pour l'API).
 */

import { accountNotFoundCauses, createManualConnector, URSSAF_CREATE_SPACE_URL } from '../../core/connectors/urssaf.js?v=c52829b';
import { searchCompany } from '../company-lookup.js?v=c52829b';
import { field, html, raw } from '../html.js?v=c52829b';
import { today, ui, ws } from '../state.js?v=c52829b';
import { icon } from '../ui/common.js?v=c52829b';

export const urssafConnector = createManualConnector({ lookupCompany: searchCompany });

const step = () => ui.urssafLink || { step: 0 };

function causesBlock(s) {
  const causes = accountNotFoundCauses({ identity: s.identity || null, hasSpace: s.hasSpace ?? null });
  return html`<div class="notice-gold" style="display:flex;flex-direction:column;gap:6px">
    <strong>Compte introuvable : causes possibles</strong>
    <ol style="margin:0;padding-left:18px">
      ${causes.map(
        (c) =>
          html`<li>
            ${c.cause} <strong>${c.action}</strong>${c.url ? html` <a href="${c.url}" target="_blank" rel="noopener">Ouvrir le site de l’URSSAF</a>` : ''}
          </li>`,
      )}
    </ol>
  </div>`;
}

/** Carte de l'écran « URSSAF et seuils ». */
export function urssafLinkCard() {
  const saved = ws.company.urssafLink;
  const s = step();
  const status = urssafConnector.status(saved);
  const error = s.error ? html`<p class="login-error" role="alert">${s.error}</p>` : '';
  const warnings = (s.warnings || []).length
    ? html`<ul class="form-hint" style="margin:0;padding-left:18px">
        ${s.warnings.map((w) => html`<li>${w}</li>`)}
      </ul>`
    : '';
  let body;
  if (!s.step) {
    body = html`<p style="margin:0">${status.label}</p>
      ${saved?.accountNumber ? html`<p class="text-muted" style="margin:0">Compte cotisant ${saved.accountNumber} · SIRET ${saved.identity?.siret}</p>` : ''}
      <div><button class="btn btn-primary" data-action="urssaf-link-start">${saved ? 'Modifier les informations' : 'Préparer le raccordement'}</button></div>`;
  } else if (s.step === 1) {
    body = html`<form data-form="urssaf-link-siret" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
        ${field('Votre SIRET (14 chiffres)', html`<input class="input" name="siret" inputmode="numeric" value="${s.siret || ''}" required />`, { hint: 'Il figure sur votre avis de situation INSEE et sur l’annuaire des entreprises.' })}
        <button class="btn btn-primary" type="submit" style="margin-bottom:26px">Vérifier</button>
      </form>
      ${error}`;
  } else if (s.step === 2) {
    body = html`<p style="margin:0">
        <strong>${s.identity.name}</strong> — SIRET ${s.identity.siret}, entreprise
        active${s.identity.createdOn ? `, immatriculée le ${s.identity.createdOn.split('-').reverse().join('/')}` : ''}.
      </p>
      ${warnings}
      <p style="margin:0">Avez-vous déjà un espace en ligne sur autoentrepreneur.urssaf.fr ?</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" data-action="urssaf-link-space" data-index="1">Oui</button>
        <button class="btn btn-secondary" data-action="urssaf-link-space" data-index="0">Pas encore</button>
      </div>`;
  } else if (s.step === 3) {
    body =
      s.hasSpace === false
        ? html`<ol style="margin:0;padding-left:18px">
              ${s.steps.map((t) => html`<li>${t}</li>`)}
            </ol>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <a class="btn btn-primary" href="${URSSAF_CREATE_SPACE_URL}" target="_blank" rel="noopener">Créer mon espace URSSAF</a>
              <button class="btn btn-secondary" data-action="urssaf-link-space" data-index="1">C’est fait</button>
            </div>`
        : html`<form data-form="urssaf-link-account" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
              ${field('Numéro de compte cotisant', html`<input class="input" name="account" inputmode="numeric" value="${s.account || ''}" required />`, {
                hint: 'Sur les courriers de l’URSSAF et dans « Mon compte » de votre espace. S’il compte moins de 18 chiffres, Nexus le complète.',
              })}
              <button class="btn btn-primary" type="submit" style="margin-bottom:26px">Enregistrer</button>
            </form>
            ${error}
            <button class="btn-link" data-action="urssaf-link-causes">Mon compte est introuvable ?</button>
            ${s.showCauses ? causesBlock(s) : ''}`;
  } else {
    body = html`<p style="margin:0">${raw('&#10003;')} Compte cotisant <strong>${s.accountNumber}</strong> enregistré.</p>
      ${s.steps.map((t) => html`<p class="text-muted" style="margin:0">${t}</p>`)}
      <div><button class="btn btn-secondary" data-action="urssaf-link-close">Terminer</button></div>`;
  }
  return html`<div class="card" style="display:flex;flex-direction:column;gap:10px">
    <div style="display:flex;gap:10px;align-items:center">
      <span style="color:var(--landing-gold-500)">${icon('link', 20)}</span>
      <h2 style="margin:0">Relier mon compte URSSAF</h2>
    </div>
    <p class="text-muted" style="margin:0">
      Nexus prépare son raccordement au service officiel de tierce déclaration de l’URSSAF. Préparez dès maintenant vos informations : le jour venu, vous
      autoriserez Nexus en un clic, sans jamais nous confier vos identifiants.
    </p>
    ${body}
  </div>`;
}

/** Actions de l'assistant (clics). */
export const urssafLinkActions = {
  'urssaf-link-start': async () => {
    ui.urssafLink = { step: 1, siret: ws.company.urssafLink?.identity?.siret || '' };
  },
  'urssaf-link-space': async ({ index }) => {
    const s = step();
    s.hasSpace = index === '1';
    const r = urssafConnector.checkAccount({ hasSpace: s.hasSpace, identity: s.identity });
    Object.assign(s, { step: 3, steps: r.steps, error: '' });
  },
  'urssaf-link-causes': async () => {
    step().showCauses = !step().showCauses;
  },
  'urssaf-link-close': async () => {
    ui.urssafLink = null;
  },
};

/** Formulaires de l'assistant ; renvoie vrai si les données de l'entreprise ont changé. */
export async function urssafLinkSubmit(kind, f) {
  const s = step();
  if (kind === 'urssaf-link-siret') {
    s.siret = f.siret;
    const r = await urssafConnector.checkIdentity(f.siret, today());
    if (!r.ok) {
      Object.assign(s, { error: r.error.message, identity: r.identity || null });
      return false;
    }
    Object.assign(s, { step: 2, identity: r.identity, warnings: r.warnings, error: '' });
    return false;
  }
  if (kind === 'urssaf-link-account') {
    s.account = f.account;
    const r = urssafConnector.checkAccount({ accountNumber: f.account, hasSpace: true, identity: s.identity });
    if (!r.ok) {
      s.error = r.error.message;
      return false;
    }
    Object.assign(s, { step: 4, accountNumber: r.accountNumber, steps: r.steps, error: '' });
    ws.company.urssafLink = { identity: s.identity, hasSpace: true, accountNumber: r.accountNumber };
    return true;
  }
  return false;
}
