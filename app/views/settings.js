/**
 * Écran « settings ».
 */

import { field, html, opt, raw } from '../html.js?v=66361b9';
import { isMicro } from '../render.js?v=66361b9';
import { cloudState, eur, pct, ui, ws } from '../state.js?v=66361b9';
import { VAT_RATES_BP } from '../../core/invoices.js?v=66361b9';
import { ICONS } from '../icons.js?v=66361b9';
import { badge, viewHeader } from '../ui/common.js?v=66361b9';
import * as cloud from '../cloud.js?v=66361b9';
import { render } from '../render.js?v=66361b9';
import { membersCard, microSettingsCard, openingPreview, securityCard } from './onboarding.js?v=66361b9';
import { EXPENSE_CATEGORIES } from '../../core/pcg.js?v=66361b9';
import { normalizeIban } from '../../core/epc.js?v=66361b9';
import { INCOME_CATEGORIES, OUTFLOW_CATEGORIES } from '../../core/workspace.js?v=66361b9';
import { DEFAULT_TEMPLATES, REMINDER_STEPS } from '../../core/reminders.js?v=66361b9';

// ------------------------------------------------------------------ paramètres

/** Modèles des trois relances (J+3, J+15, J+30), modifiables ; variables entre accolades. */
function reminderTemplatesCard() {
  const custom = ws.company.reminderTemplates || [];
  return html`<form class="card" data-form="reminder-templates" style="display:flex;flex-direction:column;gap:12px">
    <h2>Modèles de relance</h2>
    <p class="text-muted" style="margin:0">Variables : {client}, {numero}, {montant} (reste dû), {date}, {echeance}, {jours} (de retard), {entreprise}.</p>
    ${REMINDER_STEPS.map((s, i) => {
      const t = custom[i]?.subject ? custom[i] : DEFAULT_TEMPLATES[i];
      return html`<fieldset class="choice-group">
        <legend>${s.label} (${s.days} jours après l’échéance)</legend>
        ${field('Objet', html`<input class="input" name="subject${i}" value="${t.subject}" />`)}
        ${field('Message', html`<textarea class="input" name="body${i}" rows="6">${t.body}</textarea>`)}
      </fieldset>`;
    })}
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-primary" type="submit">Enregistrer les modèles</button>
      ${custom.length ? html`<button class="btn btn-secondary" type="button" data-action="reminder-templates-reset">Revenir aux modèles de Nexus</button>` : ''}
    </div>
  </form>`;
}

/** Envoi par e-mail (Brevo) : relances automatiques et derniers e-mails partis. */
function emailCard() {
  if (ui.demo)
    return html`<div class="card">
      <h2>Envoi par e-mail</h2>
      <p class="text-muted" style="margin:0">En démonstration, aucun e-mail ne part : factures et relances s’ouvrent dans votre messagerie.</p>
    </div>`;
  if (!cloudState.emailReady)
    return html`<div class="card">
      <h2>Envoi par e-mail</h2>
      <p class="text-muted" style="margin:0">
        L’envoi direct par Nexus Gestion n’est pas encore en service : factures et relances s’ouvrent dans votre messagerie, prêtes à partir.
      </p>
    </div>`;
  if (!ui.emails && cloudState.meta) {
    ui.emails = { rows: [] };
    cloud
      .listEmails(cloudState.meta.structureId)
      .then((rows) => {
        ui.emails = { rows };
        render();
      })
      .catch(() => {});
  }
  const rows = ui.emails?.rows || [];
  const what = (e) => (e.kind === 'facture' ? 'Facture' : `${REMINDER_STEPS[e.level - 1]?.label || 'Relance'}${e.automatic ? ' (automatique)' : ''}`);
  return html`<div class="card" style="display:flex;flex-direction:column;gap:12px">
    <h2>Envoi par e-mail</h2>
    <p class="text-muted" style="margin:0">
      Factures et relances partent directement chez votre client, à l’adresse de sa fiche ; ses réponses arrivent dans votre boîte e-mail.
    </p>
    <label class="form-field-checkbox" style="display:flex;gap:8px;align-items:center"
      ><input type="checkbox" data-action="auto-reminders" ${ws.company.autoReminders ? raw('checked') : ''} />Relancer automatiquement les factures impayées
      (3, 15 puis 30 jours après l’échéance, chaque matin)</label
    >
    <p class="text-muted" style="margin:0;font-size:13px">
      Ne sont pas relancées automatiquement : les factures sans adresse e-mail client, avec un avoir, en litige ou déjà encaissées. Vous pouvez toujours
      relancer à la main depuis la facture.
    </p>
    ${
      rows.length
        ? html`<table class="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Envoi</th>
                <th>Destinataire</th>
                <th>Résultat</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(
                (e) =>
                  html`<tr>
                    <td>${new Date(e.sent_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</td>
                    <td>${what(e)} — ${e.subject}</td>
                    <td>${e.recipient}</td>
                    <td>
                      ${e.status === 'envoye' ? badge('Envoyé', 'success') : html`${badge('Échec', 'danger')} <span class="text-muted">${e.detail}</span>`}
                    </td>
                  </tr>`,
              )}
            </tbody>
          </table>`
        : html`<p class="text-muted" style="margin:0">Aucun e-mail envoyé pour l’instant.</p>`
    }
  </div>`;
}

/** Catalogue des prestations et articles, proposés pendant la saisie des factures et devis. */
function catalogTab() {
  const items = ws.company.catalog || [];
  const franchise = ws.company.vatRegime === 'franchise';
  return html`<form class="card" data-form="catalog-item" style="display:flex;flex-direction:column;gap:12px">
      <h2>Ajouter une prestation ou un article</h2>
      <p class="text-muted" style="margin:0">Dans une facture ou un devis, commencez à taper la désignation : Nexus la propose et remplit le prix et la TVA.</p>
      <div class="form-grid">
        ${field('Désignation', html`<input class="input" name="label" required maxlength="200" placeholder="Ex. : Création de site vitrine" />`)}
        ${field('Prix unitaire HT', html`<input class="input" name="price" inputmode="decimal" required placeholder="0,00" />`)}
        ${
          franchise
            ? ''
            : field(
                'TVA',
                html`<select class="input" name="vatRateBp">
                  ${VAT_RATES_BP.map((r) => opt(r, pct(r), r === 2000))}
                </select>`,
              )
        }
        ${field(
          'Nature',
          html`<select class="input" name="nature">
            ${opt('services', 'Service', true)}${opt('biens', 'Bien', false)}
          </select>`,
        )}
      </div>
      <div><button class="btn btn-primary" type="submit">Ajouter au catalogue</button></div>
    </form>
    ${
      items.length
        ? html`<div class="card table-card">
            <h2 style="padding:16px 16px 0">Mon catalogue (${items.length})</h2>
            <table class="table">
              <thead>
                <tr>
                  <th>Désignation</th>
                  <th class="num">Prix HT</th>
                  ${franchise ? '' : html`<th class="num">TVA</th>`}
                  <th>Nature</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${items.map(
                  (it) =>
                    html`<tr>
                      <td>${it.label}</td>
                      <td class="num">${eur(it.unitPrice)}</td>
                      ${franchise ? '' : html`<td class="num">${pct(it.vatRateBp)}</td>`}
                      <td>${it.nature === 'biens' ? 'Bien' : 'Service'}</td>
                      <td class="num"><button class="btn btn-secondary btn-sm" data-action="catalog-remove" data-id="${it.id}">Retirer</button></td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>`
        : html`<div class="card"><p class="text-muted" style="margin:0">Catalogue vide pour l’instant.</p></div>`
    }`;
}

/** Règles de catégorisation apprises en banque, supprimables une à une. */
function categoryRulesCard() {
  const rules = ws.company.categoryRules || [];
  if (!rules.length) return '';
  const label = (id) => [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES, ...OUTFLOW_CATEGORIES].find((c) => c.id === id)?.label || id;
  return html`<div class="card table-card">
    <h2 style="padding:16px 16px 0">Catégories retenues en banque</h2>
    <p class="text-muted" style="padding:0 16px;margin:0">Nexus les propose pour les mouvements semblables ; vous validez toujours.</p>
    <table class="table">
      <tbody>
        ${rules.map(
          (r) =>
            html`<tr>
              <td>« ${r.key} » (${r.direction === 'out' ? 'dépense' : 'recette'})</td>
              <td>${label(r.categoryId)}${r.direction === 'out' ? ` · TVA ${r.vatRateBp / 100} %` : ''}</td>
              <td class="num">
                <button class="btn btn-secondary btn-sm" data-action="category-rule-forget" data-id="${r.key}" data-index="${r.direction}">Oublier</button>
              </td>
            </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

/** Une rubrique de Paramètres : groupe de la barre latérale, visibilité, contenu. */
const SETTINGS_GROUPS = [
  { key: 'entreprise', label: 'Entreprise' },
  { key: 'facturation', label: 'Facturation et banque' },
  { key: 'securite', label: 'Sécurité et données' },
  { key: 'espace', label: 'Mon espace' },
];

const hasFecImport = () => ws.ledger.entries.some((e) => e.source?.kind === 'fec-import');

const SETTINGS_TABS = [
  { key: 'entreprise', label: 'Mon entreprise', group: 'entreprise', icon: 'building', visible: () => true, render: companyTab },
  { key: 'micro', label: 'Micro-entreprise', group: 'entreprise', icon: 'scale', visible: () => isMicro(), render: () => microSettingsCard() },
  { key: 'utilisateurs', label: 'Utilisateurs', group: 'entreprise', icon: 'people', visible: () => !ui.demo, render: () => membersCard() },
  {
    key: 'relances',
    label: 'Relances clients',
    group: 'facturation',
    icon: 'bell',
    visible: () => true,
    render: () => html`${emailCard()}${reminderTemplatesCard()}`,
  },
  { key: 'catalogue', label: 'Prestations et articles', group: 'facturation', icon: 'package', visible: () => true, render: catalogTab },
  { key: 'banque', label: 'Catégories bancaires', group: 'facturation', icon: 'card', visible: () => true, render: bankTab },
  { key: 'reprise', label: 'Reprise d’historique', group: 'facturation', icon: 'upload', visible: () => !hasFecImport(), render: openingTab },
  {
    key: 'securite',
    label: 'Connexion et sécurité',
    group: 'securite',
    icon: 'shield',
    visible: () => !ui.demo && Boolean(cloudState.session),
    render: () => securityCard(),
  },
  { key: 'donnees', label: 'Mes données', group: 'securite', icon: 'archive', visible: () => true, render: dataTab },
  { key: 'affichage', label: 'Affichage', group: 'espace', icon: 'eye', visible: () => true, render: displayTab },
];

/** Rubrique demandée dans l'adresse (#/parametres/relances), sinon « Mon entreprise ». */
export function settingsTab(arg) {
  const visible = SETTINGS_TABS.filter((t) => t.visible());
  return visible.find((t) => t.key === arg) || visible[0];
}

function companyTab() {
  const c = ws.company;
  const locked = ws.identityLocked();
  const lockedHint = 'Figé : des factures ont été émises ou des écritures validées. Pour un changement de situation, contactez le support.';
  return html`<div class="settings-cards-grid">
    <form class="card settings-card-wide" data-form="company" style="display:flex;flex-direction:column;gap:14px">
      <h2>Mon entreprise</h2>
      <div class="form-grid">
        ${field('Nom', html`<input class="input" name="name" value="${c.name}" />`)}
        ${field(
          'SIREN',
          html`<input class="input" name="siren" value="${c.siren}" inputmode="numeric" ${locked ? raw('readonly aria-readonly="true"') : ''} />`,
          {
            hint: locked ? lockedHint : '',
          },
        )}
        ${field(
          'Forme juridique',
          html`<select class="input" name="legalForm" ${locked ? raw('disabled') : ''}>
            ${['EI', 'EURL', 'SARL', 'SAS', 'SASU'].map((f) => opt(f, f, c.legalForm === f))}
          </select>`,
          { hint: locked ? lockedHint : '' },
        )}
        ${field('Capital social', html`<input class="input" name="capital" value="${c.capital || ''}" placeholder="Ex. : 1 000 €" />`, { hint: 'Obligatoire sur les factures d’une société.' })}
        ${field('Immatriculation', html`<input class="input" name="registration" value="${c.registration || ''}" placeholder="Ex. : RCS Lyon, RM 69" />`, { hint: 'RCS (commerce) ou RM (artisanat) et ville du greffe : obligatoire sur les factures d’une société.' })}
        ${field('Adresse', html`<input class="input" name="address" value="${c.address}" />`)}
        ${field('N° de TVA intracommunautaire', html`<input class="input" name="vatNumber" value="${c.vatNumber || ''}" />`)}
        ${field('IBAN (affiché sur les factures)', html`<input class="input" name="iban" value="${c.iban || ''}" />`, {
          hint:
            c.iban && !normalizeIban(c.iban)
              ? 'IBAN invalide (clé de contrôle) : vérifiez-le, sinon le QR code de paiement n’apparaît pas sur vos factures.'
              : 'Un QR code de paiement par virement est ajouté à vos factures.',
        })}
        ${field('Délai de paiement (jours)', html`<input class="input" name="paymentTermsDays" inputmode="numeric" value="${c.paymentTermsDays || 30}" />`)}
      </div>
      ${
        c.vatRegime === 'reel-normal'
          ? field(
              'Déclaration de TVA',
              html`<select class="input" name="vatPeriodicity" style="max-width:260px">
                ${opt('mensuelle', 'Chaque mois', c.vatPeriodicity !== 'trimestrielle')}${opt('trimestrielle', 'Chaque trimestre', c.vatPeriodicity === 'trimestrielle')}
              </select>`,
              { hint: 'Chaque trimestre : possible quand la TVA due sur l’année reste faible (à confirmer avec votre expert-comptable).' },
            )
          : ''
      }
      <label class="form-field-checkbox" style="display:flex;gap:8px;align-items:center"
        ><input type="checkbox" name="vatOnDebits" ${c.vatOnDebits ? raw('checked') : ''} />J'ai opté pour le paiement de la TVA d'après les débits</label
      >
      <div><button class="btn btn-primary" type="submit">Enregistrer</button></div>
    </form>
    <div class="card" style="display:flex;flex-direction:column;gap:10px">
      <h2>Logo sur vos factures</h2>
      ${
        c.logo
          ? html`<img src="${c.logo}" alt="Logo actuel de l’entreprise" style="max-height:56px;max-width:180px;object-fit:contain;align-self:flex-start" />
              <div><button class="btn btn-secondary btn-sm" data-action="logo-remove">Retirer le logo</button></div>`
          : html`<p class="text-muted" style="margin:0">Aucun logo : le nom de votre entreprise figure seul en tête de vos factures.</p>`
      }
      ${field('Choisir une image (PNG ou JPEG, 200 Ko au plus)', html`<input class="input" type="file" accept="image/png,image/jpeg" data-action="logo-file" />`)}
    </div>
  </div>`;
}

function bankTab() {
  return (
    categoryRulesCard() ||
    html`<div class="card">
      <h2>Catégories bancaires</h2>
      <p class="text-muted" style="margin:0">
        Aucune catégorie retenue pour l’instant. Quand vous catégorisez un mouvement en banque, Nexus le retient et le propose pour les mouvements semblables.
      </p>
    </div>`
  );
}

function openingTab() {
  return html`<div class="card" style="display:flex;flex-direction:column;gap:10px">
    <h2>Reprise d'historique</h2>
    <p class="text-muted">Importez le FEC de l'exercice précédent : Nexus reprend les soldes de bilan, le résultat et la liste de vos clients.</p>
    ${
      ui.pendingOpening
        ? html`${openingPreview(ui.pendingOpening.opening, ui.pendingOpening.fileName)}
            <div style="display:flex;gap:8px">
              <button class="btn btn-primary" data-action="opening-import">Importer ce bilan d'ouverture</button
              ><button class="btn btn-secondary" data-action="opening-cancel">Annuler</button>
            </div>`
        : field(
            'Fichier des écritures comptables (FEC)',
            html`<input class="input" type="file" accept=".txt,.csv" data-action="settings-fec-file" style="max-width:420px" />`,
          )
    }
  </div>`;
}

function dataTab() {
  return html`<div class="card" style="display:flex;flex-direction:column;gap:10px">
    <h2>Mes données</h2>
    <p class="text-muted" style="margin:0">
      ${ui.demo ? 'Démonstration : ces données fictives restent dans ce navigateur.' : 'Vos données sont enregistrées en base (hébergement à Paris), accessibles uniquement avec votre mot de passe et votre code de vérification.'}
      Elles vous appartiennent : téléchargez-les à tout moment (comptabilité, factures, clients, banque, journal d’audit), dans un format lisible par tout autre
      logiciel.
    </p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-secondary" data-action="data-export">Exporter toutes mes données</button
      ><button class="btn btn-secondary" data-action="backup">Télécharger une copie de sauvegarde</button
      ><button class="btn btn-secondary" data-action="${ui.demo ? 'demo-exit' : 'sign-out'}">${ui.demo ? 'Quitter la démonstration' : 'Se déconnecter'}</button>
    </div>
  </div>`;
}

function displayTab() {
  return html`<div class="card" style="display:flex;flex-direction:column;gap:10px">
    <h2>Affichage</h2>
    <label class="form-field-checkbox" style="display:flex;gap:8px;align-items:center"
      ><input type="checkbox" data-action="mode" ${ui.mode === 'avance' ? raw('checked') : ''} />Mode avancé : afficher la comptabilité (balance, grand livre,
      journaux, FEC)</label
    >
  </div>`;
}

/** Même présentation que les Paramètres de Nexus RH : barre latérale groupée, une rubrique à la fois. */
export function viewSettings(arg) {
  const active = settingsTab(arg);
  const visible = SETTINGS_TABS.filter((t) => t.visible());
  const sidebar = SETTINGS_GROUPS.map((g) => {
    const tabs = visible.filter((t) => t.group === g.key);
    if (!tabs.length) return '';
    return html`<div class="nav-section-label">${g.label}</div>
      ${tabs.map(
        (t) =>
          html`<button
            type="button"
            class="nav-item ${t === active ? 'active' : ''}"
            data-href="#/parametres/${t.key}"
            ${t === active ? raw('aria-current="page"') : ''}
          >
            <span class="nav-icon">${raw(ICONS[t.icon])}</span><span class="nav-label">${t.label}</span>
          </button>`,
      )}`;
  });
  return html`${viewHeader('Paramètres', 'Entreprise, facturation, sécurité et préférences d’affichage.')}
    <div class="parametres-layout">
      <nav class="parametres-sidebar-desktop" aria-label="Rubriques des paramètres">${sidebar}</nav>
      <select class="input parametres-tab-select" data-action="settings-tab" aria-label="Rubrique des paramètres">
        ${visible.map((t) => opt(t.key, t.label, t === active))}
      </select>
      <div class="parametres-content">${active.render()}</div>
    </div>`;
}
