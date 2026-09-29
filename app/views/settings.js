/**
 * Écran « settings ».
 */

import { field, html, opt, raw } from '../html.js?v=e64ad2c';
import { isMicro } from '../render.js?v=e64ad2c';
import { ui, ws } from '../state.js?v=e64ad2c';
import { viewHeader } from '../ui/common.js?v=e64ad2c';
import { membersCard, microSettingsCard, openingPreview, securityCard } from './onboarding.js?v=e64ad2c';

// ------------------------------------------------------------------ paramètres

export function viewSettings() {
  const c = ws.company;
  const locked = ws.identityLocked();
  const lockedHint = 'Figé : des factures ont été émises ou des écritures validées. Pour un changement de situation, contactez le support.';
  return html` ${viewHeader('Paramètres', 'Informations imprimées sur vos factures et préférences d’affichage.')}
    <form class="card" data-form="company" style="display:flex;flex-direction:column;gap:14px">
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
        ${field('IBAN (affiché sur les factures)', html`<input class="input" name="iban" value="${c.iban || ''}" />`)}
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
    ${isMicro() ? microSettingsCard() : ''}
    <div class="card" style="display:flex;flex-direction:column;gap:10px">
      <h2>Affichage</h2>
      <label class="form-field-checkbox" style="display:flex;gap:8px;align-items:center"
        ><input type="checkbox" data-action="mode" ${ui.mode === 'avance' ? raw('checked') : ''} />Mode avancé : afficher la comptabilité (balance, grand livre,
        journaux, FEC)</label
      >
    </div>
    ${securityCard()} ${membersCard()}
    ${
      ws.ledger.entries.some((e) => e.source?.kind === 'fec-import')
        ? ''
        : html`<div class="card" style="display:flex;flex-direction:column;gap:10px">
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
          </div>`
    }
    <div class="card" style="display:flex;flex-direction:column;gap:10px">
      <h2>Mes données</h2>
      <p class="text-muted">
        ${ui.demo ? 'Démonstration : ces données fictives restent dans ce navigateur.' : 'Vos données sont enregistrées en base (hébergement à Paris), accessibles uniquement avec votre mot de passe et votre code de vérification.'}
      </p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-secondary" data-action="backup">Télécharger une copie de mes données</button
        ><button class="btn btn-secondary" data-action="${ui.demo ? 'demo-exit' : 'sign-out'}">
          ${ui.demo ? 'Quitter la démonstration' : 'Se déconnecter'}
        </button>
      </div>
    </div>`;
}
