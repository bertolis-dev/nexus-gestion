/**
 * Nexus Gestion — interface (lot 1).
 *
 * Design : strictement celui de Nexus RH. La feuille de style (nexus-rh.css), les polices, le logo,
 * les icônes (icons.js) et la structure HTML (#landing-root, #login-root, #app-shell > #sidebar +
 * #main-column > #topbar + #view-root) sont repris à l'identique ; gestion.css n'ajoute que les
 * éléments propres à la comptabilité (facture imprimable, lignes de facture, rapprochement).
 *
 * Toute la logique comptable vit dans core/ (testée sous Node) ; ce fichier affiche et relaie.
 * Deux modes : connecté (Supabase, app/cloud.js) ou démonstration (données fictives locales).
 */

// Erreur renvoyée par Supabase dans l'URL (lien de confirmation expiré ou déjà utilisé) : lue avant
// que supabase-js ne nettoie l'adresse, pour l'expliquer à l'utilisateur au lieu d'un échec muet.
const URL_AUTH_ERROR = (() => {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, '') || window.location.search.replace(/^\?/, ''));
  const code = params.get('error_code') || params.get('error');
  if (!code) return null;
  if (/otp_expired/.test(code)) return 'Ce lien de confirmation a expiré ou a déjà été utilisé. Demandez un nouvel e-mail ci-dessous.';
  return `Le lien n'a pas pu être validé (${params.get('error_description') || code}). Demandez un nouvel e-mail ci-dessous.`;
})();

import { Workspace, INCOME_CATEGORIES, OUTFLOW_CATEGORIES } from '../core/workspace.js';
import { EXPENSE_CATEGORIES, buildChart } from '../core/pcg.js';
import { parseFec, openingBalanceFromFec } from '../core/fecimport.js';
import { formatEuros, parseEuros } from '../core/money.js';
import { computeTotals, checkInvoice, InvoiceError, isValidSiren, isVatExempt, lineHt, VAT_RATES_BP } from '../core/invoices.js';
import { parseBankCsv, parseOfx, reconciliationStatement } from '../core/bank.js';
import { trialBalance, generalLedger, exportFEC, checkFEC, journalReport } from '../core/reports.js';
import { JOURNALS, Ledger } from '../core/ledger.js';
import { declarationPeriods, urssafDeclaration, thresholdStatus, receiptsBook, ACTIVITY_TYPES } from '../core/micro.js';
import { buildCii, checkEn16931, ciiFileName } from '../core/einvoice.js';
import { trialBalanceCsv, generalLedgerCsv, journalsCsv } from '../core/exports.js';
import { fixedAssets } from '../core/assets.js';
import { FREQUENCIES, nextDate } from '../core/recurring.js';
import { justificationRows } from '../core/vatreturn.js';
import { readIncomingInvoice, purchaseLinesFrom } from '../core/einvoice-in.js';
import { LIFECYCLE, nextStatuses } from '../core/lifecycle.js';
import { closingChecklist, incomeStatement, balanceSheet, INVENTORY_TYPES, fiscalYearLabel, allocationProposal } from '../core/closing.js';
import { ledgerStateFromRows } from '../core/sync.js';
import { toCsv } from '../core/exports.js';
import { ICONS } from './icons.js';
import * as cloud from './cloud.js';

const DEMO_KEY = 'nexus_gestion_demo_v1';
const PREFS_KEY = 'nexus_gestion_prefs';
const THEME_KEY = 'nexus_theme'; // même clé que Nexus RH : le choix de thème suit l'utilisateur d'une appli à l'autre
const CONTACT_EMAIL = 'contact@bertolis.fr';
const newId = () => crypto.randomUUID();

let ws = null;
/** Mode connecté : structure en base, file d'envoi, dernier état envoyé. */
const cloudState = { session: null, meta: null, outbox: null, synced: null, documents: [], status: { pending: 0, error: null } };
const freshOnboarding = () => ({ step: 1, data: { fyEnd: `${new Date().getFullYear()}-12-31`, chargesVat: 'oui', vatFrequency: 'mensuelle', nature: 'services', micro: 'non' } });
const ui = {
  screen: 'landing', // landing | login | app
  demo: false,
  booting: true,
  auth: { view: URL_AUTH_ERROR ? 'resend' : 'login', error: URL_AUTH_ERROR || '', info: '', busy: false, email: '' },
  mfa: null,
  mode: 'standard',
  ob: freshOnboarding(),
  draft: null,
  pendingPurchase: null,
  comptaTab: 'balance',
  salesTab: 'factures',
  expensesTab: 'depenses',
  statementBalance: '',
  faqOpen: null,
};

const today = () => new Date().toISOString().slice(0, 10);
const eur = (c) => formatEuros(c || 0);
const frDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('fr-FR') : '');
const pct = (bp) => `${(bp / 100).toLocaleString('fr-FR')} %`;

// ------------------------------------------------------------------ gabarits (échappement par défaut)

class Raw {
  constructor(s) {
    this.s = s;
  }
}
const raw = (s) => new Raw(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(fmt).join('') : v == null || v === false ? '' : esc(String(v)));
function html(strings, ...vals) {
  return raw(strings.reduce((acc, s, i) => acc + s + (i < vals.length ? fmt(vals[i]) : ''), ''));
}
const opt = (value, label, selected) => html`<option value="${value}" ${selected ? raw('selected') : ''}>${label}</option>`;
/** Même rendu que icon() de Nexus RH. */
const icon = (name, size = 16) => raw(`<span class="icon-inline" style="width:${size}px;height:${size}px;">${ICONS[name]}</span>`);
const LOGO = raw('<span class="logo-mark"><img class="logo-icon" src="logo.png" alt="Nexus"></span>');
const brand = html`${LOGO} Nexus <span class="brand-suffix">Gestion</span>`;
const badge = (text, kind = 'muted') => html`<span class="badge badge-${kind}">${text}</span>`;
function field(label, control, { id, hint } = {}) {
  return html`<div class="form-field">${label ? html`<label ${id ? raw(`for="${id}"`) : ''}>${label}</label>` : ''}${control}${hint ? html`<p class="form-hint">${hint}</p>` : ''}</div>`;
}
const viewHeader = (title, subtitle, actions) => html`<div class="view-header ${actions ? 'view-header-row' : ''}"><div><h1>${title}</h1>${subtitle ? html`<p class="view-subtitle">${subtitle}</p>` : ''}</div>${actions ? html`<div class="detail-header-actions">${actions}</div>` : ''}</div>`;

// ------------------------------------------------------------------ préférences, thème, stockage

function loadPrefs() {
  try {
    ui.mode = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}').mode || 'standard';
  } catch {}
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ mode: ui.mode }));
  } catch {}
}
function getTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || 'system';
  } catch {
    return 'system';
  }
}
function setTheme(value) {
  try {
    if (value === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, value);
  } catch {}
  if (value === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', value);
}

function loadDemo() {
  try {
    const data = JSON.parse(localStorage.getItem(DEMO_KEY) || 'null');
    if (!data) return false;
    ws = new Workspace({ company: data.company, state: data });
    ui.demo = true;
    return true;
  } catch {
    return false;
  }
}

/** Après chaque action : envoi en base (mode connecté) ou enregistrement local (démonstration). */
function save() {
  savePrefs();
  if (ui.demo) {
    try {
      localStorage.setItem(DEMO_KEY, JSON.stringify(ws.toJSON()));
    } catch {
      toast('Enregistrement local impossible (stockage plein ou bloqué).', true);
    }
    return;
  }
  const next = JSON.parse(JSON.stringify(ws));
  cloudState.outbox.push(cloudState.synced, next, cloudState.meta);
  cloudState.synced = next;
}

/** Même implémentation que showToast() de Nexus RH (empilement, apparition, retrait après 3 s). */
function toast(message, error = false) {
  const el = document.createElement('div');
  el.className = `toast toast-${error ? 'error' : 'success'}`;
  el.textContent = message;
  document.getElementById('toast-root').appendChild(el);
  setTimeout(() => el.classList.add('visible'), 10);
  setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

function download(name, content, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------------ synchronisation

function onSyncStatus(status) {
  cloudState.status = status;
  const el = document.getElementById('sync-status');
  if (el) el.outerHTML = syncStatusHtml().s;
  if (status.error) toast(`Enregistrement refusé : ${status.error}`, true);
}

function syncStatusHtml() {
  const s = cloudState.status;
  if (ui.demo) return html`<div id="sync-status" class="sync-status">Démonstration : données dans ce navigateur</div>`;
  if (s.error) {
    return html`<div id="sync-status" class="sync-status sync-error">Non enregistré : ${s.error}<br>
      <button class="btn btn-gold btn-sm" data-action="sync-retry">Réessayer</button>
      ${s.divergence ? html` <button class="btn btn-secondary btn-sm" data-action="sync-reload">Recharger depuis la base</button>` : ''}</div>`;
  }
  return html`<div id="sync-status" class="sync-status">${s.pending ? `Enregistrement… (${s.pending})` : 'Toutes les modifications sont enregistrées'}</div>`;
}

async function openStructure(structureId) {
  const { meta, state, documents } = await cloud.loadStructure(structureId);
  cloudState.meta = meta;
  cloudState.documents = documents || [];
  cloudState.role = await cloud.myRole(structureId).catch(() => null);
  cloudState.outbox = new cloud.Outbox({ key: `nexus_gestion_outbox_${structureId}`, onStatus: onSyncStatus });
  ws = new Workspace({ company: state.company, state, newId });
  cloudState.synced = JSON.parse(JSON.stringify(ws));
  if (cloudState.outbox.queue.length) {
    await cloudState.outbox.flush();
    if (!cloudState.outbox.error) return openStructure(structureId);
  }
}

/** Après connexion : double authentification, puis entreprise (ou assistant d'installation). */
async function afterSignIn() {
  const mfa = await cloud.mfaStatus();
  if (mfa.step !== 'ok') {
    ui.mfa = mfa.step === 'enroll' ? { step: 'enroll', ...(await cloud.mfaEnroll()) } : { step: 'challenge', factorId: mfa.factorId };
    ui.screen = 'login';
    return render();
  }
  ui.mfa = null;
  const structures = await cloud.listStructures();
  if (structures.length) {
    await openStructure(structures[0].id);
    ui.screen = 'app';
    if (!location.hash.startsWith('#/')) location.hash = '#/accueil';
  } else {
    ws = null;
    ui.screen = 'login'; // l'assistant s'affiche dans le même cadre que la connexion
  }
  render();
}

// ------------------------------------------------------------------ données publiques entreprise

const vatNumberFromSiren = (siren) => `FR${String((12 + 3 * (Number(siren) % 97)) % 97).padStart(2, '0')}${siren}`;
const LEGAL_FORMS = { 1000: 'EI', 5498: 'EURL', 5499: 'SARL', 5710: 'SAS', 5720: 'SASU' };

/** API Recherche d'entreprises (État, gratuite, sans clé) — §3.1 étape 1. */
async function lookupSiren(siren) {
  const r = await fetch(`https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(siren)}&page=1&per_page=1`);
  if (!r.ok) throw new Error(`Service indisponible (${r.status})`);
  const res = (await r.json()).results?.[0];
  if (!res || res.siren !== siren) throw new Error('Aucune entreprise trouvée pour ce SIREN');
  return {
    // L'API ajoute le sigle entre parenthèses, même quand il répète le nom (« QONTO (QONTO) »).
    name: res.nom_complet.replace(/\s*\(([^)]*)\)$/, (m, sigle) => (res.nom_complet.startsWith(sigle) ? '' : m)),
    address: res.siege?.adresse || '',
    legalForm: LEGAL_FORMS[res.nature_juridique] || (String(res.nature_juridique).startsWith('1') ? 'EI' : 'SAS'),
  };
}

// ------------------------------------------------------------------ rendu général

const $ = (id) => document.getElementById(id);

function show(rootId) {
  $('landing-root').style.display = rootId === 'landing-root' ? 'block' : 'none';
  $('login-root').style.display = rootId === 'login-root' ? 'flex' : 'none';
  $('app-shell').style.display = rootId === 'app-shell' ? 'flex' : 'none';
}

function render() {
  if (ui.booting) {
    show('login-root');
    $('login-root').innerHTML = html`<div class="login-card"><div class="login-logo">${brand}</div><p class="text-muted">Chargement…</p></div>`.s;
    return;
  }
  if (ui.auth.view === 'new-password' && cloudState.session) {
    show('login-root');
    $('login-root').innerHTML = viewAuth().s;
    return;
  }
  if (ws && (ui.demo || cloudState.session) && !ui.mfa) {
    ui.screen = 'app';
    show('app-shell');
    return renderApp();
  }
  if (cloudState.session) {
    show('login-root');
    $('login-root').innerHTML = (ui.mfa ? viewMfa() : viewOnboarding()).s;
    return;
  }
  if (ui.screen === 'login') {
    show('login-root');
    $('login-root').innerHTML = viewAuth().s;
    return;
  }
  show('landing-root');
  $('landing-root').innerHTML = viewLanding().s;
}

// ------------------------------------------------------------------ site public (même gabarit que Nexus RH)

const LANDING_FEATURES = [
  { icon: 'receipt', title: 'Factures conformes 2026-2027', text: 'SIREN du client, nature des opérations, mentions obligatoires : la facture est bloquée tant qu’elle n’est pas conforme, avec la liste de ce qu’il manque.' },
  { icon: 'card', title: 'Banque rapprochée automatiquement', text: 'Importez votre relevé : chaque virement est associé à sa facture (montant, numéro, nom du client), les paiements groupés et partiels compris.' },
  { icon: 'paperclip', title: 'Dépenses en une catégorie', text: '« Carburant », « Loyer », « Logiciel » : vous choisissez la catégorie, Nexus applique les bonnes règles de TVA et repère les doublons.' },
  { icon: 'percent', title: 'TVA préparée pour vous', text: 'Collectée, déductible, à payer : chaque mois, le montant est prêt et justifié facture par facture, TVA sur encaissements comprise.' },
  { icon: 'scale', title: 'Micro-entrepreneur', text: 'Livre des recettes, montant à déclarer à l’URSSAF chaque trimestre et alerte avant de dépasser les seuils de TVA.' },
  { icon: 'bell', title: 'Relances clients', text: 'Les factures en retard remontent dans votre liste « À faire » avec un e-mail de relance déjà rédigé.' },
  { icon: 'chart', title: 'Comptabilité complète et FEC', text: 'Balance, grand livre, journaux et fichier FEC pour votre expert-comptable, sans ressaisie. La partie double tourne en arrière-plan.' },
  { icon: 'shield', title: 'Sécurité bancaire', text: 'Double authentification obligatoire, données hébergées à Paris, écritures validées infalsifiables et journal d’audit.' },
];

/** Installeur Windows : toujours la dernière version publiée (voir desktop/ et scripts/deploy.mjs). */
const DESKTOP_APP_DOWNLOAD_URL = 'https://github.com/bertolis-dev/nexus-gestion/releases/latest/download/Nexus-Gestion-Setup.exe';

const LANDING_FAQ = [
  { q: 'Faut-il connaître la comptabilité ?', a: 'Non. Vous créez des factures, ajoutez vos dépenses et associez vos virements ; Nexus passe les écritures comptables pour vous. Les termes comptables n’apparaissent qu’en mode avancé, pour votre expert-comptable.' },
  { q: 'Suis-je prêt pour la facturation électronique ?', a: 'Vos factures portent déjà les mentions obligatoires de septembre 2027 (SIREN du client, nature des opérations). La transmission par plateforme agréée arrive avec la prochaine version, avant l’échéance.' },
  { q: 'Mes données sont-elles en sécurité ?', a: 'Elles sont hébergées à Paris, isolées par entreprise, et accessibles uniquement avec votre mot de passe et un code à usage unique sur votre téléphone.' },
  { q: 'Mon expert-comptable peut-il travailler dessus ?', a: 'Oui : il retrouve la balance, le grand livre, les journaux et un export FEC conforme, sans rien ressaisir.' },
  { q: 'Puis-je importer mon relevé bancaire ?', a: 'Oui, aux formats CSV et OFX proposés par toutes les banques. Un relevé importé deux fois ne crée aucun doublon.' },
];

function detectDevicePlatform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

function viewLanding() {
  const platform = detectDevicePlatform();
  const platformCard = (key, iconName, title, sub, content) => html`
    <div class="card landing-platform-card ${platform === key ? 'landing-platform-card-active' : ''}">
      ${platform === key ? html`<div class="landing-platform-badge">Votre appareil</div>` : ''}
      <div class="landing-platform-icon">${raw(ICONS[iconName])}</div>
      <h3>${title}</h3><p class="text-muted">${sub}</p>${content}
    </div>`;
  const steps = (list) => html`<ol class="landing-steps">${list.map((s, i) => html`<li><span class="landing-step-num">${i + 1}</span><span class="landing-step-text">${raw(s)}</span></li>`)}</ol>`;
  const plan = (name, price, detail, items, tag) => html`
    <div class="landing-step-card">
      ${tag ? html`<span class="badge landing-badge-gold">${tag}</span>` : ''}
      <h3>${name}</h3>
      <strong class="landing-gradient-number" style="font-size:30px">${price}</strong>
      <p class="text-muted">${detail}</p>
      <ul style="padding-left:18px;margin:6px 0 0;font-size:14px;line-height:1.7">${items.map((i) => html`<li>${i}</li>`)}</ul>
    </div>`;
  return html`
    <div class="landing-page">
      <header class="landing-topbar">
        <div class="landing-topbar-left">
          <div class="landing-brand">${brand}</div>
          <div class="landing-nav-menu">
            <button type="button" class="btn btn-secondary btn-sm landing-nav-menu-trigger" data-action="landing-menu" aria-haspopup="true" aria-expanded="false" aria-label="Menu">${raw(ICONS.menu)}</button>
            <nav class="landing-nav-links" id="landing-nav-links">
              <button type="button" class="landing-nav-link" data-goto="landing-fonctionnalites">Fonctionnalités</button>
              <button type="button" class="landing-nav-link" data-goto="landing-tarifs">Tarifs</button>
              <button type="button" class="landing-nav-link" data-goto="landing-installer">Installer</button>
              <button type="button" class="landing-nav-link" data-goto="landing-faq">Questions</button>
            </nav>
          </div>
        </div>
        <nav class="landing-topbar-nav">
          <button type="button" class="btn btn-secondary" data-action="goto-login">Se connecter</button>
          <button type="button" class="btn btn-gold landing-topbar-cta btn-arrow-cta" data-action="goto-signup"><span class="landing-topbar-cta-full">Créer mon entreprise</span><span class="landing-topbar-cta-short">S'inscrire</span> <span class="btn-arrow">→</span></button>
        </nav>
      </header>

      <section class="landing-hero">
        <div class="landing-hero-inner">
          <div class="landing-hero-text">
            <span class="badge landing-badge-gold">Nouveau · Prêt pour la facture électronique</span>
            <h1>La comptabilité de votre TPE, de la facture au bilan, sans jargon</h1>
            <p>Nexus Gestion tient votre comptabilité à votre place : vous facturez, vous ajoutez vos dépenses, vous associez vos virements. Les écritures, la TVA et le FEC se font tout seuls.</p>
            <div class="landing-hero-cta">
              <button type="button" class="btn btn-gold btn-arrow-cta" data-action="goto-signup">Créer mon entreprise <span class="btn-arrow">→</span></button>
              <button type="button" class="btn btn-ghost-light" data-action="demo">Voir la démonstration</button>
            </div>
            <div class="landing-trust-row">
              <span>${icon('lock', 14)} Double authentification obligatoire</span>
              <span>${icon('shield', 14)} Accès isolé par entreprise</span>
              <span>${icon('checkCircle', 14)} Export FEC conforme</span>
              <span>${icon('globe', 14)} Données hébergées à Paris · Conforme RGPD</span>
            </div>
          </div>
          <div class="landing-hero-mock" aria-hidden="true">
            <img class="landing-hero-screenshot" src="landing-screenshot.png" alt="Tableau de bord Nexus Gestion : trésorerie, créances clients, liste À faire" width="1280" height="760" loading="eager">
          </div>
        </div>
      </section>

      <section class="landing-stats-band">
        <div class="landing-stat-tile"><strong class="landing-gradient-number">0 €</strong><span>Pour les micro-entrepreneurs : facturation, livre des recettes et URSSAF</span></div>
        <div class="landing-stat-tile"><strong class="landing-gradient-number">2 min</strong><span>Pour créer et envoyer une facture conforme, paramétrage compris</span></div>
        <div class="landing-stat-tile"><strong class="landing-gradient-number">0</strong><span>Numéro de compte comptable à connaître : vous choisissez une catégorie en français</span></div>
        <div class="landing-stat-tile"><strong class="landing-gradient-number">100%</strong><span>Des écritures générées automatiquement à partir de vos factures et de votre banque</span></div>
      </section>

      <section class="landing-section" id="landing-fonctionnalites">
        <div class="landing-section-head">
          <h2>Tout ce qu'il faut, rien de superflu</h2>
          <p>Pensé pour les dirigeants qui ne sont pas comptables : chaque écran parle votre langue, pas celle du plan comptable.</p>
        </div>
        <div class="landing-features-grid">
          ${LANDING_FEATURES.map((f) => html`<div class="card landing-feature-card"><div class="landing-feature-icon">${raw(ICONS[f.icon])}</div><h3>${f.title}</h3><p>${f.text}</p></div>`)}
        </div>
      </section>

      <section class="landing-section landing-section-alt" id="landing-comment">
        <div class="landing-section-head"><h2>Comment ça marche</h2></div>
        <div class="landing-steps-grid">
          <div class="landing-step-card"><div class="landing-step-badge">1</div><h3>Saisissez votre SIREN</h3><p class="text-muted">Nom, adresse et forme juridique sont remplis automatiquement. Quatre questions simples suffisent à régler votre régime.</p></div>
          <div class="landing-step-card"><div class="landing-step-badge">2</div><h3>Ajoutez votre banque</h3><p class="text-muted">Importez votre relevé : Nexus associe chaque mouvement à la bonne facture ou vous propose une catégorie.</p></div>
          <div class="landing-step-card"><div class="landing-step-badge">3</div><h3>C'est tenu</h3><p class="text-muted">Factures, TVA, balance et FEC sont à jour en permanence. Votre liste « À faire » vous dit quoi faire et quand.</p></div>
        </div>
      </section>

      <section class="landing-section" id="landing-tarifs">
        <div class="landing-section-head"><h2>Des formules simples</h2><p>Prix affichés en clair, sans engagement. Les tarifs des formules société seront publiés à l'ouverture.</p></div>
        <div class="landing-steps-grid">
          ${plan('Micro-entrepreneur', '0 €', 'Pour facturer et suivre votre activité', ['Factures et avoirs conformes', 'Livre des recettes et registre des achats', 'Montant URSSAF par trimestre', 'Alerte seuils de TVA'])}
          ${plan('Société', 'Bientôt', 'EURL à l’IR ou à l’IS', ['Tout Micro-entrepreneur', 'Rapprochement bancaire et lettrage', 'TVA préparée (CA3 / CA12)', 'Balance, grand livre, FEC'], 'Ouverture prochaine')}
          ${plan('Société + clôture', 'Bientôt', 'Jusqu’au bilan', ['Tout Société', 'Écritures d’inventaire assistées', 'Bilan et compte de résultat', 'Liasse fiscale'], 'En préparation')}
        </div>
        <div class="landing-compare-table-wrap">
          <table class="landing-compare-table">
            <thead><tr><th></th><th>Nexus Gestion</th><th>La plupart des logiciels du marché</th></tr></thead>
            <tbody>
              <tr><td>Vocabulaire</td><td>« Ce que mes clients me doivent », « Dépense », « Recette »</td><td>Comptes 411, 401, lettrage</td></tr>
              <tr><td>Banque</td><td>Toutes les banques, par import de relevé</td><td>Souvent liée à une seule banque</td></tr>
              <tr><td>Sécurité</td><td>Double authentification obligatoire</td><td>Souvent en option</td></tr>
              <tr><td>Avec Nexus RH</td><td>Même compte, même interface</td><td>Deux outils séparés</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="landing-section" id="landing-faq">
        <div class="landing-section-head"><h2>Questions fréquentes</h2></div>
        <div class="landing-faq-list">
          ${LANDING_FAQ.map((item, i) => html`
            <div class="landing-faq-item ${ui.faqOpen === i ? 'landing-faq-item-open' : ''}">
              <button type="button" class="landing-faq-question" data-action="faq" data-index="${i}"><span>${item.q}</span><span class="landing-faq-chevron">⌄</span></button>
              <div class="landing-faq-answer"><p>${item.a}</p></div>
            </div>`)}
        </div>
      </section>

      <section class="landing-section landing-install-section" id="landing-installer">
        <div class="landing-section-head">
          <h2>Installez Nexus Gestion en 1 minute</h2>
          <p>Une icône sur votre bureau ou votre écran d'accueil, ouverture instantanée, comme une vraie application. Gratuit, sans magasin d'applications.</p>
        </div>
        <div class="landing-install-grid">
          ${platformCard('desktop', 'desktop', 'Ordinateur', 'Windows, via Chrome ou Edge', html`
            <a class="btn btn-gold" href="${DESKTOP_APP_DOWNLOAD_URL}">${icon('desktop', 14)} Télécharger (.exe)</a>
            <p class="landing-platform-note">Windows peut afficher « Windows a protégé votre PC » (pas de certificat payant) : cliquez « Informations complémentaires » puis « Exécuter quand même ».</p>
            <button type="button" class="btn-link" data-action="install" style="margin-top:6px">Ou installer depuis le navigateur</button>`)}
          ${platformCard('ios', 'mobile', 'iPhone & iPad', 'Via Safari (obligatoire)', steps(['Ouvrez ce site dans <strong>Safari</strong>', 'Appuyez sur <strong>Partager</strong>, en bas de l’écran', 'Choisissez <strong>« Sur l’écran d’accueil »</strong>, puis « Ajouter »']))}
          ${platformCard('android', 'mobile', 'Android', 'Via Chrome', html`
            ${platform === 'android' ? html`<button type="button" class="btn btn-gold" data-action="install">${icon('mobileAlert', 14)} Installer Nexus Gestion</button>` : ''}
            ${steps(['Ouvrez ce site dans <strong>Chrome</strong>', 'Appuyez sur <strong>⋮</strong>, en haut à droite', 'Choisissez <strong>« Installer l’application »</strong>'])}`)}
        </div>
      </section>

      <section class="landing-cta-banner">
        <h2>Prêt à ne plus vous soucier de votre comptabilité ?</h2>
        <p>Créez votre entreprise en quelques minutes, aucune carte bancaire requise.</p>
        <div class="landing-cta-banner-actions">
          <button type="button" class="btn btn-gold btn-arrow-cta" data-action="goto-signup">Créer mon entreprise <span class="btn-arrow">→</span></button>
          <button type="button" class="btn btn-ghost-light" data-action="goto-login">Se connecter</button>
        </div>
      </section>

      <footer class="landing-footer">
        <div class="landing-footer-top">
          <div class="landing-brand">${brand}</div>
          <nav class="landing-footer-links">
            <button type="button" class="btn-link" data-action="goto-login">Se connecter</button>
            <button type="button" class="btn-link" data-action="goto-signup">Créer mon entreprise</button>
            <button type="button" class="btn-link" data-action="demo">Démonstration</button>
          </nav>
        </div>
        <p class="landing-footer-bottom">© ${new Date().getFullYear()} BERTOLIS · Nexus Gestion · <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
      </footer>
    </div>`;
}

// ------------------------------------------------------------------ connexion (même carte que Nexus RH)

function viewAuth() {
  const a = ui.auth;
  const err = a.error ? html`<p class="login-error" role="alert">${a.error}</p>` : '';
  const info = a.info ? html`<p class="text-muted">${a.info}</p>` : '';
  const busy = a.busy ? raw('disabled') : '';
  const emailField = (autocomplete = 'username') => field('Email', html`<input class="input" type="email" id="f-email" name="email" required autocomplete="${autocomplete}" value="${a.email || ''}">`, { id: 'f-email' });
  const passwordField = (label, autocomplete) => field(label, html`<div class="password-input-wrapper"><input class="input" type="password" id="f-password" name="password" required minlength="${autocomplete === 'new-password' ? 8 : 1}" autocomplete="${autocomplete}"><button type="button" class="btn-icon password-toggle" data-action="toggle-password" tabindex="-1" aria-label="Afficher le mot de passe">${icon('eye', 14)}</button></div>`, { id: 'f-password' });
  const link = (view, label) => html`<button type="button" class="btn-link" data-action="auth-view" data-view="${view}">${label}</button>`;
  let body;
  if (a.view === 'signup') {
    body = html`<h1>Créer mon entreprise</h1>
      <p class="text-muted">Créez votre accès, puis laissez-vous guider : votre SIREN suffit pour démarrer.</p>
      <form data-form="signup">${emailField()}${passwordField('Mot de passe', 'new-password')}
        <p class="form-hint">8 caractères minimum. Un code sur votre téléphone vous sera aussi demandé à chaque connexion.</p>
        ${err}${info}<button type="submit" class="btn btn-primary" style="width:100%" ${busy}>${a.busy ? 'Création…' : 'Créer mon compte'}</button></form>
      ${link('login', 'J’ai déjà un compte')}`;
  } else if (a.view === 'forgot') {
    body = html`<h1>Mot de passe oublié</h1>
      <form data-form="forgot">${emailField()}${err}${info}<button type="submit" class="btn btn-primary" style="width:100%" ${busy}>Recevoir un lien de réinitialisation</button></form>
      ${link('login', 'Retour à la connexion')}`;
  } else if (a.view === 'resend') {
    body = html`<h1>Email de confirmation</h1>
      <p class="text-muted">Saisissez l'adresse utilisée à l'inscription : nous vous renvoyons un lien de confirmation.</p>
      <form data-form="resend">${emailField()}${err}${info}<button type="submit" class="btn btn-primary" style="width:100%" ${busy}>Renvoyer l'email de confirmation</button></form>
      ${link('login', 'Retour à la connexion')}`;
  } else if (a.view === 'new-password') {
    body = html`<h1>Nouveau mot de passe</h1>
      <form data-form="new-password">${passwordField('Nouveau mot de passe', 'new-password')}${err}<button type="submit" class="btn btn-primary" style="width:100%" ${busy}>Enregistrer</button></form>`;
  } else {
    body = html`<h1>Connexion</h1>
      <form data-form="login">${emailField()}${passwordField('Mot de passe', 'current-password')}${err}${info}
        <button type="submit" class="btn btn-primary" style="width:100%" ${busy}>${a.busy ? 'Connexion…' : 'Se connecter'}</button></form>
      ${link('forgot', 'Mot de passe oublié ?')}
      ${link('signup', 'Créer mon entreprise')}
      ${link('resend', "Vous n'avez pas reçu l'email de confirmation ?")}
      <button type="button" class="btn-link" data-action="demo">Voir la démonstration</button>
      <button type="button" class="btn-link" data-action="goto-landing">← Accueil</button>`;
  }
  return html`<div class="login-card"><div class="login-logo">${brand}</div>${body}</div>`;
}

function viewMfa() {
  const m = ui.mfa;
  const err = m.error ? html`<p class="login-error" role="alert">${m.error}</p>` : '';
  const form = html`<form data-form="mfa">
      ${field('Code à 6 chiffres', html`<input class="input" id="f-mfa" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required autofocus>`, { id: 'f-mfa' })}
      ${err}<button type="submit" class="btn btn-primary" style="width:100%" ${m.busy ? raw('disabled') : ''}>Valider</button></form>
    <button type="button" class="btn-link" data-action="sign-out">Se déconnecter</button>`;
  const body = m.step === 'enroll'
    ? html`<h1>Protégez votre comptabilité</h1>
        <p class="text-muted">La double authentification est obligatoire : sans votre téléphone, personne ne peut ouvrir vos comptes, même avec votre mot de passe.</p>
        <ol class="landing-steps">
          <li><span class="landing-step-num">1</span><span class="landing-step-text">Installez <strong>Google Authenticator</strong> ou <strong>Microsoft Authenticator</strong></span></li>
          <li><span class="landing-step-num">2</span><span class="landing-step-text">Scannez ce code avec l'application</span></li>
          <li><span class="landing-step-num">3</span><span class="landing-step-text">Saisissez le code à 6 chiffres affiché</span></li>
        </ol>
        <img class="mfa-qr" src="${m.qrCode}" alt="QR code à scanner avec votre application d'authentification" width="190" height="190">
        <p class="form-hint">Impossible de scanner ? Saisissez cette clé : <span class="mono">${m.secret}</span></p>${form}`
    : html`<h1>Code de vérification</h1><p class="text-muted">Saisissez le code à 6 chiffres affiché par votre application d'authentification.</p>${form}`;
  return html`<div class="login-card"><div class="login-logo">${brand}</div>${body}</div>`;
}

// ------------------------------------------------------------------ assistant d'installation (§3.1)

function viewOnboarding() {
  const { step, data, error, loading } = ui.ob;
  const choice = (key, value, label) => html`<label class="choice-card"><input type="radio" name="${key}" data-ob="${key}" value="${value}" ${data[key] === value ? raw('checked') : ''}>${label}</label>`;
  const nav = (next = 'Continuer') => html`<div style="display:flex;gap:8px;margin-top:6px">
    ${step > 1 ? html`<button type="button" class="btn btn-secondary" data-action="ob-back">Retour</button>` : ''}
    <button type="button" class="btn btn-primary" style="flex:1" data-action="ob-next" ${loading ? raw('disabled') : ''}>${loading ? 'Un instant…' : next}</button></div>`;
  const errBox = error ? html`<p class="login-error" role="alert">${error}</p>` : '';
  let body;
  if (step === 1) {
    body = html`<h1>Votre entreprise</h1>
      <p class="text-muted">Saisissez votre SIREN : nous récupérons le nom, l'adresse et la forme juridique.</p>
      <div class="form-field"><label for="ob-siren">SIREN (9 chiffres)</label>
        <div style="display:flex;gap:8px"><input class="input" id="ob-siren" data-ob="siren" inputmode="numeric" maxlength="11" value="${data.siren || ''}" placeholder="123 456 789">
        <button type="button" class="btn btn-secondary" data-action="ob-lookup" ${loading ? raw('disabled') : ''}>${loading ? 'Recherche…' : 'Rechercher'}</button></div></div>
      ${field("Nom de l'entreprise", html`<input class="input" id="ob-name" data-ob="name" value="${data.name || ''}">`, { id: 'ob-name' })}
      ${field('Forme juridique', html`<select class="input" id="ob-form" data-ob="legalForm">${['EI', 'EURL', 'SARL', 'SAS', 'SASU'].map((f) => opt(f, f === 'EI' ? 'Entreprise individuelle (EI, micro)' : f, data.legalForm === f))}</select>`, { id: 'ob-form' })}
      ${field('Adresse', html`<input class="input" id="ob-address" data-ob="address" value="${data.address || ''}">`, { id: 'ob-address' })}
      ${errBox}${nav()}`;
  } else if (step === 2) {
    body = html`<h1>Quelques questions simples</h1>
      <p class="text-muted">Vos réponses suffisent à déterminer votre régime et votre plan comptable.</p>
      ${data.legalForm === 'EI' ? field('Êtes-vous micro-entrepreneur (auto-entrepreneur) ?', html`<div class="choice-cards">${choice('micro', 'oui', 'Oui')}${choice('micro', 'non', 'Non, au régime réel')}</div>`) : ''}
      ${field('Facturez-vous la TVA à vos clients ?', html`<div class="choice-cards">${choice('chargesVat', 'oui', 'Oui')}${choice('chargesVat', 'non', 'Non (franchise en base)')}</div>`, { hint: 'Si vos factures portent la mention « TVA non applicable, art. 293 B du CGI », répondez non.' })}
      ${data.chargesVat === 'oui' ? field('Déclarez-vous la TVA chaque mois ou une fois par an ?', html`<div class="choice-cards">${choice('vatFrequency', 'mensuelle', 'Chaque mois (CA3)')}${choice('vatFrequency', 'annuelle', 'Une fois par an (CA12)')}</div>`) : ''}
      ${field('Vendez-vous des biens, des services ou les deux ?', html`<div class="choice-cards">${choice('nature', 'biens', 'Des biens')}${choice('nature', 'services', 'Des services')}${choice('nature', 'mixte', 'Les deux')}</div>`)}
      ${field('Date de fin de votre exercice comptable', html`<input class="input" id="ob-fy" type="date" data-ob="fyEnd" value="${data.fyEnd}" style="max-width:220px">`, { id: 'ob-fy', hint: 'Le plus souvent le 31 décembre.' })}
      ${errBox}${nav()}`;
  } else if (step === 3) {
    body = html`<h1>Votre banque</h1>
      <p class="text-muted">Vos transactions alimentent le rapprochement automatique avec vos factures.</p>
      <div class="notice-gold"><strong>Connexion automatique (Qonto, Shine, autres banques)</strong> : disponible dès l'ouverture des accès partenaires. En attendant, importez le relevé CSV ou OFX de votre banque.</div>
      ${field('Relevé bancaire (facultatif)', html`<input class="input" id="ob-bank" type="file" accept=".csv,.ofx,.qfx,.txt" data-action="ob-bank-file">`, { id: 'ob-bank' })}
      ${data.bankFileName ? html`<p class="text-muted">Relevé prêt : <strong>${data.bankFileName}</strong> (${data.bankTx.length} transactions)</p>` : ''}
      ${errBox}${nav()}`;
  } else if (step === 4) {
    body = html`<h1>Facturation électronique</h1>
      <p class="text-muted">Depuis le 1er septembre 2026, toute entreprise doit pouvoir <strong>recevoir</strong> ses factures électroniques via une plateforme agréée. L'émission devient obligatoire pour les TPE le 1er septembre 2027.</p>
      <div class="notice-gold">Nexus Gestion sera raccordé à une plateforme agréée partenaire. Vous pourrez alors vous inscrire à l'annuaire en un clic. Rien à faire aujourd'hui : vos factures sont déjà conformes.</div>
      ${nav()}`;
  } else {
    const fec = data.start === 'fec';
    body = html`<h1>Reprise de votre historique</h1>
      <div class="choice-cards">
        <label class="choice-card"><input type="radio" name="start" data-ob="start" value="zero" ${fec ? '' : raw('checked')}>Je démarre à zéro</label>
        <label class="choice-card"><input type="radio" name="start" data-ob="start" value="fec" ${fec ? raw('checked') : ''}>Reprendre le FEC de l'an dernier</label>
      </div>
      ${fec
        ? html`${field('Fichier des écritures comptables (FEC)', html`<input class="input" id="ob-fec" type="file" accept=".txt,.csv" data-action="ob-fec-file">`, { id: 'ob-fec', hint: 'Demandez-le à votre expert-comptable ou exportez-le de votre ancien logiciel.' })}
          ${data.opening ? openingPreview(data.opening, data.fecFileName) : ''}`
        : field('Solde actuel de votre compte bancaire', html`<input class="input" id="ob-cash" data-ob="openingCash" inputmode="decimal" placeholder="0,00" value="${data.openingCash || ''}" style="max-width:220px">`, { id: 'ob-cash', hint: "Repris comme solde d'ouverture, modifiable ensuite par votre expert-comptable." })}
      ${errBox}${nav('Terminer et ouvrir mon espace')}`;
  }
  return html`<div class="login-card onboarding-card"><div class="login-logo">${brand}</div>
    <div class="onboarding-steps" aria-label="Étape ${step} sur 5">${[1, 2, 3, 4, 5].map((i) => html`<span class="${i <= step ? 'done' : ''}"></span>`)}</div>
    ${body}<button type="button" class="btn-link" data-action="sign-out">Se déconnecter</button></div>`;
}

/** Accès partagés : expert-comptable et collaborateurs (mode connecté uniquement). */
function membersCard() {
  if (ui.demo) return '';
  if (!ui.members && cloudState.meta) {
    cloud.listMembers(cloudState.meta.structureId).then((m) => { ui.members = m; render(); }).catch(() => { ui.members = []; });
  }
  const roleLabel = { dirigeant: 'Dirigeant', expert: 'Expert-comptable', collaborateur: 'Collaborateur' };
  return html`<div class="card" style="display:flex;flex-direction:column;gap:10px">
    <h2>Mon expert-comptable et mon équipe</h2>
    <p class="text-muted">Votre expert-comptable voit toute la comptabilité, passe les écritures d'inventaire et valide la clôture ; un collaborateur saisit dépenses et justificatifs sans rien valider.</p>
    ${(ui.members || []).length ? html`<table class="table"><tbody>${ui.members.map((m) => html`<tr><td>${m.email || '—'}</td><td>${badge(roleLabel[m.role] || m.role, m.role === 'expert' ? 'primary' : 'muted')}</td></tr>`)}</tbody></table>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
      ${field('Adresse e-mail', html`<input class="input" type="email" data-invite-email placeholder="expert@cabinet.fr">`)}
      ${field('Rôle', html`<select class="input" data-invite-role>${opt('expert', 'Expert-comptable', true)}${opt('collaborateur', 'Collaborateur')}</select>`)}
      <button class="btn btn-primary" data-action="invite-member" style="margin-bottom:2px">Donner accès</button>
    </div>
    <p class="form-hint">La personne doit d'abord créer son compte Nexus Gestion avec cette adresse.</p>
  </div>`;
}

/** Aperçu d'une reprise de FEC, à valider avant import (§3.1 étape 5). */
function openingPreview(opening, fileName) {
  const unmapped = opening.mapping.filter((m) => m.unmapped);
  const approx = opening.mapping.filter((m) => !m.exact && !m.unmapped);
  const cash = opening.lines.filter((l) => l.account.startsWith('512')).reduce((s, l) => s + l.debit - l.credit, 0);
  const receivable = opening.clients.reduce((s, c) => s + c.balance, 0);
  return html`<div class="card" style="box-shadow:none;border:1px solid var(--color-border);display:flex;flex-direction:column;gap:8px">
    <strong>${fileName || 'FEC'} : ${opening.balanced ? 'prêt à être repris' : 'déséquilibré, impossible à reprendre'}</strong>
    <table class="table"><tbody>
      <tr><td>Résultat de l'exercice précédent</td><td class="num">${eur(opening.result)}</td></tr>
      <tr><td>Trésorerie à l'ouverture</td><td class="num">${eur(cash)}</td></tr>
      <tr><td>Ce que les clients doivent encore</td><td class="num">${eur(receivable)}</td></tr>
      <tr><td>Clients repris</td><td class="num">${opening.clients.length}</td></tr>
      <tr><td>Comptes de bilan repris</td><td class="num">${opening.lines.length}</td></tr>
    </tbody></table>
    ${approx.length ? html`<p class="form-hint">${approx.length} compte(s) rattaché(s) au compte Nexus le plus proche (ex. ${approx[0].source} → ${approx[0].account}).</p>` : ''}
    ${unmapped.length ? html`<div class="notice-gold">${unmapped.length} compte(s) sans équivalent placé(s) en « à classer » (471) : ${unmapped.map((m) => `${m.source} ${m.label}`).join(', ')}. Votre expert-comptable pourra les reclasser.</div>` : ''}
  </div>`;
}

async function readOpeningFile(file) {
  const opening = openingBalanceFromFec(parseFec(await file.text()), ws?.chart || buildChart());
  if (!opening.balanced) throw new Error('Ce FEC n’est pas équilibré : impossible de constituer le bilan d’ouverture.');
  return opening;
}

function fiscalYearFromEnd(end) {
  const [y, m, d] = end.split('-').map(Number);
  return { start: new Date(Date.UTC(y - 1, m - 1, d + 1)).toISOString().slice(0, 10), end };
}

async function finishOnboarding() {
  if (ui.ob.loading) return;
  const d = ui.ob.data;
  const siren = (d.siren || '').replace(/\s/g, '');
  const micro = d.legalForm === 'EI' && d.micro === 'oui';
  const vatRegime = d.chargesVat === 'non' ? 'franchise' : d.vatFrequency === 'annuelle' ? 'reel-simplifie' : 'reel-normal';
  const company = {
    name: d.name.trim(),
    siren,
    address: d.address.trim(),
    legalForm: d.legalForm,
    capital: '',
    vatRegime,
    vatNumber: vatRegime === 'franchise' ? '' : vatNumberFromSiren(siren),
    vatOnDebits: false,
    taxRegime: micro ? (d.nature === 'biens' ? 'micro-bic' : 'micro-bnc') : d.legalForm === 'EI' ? 'ir-reel' : 'is-reel',
    microActivity: d.nature === 'biens' ? 'bic-vente' : 'bnc',
    defaultNature: d.nature === 'biens' ? 'biens' : 'services',
    fiscalYear: fiscalYearFromEnd(d.fyEnd),
    paymentTermsDays: 30,
  };
  ui.ob.loading = true;
  render();
  try {
    const created = await cloud.createStructure(company);
    cloudState.meta = { structureId: created.structure_id, fiscalYearId: created.fiscal_year_id, bankAccountId: created.bank_account_id };
    cloudState.outbox = new cloud.Outbox({ key: `nexus_gestion_outbox_${created.structure_id}`, onStatus: onSyncStatus });
    cloudState.synced = null;
  } catch (e) {
    ui.ob.loading = false;
    ui.ob.error = `Création impossible : ${cloud.friendly(e)}`;
    return render();
  }
  ui.ob.loading = false;
  ws = new Workspace({ company, newId });
  const opening = d.start !== 'fec' && d.openingCash ? parseEuros(d.openingCash) : 0;
  if (d.start === 'fec' && d.opening) ws.importOpening(d.opening);
  if (opening > 0) {
    ws.ledger.addDraft({ journal: 'AN', date: company.fiscalYear.start > today() ? company.fiscalYear.start : today(), label: "Solde bancaire à l'ouverture", lines: [
      { account: '512000', debit: opening },
      { account: company.legalForm === 'EI' ? '108000' : '455000', credit: opening },
    ] });
  }
  if (d.bankTx?.length) ws.importTransactions(d.bankTx);
  save();
  location.hash = '#/accueil';
  render();
  toast('Votre espace est prêt.');
}

async function onboardingAction(action) {
  const ob = ui.ob;
  if (action === 'ob-lookup') {
    const siren = (ob.data.siren || '').replace(/\s/g, '');
    if (!isValidSiren(siren)) {
      ob.error = 'Ce SIREN ne semble pas valide : vérifiez les 9 chiffres.';
      return render();
    }
    Object.assign(ob, { loading: true, error: '' });
    render();
    try {
      Object.assign(ob.data, await lookupSiren(siren), { siren });
    } catch (e) {
      ob.error = `${e.message}. Vous pouvez compléter les champs vous-même.`;
    }
    ob.loading = false;
    return render();
  }
  if (action === 'ob-back') {
    ob.step--;
    ob.error = '';
    return render();
  }
  if (action === 'ob-next') {
    ob.error = '';
    if (ob.step === 1) {
      const siren = (ob.data.siren || '').replace(/\s/g, '');
      if (!isValidSiren(siren)) ob.error = 'Le SIREN est obligatoire (9 chiffres) : il figure sur toutes vos factures.';
      else if (!ob.data.name?.trim() || !ob.data.address?.trim()) ob.error = "Le nom et l'adresse de l'entreprise sont obligatoires.";
      if (ob.error) return render();
    }
    if (ob.step === 5) {
      if (ob.data.start === 'fec' && !ob.data.opening) {
        ob.error = 'Choisissez le fichier FEC à reprendre, ou démarrez à zéro.';
        return render();
      }
      try {
        if (ob.data.openingCash) parseEuros(ob.data.openingCash);
      } catch {
        ob.error = 'Le solde saisi n’est pas un montant valide (exemple : 1 250,00).';
        return render();
      }
      return finishOnboarding();
    }
    ob.step++;
    return render();
  }
}

// ------------------------------------------------------------------ application (cadre Nexus RH)

const routes = {
  accueil: viewHome,
  ventes: viewSales,
  depenses: viewExpenses,
  banque: viewBank,
  tva: viewVat,
  urssaf: viewUrssaf,
  compta: viewCompta,
  cloture: viewClosing,
  parametres: viewSettings,
};

function route() {
  const [name = 'accueil', arg] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: routes[name] ? name : 'accueil', arg };
}

const isMicro = () => ws.company.taxRegime?.startsWith('micro');

function navItems() {
  const items = [
    { key: 'accueil', label: 'Accueil', icon: 'home' },
    { key: 'ventes', label: 'Factures', icon: 'receipt' },
    { key: 'depenses', label: 'Dépenses', icon: 'paperclip' },
    { key: 'banque', label: 'Banque', icon: 'card' },
    isMicro() ? { key: 'urssaf', label: 'URSSAF et seuils', icon: 'scale' } : { key: 'tva', label: 'TVA', icon: 'percent' },
  ];
  if (ui.mode === 'avance' && !isMicro()) items.push({ section: 'Expert' }, { key: 'compta', label: 'Comptabilité', icon: 'chart' }, { key: 'cloture', label: 'Clôture', icon: 'lock' });
  return items;
}

function initials(name) {
  return (name || 'N').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

function renderApp() {
  runRecurring();
  const { name, arg } = route();
  const shell = $('app-shell');
  if (!shell.dataset.ready) {
    shell.innerHTML = html`
      <aside id="sidebar">
        <div class="sidebar-logo">${LOGO}<span class="logo-text">Nexus <span class="brand-suffix">Gestion</span></span></div>
        <nav id="sidebar-nav"></nav>
        <div id="sidebar-nav-pinned"></div>
      </aside>
      <div id="main-column">
        <header id="topbar">
          <button type="button" id="btn-mobile-nav-toggle" class="mobile-nav-toggle" data-action="toggle-nav" aria-label="Menu" aria-expanded="false">${raw(ICONS.menu)}</button>
          <div class="topbar-search">
            <input type="text" id="global-search-input" class="input" placeholder="Rechercher une facture, un client, une dépense... (Ctrl+K)" autocomplete="off">
            <div id="global-search-results" class="search-results"></div>
          </div>
          <div class="topbar-user">
            <button class="btn-icon" data-action="reload" title="Recharger la page">${raw(ICONS.refresh)}</button>
            <div class="user-menu-wrapper">
              <button class="avatar avatar-initials" id="btn-user-menu" data-action="user-menu" title="Mon compte"></button>
              <div id="user-menu-panel" class="user-menu-panel"></div>
            </div>
          </div>
        </header>
        <main id="view-root"></main>
      </div>`.s;
    shell.dataset.ready = '1';
  }
  $('sidebar-nav').innerHTML = html`${navItems().map((item) => item.section
    ? html`<div class="nav-section-label">${item.section}</div>`
    : html`<button class="nav-item ${name === item.key ? 'active' : ''}" data-href="#/${item.key}" aria-label="${item.label}"><span class="nav-icon">${raw(ICONS[item.icon])}</span><span class="nav-label">${item.label}</span></button>`)}`.s;
  $('sidebar-nav').classList.remove('open');
  $('sidebar-nav-pinned').innerHTML = syncStatusHtml().s;
  $('btn-user-menu').textContent = initials(ws.company.name);
  $('user-menu-panel').innerHTML = html`
    <div class="user-menu-header">
      <div class="user-menu-name">${ws.company.name}</div>
      ${badge(ui.demo ? 'Démonstration' : 'Dirigeant', 'primary')}
      <span class="text-muted" style="font-size:12px;">${cloudState.session?.user?.email || ''}</span>
    </div>
    <div class="theme-toggle-group" role="group" aria-label="Thème de l'application">
      ${[['system', 'Système'], ['light', 'Clair'], ['dark', 'Sombre']].map(([v, l]) => html`<button type="button" class="theme-toggle-btn ${getTheme() === v ? 'active' : ''}" data-action="theme" data-value="${v}">${l}</button>`)}
    </div>
    <div class="user-menu-divider"></div>
    <button type="button" class="user-menu-item" data-href="#/parametres">Paramètres</button>
    <button type="button" class="user-menu-item" data-action="${ui.demo ? 'demo-exit' : 'sign-out'}">${ui.demo ? 'Quitter la démonstration' : 'Se déconnecter'}</button>`.s;
  $('view-root').innerHTML = routes[name](arg).s;
}

// ------------------------------------------------------------------ recherche globale (barre du haut)

function searchResults(q) {
  const n = q.trim().toLowerCase();
  if (n.length < 2) return [];
  const out = [];
  for (const i of ws.book.invoices) {
    if (`${i.number || ''} ${i.client?.name || ''}`.toLowerCase().includes(n)) out.push({ icon: 'receipt', label: i.number || 'Brouillon de facture', sub: `${i.client?.name || ''} · ${frDate(i.issueDate)}`, href: `#/ventes/${i.id}` });
  }
  for (const p of ws.purchases) {
    if (`${p.supplier.name} ${p.number}`.toLowerCase().includes(n)) out.push({ icon: 'paperclip', label: p.supplier.name, sub: `Dépense ${p.number || ''} · ${eur(p.totalTtc)}`, href: '#/depenses' });
  }
  for (const t of ws.transactions) {
    if (t.label.toLowerCase().includes(n)) out.push({ icon: 'card', label: t.label, sub: `${frDate(t.date)} · ${eur(t.amount)}`, href: '#/banque' });
  }
  return out.slice(0, 12);
}

// ------------------------------------------------------------------ accueil

function viewHome() {
  const t = today();
  const d = ws.dashboard(t);
  const todo = ws.todo(t);
  const kpi = (iconName, value, label, href, hero) => html`<a class="kpi-card${hero ? ' kpi-card-hero' : ''}" href="${href}" style="text-decoration:none;color:inherit"><div class="kpi-icon">${raw(ICONS[iconName])}</div><div class="kpi-value">${eur(value)}</div><div class="kpi-label">${label}</div></a>`;
  const todoIcon = { bank: 'card', late: 'bell', draft: 'pencil', receipt: 'paperclip', vat: 'percent' };
  return html`
    <div class="dashboard-hero">
      <div class="dashboard-hero-text"><h1>Accueil</h1><p>Voici ce qui demande votre attention aujourd'hui.</p></div>
      <div class="dashboard-hero-actions"><a class="btn btn-gold btn-sm" href="#/ventes/nouvelle">Créer une facture</a><a class="btn btn-ghost-light btn-sm" href="#/depenses">Ajouter une dépense</a></div>
    </div>
    <div class="kpi-grid">
      ${kpi('coin', d.cash, 'Trésorerie', '#/banque', true)}
      ${kpi('receipt', d.receivable, 'Ce que mes clients me doivent', '#/ventes')}
      ${kpi('trendingUp', d.revenue, "Chiffre d'affaires de l'exercice", '#/ventes')}
      ${kpi('chart', d.result, 'Résultat estimé', ui.mode === 'avance' ? '#/compta' : '#/depenses')}
    </div>
    ${isMicro() ? '' : allocationCard()}
    <div class="card action-center">
      <h2>À faire</h2>
      ${todo.length ? html`<div class="action-center-list">${todo.map((i) => html`
        <button type="button" class="action-center-item" data-href="#/${i.view}${i.id ? `/${i.id}` : ''}">
          <span class="action-center-icon">${raw(ICONS[todoIcon[i.kind] || 'info'])}</span>
          <span class="action-center-label">${i.text}${i.amount != null ? ` — ${eur(i.amount)}` : ''}</span>
          <span class="action-center-arrow">→</span>
        </button>`)}</div>` : html`<p class="text-muted">Tout est à jour. Rien à faire pour le moment.</p>`}
    </div>`;
}

// ------------------------------------------------------------------ factures (§3.2, §3.5)

const STATUS = { 'a-echoir': ['À échoir', 'info'], '0-30': ['En retard', 'warning'], '31-60': ['En retard +30 j', 'warning'], '+60': ['En retard +60 j', 'danger'], payee: ['Payée', 'success'] };

/** Routes de création : le type de document découle de l'adresse. */
const NEW_DOC_ROUTES = { nouvelle: 'invoice', 'nouveau-devis': 'quote', 'nouvel-acompte': 'deposit' };
const DOC_TITLES = { invoice: 'FACTURE', credit: 'AVOIR', deposit: "FACTURE D'ACOMPTE", quote: 'DEVIS' };

function totalFor(i) {
  return i.status === 'issued' ? i.totals.totalTtc : computeTotals(i, { franchise: isVatExempt(i, ws.company) }).totalTtc;
}

function viewSales(arg) {
  if (NEW_DOC_ROUTES[arg] || (arg && arg.startsWith('modifier-'))) return viewInvoiceForm(arg);
  if (arg) return viewInvoice(arg);
  if (ui.salesTab === 'recurrentes') return viewRecurring();
  const quotesTab = ui.salesTab === 'devis';
  const rec = new Map(ws.receivables(today()).map((r) => [r.invoice.id, r]));
  const buckets = { 'a-echoir': 0, '0-30': 0, '31-60': 0, '+60': 0 };
  for (const r of rec.values()) if (r.outstanding > 0) buckets[r.bucket] += r.outstanding;
  const docs = [...ws.book.invoices].reverse().filter((i) => (i.type === 'quote') === quotesTab);
  const invoiced = new Set(ws.book.invoices.map((i) => i.quoteRef).filter(Boolean));
  const actions = html`<a class="btn btn-primary" href="#/ventes/nouvelle">Créer une facture</a><a class="btn btn-secondary" href="#/ventes/nouveau-devis">Créer un devis</a><a class="btn btn-secondary" href="#/ventes/nouvel-acompte">Facture d'acompte</a>`;
  const statusOf = (i) => {
    if (i.status === 'draft') return badge('Brouillon');
    if (i.type === 'quote') return invoiced.has(i.number) ? badge('Facturé', 'success') : i.dueDate < today() ? badge('Expiré', 'muted') : badge('Envoyé', 'info');
    if (i.type === 'credit') return badge('Avoir', 'primary');
    return html`<div class="badge-row">${i.type === 'deposit' ? badge('Acompte', 'primary') : ''}${badge(...STATUS[rec.get(i.id).bucket])}</div>`;
  };
  return html`
    ${viewHeader('Factures', 'Ce que mes clients me doivent, et ce qu’ils ont réglé.', actions)}
    <div class="kpi-grid">
      ${[['a-echoir', 'À échoir', 'hourglass'], ['0-30', 'En retard (0–30 j)', 'bell'], ['31-60', 'En retard (31–60 j)', 'warningTriangle'], ['+60', 'En retard (+60 j)', 'block']].map(([k, l, ic]) => html`<div class="kpi-card"><div class="kpi-icon">${raw(ICONS[ic])}</div><div class="kpi-value">${eur(buckets[k])}</div><div class="kpi-label">${l}</div></div>`)}
    </div>
    <div class="tabs" style="margin-bottom:14px">
      <button class="tab ${quotesTab ? '' : 'active'}" data-action="sales-tab" data-tab="factures">Factures</button>
      <button class="tab ${quotesTab ? 'active' : ''}" data-action="sales-tab" data-tab="devis">Devis</button>
      <button class="tab" data-action="sales-tab" data-tab="recurrentes">Récurrentes</button>
    </div>
    <div class="card table-card">
      ${docs.length ? html`<div class="table-scroll"><table class="table"><thead><tr><th>N°</th><th>Client</th><th>Date</th><th>${quotesTab ? 'Valable jusqu’au' : 'Échéance'}</th><th class="num">Total TTC</th>${quotesTab ? '' : html`<th class="num">Reste dû</th>`}<th>Statut</th></tr></thead><tbody>
        ${docs.map((i) => {
          const total = totalFor(i);
          const r = rec.get(i.id);
          return html`<tr class="row-link" data-href="#/ventes/${i.id}"><td class="mono">${i.number || '—'}</td><td>${i.client?.name || ''}</td><td>${frDate(i.issueDate)}</td><td>${frDate(i.dueDate)}</td><td class="num">${eur(i.type === 'credit' ? -total : total)}</td>${quotesTab ? '' : html`<td class="num">${r ? eur(r.outstanding) : ''}</td>`}<td>${statusOf(i)}</td></tr>`;
        })}</tbody></table></div>`
        : html`<div class="empty-state"><div class="empty-icon">${raw(ICONS.receipt)}</div><h3>${quotesTab ? 'Aucun devis pour l’instant' : 'Aucune facture pour l’instant'}</h3><p class="text-muted">${quotesTab ? 'Un devis accepté se transforme en facture en un clic.' : 'Créez la première en moins de 2 minutes.'}</p><a class="btn btn-primary" href="#/ventes/${quotesTab ? 'nouveau-devis' : 'nouvelle'}">${quotesTab ? 'Créer un devis' : 'Créer une facture'}</a></div>`}
    </div>`;
}

/** Onglet « Récurrentes » : modèles de factures produites automatiquement à chaque échéance. */
function viewRecurring() {
  const f = ui.recurringForm || {};
  const franchise = ws.company.vatRegime === 'franchise';
  const tabs = html`<div class="tabs" style="margin-bottom:14px">
      <button class="tab" data-action="sales-tab" data-tab="factures">Factures</button>
      <button class="tab" data-action="sales-tab" data-tab="devis">Devis</button>
      <button class="tab active" data-action="sales-tab" data-tab="recurrentes">Récurrentes</button>
    </div>`;
  const rows = ws.recurring.map((t) => {
    const ht = t.lines.reduce((s, l) => s + lineHt(l), 0);
    return html`<tr>
      <td>${t.client.name}</td><td>${t.lines[0].label}</td><td class="num">${eur(ht)} HT</td>
      <td>${FREQUENCIES[t.frequency].label}</td>
      <td>${t.active ? frDate(nextDate(t)) : '—'}${t.endDate ? html`<br><span class="text-muted" style="font-size:12px">jusqu'au ${frDate(t.endDate)}</span>` : ''}</td>
      <td>${t.autoIssue ? badge('Émission automatique', 'primary') : badge('Brouillon à valider')}</td>
      <td><div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-secondary btn-sm" data-action="recurring-toggle" data-id="${t.id}">${t.active ? 'Suspendre' : 'Reprendre'}</button><button class="btn-link" data-action="recurring-delete" data-id="${t.id}">Supprimer</button></div></td></tr>`;
  });
  return html`
    ${viewHeader('Factures', 'Abonnements, loyers, suivis mensuels : la facture se prépare toute seule à chaque échéance.')}
    ${tabs}
    <form class="card" data-form="recurring" style="display:flex;flex-direction:column;gap:14px">
      <h2>Nouvelle facture récurrente</h2>
      ${f.error ? html`<div class="issues-box">${f.error}</div>` : ''}
      <div class="form-grid">
        ${field('Client', ws.clients.length ? html`<select class="input" name="clientId">${ws.clients.map((c) => opt(c.id, c.name, f.clientId === c.id))}</select>` : html`<p class="form-hint">Créez d'abord une facture pour enregistrer un client.</p>`)}
        ${field('Désignation', html`<input class="input" name="label" value="${f.label || ''}" placeholder="Ex. : Maintenance mensuelle">`, { hint: 'La période (« octobre 2026 ») est ajoutée automatiquement.' })}
        ${field('Prix HT', html`<input class="input" name="price" inputmode="decimal" placeholder="0,00" value="${f.price || ''}">`)}
        ${franchise ? '' : field('TVA', html`<select class="input" name="vatRateBp">${VAT_RATES_BP.map((r) => opt(r, pct(r), Number(f.vatRateBp ?? 2000) === r))}</select>`)}
        ${field('Nature', html`<select class="input" name="nature">${opt('services', 'Service', f.nature !== 'biens')}${opt('biens', 'Bien', f.nature === 'biens')}</select>`)}
        ${field('Fréquence', html`<select class="input" name="frequency">${Object.entries(FREQUENCIES).map(([k, v]) => opt(k, v.label, (f.frequency || 'monthly') === k))}</select>`)}
        ${field('Première facture le', html`<input class="input" type="date" name="anchorDate" value="${f.anchorDate || today()}">`)}
        ${field('Dernière facture au plus tard le (facultatif)', html`<input class="input" type="date" name="endDate" value="${f.endDate || ''}">`)}
        ${field('Délai de paiement (jours)', html`<input class="input" name="paymentDays" inputmode="numeric" value="${f.paymentDays ?? ws.company.paymentTermsDays ?? 30}">`)}
      </div>
      <label class="form-field-checkbox" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="autoIssue" ${f.autoIssue ? raw('checked') : ''}>Émettre automatiquement (sinon la facture est préparée en brouillon et apparaît dans « À faire »)</label>
      <div><button class="btn btn-primary" type="submit" ${ws.clients.length ? '' : raw('disabled')}>Créer la facture récurrente</button></div>
    </form>
    <div class="card table-card">
      ${rows.length ? html`<div class="table-scroll"><table class="table"><thead><tr><th>Client</th><th>Désignation</th><th class="num">Montant</th><th>Fréquence</th><th>Prochaine</th><th>Mode</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : html`<div class="empty-state"><div class="empty-icon">${raw(ICONS.refresh)}</div><h3>Aucune facture récurrente</h3></div>`}
    </div>`;
}

/** Prépare les factures récurrentes échues, une fois par jour et par session. */
function runRecurring() {
  if (ui.recurringRanOn === today() || !ws.recurring.some((t) => t.active)) return;
  ui.recurringRanOn = today();
  const r = ws.generateRecurring(today());
  const n = r.drafts.length + r.issued.length;
  if (!n) return;
  save();
  setTimeout(() => toast(r.issued.length ? `${r.issued.length} facture(s) récurrente(s) émise(s)${r.drafts.length ? `, ${r.drafts.length} à vérifier` : ''}.` : `${r.drafts.length} facture(s) récurrente(s) prête(s) à émettre.`), 50);
}

function emptyLine() {
  return { label: '', qty: 1, unitPrice: 0, priceText: '', vatRateBp: ws.company.vatRegime === 'franchise' ? 0 : 2000, nature: ws.company.defaultNature || 'services' };
}

function startDraft(arg) {
  if (arg && arg.startsWith('modifier-')) {
    const inv = ws.book.get(arg.slice(9));
    ui.draft = { ...structuredClone(inv), lines: inv.lines.map((l) => ({ ...l, priceText: (l.unitPrice / 100).toFixed(2).replace('.', ',') })), clientId: ws.clients.find((c) => c.code === inv.client.code)?.id || '', savedId: inv.id };
  } else {
    const type = NEW_DOC_ROUTES[arg] || 'invoice';
    const days = type === 'quote' ? 30 : type === 'deposit' ? 0 : ws.company.paymentTermsDays || 30;
    const due = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    ui.draft = { type, issueDate: today(), dueDate: due, clientId: ws.clients[0]?.id || '__new', newClient: { type: 'B2B', country: 'FR' }, lines: [emptyLine()], depositIds: [] };
    if (type === 'deposit') ui.draft.lines[0].label = 'Acompte sur commande';
  }
  ui.draft.depositIds ||= (ui.draft.deposits || []).map((x) => x.id);
  ui.draft.key = arg;
}

function draftClient() {
  const d = ui.draft;
  return d.clientId === '__new' ? { ...d.newClient, siren: (d.newClient.siren || '').replace(/\s/g, '') } : ws.clients.find((c) => c.id === d.clientId) || d.client;
}

/** Acomptes proposés à la déduction : ceux du client choisi, pas encore déduits ailleurs. */
function draftAvailableDeposits() {
  const d = ui.draft;
  const client = draftClient();
  if (d.type !== 'invoice' || !client?.code) return [];
  return ws.book.availableDeposits(client.code, { exceptId: d.savedId });
}

function draftInvoiceData() {
  const d = ui.draft;
  const deposits = draftAvailableDeposits().filter((x) => d.depositIds.includes(x.id));
  return {
    type: d.type || 'invoice',
    client: draftClient(),
    issueDate: d.issueDate,
    dueDate: d.dueDate,
    lines: d.lines.map(({ priceText, ...l }) => l),
    deposits,
    ...(d.creditOf ? { creditOf: d.creditOf } : {}),
    ...(d.quoteRef ? { quoteRef: d.quoteRef } : {}),
  };
}

function totalsBlock() {
  const d = draftInvoiceData();
  const t = computeTotals(d, { franchise: (Boolean(d.client) && isVatExempt(d, ws.company)) || ws.company.vatRegime === 'franchise' });
  return html`<table class="totals-table"><tbody>
    <tr><td>Total HT</td><td class="num">${eur(t.totalHt)}</td></tr>
    ${t.vatBreakdown.filter((v) => v.vat).map((v) => html`<tr><td class="text-muted">TVA ${pct(v.rateBp)} sur ${eur(v.base)}</td><td class="num">${eur(v.vat)}</td></tr>`)}
    <tr class="grand"><td>Total TTC</td><td class="num">${eur(t.totalTtc)}</td></tr>
    ${d.deposits.map((x) => html`<tr><td class="text-muted">Acompte ${x.number} déduit</td><td class="num">${eur(-x.amountTtc)}</td></tr>`)}
    ${d.deposits.length ? html`<tr class="grand"><td>Net à payer</td><td class="num">${eur(t.netToPay)}</td></tr>` : ''}</tbody></table>`;
}

function viewInvoiceForm(arg) {
  if (!ui.draft || ui.draft.key !== arg) startDraft(arg);
  const d = ui.draft;
  const franchise = ws.company.vatRegime === 'franchise';
  const nc = d.newClient || {};
  const kind = { invoice: 'facture', quote: 'devis', deposit: "facture d'acompte", credit: 'avoir' }[d.type || 'invoice'];
  const title = d.savedId ? `Modifier le brouillon (${kind})` : { invoice: 'Nouvelle facture', quote: 'Nouveau devis', deposit: "Nouvelle facture d'acompte", credit: 'Nouvel avoir' }[d.type || 'invoice'];
  const deposits = draftAvailableDeposits();
  return html`
    <button class="btn-link no-print" data-href="#/ventes">← Retour aux factures</button>
    ${viewHeader(title, d.type === 'quote' ? 'Le devis est numéroté à l’envoi (série D). Une fois accepté, il se transforme en facture en un clic.' : d.type === 'deposit' ? 'L’acompte est enregistré en « acomptes reçus » ; il sera déduit de la facture finale.' : 'Le numéro est attribué à l’émission. Une facture émise ne se modifie plus.')}
    <form class="card" data-form="invoice" novalidate style="display:flex;flex-direction:column;gap:16px">
      ${d.issues?.length ? html`<div class="issues-box"><strong>Pour émettre cette facture, complétez :</strong><ul>${d.issues.map((i) => html`<li>${i.message}</li>`)}</ul></div>` : ''}
      <div class="form-section"><h3 class="form-subsection-title">Client</h3>
        <div class="form-grid">
          ${field('Client', html`<select class="input" name="clientId" data-rerender>${ws.clients.map((c) => opt(c.id, c.name, d.clientId === c.id))}${opt('__new', '+ Nouveau client', d.clientId === '__new')}</select>`)}
          ${d.clientId === '__new' ? field('Type de client', html`<select class="input" name="newClient.type" data-rerender>${opt('B2B', 'Entreprise', nc.type !== 'B2C')}${opt('B2C', 'Particulier', nc.type === 'B2C')}</select>`) : ''}
        </div>
        ${d.clientId === '__new' ? html`<div class="form-grid" style="margin-top:12px">
          ${nc.type !== 'B2C' ? field('SIREN', html`<div style="display:flex;gap:8px"><input class="input" name="newClient.siren" inputmode="numeric" value="${nc.siren || ''}"><button type="button" class="btn btn-secondary btn-sm" data-action="client-lookup">Remplir</button></div>`, { hint: 'Obligatoire pour une entreprise française.' }) : ''}
          ${field('Nom ou raison sociale', html`<input class="input" name="newClient.name" value="${nc.name || ''}">`)}
          ${field('Email (relances)', html`<input class="input" name="newClient.email" type="email" value="${nc.email || ''}">`)}
          ${field('Adresse', html`<input class="input" name="newClient.address" value="${nc.address || ''}">`)}
        </div>` : ''}
      </div>
      <div class="form-section"><h3 class="form-subsection-title">Dates</h3>
        <div class="form-grid">
          ${field("Date d'émission", html`<input class="input" type="date" name="issueDate" value="${d.issueDate}">`)}
          ${field(d.type === 'quote' ? 'Valable jusqu’au' : "Date d'échéance", html`<input class="input" type="date" name="dueDate" value="${d.dueDate}">`)}
        </div>
      </div>
      ${deposits.length ? html`<div class="form-section"><h3 class="form-subsection-title">Acomptes à déduire</h3>
        ${deposits.map((x) => html`<label class="form-field-checkbox" style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-action="toggle-deposit" data-id="${x.id}" ${d.depositIds.includes(x.id) ? raw('checked') : ''}>Acompte ${x.number} — ${eur(x.amountTtc)} TTC</label>`)}
      </div>` : ''}
      <div class="form-section"><h3 class="form-subsection-title">Lignes</h3>
        <div class="table-scroll"><table class="table lines-table"><thead><tr><th style="width:38%">Désignation</th><th>Qté</th><th>Prix unitaire HT</th>${franchise ? '' : html`<th>TVA</th>`}<th>Nature</th><th></th></tr></thead><tbody>
          ${d.lines.map((l, i) => html`<tr>
            <td><input class="input" name="lines.${i}.label" value="${l.label}" placeholder="Ex. : Accompagnement mars"></td>
            <td style="width:80px"><input class="input" name="lines.${i}.qty" inputmode="decimal" value="${String(l.qty).replace('.', ',')}"></td>
            <td style="width:130px"><input class="input" name="lines.${i}.priceText" inputmode="decimal" value="${l.priceText}" placeholder="0,00"></td>
            ${franchise ? '' : html`<td style="width:100px"><select class="input" name="lines.${i}.vatRateBp">${VAT_RATES_BP.map((r) => opt(r, pct(r), l.vatRateBp === r))}</select></td>`}
            <td style="width:120px"><select class="input" name="lines.${i}.nature">${opt('services', 'Service', l.nature === 'services')}${opt('biens', 'Bien', l.nature === 'biens')}</select></td>
            <td style="width:44px">${d.lines.length > 1 ? html`<button type="button" class="btn-icon" data-action="line-remove" data-index="${i}" aria-label="Supprimer la ligne">${raw(ICONS.close)}</button>` : ''}</td></tr>`)}
        </tbody></table></div>
        <button type="button" class="btn btn-secondary btn-sm" data-action="line-add" style="margin-top:10px">+ Ajouter une ligne</button>
      </div>
      <div id="totals">${totalsBlock()}</div>
      ${franchise ? html`<p class="form-hint">Mention ajoutée automatiquement : « TVA non applicable, art. 293 B du CGI ».</p>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn btn-primary" data-action="invoice-issue">${d.type === 'quote' ? 'Émettre le devis' : d.type === 'deposit' ? "Émettre la facture d'acompte" : d.type === 'credit' ? 'Émettre l’avoir' : 'Émettre la facture'}</button>
        <button type="button" class="btn btn-secondary" data-action="invoice-save">Enregistrer le brouillon</button>
        <button type="button" class="btn-link" data-action="invoice-cancel">Annuler</button>
      </div>
    </form>`;
}

function persistDraft() {
  const d = ui.draft;
  for (const l of d.lines) {
    try {
      l.unitPrice = l.priceText ? parseEuros(l.priceText) : 0;
    } catch {
      l.unitPrice = NaN;
    }
    l.qty = Number(String(l.qty).replace(',', '.')) || 0;
  }
  const data = draftInvoiceData();
  if (d.clientId === '__new') {
    if (!data.client.name?.trim()) {
      d.issues = [{ message: 'Le nom du client est manquant.' }];
      return null;
    }
    const client = ws.saveClient(data.client);
    d.clientId = client.id;
    data.client = client;
  }
  const inv = d.savedId ? ws.book.updateDraft(d.savedId, data) : ws.book.createDraft(data);
  d.savedId = inv.id;
  save();
  return inv;
}

function viewInvoice(id) {
  let inv;
  try {
    inv = ws.book.get(id);
  } catch {
    return html`<div class="empty-state"><h3>Facture introuvable</h3><button class="btn btn-primary" data-href="#/ventes">Retour aux factures</button></div>`;
  }
  const issued = inv.status === 'issued';
  const company = issued ? inv.issuer : ws.company;
  const franchise = isVatExempt(inv, company);
  const totals = issued ? inv.totals : computeTotals(inv, { franchise });
  const outstanding = issued ? ws.book.outstanding(inv) : null;
  const issues = issued ? [] : checkInvoice(inv, ws.company);
  const payments = ws.book.payments[inv.id] || [];
  const c = inv.client;
  const mailto = c.email && issued && outstanding > 0 ? `mailto:${encodeURIComponent(c.email)}?subject=${encodeURIComponent(`Facture ${inv.number} en attente de règlement`)}&body=${encodeURIComponent(`Bonjour,\n\nSauf erreur de notre part, la facture ${inv.number} du ${frDate(inv.issueDate)}, d'un montant de ${eur(outstanding)}, arrivée à échéance le ${frDate(inv.dueDate)}, reste à régler.\n\nMerci de procéder au règlement dans les meilleurs délais.\n\nCordialement,\n${ws.company.name}`)}` : '';
  const quote = inv.type === 'quote';
  const invoicedFrom = quote && issued ? ws.book.invoices.find((i) => i.quoteRef === inv.number) : null;
  const subtitle = !issued
    ? 'Brouillon : pas encore de numéro, modifiable.'
    : quote
      ? invoicedFrom ? `Devis facturé (${invoicedFrom.number || 'facture en brouillon'})` : `Devis valable jusqu'au ${frDate(inv.dueDate)}`
      : outstanding > 0 ? `Reste dû : ${eur(outstanding)}` : inv.type === 'credit' ? `Avoir sur la facture ${inv.creditOf}` : 'Payée intégralement';
  const actions = html`
    ${!issued ? html`<button class="btn btn-primary" data-action="invoice-issue-existing" data-id="${inv.id}">Émettre</button><button class="btn btn-secondary" data-href="#/ventes/modifier-${inv.id}">Modifier</button><button class="btn btn-secondary" data-action="invoice-delete" data-id="${inv.id}">Supprimer</button>` : ''}
    ${quote && issued && !invoicedFrom ? html`<button class="btn btn-gold" data-action="quote-convert" data-id="${inv.id}">Transformer en facture</button>` : ''}
    ${issued ? html`<button class="btn btn-secondary" data-action="print">Imprimer / PDF</button>` : ''}
    ${issued && !quote ? html`<button class="btn btn-secondary" data-action="einvoice" data-id="${inv.id}">Facture électronique (XML)</button>` : ''}
    ${mailto && !quote ? html`<a class="btn btn-gold" href="${mailto}">Relancer le client</a>` : ''}
    ${issued && inv.type !== 'credit' && !quote ? html`<button class="btn btn-secondary" data-action="credit-note" data-id="${inv.id}">Créer un avoir</button>` : ''}`;
  return html`
    <div class="no-print"><button class="btn-link" data-href="#/ventes">← Retour aux factures</button>${viewHeader(inv.number || (quote ? 'Brouillon de devis' : 'Brouillon de facture'), subtitle, actions)}</div>
    ${issues.length ? html`<div class="issues-box no-print" style="margin-bottom:14px"><strong>Avant émission, complétez :</strong><ul>${issues.map((i) => html`<li>${i.message}</li>`)}</ul></div>` : ''}
    <article class="invoice-sheet">
      <div class="sheet-head">
        <div class="party"><strong>${company.name}</strong><br>${company.address}<br>${company.legalForm}${company.capital ? ` au capital de ${company.capital}` : ''}<br>SIREN ${company.siren}${company.vatNumber ? html`<br>TVA ${company.vatNumber}` : ''}</div>
        <div><h2 class="sheet-title">${DOC_TITLES[inv.type] || 'FACTURE'}</h2><div class="gold-rule"></div>
          <div class="party">N° <strong>${inv.number || '(attribué à l’émission)'}</strong><br>Date : ${frDate(inv.issueDate)}<br>${quote ? 'Valable jusqu’au' : 'Échéance'} : ${frDate(inv.dueDate)}${inv.creditOf ? html`<br>Avoir sur facture ${inv.creditOf}` : ''}${inv.quoteRef ? html`<br>Selon devis ${inv.quoteRef}` : ''}${issued ? html`<br>Nature : ${inv.operationNature}` : ''}</div></div>
      </div>
      <div class="party" style="margin-bottom:22px"><span style="color:#5f6673">Facturé à</span><br><strong>${c.name}</strong><br>${c.address || ''}${c.siren ? html`<br>SIREN ${c.siren}` : ''}${c.vatNumber ? html`<br>TVA ${c.vatNumber}` : ''}</div>
      <table class="table"><thead><tr><th>Désignation</th><th class="num">Qté</th><th class="num">PU HT</th>${franchise ? '' : html`<th class="num">TVA</th>`}<th class="num">Total HT</th></tr></thead><tbody>
        ${inv.lines.map((l) => html`<tr><td>${l.label}</td><td class="num">${String(l.qty).replace('.', ',')}</td><td class="num">${eur(l.unitPrice)}</td>${franchise ? '' : html`<td class="num">${pct(l.vatRateBp)}</td>`}<td class="num">${eur(lineHt(l))}</td></tr>`)}
      </tbody></table>
      <table class="totals-table" style="margin-top:14px"><tbody>
        <tr><td>Total HT</td><td class="num">${eur(totals.totalHt)}</td></tr>
        ${totals.vatBreakdown.filter((v) => v.vat).map((v) => html`<tr><td>TVA ${pct(v.rateBp)}</td><td class="num">${eur(v.vat)}</td></tr>`)}
        <tr class="grand"><td>Total TTC</td><td class="num">${eur(totals.totalTtc)}</td></tr>
        ${(inv.deposits || []).map((x) => html`<tr><td>Acompte ${x.number} déduit</td><td class="num">${eur(-x.amountTtc)}</td></tr>`)}
        ${inv.deposits?.length ? html`<tr class="grand"><td>Net à payer</td><td class="num">${eur(totals.netToPay)}</td></tr>` : ''}</tbody></table>
      ${company.iban && !quote ? html`<p style="margin-top:18px;font-size:13.5px">Règlement par virement : <span class="mono">${company.iban}</span></p>` : ''}
      <div class="mentions">${(issued ? inv.mentions : []).map((m) => html`<div>${m}</div>`)}</div>
    </article>
    ${issued && !quote ? lifecycleCard(inv) : ''}
    ${payments.length ? html`<div class="card table-card no-print" style="margin-top:20px"><h2 style="padding:16px 16px 0">Règlements reçus</h2><table class="table"><tbody>${payments.map((p) => html`<tr><td>${frDate(p.date)}</td><td class="num">${eur(p.amount)}</td></tr>`)}</tbody></table></div>` : ''}`;
}

// ------------------------------------------------------------------ dépenses (§3.3)

function viewExpenses() {
  const pending = ui.pendingPurchase;
  const f = pending?.form || {};
  const franchise = ws.company.vatRegime === 'franchise';
  const list = [...ws.purchases].reverse();
  const tabs = html`<div class="tabs" style="margin-bottom:14px">
      <button class="tab ${ui.expensesTab === 'immobilisations' ? '' : 'active'}" data-action="expenses-tab" data-tab="depenses">Dépenses</button>
      <button class="tab ${ui.expensesTab === 'immobilisations' ? 'active' : ''}" data-action="expenses-tab" data-tab="immobilisations">Immobilisations</button>
    </div>`;
  if (ui.expensesTab === 'immobilisations') return html`${viewHeader('Dépenses', 'Vos équipements durables et leur amortissement.')}${tabs}${viewAssets()}`;
  return html`
    ${viewHeader('Dépenses', 'Ajoutez vos factures d’achat : la catégorie suffit, Nexus fait le reste.', html`<label class="btn btn-secondary" style="margin:0">${icon('upload', 14)} Importer une facture électronique (XML)<input type="file" accept=".xml,application/xml,text/xml" data-action="einvoice-in-file" hidden></label>`)}
    ${tabs}
    ${ui.pendingEinvoice ? einvoicePreview(ui.pendingEinvoice) : ''}
    <form class="card" data-form="purchase" style="display:flex;flex-direction:column;gap:14px">
      <h2>Ajouter une dépense</h2>
      ${pending?.duplicates?.length ? html`<div class="notice-gold">Cette dépense ressemble à une facture déjà enregistrée (${pending.duplicates.map((p) => `${p.supplier.name} du ${frDate(p.date)}`).join(', ')}). <button type="button" class="btn btn-gold btn-sm" data-action="purchase-force">L'enregistrer quand même</button> <button type="button" class="btn btn-secondary btn-sm" data-action="purchase-cancel">Annuler</button></div>` : ''}
      ${pending?.error ? html`<div class="issues-box">${pending.error}</div>` : ''}
      <div class="form-grid">
        ${field('Fournisseur', html`<input class="input" name="supplier" required value="${f.supplier || ''}" placeholder="Ex. : Orange">`)}
        ${field('Date de la facture', html`<input class="input" type="date" name="date" value="${f.date || today()}">`)}
        ${field('N° de facture', html`<input class="input" name="number" value="${f.number || ''}">`, { hint: 'Sert à détecter les doublons et à rapprocher le paiement.' })}
        ${field('Type de pièce', html`<select class="input" name="docType">${opt('invoice', 'Facture', f.docType !== 'credit')}${opt('credit', 'Avoir (remboursement ou remise)', f.docType === 'credit')}</select>`)}
        ${field('Catégorie', html`<select class="input" name="categoryId">${EXPENSE_CATEGORIES.map((c) => opt(c.id, c.label, f.categoryId === c.id))}</select>`)}
        ${field('Montant TTC', html`<input class="input" name="ttc" inputmode="decimal" placeholder="0,00" value="${f.ttc || ''}" required>`)}
        ${franchise ? '' : field('Taux de TVA', html`<select class="input" name="vatRateBp">${VAT_RATES_BP.map((r) => opt(r, pct(r), Number(f.vatRateBp ?? 2000) === r))}</select>`)}
        ${field('Justificatif', html`<input class="input" type="file" name="document" accept="image/*,application/pdf" capture="environment">`, { hint: 'Photo ou PDF, conservé au format d’origine.' })}
      </div>
      <div><button class="btn btn-primary" type="submit">Enregistrer la dépense</button></div>
    </form>
    <div class="card table-card">
      ${list.length ? html`<div class="table-scroll"><table class="table"><thead><tr><th>Date</th><th>Fournisseur</th><th>Catégorie</th><th class="num">Montant TTC</th><th>Statut</th></tr></thead><tbody>
        ${list.map((p) => html`<tr><td>${frDate(p.date)}</td><td>${p.supplier.name}${p.number ? html` <span class="text-muted mono">${p.number}</span>` : ''}</td><td>${EXPENSE_CATEGORIES.find((c) => c.id === p.lines[0].categoryId)?.label}</td><td class="num">${eur(p.type === 'credit' ? -p.totalTtc : p.totalTtc)}</td><td><div class="badge-row">${p.type === 'credit' ? badge('Avoir', 'primary') : ''}${p.paid >= p.totalTtc ? badge(p.type === 'credit' ? 'Remboursé' : 'Payée', 'success') : badge(p.type === 'credit' ? 'À recevoir' : 'À payer', 'warning')}${receiptCell(p)}</div></td></tr>`)}
      </tbody></table></div>` : html`<div class="empty-state"><div class="empty-icon">${raw(ICONS.paperclip)}</div><h3>Aucune dépense enregistrée</h3></div>`}
    </div>`;
}

/** Suivi des statuts d'une facture émise (cycle de vie de la facturation électronique). */
function lifecycleCard(inv) {
  const events = ws.book.lifecycle[inv.id] || [];
  const next = nextStatuses(events);
  const sourceLabel = { manuel: 'saisi', banque: 'paiement rapproché', PA: 'plateforme agréée' };
  const kind = (s) => (LIFECYCLE[s].alert ? 'warning' : s === 'encaissee' ? 'success' : 'info');
  return html`<div class="card no-print" style="margin-top:20px;display:flex;flex-direction:column;gap:10px">
    <h2>Suivi de la facture</h2>
    ${events.length
      ? html`<table class="table"><tbody>${events.map((e) => html`<tr><td style="width:110px">${frDate(e.date)}</td><td>${badge(LIFECYCLE[e.status].label, kind(e.status))}${e.detail ? html` <span class="text-muted">${e.detail}</span>` : ''}</td><td class="text-muted" style="font-size:12px">${sourceLabel[e.source] || e.source}</td></tr>`)}</tbody></table>`
      : html`<p class="text-muted">Aucun statut pour l'instant. Une fois Nexus raccordé à la plateforme agréée, les statuts (déposée, reçue, approuvée…) arriveront tout seuls ; « Encaissée » se pose déjà au paiement.</p>`}
    ${next.length ? html`<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
      ${field('Ajouter un statut', html`<select class="input" data-status-select>${next.map((k) => opt(k, LIFECYCLE[k].label))}</select>`)}
      ${field('Précision (facultatif)', html`<input class="input" data-status-detail placeholder="Ex. : motif du refus">`)}
      <button class="btn btn-secondary" data-action="status-add" data-id="${inv.id}" style="margin-bottom:2px">Ajouter</button>
    </div>` : ''}
  </div>`;
}

/** Aperçu d'une facture électronique reçue, avant enregistrement de la dépense. */
function einvoicePreview({ inv, duplicates }) {
  const blocked = inv.currency !== 'EUR';
  return html`<div class="card" style="display:flex;flex-direction:column;gap:12px;border:2px solid var(--landing-gold-500)">
    <h2>Facture électronique reçue (${inv.format})</h2>
    <table class="table"><tbody>
      <tr><td>Fournisseur</td><td><strong>${inv.seller.name}</strong>${inv.seller.siren ? html` <span class="text-muted">SIREN ${inv.seller.siren}</span>` : ''}</td></tr>
      <tr><td>Facture</td><td class="mono">${inv.number} du ${frDate(inv.issueDate)}${inv.dueDate ? ` · échéance ${frDate(inv.dueDate)}` : ''}</td></tr>
      ${inv.taxes.map((t) => html`<tr><td>Base à ${pct(t.rateBp)}</td><td class="num">${eur(t.base)} HT · TVA ${eur(t.vat)}</td></tr>`)}
      <tr><td><strong>Total TTC</strong></td><td class="num"><strong>${eur(inv.totalTtc)}</strong></td></tr>
    </tbody></table>
    ${inv.type === 'credit' ? html`<div class="notice-gold">Avoir fournisseur : la charge et la TVA récupérable seront diminuées d'autant ; le remboursement sera proposé en face du virement reçu.</div>` : ''}
    ${inv.warnings.length ? html`<div class="notice-gold"><ul style="margin:0;padding-left:18px">${inv.warnings.map((w) => html`<li>${w}</li>`)}</ul></div>` : ''}
    ${duplicates?.length ? html`<div class="notice-gold">Cette facture semble déjà enregistrée (${duplicates.map((p) => `${p.supplier.name} du ${frDate(p.date)}`).join(', ')}).</div>` : ''}
    ${blocked ? '' : html`<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
      ${field('Catégorie', html`<select class="input" data-einvoice-cat>${EXPENSE_CATEGORIES.map((cat) => opt(cat.id, cat.label))}</select>`)}
      <button class="btn btn-primary" data-action="einvoice-in-save" style="margin-bottom:2px">${duplicates?.length ? 'Enregistrer quand même' : 'Enregistrer la dépense'}</button>
    </div>`}
    <div><button class="btn-link" data-action="einvoice-in-cancel">Annuler</button></div>
  </div>`;
}

/** Justificatif d'une dépense : lien vers la pièce stockée, ou signalement de son absence. */
function receiptCell(p) {
  const doc = cloudState.documents.find((d) => d.linked_entity === 'purchase' && d.linked_id === p.id);
  if (doc) return html`<button class="btn-link" data-action="receipt-open" data-path="${doc.storage_path}">Voir le justificatif</button>`;
  if (ui.demo && p.documentName) return badge('Justificatif joint', 'info');
  return badge('Sans justificatif');
}

/** Envoie la pièce jointe d'une dépense vers le stockage (mode connecté uniquement). */
async function attachReceipt(purchase, file) {
  if (!file || ui.demo || !cloudState.meta) return;
  try {
    cloudState.documents.push(await cloud.uploadReceipt(cloudState.meta.structureId, file, { entity: 'purchase', id: purchase.id }));
    render();
    toast('Justificatif enregistré.');
  } catch (err) {
    toast(`Justificatif non enregistré : ${cloud.friendly(err)}`, true);
  }
}

// ------------------------------------------------------------------ banque (§3.4)

function viewBank() {
  const open = ws.transactions.filter((t) => t.status === 'open').sort((a, b) => b.date.localeCompare(a.date));
  const done = ws.transactions.filter((t) => t.status !== 'open').sort((a, b) => b.date.localeCompare(a.date));
  let stmt = null;
  if (ui.statementBalance) {
    try {
      stmt = reconciliationStatement(ws.ledger, ws.transactions, { date: today(), statementBalance: parseEuros(ui.statementBalance) });
    } catch {}
  }
  const franchise = ws.company.vatRegime === 'franchise';
  return html`
    ${viewHeader('Banque', 'Associez chaque mouvement à une facture, ou choisissez une catégorie.', html`<label class="btn btn-primary" style="margin:0">${icon('upload', 14)} Importer un relevé (CSV, OFX)<input type="file" accept=".csv,.ofx,.qfx,.txt" data-action="bank-file" hidden></label>`)}
    <div class="card table-card">
      <h2 style="padding:16px 16px 0">À justifier (${open.length})</h2>
      ${open.length ? html`<table class="table"><tbody>${open.map((t) => {
        const sugg = ws.suggestionsFor(t.id).slice(0, 2);
        const cats = t.amount < 0 ? EXPENSE_CATEGORIES : INCOME_CATEGORIES;
        const others = t.amount < 0 ? OUTFLOW_CATEGORIES : [];
        return html`<tr><td style="width:110px">${frDate(t.date)}</td><td><strong>${t.label}</strong>
          ${sugg.map((s, si) => html`<div class="match-suggestion"><span>${s.docs.map((d) => `${d.kind === 'invoice' ? 'Facture' : 'Dépense'} ${d.number} — ${d.partyName} (${eur(d.outstanding)})`).join(' + ')}<br><span class="match-reasons">${s.reasons.join(', ')} · confiance ${s.score} %</span></span><button class="btn btn-primary btn-sm" data-action="tx-match" data-id="${t.id}" data-index="${si}">Associer</button></div>`)}
          <div class="tx-actions">
            <select class="input input-sm" data-cat="${t.id}" aria-label="Catégorie">${opt('', sugg.length ? 'Ou choisir une catégorie…' : 'Choisir une catégorie…', true)}${others.length ? html`<optgroup label="Dépenses">${cats.map((c) => opt(c.id, c.label))}</optgroup><optgroup label="Autres sorties d’argent">${others.map((c) => opt(c.id, c.label))}</optgroup>` : cats.map((c) => opt(c.id, c.label))}</select>
            ${t.amount < 0 && !franchise ? html`<select class="input input-sm" data-vat="${t.id}" aria-label="TVA" style="min-width:110px;flex:0">${VAT_RATES_BP.map((r) => opt(r, `TVA ${pct(r)}`, r === 0))}</select>` : ''}
            ${t.amount < 0 ? html`<label><input type="checkbox" data-receipt="${t.id}">J'ai la facture</label>` : ''}
            <button class="btn btn-secondary btn-sm" data-action="tx-categorize" data-id="${t.id}">Valider</button>
            <button class="btn-link" data-action="tx-ignore" data-id="${t.id}" title="Mouvement déjà comptabilisé par ailleurs">Ignorer</button>
          </div></td><td class="num" style="width:120px"><strong>${eur(t.amount)}</strong></td></tr>`;
      })}</tbody></table>` : html`<div class="empty-state"><div class="empty-icon">${raw(ICONS.card)}</div><p class="text-muted">${ws.transactions.length ? 'Toutes vos transactions sont justifiées.' : 'Importez votre premier relevé bancaire pour commencer.'}</p></div>`}
    </div>
    <div class="card">
      <h2>État de rapprochement</h2>
      ${field("Solde affiché par votre banque aujourd'hui", html`<input class="input" data-statement value="${ui.statementBalance}" inputmode="decimal" placeholder="0,00" style="max-width:240px">`)}
      ${stmt ? html`<table class="table" style="max-width:520px;margin-top:10px"><tbody>
        <tr><td>Solde banque</td><td class="num">${eur(stmt.statementBalance)}</td></tr>
        <tr><td>Solde comptable</td><td class="num">${eur(stmt.bookBalance)}</td></tr>
        <tr><td>Mouvements à justifier (${stmt.pendingCount})</td><td class="num">${eur(stmt.pendingTotal)}</td></tr>
        <tr><td><strong>Écart inexpliqué</strong></td><td class="num"><strong>${eur(stmt.difference)}</strong></td></tr></tbody></table>
        <p class="form-hint">${stmt.difference ? 'Un écart indique un mouvement non importé ou saisi deux fois.' : 'Aucun écart : votre banque et votre comptabilité concordent.'}</p>` : ''}
    </div>
    ${done.length ? html`<div class="card table-card"><h2 style="padding:16px 16px 0">Déjà justifiées</h2><table class="table"><tbody>${done.slice(0, 50).map((t) => html`<tr><td style="width:110px">${frDate(t.date)}</td><td>${t.label} <span class="badge-row" style="display:inline-flex">${t.status === 'ignored' ? badge('Ignorée') : ''}${t.missingReceipt ? badge('Sans justificatif', 'warning') : ''}</span></td><td class="num">${eur(t.amount)}</td></tr>`)}</tbody></table></div>` : ''}`;
}

async function importBankFile(file) {
  const text = await file.text();
  return /<OFX|<STMTTRN/i.test(text) ? parseOfx(text) : parseBankCsv(text);
}

// ------------------------------------------------------------------ TVA (§3.6)

function viewVat() {
  if (ws.company.vatRegime === 'franchise') {
    return html`${viewHeader('TVA', 'Vous êtes en franchise en base : vous ne facturez pas de TVA.')}<div class="card">${thresholdCard(thresholdStatus(microReceipts(), Number(today().slice(0, 4))))}</div>`;
  }
  const fy = ws.company.fiscalYear;
  const months = [];
  let [y, m] = fy.start.split('-').map(Number);
  for (let i = 0; i < 12; i++) {
    const from = `${y}-${String(m).padStart(2, '0')}-01`;
    if (from > today()) break;
    const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    months.push({ from, to, label: new Date(`${from}T00:00:00`).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }), ...ws.vatDue({ from, to }) });
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  if (ws.company.vatRegime === 'reel-normal') return viewCa3(months);
  if (ws.company.vatRegime === 'reel-simplifie') return viewCa12();
  return html`
    ${viewHeader('TVA', `${ws.company.vatRegime === 'reel-normal' ? 'Déclaration mensuelle (CA3).' : 'Déclaration annuelle (CA12) avec acomptes.'} La télétransmission arrive avec la prochaine version.`)}
    <div class="notice-gold" style="margin-bottom:14px">Comment lire ce tableau : la <strong>TVA collectée</strong> est celle que vous avez facturée et encaissée ; la <strong>TVA déductible</strong> est celle payée sur vos achats. Vous reversez la différence. Exemple : 200 € collectés − 50 € déductibles = 150 € à payer.</div>
    <div class="card table-card"><table class="table"><thead><tr><th>Période</th><th class="num">TVA collectée</th><th class="num">TVA déductible</th><th class="num">À payer (ou crédit)</th></tr></thead><tbody>
      ${months.reverse().map((r) => html`<tr><td style="text-transform:capitalize">${r.label}</td><td class="num">${eur(r.collected)}</td><td class="num">${eur(r.deductible)}</td><td class="num"><strong>${eur(r.net)}</strong></td></tr>`)}
    </tbody></table></div>`;
}

/** Régime simplifié : déclaration annuelle CA12 et acomptes de juillet et décembre. */
function viewCa12() {
  const fy = ws.company.fiscalYear;
  const ended = fy.end < today();
  const period = { from: fy.start, to: ended ? fy.end : today() };
  const record = ws.vatReturns.find((r) => r.from === fy.start && r.kind === 'CA12');
  const ca12 = ws.prepareVatReturn(period);
  const b = record ? record.boxes : ca12.boxes;
  const advances = ws.vatAdvancesDue();
  const status = record ? `Déclarée le ${frDate(record.declaredAt)}` : ended ? 'À déclarer' : 'Exercice en cours';
  const rows = [
    ['Ventes et prestations imposables (HT)', b['01']],
    ['TVA due', b['16']],
    ['TVA récupérable sur les équipements', b['19']],
    ['TVA récupérable sur les autres dépenses', b['20']],
    ['Acomptes déjà versés (juillet, décembre)', b.acomptes],
    [b['28'] ? 'TVA restant à payer' : 'Crédit de TVA', b['28'] || b['25']],
  ];
  return html`
    ${viewHeader('TVA', 'Régime simplifié : une déclaration annuelle (CA12), avec deux acomptes en juillet et en décembre.')}
    <div class="kpi-grid">
      <div class="kpi-card kpi-card-hero"><div class="kpi-icon">${raw(ICONS.percent)}</div><div class="kpi-value">${eur(b['28'] || -(b['25'] || 0))}</div><div class="kpi-label">${ended ? 'Solde de l’exercice' : 'Estimation à ce jour'}</div></div>
      <div class="kpi-card"><div class="kpi-icon">${raw(ICONS.calendar)}</div><div class="kpi-value" style="font-size:18px">${advances ? eur(advances.july) : '—'}</div><div class="kpi-label">Acompte de juillet</div></div>
      <div class="kpi-card"><div class="kpi-icon">${raw(ICONS.calendar)}</div><div class="kpi-value" style="font-size:18px">${advances ? eur(advances.december) : '—'}</div><div class="kpi-label">Acompte de décembre</div></div>
      <div class="kpi-card"><div class="kpi-icon">${raw(record ? ICONS.checkCircle : ICONS.hourglass)}</div><div class="kpi-value" style="font-size:18px">${status}</div><div class="kpi-label">CA12 ${fy.start.slice(0, 4)}</div></div>
    </div>
    ${!record && ca12.warnings.length ? html`<div class="notice-gold" style="margin-bottom:14px"><ul style="margin:0;padding-left:18px">${ca12.warnings.map((w) => html`<li>${w}</li>`)}</ul></div>` : ''}
    <div class="card table-card"><table class="table"><tbody>${rows.map(([l, v]) => html`<tr><td>${l}</td><td class="num">${eur(v || 0)}</td></tr>`)}</tbody></table></div>
    ${!advances ? html`<p class="form-hint">Les acomptes de l'année suivante (55 % en juillet, 40 % en décembre) sont calculés dès la première CA12 validée ; aucun acompte si la TVA de l'année est inférieure à 1 000 €.</p>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${ended && !record ? html`<button class="btn btn-primary" data-action="vat-declare" data-from="${period.from}" data-to="${period.to}">Valider la CA12 ${fy.start.slice(0, 4)}</button>` : ''}
      <button class="btn btn-secondary" data-action="vat-justification" data-from="${period.from}" data-to="${period.to}">Exporter le détail par facture (Excel)</button>
    </div>
    <p class="form-hint">Versez les acomptes depuis votre banque puis classez le prélèvement en « Acompte de TVA » : ils seront déduits automatiquement de la CA12. Cases du formulaire 3517-S à reporter, millésime à confirmer avec votre expert-comptable.</p>`;
}

/** Libellés en langage courant des cases de la CA3 affichées (le numéro officiel reste visible). */
const CA3_ROWS = [
  ['01', 'Ventes et prestations imposables (HT)'],
  ['3B', 'Achats de services à l’étranger, autoliquidés (HT)'],
  ['F2', 'Livraisons de biens dans l’Union européenne, exonérées (HT)'],
  ['E2', 'Autres opérations non imposables (HT)'],
  ['08-base', 'Base à 20 %'], ['08-taxe', 'TVA à 20 %'],
  ['9B-base', 'Base à 10 %'], ['9B-taxe', 'TVA à 10 %'],
  ['09-base', 'Base à 5,5 %'], ['09-taxe', 'TVA à 5,5 %'],
  ['10-base', 'Base à 2,1 %'], ['10-taxe', 'TVA à 2,1 %'],
  ['17', 'TVA due sur les achats autoliquidés'],
  ['16', 'Total de la TVA due'],
  ['19', 'TVA récupérable sur les équipements'],
  ['20', 'TVA récupérable sur les autres dépenses'],
  ['22', 'Crédit de TVA reporté du mois précédent'],
  ['23', 'Total de la TVA récupérable'],
  ['25', 'Crédit de TVA (à reporter ou à rembourser)'],
  ['28', 'TVA nette due'],
];

function viewCa3(months) {
  const closed = months.filter((mo) => mo.to < today());
  const declared = new Map(ws.vatReturns.map((r) => [r.from, r]));
  const selected = closed.find((mo) => mo.from === ui.vatPeriod) || closed.find((mo) => !declared.has(mo.from)) || closed.at(-1);
  const header = viewHeader('TVA', 'Déclaration mensuelle (CA3) préparée à partir de vos factures et de votre banque. La télétransmission arrive avec la prochaine version.');
  if (!selected) return html`${header}<div class="card"><div class="empty-state"><p class="text-muted">La première déclaration sera prête au lendemain de la fin du premier mois.</p></div></div>`;
  const record = declared.get(selected.from);
  const ca3 = ws.prepareVatReturn({ from: selected.from, to: selected.to });
  const boxes = record ? record.boxes : ca3.boxes;
  const shown = CA3_ROWS.filter(([k]) => boxes[k] || ['01', '16', '23', '28'].includes(k));
  const strong = new Set(['16', '23', '25', '28']);
  return html`
    ${header}
    <div class="tabs" style="margin-bottom:14px;flex-wrap:wrap">${closed.map((mo) => html`<button class="tab ${mo.from === selected.from ? 'active' : ''}" data-action="vat-period" data-from="${mo.from}" style="text-transform:capitalize">${mo.label}${declared.has(mo.from) ? ' ✓' : ''}</button>`)}</div>
    <div class="kpi-grid">
      <div class="kpi-card kpi-card-hero"><div class="kpi-icon">${raw(ICONS.percent)}</div><div class="kpi-value">${eur(boxes['28'] || -(boxes['25'] || 0))}</div><div class="kpi-label">${boxes['28'] ? 'TVA à payer' : 'Crédit de TVA'} — ${selected.label}</div></div>
      <div class="kpi-card"><div class="kpi-icon">${raw(ICONS.receipt)}</div><div class="kpi-value">${eur(boxes['16'])}</div><div class="kpi-label">TVA due</div></div>
      <div class="kpi-card"><div class="kpi-icon">${raw(ICONS.paperclip)}</div><div class="kpi-value">${eur(boxes['23'])}</div><div class="kpi-label">TVA récupérable</div></div>
      <div class="kpi-card"><div class="kpi-icon">${raw(record ? ICONS.checkCircle : ICONS.hourglass)}</div><div class="kpi-value" style="font-size:18px">${record ? `Déclarée le ${frDate(record.declaredAt)}` : 'À déclarer'}</div><div class="kpi-label">Statut</div></div>
    </div>
    ${!record && ca3.warnings.length ? html`<div class="notice-gold" style="margin-bottom:14px"><strong>Avant de valider :</strong><ul style="margin:6px 0 0;padding-left:18px">${ca3.warnings.map((w) => html`<li>${w}</li>`)}</ul></div>` : ''}
    <div class="card table-card"><table class="table"><thead><tr><th>Case</th><th>Libellé</th><th class="num">Montant</th></tr></thead><tbody>
      ${shown.map(([k, label]) => html`<tr><td class="mono">${k.replace('-base', '').replace('-taxe', '')}</td><td>${strong.has(k) ? html`<strong>${label}</strong>` : label}</td><td class="num">${strong.has(k) ? html`<strong>${eur(boxes[k] || 0)}</strong>` : eur(boxes[k] || 0)}</td></tr>`)}
    </tbody></table></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      ${record ? '' : html`<button class="btn btn-primary" data-action="vat-declare" data-from="${selected.from}" data-to="${selected.to}">Valider la déclaration de ${selected.label}</button>`}
      <button class="btn btn-secondary" data-action="vat-justification" data-from="${selected.from}" data-to="${selected.to}">Exporter le détail par facture (Excel)</button>
      <button class="btn btn-secondary" data-action="print">Imprimer / PDF</button>
    </div>
    <div class="card table-card"><h2 style="padding:16px 16px 0">Détail par facture</h2>
      ${ca3.justification.length ? html`<div class="table-scroll"><table class="table"><thead><tr><th>Case</th><th>Facture</th><th>Client</th><th>Exigible le</th><th class="num">Base HT</th><th class="num">TVA</th></tr></thead><tbody>
        ${ca3.justification.map((j) => html`<tr><td class="mono">${j.line}</td><td class="mono">${j.number}</td><td>${j.client}</td><td>${frDate(j.date)} <span class="text-muted" style="font-size:12px">(${j.reason})</span></td><td class="num">${eur(j.base)}</td><td class="num">${eur(j.vat)}</td></tr>`)}
      </tbody></table></div>` : html`<div class="empty-state"><p class="text-muted">Aucune vente taxable ce mois-ci.</p></div>`}
    </div>
    <p class="form-hint">Les numéros de case suivent le formulaire 3310-CA3 ; le millésime en vigueur est à confirmer avec votre expert-comptable.</p>`;
}

// ------------------------------------------------------------------ micro-entrepreneur

function microReceipts() {
  const out = [];
  for (const inv of ws.book.invoices) {
    for (const p of ws.book.payments[inv.id] || []) {
      out.push({ date: p.date, invoiceNumber: inv.number, clientName: inv.client.name, amount: p.amount, method: 'Virement', activity: ws.company.microActivity || 'bnc' });
    }
  }
  return out;
}

function thresholdCard(s) {
  const label = { ok: ['Sous le seuil', 'success'], 'alerte-80': ['Attention : 80 % du seuil atteint', 'warning'], 'depasse-base': ['Seuil dépassé : la franchise prend fin au 1er janvier prochain', 'danger'], 'depasse-majore': ['Seuil majoré dépassé : TVA à facturer dès maintenant', 'danger'] };
  const fam = ws.company.microActivity === 'bic-vente' ? 'biens' : 'services';
  return html`<h2>Suivi du seuil de franchise de TVA</h2><p>Chiffre d'affaires encaissé cette année : <strong>${eur(s.ca[fam])}</strong></p><p>${badge(...label[s.vat[fam]])}</p><p class="form-hint">Seuils 2026 à confirmer par votre expert-comptable : 85 000 € (ventes) et 37 500 € (services).</p>`;
}

function viewUrssaf() {
  const receipts = microReceipts();
  const year = Number(today().slice(0, 4));
  const book = receiptsBook(receipts, { from: `${year}-01-01`, to: `${year}-12-31` });
  return html`
    ${viewHeader('URSSAF et seuils', 'Le montant à déclarer est votre chiffre d’affaires encaissé sur la période.')}
    <div class="card table-card"><h2 style="padding:16px 16px 0">À déclarer par trimestre</h2><table class="table"><thead><tr><th>Période</th><th>Activité</th><th class="num">Montant à déclarer</th></tr></thead><tbody>
      ${declarationPeriods(year).map((p) => html`<tr><td>${p.label}</td><td>${ACTIVITY_TYPES[ws.company.microActivity]?.label}</td><td class="num"><strong>${eur(urssafDeclaration(receipts, p).total)}</strong></td></tr>`)}</tbody></table></div>
    <div class="card">${thresholdCard(thresholdStatus(receipts, year))}</div>
    <div class="card table-card">
      <div class="view-header-row" style="display:flex;justify-content:space-between;align-items:center;padding:16px 16px 0"><h2>Livre des recettes ${year}</h2><button class="btn btn-secondary btn-sm" data-action="export-receipts">Exporter (Excel)</button></div>
      ${book.rows.length ? html`<table class="table"><thead><tr><th>Date</th><th>Facture</th><th>Client</th><th>Mode</th><th class="num">Montant</th></tr></thead><tbody>${book.rows.map((r) => html`<tr><td>${frDate(r.date)}</td><td class="mono">${r.invoiceNumber}</td><td>${r.clientName}</td><td>${r.method}</td><td class="num">${eur(r.amount)}</td></tr>`)}</tbody><tfoot><tr><td colspan="4">Total</td><td class="num">${eur(book.total)}</td></tr></tfoot></table>` : html`<div class="empty-state"><p class="text-muted">Les encaissements rapprochés dans « Banque » apparaissent ici automatiquement.</p></div>`}
    </div>`;
}

// ------------------------------------------------------------------ comptabilité (mode avancé)

function viewCompta() {
  if (ui.mode !== 'avance') return html`<div class="empty-state"><p>Activez le mode avancé dans les paramètres.</p><button class="btn btn-primary" data-href="#/parametres">Paramètres</button></div>`;
  const tab = ui.comptaTab;
  const tabs = [['balance', 'Balance'], ['grand-livre', 'Grand livre'], ['journaux', 'Journaux'], ['cloture', 'Validation et FEC'], ['archives', 'Exercices clos']];
  let body;
  if (tab === 'balance') {
    const tb = trialBalance(ws.ledger);
    body = html`<div class="card table-card"><div class="table-scroll"><table class="table"><thead><tr><th>Compte</th><th>Libellé</th><th class="num">Débit</th><th class="num">Crédit</th><th class="num">Solde débiteur</th><th class="num">Solde créditeur</th></tr></thead><tbody>
      ${tb.rows.map((r) => html`<tr><td class="mono">${r.account}</td><td>${r.label}<br><span class="text-muted" style="font-size:12px">${r.plainLabel}</span></td><td class="num">${eur(r.debit)}</td><td class="num">${eur(r.credit)}</td><td class="num">${r.soldeDebiteur ? eur(r.soldeDebiteur) : ''}</td><td class="num">${r.soldeCrediteur ? eur(r.soldeCrediteur) : ''}</td></tr>`)}
      </tbody><tfoot><tr><td colspan="2">Total ${tb.balanced ? '(équilibrée)' : '(DÉSÉQUILIBRÉE)'}</td><td class="num">${eur(tb.totals.debit)}</td><td class="num">${eur(tb.totals.credit)}</td><td class="num">${eur(tb.totals.soldeDebiteur)}</td><td class="num">${eur(tb.totals.soldeCrediteur)}</td></tr></tfoot></table></div></div>`;
  } else if (tab === 'grand-livre') {
    body = generalLedger(ws.ledger).map((b) => html`<div class="card table-card"><h3 style="padding:14px 16px 0"><span class="mono">${b.account}</span> ${b.label}</h3><div class="table-scroll"><table class="table"><thead><tr><th>Date</th><th>Jnl</th><th>N°</th><th>Pièce</th><th>Libellé</th><th>Let.</th><th class="num">Débit</th><th class="num">Crédit</th><th class="num">Solde</th></tr></thead><tbody>
      ${b.lines.map((l) => html`<tr><td>${frDate(l.date)}</td><td>${l.journal}</td><td>${l.number ?? badge('brouillon')}</td><td class="mono">${l.pieceRef.length > 14 ? `${l.pieceRef.slice(0, 12)}…` : l.pieceRef}</td><td>${l.label}</td><td class="mono">${l.letter}</td><td class="num">${l.debit ? eur(l.debit) : ''}</td><td class="num">${l.credit ? eur(l.credit) : ''}</td><td class="num">${eur(l.runningBalance)}</td></tr>`)}
      </tbody></table></div></div>`);
  } else if (tab === 'journaux') {
    body = Object.entries(JOURNALS).map(([code, label]) => {
      const entries = journalReport(ws.ledger, code);
      if (!entries.length) return '';
      return html`<div class="card table-card"><h3 style="padding:14px 16px 0">${code} — ${label}</h3><table class="table"><tbody>${entries.map((e) => html`<tr><td style="width:100px">${frDate(e.date)}</td><td style="width:60px">${e.number ?? '—'}</td><td>${e.label}</td><td>${e.lines.map((l) => html`<div class="mono">${l.account} ${l.debit ? `D ${eur(l.debit)}` : `C ${eur(l.credit)}`}</div>`)}</td></tr>`)}</tbody></table></div>`;
    });
  } else if (tab === 'archives') {
    body = archivesView();
  } else {
    const drafts = ws.ledger.entries.filter((e) => e.status === 'draft').length;
    body = html`<div class="card" style="display:flex;flex-direction:column;gap:14px">
      <p>Écritures en brouillon : <strong>${drafts}</strong>. Période verrouillée jusqu'au : <strong>${ws.ledger.lockedThrough ? frDate(ws.ledger.lockedThrough) : 'aucune'}</strong>.</p>
      <div class="notice-gold">La validation numérote définitivement les écritures dans l'ordre chronologique et verrouille la période : une écriture validée ne se modifie plus (correction par contre-passation).</div>
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">${field("Valider jusqu'au", html`<input class="input" type="date" data-validate-date value="${today()}">`)}<button class="btn btn-primary" data-action="validate" style="margin-bottom:2px">Valider la période</button></div>
      <h3 class="form-subsection-title">Fichier des écritures comptables (FEC)</h3>
      <p class="text-muted">Export conforme à l'article A47 A-1 du LPF, à contrôler avec l'outil Test Compta Demat de la DGFiP. Toutes les écritures doivent être validées.</p>
      <div><button class="btn btn-secondary" data-action="fec" ${drafts ? raw('disabled title="Validez d’abord toutes les écritures"') : ''}>Télécharger le FEC</button></div></div>`;
  }
  const exportable = tab !== 'cloture' && tab !== 'archives';
  return html`
    ${viewHeader('Comptabilité', 'Vue avancée pour vous et votre expert-comptable.', exportable ? html`<button class="btn btn-secondary no-print" data-action="export-state" data-tab="${tab}">Exporter (Excel)</button><button class="btn btn-secondary no-print" data-action="print">Imprimer / PDF</button>` : '')}
    <div class="tabs no-print" style="margin-bottom:14px">${tabs.map(([k, l]) => html`<button class="tab ${k === tab ? 'active' : ''}" data-action="compta-tab" data-tab="${k}">${l}</button>`)}</div>
    ${body}`;
}

// ------------------------------------------------------------------ clôture de l'exercice (lot 3)

const CHARGE_ACCOUNTS = [['613200', 'Loyer'], ['616000', 'Assurances'], ['628000', 'Abonnements et logiciels'], ['606100', 'Électricité, gaz, eau'], ['626000', 'Téléphone, internet'], ['622600', 'Honoraires'], ['604000', 'Sous-traitance'], ['615000', 'Entretien et réparations']];
const REVENUE_ACCOUNTS = [['706000', 'Prestations de services'], ['707000', 'Ventes de marchandises'], ['701000', 'Ventes de produits fabriqués']];

function statementTable(title, rows, total, totalLabel) {
  return html`<div class="card table-card"><h3 style="padding:14px 16px 0">${title}</h3><table class="table"><tbody>
    ${rows.filter(([, v]) => v).map(([l, v]) => html`<tr><td>${l}</td><td class="num">${eur(v)}</td></tr>`)}
    <tr><td><strong>${totalLabel}</strong></td><td class="num"><strong>${eur(total)}</strong></td></tr></tbody></table></div>`;
}

function viewClosing() {
  if (ui.mode !== 'avance') return html`<div class="empty-state"><p>Activez le mode avancé dans les paramètres.</p><button class="btn btn-primary" data-href="#/parametres">Paramètres</button></div>`;
  const fy = ws.company.fiscalYear;
  const checklist = closingChecklist(ws, { today: today() });
  const inventory = ws.ledger.entries.filter((e) => e.source?.kind === 'inventory');
  const pnl = incomeStatement(ws.ledger);
  const bs = balanceSheet(ws.ledger);
  const isCompanyTax = ws.company.taxRegime === 'is-reel';
  const opts = ui.isOptions || { addBacks: '', previousLosses: '', reducedRateEligible: true };
  const toCents = (s) => { try { return s ? parseEuros(s) : 0; } catch { return 0; } };
  const is = isCompanyTax ? ws.computeCorporateTax({ addBacks: toCents(opts.addBacks), previousLosses: toCents(opts.previousLosses), reducedRateEligible: opts.reducedRateEligible }) : null;
  const isPaid = ws.ledger.lines().filter((l) => l.account === '444000' && l.entry.source?.type !== 'corporate-tax').reduce((s, l) => s + l.debit - l.credit, 0);
  const society = ws.company.legalForm !== 'EI';
  const canClose = ui.demo || !society || cloudState.role === 'expert';
  const it = ui.inventoryForm || { type: 'prepaid' };
  const accounts = ['deferred', 'receivable'].includes(it.type) ? REVENUE_ACCOUNTS : CHARGE_ACCOUNTS;
  const clientsDue = ws.receivables(fy.end).filter((r) => r.outstanding > 0);
  return html`
    ${viewHeader(`Clôture de l'exercice ${fiscalYearLabel(fy)}`, `Du ${frDate(fy.start)} au ${frDate(fy.end)} : inventaire, impôt, comptes annuels.`, html`<button class="btn btn-secondary no-print" data-action="print">Imprimer / PDF</button>`)}
    ${allocationCard()}
    <div class="card action-center no-print"><h2>1. Check-list</h2><div class="action-center-list">
      ${checklist.map((i) => html`<button type="button" class="action-center-item" ${i.view ? raw(`data-href="#/${i.view}"`) : ''}>
        <span class="action-center-icon">${raw(ICONS[i.ok ? 'checkCircle' : 'warningTriangle'])}</span>
        <span class="action-center-label">${i.label} — <span class="text-muted">${i.detail}</span></span>
        <span class="action-center-arrow">${i.view ? '→' : ''}</span></button>`)}
    </div></div>

    <div class="card no-print" style="display:flex;flex-direction:column;gap:12px">
      <h2>2. Écritures d'inventaire</h2>
      ${inventory.length ? html`<table class="table"><tbody>${inventory.map((e) => html`<tr><td>${e.label}</td><td class="num">${eur(e.lines[0].debit)}</td><td>${e.status === 'draft' ? html`<button class="btn-link" data-action="inventory-delete" data-id="${e.id}">Supprimer</button>` : badge('Validée', 'success')}</td></tr>`)}</tbody></table>` : html`<p class="text-muted">Aucune écriture d'inventaire pour l'instant.</p>`}
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-secondary" data-action="depreciation-book">Passer les dotations aux amortissements</button></div>
      <div class="form-grid">
        ${field('Type', html`<select class="input" data-inv="type" data-rerender-inv>${Object.entries(INVENTORY_TYPES).map(([k, v]) => opt(k, v.label, it.type === k))}</select>`, { hint: INVENTORY_TYPES[it.type].help })}
        ${it.type === 'doubtful'
          ? field('Client concerné', html`<select class="input" data-inv="aux">${clientsDue.map((r) => opt(ws.invoiceAux(r.invoice), `${r.invoice.client.name} — ${r.invoice.number} (${eur(r.outstanding)})`, it.aux === ws.invoiceAux(r.invoice)))}</select>`)
          : field('Compte concerné', html`<select class="input" data-inv="account">${accounts.map(([k, l]) => opt(k, l, it.account === k))}</select>`)}
        ${field('Montant HT', html`<input class="input" data-inv="amount" inputmode="decimal" placeholder="0,00" value="${it.amount || ''}">`)}
        ${field('Libellé (facultatif)', html`<input class="input" data-inv="label" value="${it.label || ''}">`)}
      </div>
      <div><button class="btn btn-primary" data-action="inventory-add">Ajouter l'écriture</button></div>
    </div>

    ${isCompanyTax ? html`<div class="card no-print" style="display:flex;flex-direction:column;gap:12px">
      <h2>3. Impôt sur les sociétés</h2>
      <div class="form-grid">
        ${field('Charges non déductibles à réintégrer', html`<input class="input" data-is="addBacks" inputmode="decimal" placeholder="0,00" value="${opts.addBacks}">`, { hint: 'Amendes, part non déductible des cadeaux…' })}
        ${field('Déficits des années précédentes', html`<input class="input" data-is="previousLosses" inputmode="decimal" placeholder="0,00" value="${opts.previousLosses}">`)}
      </div>
      <label class="form-field-checkbox" style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-is="reducedRateEligible" ${opts.reducedRateEligible ? raw('checked') : ''}>Taux réduit de 15 % applicable (chiffre d'affaires &lt; 10 M€, capital entièrement libéré et détenu à 75 % au moins par des personnes physiques)</label>
      <table class="table"><tbody>
        <tr><td>Résultat avant impôt</td><td class="num">${eur(pnl.resultBeforeTax)}</td></tr>
        <tr><td>Bénéfice imposable</td><td class="num">${eur(is.taxable)}</td></tr>
        <tr><td>dont à 15 %</td><td class="num">${eur(is.atReduced)}</td></tr>
        <tr><td>dont à 25 %</td><td class="num">${eur(is.atNormal)}</td></tr>
        <tr><td><strong>Impôt de l'exercice</strong></td><td class="num"><strong>${eur(is.tax)}</strong></td></tr>
        <tr><td>Acomptes déjà versés</td><td class="num">${eur(isPaid)}</td></tr>
        <tr><td><strong>${is.tax - isPaid >= 0 ? 'Solde à payer' : 'Excédent à récupérer'}</strong></td><td class="num"><strong>${eur(Math.abs(is.tax - isPaid))}</strong></td></tr>
      </tbody></table>
      <div><button class="btn btn-primary" data-action="is-book" data-tax="${is.tax}">Comptabiliser l'impôt (${eur(is.tax)})</button></div>
      <p class="form-hint">Solde à payer au plus tard le 15 du 4e mois suivant la clôture (15 mai pour un exercice clos le 31 décembre). Calcul à faire valider par votre expert-comptable.</p>
    </div>` : ''}

    <h2 style="margin:18px 0 10px">${isCompanyTax ? '4' : '3'}. Comptes annuels</h2>
    <div class="grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px">
      ${statementTable('Bilan — actif', Object.entries(bs.assets), bs.totalAssets, 'Total actif')}
      ${statementTable('Bilan — passif', Object.entries(bs.liabilities), bs.totalLiabilities, 'Total passif')}
    </div>
    ${!bs.balanced ? html`<div class="issues-box">Le bilan n'est pas équilibré (écart de ${eur(bs.totalAssets - bs.totalLiabilities)}) : contactez le support.</div>` : ''}
    <div class="grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px">
      ${statementTable('Produits d’exploitation', Object.entries(pnl.operatingIncome), pnl.opIncome, 'Total des produits')}
      ${statementTable('Charges d’exploitation', Object.entries(pnl.operatingCharges), pnl.opCharges, 'Total des charges')}
    </div>
    <div class="card table-card"><table class="table"><tbody>
      <tr><td>Résultat d'exploitation</td><td class="num">${eur(pnl.operatingResult)}</td></tr>
      <tr><td>Résultat financier</td><td class="num">${eur(pnl.financialIncome - pnl.financialCharges)}</td></tr>
      <tr><td>Résultat exceptionnel</td><td class="num">${eur(pnl.exceptionalIncome - pnl.exceptionalCharges)}</td></tr>
      <tr><td>Impôt sur les bénéfices</td><td class="num">${eur(pnl.incomeTax)}</td></tr>
      <tr><td><strong>Résultat net</strong></td><td class="num"><strong>${eur(pnl.netResult)}</strong></td></tr>
    </tbody></table></div>
    <p class="form-hint">Présentation simplifiée (rubriques des formulaires 2033-A et 2033-B) ; la correspondance compte par compte et la liasse fiscale sont à valider par votre expert-comptable avant dépôt.</p>

    <div class="card no-print" style="display:flex;flex-direction:column;gap:10px">
      <h2>${isCompanyTax ? '5' : '4'}. Clôturer l'exercice</h2>
      <p class="text-muted">La clôture détermine le résultat, valide définitivement toutes les écritures de l'exercice (plus aucune modification possible) et ouvre l'exercice suivant avec son bilan d'ouverture.</p>
      ${!canClose ? html`<div class="notice-gold">Pour une société, la clôture est réalisée par votre expert-comptable : invitez-le depuis les <a href="#/parametres">paramètres</a>, il la validera depuis son propre accès.</div>` : ''}
      ${ui.demo && society ? html`<p class="form-hint">Démonstration : dans l'application réelle, la clôture d'une société est réservée à l'expert-comptable invité.</p>` : ''}
      <div><button class="btn btn-primary" data-action="close-year" ${canClose && today() > fy.end ? '' : raw('disabled')}>Clôturer l'exercice ${fiscalYearLabel(fy)}</button></div>
      ${today() <= fy.end ? html`<p class="form-hint">Disponible à partir du ${frDate(new Date(Date.parse(fy.end + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10))}.</p>` : ''}
    </div>`;
}

/** Affectation du résultat de l'exercice précédent (tant qu'elle n'est pas faite). */
function allocationCard() {
  const { result, legalReserveMin, proposal } = allocationProposal(ws.ledger, ws.company);
  if (!result || ws.ledger.entries.some((e) => e.source?.kind === 'allocation')) return '';
  const ei = ws.company.legalForm === 'EI';
  const f = ui.allocationForm || Object.fromEntries(Object.entries(proposal).map(([k, v]) => [k, v ? (v / 100).toFixed(2).replace('.', ',') : '']));
  const input = (key, label, hint) => field(label, html`<input class="input" data-alloc="${key}" inputmode="decimal" placeholder="0,00" value="${f[key] || ''}">`, { hint });
  return html`<div class="card no-print" style="display:flex;flex-direction:column;gap:12px;border:2px solid var(--landing-gold-500)">
    <h2>Affectation du résultat de l'exercice précédent</h2>
    <p>${result > 0 ? 'Bénéfice' : 'Perte'} à affecter : <strong>${eur(Math.abs(result))}</strong>. ${ei ? 'En entreprise individuelle, il rejoint votre compte de l’exploitant.' : 'À répartir selon la décision de l’assemblée des associés (dans les 6 mois de la clôture).'}</p>
    ${ei ? '' : html`<div class="form-grid">
      ${result > 0 ? input('legalReserve', 'Réserve légale', `Minimum : ${eur(legalReserveMin)} (5 % du bénéfice, jusqu'à 10 % du capital).`) : ''}
      ${result > 0 ? input('otherReserves', 'Autres réserves') : ''}
      ${result > 0 ? input('dividends', 'Dividendes') : ''}
      ${input('retained', 'Report à nouveau', result < 0 ? 'Une perte est reportée : elle viendra en déduction des bénéfices futurs.' : '')}
    </div>`}
    <div><button class="btn btn-primary" data-action="allocate-result">Enregistrer l'affectation</button></div>
  </div>`;
}

/** Passe à l'exercice suivant après la clôture (et l'enregistre en base en mode connecté). */
async function closeYearFlow() {
  const fy = ws.company.fiscalYear;
  const pending = closingChecklist(ws, { today: today() }).filter((i) => !i.ok);
  const warning = pending.length ? ` Attention, ${pending.length} point(s) de la check-list ne sont pas réglés : ${pending.map((i) => i.detail).join(' ; ')}.` : '';
  if (!confirm(`Clôturer l'exercice ${fiscalYearLabel(fy)} ? Toutes ses écritures seront validées définitivement et l'exercice suivant sera ouvert.${warning}`)) return;
  let next;
  try {
    next = ws.closeYear(today());
  } catch (err) {
    return toast(err.message, true);
  }
  if (ui.demo) {
    ws = next;
    save();
    location.hash = '#/accueil';
    render();
    return toast(`Exercice clôturé. Bienvenue dans l'exercice ${fiscalYearLabel(next.company.fiscalYear)}.`);
  }
  try {
    save(); // détermination du résultat + validation de l'exercice
    await cloudState.outbox.waitIdle();
    const nextFiscalYearId = await cloud.closeFiscalYear(cloudState.meta.fiscalYearId);
    cloudState.meta = { ...cloudState.meta, fiscalYearId: nextFiscalYearId };
    ws = next;
    // En base, le nouvel exercice n'a encore aucune écriture : le bilan d'ouverture et les extournes partent maintenant.
    const synced = JSON.parse(JSON.stringify(next));
    synced.ledger = { ...synced.ledger, entries: [], lockedThrough: null };
    cloudState.synced = synced;
    save();
    location.hash = '#/accueil';
    render();
    toast(`Exercice clôturé. Bienvenue dans l'exercice ${fiscalYearLabel(next.company.fiscalYear)}.`);
  } catch (err) {
    toast(`Clôture refusée : ${cloud.friendly(err)}`, true);
    await openStructure(cloudState.meta.structureId);
    render();
  }
}

// ------------------------------------------------------------------ exercices clos (consultation)

/** Liste des exercices clos : archives locales en démonstration, base de données sinon. */
function closedYears() {
  if (ui.demo) return ws.archives.map((a) => ({ key: a.fiscalYear.start, fiscalYear: a.fiscalYear }));
  if (!ui.closedYears && cloudState.meta) {
    ui.closedYears = [];
    cloud.closedFiscalYears(cloudState.meta.structureId).then((rows) => {
      ui.closedYears = rows.map((r) => ({ key: r.start_date, id: r.id, row: r, fiscalYear: { start: r.start_date, end: r.end_date } }));
      render();
    }).catch(() => {});
  }
  return ui.closedYears || [];
}

async function openArchive(key) {
  const year = closedYears().find((y) => y.key === key);
  if (!year) return;
  let state;
  if (ui.demo) state = ws.archives.find((a) => a.fiscalYear.start === key).ledger;
  else state = ledgerStateFromRows(await cloud.fiscalYearEntries(cloudState.meta.structureId, year.id), year.row);
  ui.archive = { key, fiscalYear: year.fiscalYear, ledger: new Ledger({ chart: ws.chart, fiscalYear: year.fiscalYear, state: structuredClone(state) }) };
  render();
}

function archivesView() {
  const years = closedYears();
  if (!years.length) return html`<div class="card"><div class="empty-state"><p class="text-muted">Aucun exercice clôturé pour l'instant.</p></div></div>`;
  const a = ui.archive;
  const pick = html`<div class="tabs" style="margin-bottom:14px">${years.map((y) => html`<button class="tab ${a?.key === y.key ? 'active' : ''}" data-action="archive-open" data-key="${y.key}">Exercice ${fiscalYearLabel(y.fiscalYear)}</button>`)}</div>`;
  if (!a) return html`${pick}<p class="text-muted">Choisissez un exercice pour consulter ses comptes.</p>`;
  const pnl = incomeStatement(a.ledger);
  const bs = balanceSheet(a.ledger);
  const tb = trialBalance(a.ledger);
  return html`${pick}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px"><button class="btn btn-secondary" data-action="archive-fec">Télécharger le FEC ${fiscalYearLabel(a.fiscalYear)}</button><button class="btn btn-secondary" data-action="print">Imprimer / PDF</button></div>
    <div class="grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px">
      ${statementTable('Bilan — actif', Object.entries(bs.assets), bs.totalAssets, 'Total actif')}
      ${statementTable('Bilan — passif', Object.entries(bs.liabilities).map(([k, v]) => [k === 'Résultat antérieur en attente d’affectation' ? 'Résultat de l’exercice' : k, v]), bs.totalLiabilities, 'Total passif')}
    </div>
    <div class="card table-card"><table class="table"><tbody>
      <tr><td>Chiffre d'affaires</td><td class="num">${eur(pnl.revenue)}</td></tr>
      <tr><td>Résultat d'exploitation</td><td class="num">${eur(pnl.operatingResult)}</td></tr>
      <tr><td>Impôt sur les bénéfices</td><td class="num">${eur(pnl.incomeTax)}</td></tr>
      <tr><td><strong>Résultat net</strong></td><td class="num"><strong>${eur(pnl.netResult)}</strong></td></tr>
    </tbody></table></div>
    <div class="card table-card"><h3 style="padding:14px 16px 0">Balance de clôture</h3><div class="table-scroll"><table class="table"><thead><tr><th>Compte</th><th>Libellé</th><th class="num">Débit</th><th class="num">Crédit</th></tr></thead><tbody>
      ${tb.rows.map((r) => html`<tr><td class="mono">${r.account}</td><td>${r.label}</td><td class="num">${eur(r.debit)}</td><td class="num">${eur(r.credit)}</td></tr>`)}
    </tbody><tfoot><tr><td colspan="2">Total</td><td class="num">${eur(tb.totals.debit)}</td><td class="num">${eur(tb.totals.credit)}</td></tr></tfoot></table></div></div>`;
}

// ------------------------------------------------------------------ immobilisations

function viewAssets() {
  const assets = fixedAssets(ws.purchases, ws.company, ws.company.fiscalYear);
  const fyYear = ws.company.fiscalYear.end.slice(0, 4);
  if (!assets.length) {
    return html`<div class="card"><div class="empty-state"><div class="empty-icon">${raw(ICONS.package)}</div><h3>Aucune immobilisation</h3><p class="text-muted">Un équipement acheté plus de 500 € HT (ordinateur, mobilier…) est inscrit ici automatiquement quand vous enregistrez la dépense.</p></div></div>`;
  }
  return html`
    <div class="notice-gold" style="margin-bottom:14px">Un équipement durable ne passe pas en charge d'un coup : son coût est réparti sur sa durée d'usage (amortissement). Les dotations sont passées à la clôture de l'exercice ; durées par défaut à confirmer avec votre expert-comptable.</div>
    <div class="card table-card"><div class="table-scroll"><table class="table"><thead><tr><th>Bien</th><th>Acquis le</th><th class="num">Coût</th><th>Durée</th><th class="num">Dotation ${fyYear}</th><th class="num">Valeur nette fin ${fyYear}</th></tr></thead><tbody>
      ${assets.map((a) => html`<tr>
        <td>${a.label}<details style="margin-top:4px"><summary class="text-muted" style="cursor:pointer;font-size:12px">Plan d'amortissement</summary><table class="table" style="margin-top:6px"><tbody>${a.schedule.map((s) => html`<tr><td>${s.year}</td><td class="num">${eur(s.dotation)}</td><td class="num text-muted">reste ${eur(s.vnc)}</td></tr>`)}</tbody></table></details></td>
        <td>${frDate(a.date)}</td>
        <td class="num">${eur(a.cost)}</td>
        <td><select class="input input-sm" data-action="asset-years" data-id="${a.id}" style="width:auto">${[1, 2, 3, 4, 5, 6, 7, 8, 10, 15, 20].map((n) => opt(n, `${n} an${n > 1 ? 's' : ''}`, a.years === n))}</select></td>
        <td class="num">${eur(a.dotationThisYear)}</td>
        <td class="num">${eur(a.netBookValue)}</td></tr>`)}
    </tbody></table></div></div>`;
}

// ------------------------------------------------------------------ paramètres

function viewSettings() {
  const c = ws.company;
  return html`
    ${viewHeader('Paramètres', 'Informations imprimées sur vos factures et préférences d’affichage.')}
    <form class="card" data-form="company" style="display:flex;flex-direction:column;gap:14px">
      <h2>Mon entreprise</h2>
      <div class="form-grid">
        ${field('Nom', html`<input class="input" name="name" value="${c.name}">`)}
        ${field('SIREN', html`<input class="input" name="siren" value="${c.siren}" inputmode="numeric">`)}
        ${field('Forme juridique', html`<select class="input" name="legalForm">${['EI', 'EURL', 'SARL', 'SAS', 'SASU'].map((f) => opt(f, f, c.legalForm === f))}</select>`)}
        ${field('Capital social', html`<input class="input" name="capital" value="${c.capital || ''}" placeholder="Ex. : 1 000 €">`, { hint: 'Obligatoire sur les factures d’une société.' })}
        ${field('Adresse', html`<input class="input" name="address" value="${c.address}">`)}
        ${field('N° de TVA intracommunautaire', html`<input class="input" name="vatNumber" value="${c.vatNumber || ''}">`)}
        ${field('IBAN (affiché sur les factures)', html`<input class="input" name="iban" value="${c.iban || ''}">`)}
        ${field('Délai de paiement (jours)', html`<input class="input" name="paymentTermsDays" inputmode="numeric" value="${c.paymentTermsDays || 30}">`)}
      </div>
      <label class="form-field-checkbox" style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="vatOnDebits" ${c.vatOnDebits ? raw('checked') : ''}>J'ai opté pour le paiement de la TVA d'après les débits</label>
      <div><button class="btn btn-primary" type="submit">Enregistrer</button></div>
    </form>
    <div class="card" style="display:flex;flex-direction:column;gap:10px">
      <h2>Affichage</h2>
      <label class="form-field-checkbox" style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-action="mode" ${ui.mode === 'avance' ? raw('checked') : ''}>Mode avancé : afficher la comptabilité (balance, grand livre, journaux, FEC)</label>
    </div>
    ${membersCard()}
    ${ws.ledger.entries.some((e) => e.source?.kind === 'fec-import') ? '' : html`<div class="card" style="display:flex;flex-direction:column;gap:10px">
      <h2>Reprise d'historique</h2>
      <p class="text-muted">Importez le FEC de l'exercice précédent : Nexus reprend les soldes de bilan, le résultat et la liste de vos clients.</p>
      ${ui.pendingOpening
        ? html`${openingPreview(ui.pendingOpening.opening, ui.pendingOpening.fileName)}<div style="display:flex;gap:8px"><button class="btn btn-primary" data-action="opening-import">Importer ce bilan d'ouverture</button><button class="btn btn-secondary" data-action="opening-cancel">Annuler</button></div>`
        : field('Fichier des écritures comptables (FEC)', html`<input class="input" type="file" accept=".txt,.csv" data-action="settings-fec-file" style="max-width:420px">`)}
    </div>`}
    <div class="card" style="display:flex;flex-direction:column;gap:10px">
      <h2>Mes données</h2>
      <p class="text-muted">${ui.demo ? 'Démonstration : ces données fictives restent dans ce navigateur.' : 'Vos données sont enregistrées en base (hébergement à Paris), accessibles uniquement avec votre mot de passe et votre code de vérification.'}</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-secondary" data-action="backup">Télécharger une copie de mes données</button><button class="btn btn-secondary" data-action="${ui.demo ? 'demo-exit' : 'sign-out'}">${ui.demo ? 'Quitter la démonstration' : 'Se déconnecter'}</button></div>
    </div>`;
}

// ------------------------------------------------------------------ démonstration

function seedDemo() {
  ui.demo = true;
  const year = Number(today().slice(0, 4));
  const d = (m, day) => `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const now = new Date();
  const cm = now.getMonth() + 1;
  const back = (months, day) => new Date(Date.UTC(year, cm - 1 - months, day)).toISOString().slice(0, 10);
  ws = new Workspace({ company: {
    name: 'Atelier Durand EURL', siren: '732829320', address: '12 rue des Lilas, 69003 Lyon', legalForm: 'EURL', capital: '1 000 €',
    vatRegime: 'reel-normal', vatNumber: vatNumberFromSiren('732829320'), vatOnDebits: false, taxRegime: 'is-reel', defaultNature: 'services',
    fiscalYear: { start: d(1, 1), end: d(12, 31) }, paymentTermsDays: 30, iban: 'FR76 3000 4000 0500 0012 3456 789',
  } });
  const martin = ws.saveClient({ name: 'Martin SAS', siren: '552100554', address: '1 place Bellecour, 69002 Lyon', email: 'compta@martin.example' });
  const bio = ws.saveClient({ name: 'Bio & Co SARL', siren: '443061841', address: '8 quai Rambaud, 69002 Lyon', email: 'factures@bioco.example' });
  ws.ledger.addDraft({ journal: 'AN', date: d(1, 1), label: "Solde bancaire à l'ouverture", lines: [{ account: '512000', debit: 850000 }, { account: '455000', credit: 850000 }] });
  const mk = (client, issue, due, lines) => ws.issueInvoice(ws.book.createDraft({ client, issueDate: issue, dueDate: due, lines }).id);
  const f1 = mk(martin, back(3, 5), back(2, 5), [{ label: 'Accompagnement stratégique', qty: 4, unitPrice: 65000, vatRateBp: 2000, nature: 'services' }]);
  mk(bio, back(2, 10), back(1, 9), [{ label: 'Audit des process', qty: 1, unitPrice: 180000, vatRateBp: 2000, nature: 'services' }]);
  const f3 = mk(martin, back(1, 3), back(0, 3), [{ label: 'Atelier équipe', qty: 2, unitPrice: 90000, vatRateBp: 2000, nature: 'services' }, { label: 'Supports imprimés', qty: 20, unitPrice: 1250, vatRateBp: 2000, nature: 'biens' }]);
  ws.book.createDraft({ client: bio, issueDate: today(), dueDate: back(-1, now.getDate()), lines: [{ label: 'Suivi mensuel', qty: 1, unitPrice: 75000, vatRateBp: 2000, nature: 'services' }] });
  ws.addPurchase({ supplier: { name: 'Orange' }, date: back(2, 2), number: 'OR-2211', categoryId: 'telecom', ttc: 4799, documentName: 'orange.pdf' });
  ws.addPurchase({ supplier: { name: 'LDLC' }, date: back(2, 15), number: 'LD-9087', categoryId: 'materiel-info', ttc: 162000, documentName: 'ldlc.pdf' });
  ws.addPurchase({ supplier: { name: 'Regus' }, date: back(1, 1), number: 'RG-445', categoryId: 'loyer', ttc: 54000, documentName: 'regus.pdf' });
  const money = (c) => (c / 100).toFixed(2).replace('.', ',');
  ws.importTransactions(parseBankCsv([
    'Date;Libellé;Montant',
    `${frDate(back(2, 8))};VIR MARTIN SAS ${f1.number};${money(f1.totals.totalTtc)}`,
    `${frDate(back(2, 4))};PRLV ORANGE OR-2211;-47,99`,
    `${frDate(back(2, 18))};CB LDLC LD-9087;-1620,00`,
    `${frDate(back(1, 2))};PRLV REGUS RG-445;-540,00`,
    `${frDate(back(1, 28))};FRAIS TENUE DE COMPTE;-9,00`,
    `${frDate(back(0, 2))};VIR MARTIN SAS ${f3.number};${money(f3.totals.totalTtc)}`,
    `${frDate(back(0, 1))};CB SNCF PARIS LYON;-89,00`,
  ].join('\n')));
  for (const t of ws.transactions.slice(0, 4)) {
    const [best] = ws.suggestionsFor(t.id);
    if (best) ws.matchTransaction(t.id, best.docs.map((doc, i) => ({ doc, amount: best.amounts[i] })));
  }
  save();
  location.hash = '#/accueil';
  render();
  toast('Entreprise de démonstration chargée.');
}

// ------------------------------------------------------------------ installation (PWA)

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});

// ------------------------------------------------------------------ évènements

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  const last = keys.at(-1);
  o[last] = last === 'vatRateBp' ? Number(value) : value;
}

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.ob) {
    ui.ob.data[el.dataset.ob] = el.value;
    if (el.type === 'radio') render();
    return;
  }
  if (el.dataset.statement !== undefined) {
    ui.statementBalance = el.value;
    return;
  }
  if (el.id === 'global-search-input') {
    const results = searchResults(el.value);
    const box = $('global-search-results');
    box.innerHTML = html`${results.map((r) => html`<div class="search-result-item" data-href="${r.href}"><span class="search-result-icon">${raw(ICONS[r.icon])}</span><div><div class="search-result-label">${r.label}</div><div class="search-result-sublabel">${r.sub}</div></div></div>`)}${el.value.trim().length >= 2 && !results.length ? html`<div class="search-result-item"><div class="search-result-sublabel">Aucun résultat</div></div>` : ''}`.s;
    box.classList.toggle('open', el.value.trim().length >= 2);
    return;
  }
  const form = el.closest('form[data-form="invoice"]');
  if (form && el.name) {
    setPath(ui.draft, el.name, el.value);
    if (el.hasAttribute('data-rerender')) return render();
    const m = /^lines\.(\d+)\.priceText$/.exec(el.name);
    if (m) {
      try {
        ui.draft.lines[m[1]].unitPrice = el.value ? parseEuros(el.value) : 0;
      } catch {
        return;
      }
    }
    if (/^lines\.\d+\.qty$/.test(el.name)) ui.draft.lines[el.name.split('.')[1]].qty = Number(el.value.replace(',', '.')) || 0;
    $('totals').innerHTML = totalsBlock().s;
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.statement !== undefined) return render();
  if (el.dataset.action === 'ob-fec-file' && el.files[0]) {
    try {
      Object.assign(ui.ob.data, { opening: await readOpeningFile(el.files[0]), fecFileName: el.files[0].name });
      ui.ob.error = '';
    } catch (err) {
      Object.assign(ui.ob.data, { opening: null });
      ui.ob.error = err.message;
    }
    return render();
  }
  if (el.dataset.action === 'settings-fec-file' && el.files[0]) {
    try {
      ui.pendingOpening = { opening: await readOpeningFile(el.files[0]), fileName: el.files[0].name };
    } catch (err) {
      toast(err.message, true);
    }
    return render();
  }
  if (el.dataset.action === 'ob-bank-file' && el.files[0]) {
    try {
      Object.assign(ui.ob.data, { bankFileName: el.files[0].name, bankTx: await importBankFile(el.files[0]) });
    } catch (err) {
      ui.ob.error = err.message;
    }
    return render();
  }
  if (el.dataset.action === 'bank-file' && el.files[0]) {
    try {
      const added = ws.importTransactions(await importBankFile(el.files[0]));
      save();
      render();
      toast(added.length ? `${added.length} nouvelle(s) transaction(s) importée(s).` : 'Aucune nouvelle transaction : ce relevé était déjà importé.');
    } catch (err) {
      toast(err.message, true);
    }
    return;
  }
  if (el.dataset.action === 'einvoice-in-file' && el.files[0]) {
    try {
      const inv = readIncomingInvoice(await el.files[0].text(), { ownSiren: ws.company.siren });
      ui.pendingEinvoice = { inv, file: el.files[0] };
      ui.expensesTab = 'depenses';
    } catch (err) {
      toast(err.message, true);
    }
    return render();
  }
  if (el.dataset.alloc) {
    ui.allocationForm = { ...(ui.allocationForm || {}), ...Object.fromEntries([...document.querySelectorAll('[data-alloc]')].map((e) => [e.dataset.alloc, e.value])) };
    return;
  }
  if (el.dataset.inv === 'type') {
    ui.inventoryForm = { type: el.value };
    return render();
  }
  if (el.dataset.is) {
    ui.isOptions = { ...(ui.isOptions || { addBacks: '', previousLosses: '', reducedRateEligible: true }), [el.dataset.is]: el.type === 'checkbox' ? el.checked : el.value };
    return render();
  }
  if (el.dataset.action === 'asset-years') {
    ws.company.assetYears = { ...(ws.company.assetYears || {}), [el.dataset.id]: Number(el.value) };
    save();
    render();
    return toast('Durée d’amortissement enregistrée.');
  }
  if (el.dataset.action === 'toggle-deposit') {
    const ids = ui.draft.depositIds;
    ui.draft.depositIds = el.checked ? [...ids, el.dataset.id] : ids.filter((x) => x !== el.dataset.id);
    $('totals').innerHTML = totalsBlock().s;
    return;
  }
  if (el.dataset.action === 'mode') {
    ui.mode = el.checked ? 'avance' : 'standard';
    savePrefs();
    return render();
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && $('global-search-input')?.offsetParent) {
    e.preventDefault();
    $('global-search-input').focus();
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  const kind = form.dataset.form;
  e.preventDefault();
  const fd = new FormData(form);
  const f = Object.fromEntries(fd);

  if (kind === 'purchase') {
    const file = fd.get('document');
    ui.pendingPurchase = { form: { ...f, document: undefined }, file: file && file.size ? file : null };
    try {
      const data = { supplier: { name: f.supplier.trim() }, date: f.date, number: f.number.trim(), categoryId: f.categoryId, ttc: parseEuros(f.ttc), vatRateBp: Number(f.vatRateBp ?? 0), documentName: file && file.size ? file.name : '', type: f.docType === 'credit' ? 'credit' : 'invoice' };
      if (!data.supplier.name) throw new Error('Indiquez le fournisseur.');
      if (data.ttc <= 0) throw new Error('Le montant doit être positif.');
      ui.pendingPurchase.data = data;
      const res = ws.addPurchase(data);
      if (!res.purchase) {
        ui.pendingPurchase.duplicates = res.duplicates;
        return render();
      }
      const pendingFile = ui.pendingPurchase.file;
      ui.pendingPurchase = null;
      save();
      render();
      toast('Dépense enregistrée.');
      attachReceipt(res.purchase, pendingFile);
    } catch (err) {
      ui.pendingPurchase.error = err.message.startsWith('Montant invalide') ? 'Le montant saisi n’est pas valide (exemple : 49,90).' : err.message;
      render();
    }
    return;
  }
  if (kind === 'recurring') {
    ui.recurringForm = { ...f, autoIssue: fd.has('autoIssue') };
    try {
      const client = ws.clients.find((x) => x.id === f.clientId);
      const unitPrice = parseEuros(f.price || '');
      ws.saveRecurring({
        client: structuredClone(client),
        lines: [{ label: (f.label || '').trim(), qty: 1, unitPrice, vatRateBp: Number(f.vatRateBp ?? 0), nature: f.nature }],
        frequency: f.frequency,
        anchorDate: f.anchorDate,
        endDate: f.endDate || null,
        paymentDays: Number(f.paymentDays) || 0,
        autoIssue: fd.has('autoIssue'),
      });
      ui.recurringForm = null;
      ui.recurringRanOn = null; // une échéance déjà atteinte est préparée tout de suite
      save();
      render();
      toast('Facture récurrente créée.');
    } catch (err) {
      ui.recurringForm.error = err.message.startsWith('Montant invalide') ? 'Le prix saisi n’est pas valide (exemple : 750,00).' : err.message;
      render();
    }
    return;
  }
  if (kind === 'company') {
    const siren = f.siren.replace(/\s/g, '');
    if (!isValidSiren(siren)) return toast('Le SIREN saisi n’est pas valide.', true);
    Object.assign(ws.company, { ...f, siren, vatOnDebits: fd.has('vatOnDebits'), paymentTermsDays: Number(f.paymentTermsDays) || 30 });
    save();
    render();
    return toast('Paramètres enregistrés.');
  }
  if (kind === 'mfa') {
    ui.mfa = { ...ui.mfa, busy: true, error: '' };
    render();
    try {
      await cloud.mfaVerify(ui.mfa.factorId, f.code);
      ui.mfa = null;
      await afterSignIn();
    } catch (err) {
      ui.mfa = { ...ui.mfa, busy: false, error: cloud.friendly(err) };
      render();
    }
    return;
  }
  if (!['login', 'signup', 'forgot', 'resend', 'new-password'].includes(kind)) return;
  const a = ui.auth;
  Object.assign(a, { busy: true, error: '', info: '', email: f.email || a.email });
  render();
  try {
    if (kind === 'login') {
      cloudState.session = (await cloud.signIn(f.email, f.password)).session;
      a.busy = false;
      return afterSignIn();
    }
    if (kind === 'signup') {
      const res = await cloud.signUp(f.email, f.password);
      if (res.session) {
        cloudState.session = res.session;
        a.busy = false;
        return afterSignIn();
      }
      Object.assign(a, { view: 'login', info: `Compte créé pour ${f.email}. Vérifiez votre boîte mail et cliquez sur le lien de confirmation avant de vous connecter.` });
    }
    if (kind === 'forgot') {
      await cloud.resetPassword(f.email);
      a.info = 'Si un compte existe pour cette adresse, un lien de réinitialisation vient de vous être envoyé.';
    }
    if (kind === 'resend') {
      await cloud.resendConfirmation(f.email);
      Object.assign(a, { view: 'login', info: `Un nouvel email de confirmation a été envoyé à ${f.email}. Le lien est valable une heure.` });
    }
    if (kind === 'new-password') {
      await cloud.updatePassword(f.password);
      a.view = 'login';
      a.busy = false;
      toast('Mot de passe modifié.');
      return afterSignIn();
    }
  } catch (err) {
    a.error = cloud.friendly(err);
  }
  a.busy = false;
  render();
});

document.addEventListener('click', async (e) => {
  // Menus déroulants : fermeture au clic extérieur (même comportement que Nexus RH).
  if (!e.target.closest('.user-menu-wrapper')) $('user-menu-panel')?.classList.remove('open');
  if (!e.target.closest('.topbar-search')) $('global-search-results')?.classList.remove('open');
  if (!e.target.closest('.landing-nav-menu')) $('landing-nav-links')?.classList.remove('open');

  const nav = e.target.closest('[data-href]');
  if (nav) {
    location.hash = nav.dataset.href;
    $('global-search-results')?.classList.remove('open');
    return;
  }
  const goto = e.target.closest('[data-goto]');
  if (goto) {
    $('landing-nav-links')?.classList.remove('open');
    return document.getElementById(goto.dataset.goto)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && el.type !== 'button')) return;
  const { action, id, index } = el.dataset;
  if (action.startsWith('ob-') && action !== 'ob-bank-file') return onboardingAction(action);

  switch (action) {
    case 'goto-login':
    case 'goto-signup':
      ui.screen = 'login';
      ui.auth = { ...ui.auth, view: action === 'goto-signup' ? 'signup' : 'login', error: '', info: '' };
      window.scrollTo(0, 0);
      return render();
    case 'goto-landing':
      ui.screen = 'landing';
      return render();
    case 'auth-view':
      ui.auth = { ...ui.auth, view: el.dataset.view, error: '', info: '' };
      return render();
    case 'toggle-password': {
      const input = el.parentElement.querySelector('input');
      input.type = input.type === 'password' ? 'text' : 'password';
      return;
    }
    case 'landing-menu':
      return $('landing-nav-links').classList.toggle('open');
    case 'faq':
      ui.faqOpen = ui.faqOpen === Number(index) ? null : Number(index);
      return el.closest('.landing-faq-item').classList.toggle('landing-faq-item-open');
    case 'install':
      if (installPrompt) {
        installPrompt.prompt();
        installPrompt = null;
      } else {
        toast('Ouvrez le menu ⋮ de votre navigateur puis « Installer Nexus Gestion ».');
      }
      return;
    case 'demo':
      return seedDemo();
    case 'toggle-nav': {
      const open = $('sidebar-nav').classList.toggle('open');
      el.setAttribute('aria-expanded', String(open));
      return;
    }
    case 'user-menu':
      return $('user-menu-panel').classList.toggle('open');
    case 'theme':
      setTheme(el.dataset.value);
      return renderApp();
    case 'reload':
      return location.reload();
    case 'line-add':
      ui.draft.lines.push(emptyLine());
      return render();
    case 'line-remove':
      ui.draft.lines.splice(Number(index), 1);
      return render();
    case 'client-lookup': {
      const nc = ui.draft.newClient;
      const siren = (nc.siren || '').replace(/\s/g, '');
      if (!isValidSiren(siren)) return toast('Ce SIREN ne semble pas valide.', true);
      try {
        Object.assign(nc, await lookupSiren(siren), { siren });
        render();
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }
    case 'invoice-cancel':
      ui.draft = null;
      location.hash = '#/ventes';
      return;
    case 'invoice-save': {
      const inv = persistDraft();
      if (!inv) return render();
      ui.draft = null;
      location.hash = `#/ventes/${inv.id}`;
      return toast('Brouillon enregistré.');
    }
    case 'invoice-issue':
    case 'invoice-issue-existing': {
      const inv = action === 'invoice-issue' ? persistDraft() : ws.book.get(id);
      if (!inv) return render();
      try {
        const issued = ws.issueInvoice(inv.id);
        ui.draft = null;
        save();
        location.hash = `#/ventes/${issued.id}`;
        render();
        toast(`${issued.type === 'quote' ? 'Devis' : issued.type === 'deposit' ? "Facture d'acompte" : issued.type === 'credit' ? 'Avoir' : 'Facture'} ${issued.number} émis${issued.type === 'quote' || issued.type === 'credit' ? '' : 'e'}.`);
      } catch (err) {
        if (err instanceof InvoiceError && err.issues.length) {
          if (ui.draft) {
            Object.assign(ui.draft, { issues: err.issues, key: `modifier-${inv.id}`, savedId: inv.id });
            location.hash = `#/ventes/modifier-${inv.id}`;
          }
          render();
        } else toast(err.message, true);
      }
      return;
    }
    case 'invoice-delete':
      if (!confirm('Supprimer ce brouillon ?')) return;
      ws.book.deleteDraft(id);
      save();
      location.hash = '#/ventes';
      return;
    case 'credit-note': {
      const draft = ws.book.createCreditNote(id, { issueDate: today() });
      save();
      location.hash = `#/ventes/modifier-${draft.id}`;
      return;
    }
    case 'print':
      return window.print();
    case 'einvoice': {
      const inv = ws.book.get(id);
      const problems = checkEn16931(inv);
      if (problems.length) return toast(`Facture électronique non conforme : ${problems[0]}`, true);
      download(ciiFileName(inv), buildCii(inv), 'application/xml;charset=utf-8');
      return toast('Facture électronique CII (EN 16931) téléchargée.');
    }
    case 'purchase-force': {
      const res = ws.addPurchase(ui.pendingPurchase.data, { force: true });
      const pendingFile = ui.pendingPurchase.file;
      ui.pendingPurchase = null;
      if (res.purchase) attachReceipt(res.purchase, pendingFile);
      save();
      render();
      return toast(res.purchase ? 'Dépense enregistrée.' : 'Enregistrement impossible.', !res.purchase);
    }
    case 'purchase-cancel':
      ui.pendingPurchase = null;
      return render();
    case 'tx-match': {
      const s = ws.suggestionsFor(id)[Number(index)];
      ws.matchTransaction(id, s.docs.map((doc, i) => ({ doc, amount: s.amounts[i] })));
      save();
      render();
      return toast('Transaction associée.');
    }
    case 'tx-categorize': {
      const cat = document.querySelector(`[data-cat="${id}"]`).value;
      if (!cat) return toast('Choisissez une catégorie.', true);
      const vat = Number(document.querySelector(`[data-vat="${id}"]`)?.value || 0);
      const hasReceipt = document.querySelector(`[data-receipt="${id}"]`)?.checked || false;
      ws.categorizeTransaction(id, { categoryId: cat, vatRateBp: vat, hasReceipt });
      save();
      render();
      return toast(hasReceipt || [...INCOME_CATEGORIES, ...OUTFLOW_CATEGORIES].some((c) => c.id === cat) ? 'Transaction justifiée.' : 'Transaction classée. Pensez à ajouter le justificatif.');
    }
    case 'tx-ignore':
      ws.ignoreTransaction(id);
      save();
      return render();
    case 'opening-import':
      try {
        const r = ws.importOpening(ui.pendingOpening.opening);
        ui.pendingOpening = null;
        save();
        render();
        toast(`Bilan d'ouverture repris (${r.clientsCreated} client(s) recréé(s)).`);
      } catch (err) {
        toast(err.message, true);
      }
      return;
    case 'opening-cancel':
      ui.pendingOpening = null;
      return render();
    case 'expenses-tab':
      ui.expensesTab = el.dataset.tab;
      return render();
    case 'export-state': {
      const t = el.dataset.tab;
      const [make, name] = t === 'balance' ? [trialBalanceCsv, 'balance'] : t === 'grand-livre' ? [generalLedgerCsv, 'grand-livre'] : [journalsCsv, 'journaux'];
      return download(`${name}-${ws.company.siren}-${today()}.csv`, make(ws.ledger), 'text/csv;charset=utf-8');
    }
    case 'vat-period':
      ui.vatPeriod = el.dataset.from;
      return render();
    case 'vat-declare': {
      const period = { from: el.dataset.from, to: el.dataset.to };
      const ca3 = ws.prepareVatReturn(period);
      const amount = ca3.balance >= 0 ? `${eur(ca3.balance)} de TVA à payer` : `un crédit de ${eur(-ca3.balance)}`;
      if (!confirm(`Valider la déclaration (${amount}) ? L'écriture de liquidation sera passée et la période marquée comme déclarée.${ca3.warnings.length ? ' Attention : ' + ca3.warnings.join(' ') : ''}`)) return;
      try {
        ws.declareVat(period, today());
        save();
        render();
        toast('Déclaration validée. Pensez à la déposer sur impots.gouv.fr avant la date limite.');
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }
    case 'vat-justification': {
      const ca3 = ws.prepareVatReturn({ from: el.dataset.from, to: el.dataset.to });
      const rows = justificationRows(ca3).map(([line, number, client, date, reason, base, vat]) => [line, number, client, frDate(date), reason, (base / 100).toFixed(2).replace('.', ','), (vat / 100).toFixed(2).replace('.', ',')]);
      return download(`tva-${el.dataset.from.slice(0, 7)}-detail.csv`, toCsv(['Case', 'Facture', 'Client', 'Exigible le', 'Motif', 'Base HT', 'TVA'], rows), 'text/csv;charset=utf-8');
    }
    case 'einvoice-in-save': {
      const { inv, file, duplicates } = ui.pendingEinvoice;
      const categoryId = document.querySelector('[data-einvoice-cat]').value;
      const data = { supplier: { name: inv.seller.name, siren: inv.seller.siren, country: inv.seller.country }, date: inv.issueDate, number: inv.number, documentName: file.name, lines: purchaseLinesFrom(inv, categoryId), type: inv.type === 'credit' ? 'credit' : 'invoice', einvoice: { format: inv.format, totalTtc: inv.totalTtc } };
      const res = ws.addPurchaseLines(data, { force: Boolean(duplicates?.length) });
      if (!res.purchase) {
        ui.pendingEinvoice.duplicates = res.duplicates;
        return render();
      }
      ui.pendingEinvoice = null;
      save();
      render();
      if (res.purchase.totalTtc !== inv.totalTtc) toast(`Dépense enregistrée, mais le total recalculé (${eur(res.purchase.totalTtc)}) diffère de la facture (${eur(inv.totalTtc)}) : vérifiez la catégorie.`, true);
      else toast('Facture électronique enregistrée en dépense.');
      attachReceipt(res.purchase, file);
      return;
    }
    case 'inventory-add': {
      const f = ui.inventoryForm || { type: 'prepaid' };
      const form = Object.fromEntries([...document.querySelectorAll('[data-inv]')].map((e) => [e.dataset.inv, e.value]));
      try {
        const amount = parseEuros(form.amount || '');
        ws.addInventory({ type: form.type || f.type, account: form.account, aux: form.aux, amount, label: form.label?.trim() || undefined });
        ui.inventoryForm = { type: form.type };
        save();
        render();
        toast('Écriture d’inventaire ajoutée.');
      } catch (err) {
        toast(err.message.startsWith('Montant invalide') ? 'Le montant saisi n’est pas valide.' : err.message, true);
      }
      return;
    }
    case 'inventory-delete':
      ws.ledger.deleteDraft(id);
      save();
      return render();
    case 'depreciation-book':
      try {
        ws.bookDepreciation();
        save();
        render();
        toast('Dotations aux amortissements passées.');
      } catch (err) {
        toast(err.message, true);
      }
      return;
    case 'is-book':
      try {
        ws.bookCorporateTax(Number(el.dataset.tax));
        save();
        render();
        toast('Impôt sur les sociétés comptabilisé.');
      } catch (err) {
        toast(err.message, true);
      }
      return;
    case 'archive-open':
      return openArchive(el.dataset.key).catch((err) => toast(cloud.friendly(err), true));
    case 'archive-fec':
      try {
        const fec = exportFEC(ui.archive.ledger, { siren: ws.company.siren, closingDate: ui.archive.fiscalYear.end });
        return download(fec.fileName, fec.content);
      } catch (err) {
        return toast(err.message, true);
      }
    case 'allocate-result': {
      const { result } = allocationProposal(ws.ledger, ws.company);
      const read = (k) => { const e = document.querySelector(`[data-alloc="${k}"]`); return e && e.value ? parseEuros(e.value) : 0; };
      try {
        const parts = ws.company.legalForm === 'EI'
          ? { owner: result }
          : { legalReserve: read('legalReserve'), otherReserves: read('otherReserves'), dividends: read('dividends'), retained: result < 0 ? -Math.abs(read('retained')) : read('retained') };
        const fy = ws.company.fiscalYear;
        ws.allocateResult(parts, today() < fy.start ? fy.start : today() > fy.end ? fy.end : today());
        ui.allocationForm = null;
        save();
        render();
        toast('Affectation du résultat enregistrée.');
      } catch (err) {
        toast(err.message.startsWith('Montant invalide') ? 'Un des montants n’est pas valide.' : err.message, true);
      }
      return;
    }
    case 'close-year':
      return closeYearFlow();
    case 'invite-member': {
      const email = document.querySelector('[data-invite-email]').value.trim();
      const role = document.querySelector('[data-invite-role]').value;
      if (!email) return toast('Indiquez l’adresse e-mail.', true);
      try {
        await cloud.inviteMember(cloudState.meta.structureId, email, role);
        ui.members = await cloud.listMembers(cloudState.meta.structureId);
        render();
        toast(`${email} a désormais accès à votre comptabilité.`);
      } catch (err) {
        toast(cloud.friendly(err), true);
      }
      return;
    }
    case 'status-add': {
      const status = document.querySelector('[data-status-select]').value;
      const detail = document.querySelector('[data-status-detail]').value.trim();
      try {
        ws.book.recordStatus(id, { status, date: today(), detail });
        save();
        render();
        toast(`Statut « ${LIFECYCLE[status].label} » ajouté.`);
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }
    case 'einvoice-in-cancel':
      ui.pendingEinvoice = null;
      return render();
    case 'recurring-toggle': {
      const t = ws.recurring.find((x) => x.id === id);
      ws.saveRecurring({ ...t, active: !t.active });
      save();
      return render();
    }
    case 'recurring-delete':
      if (!confirm('Supprimer cette facture récurrente ? Les factures déjà créées sont conservées.')) return;
      ws.deleteRecurring(id);
      save();
      return render();
    case 'receipt-open':
      try {
        window.open(await cloud.receiptUrl(el.dataset.path), '_blank', 'noopener');
      } catch (err) {
        toast(`Justificatif indisponible : ${cloud.friendly(err)}`, true);
      }
      return;
    case 'sales-tab':
      ui.salesTab = el.dataset.tab;
      return render();
    case 'quote-convert': {
      const q = ws.book.get(id);
      const due = new Date(Date.now() + (ws.company.paymentTermsDays || 30) * 86400000).toISOString().slice(0, 10);
      const draft = ws.book.convertQuote(id, { issueDate: today(), dueDate: due });
      save();
      ui.draft = null;
      location.hash = `#/ventes/modifier-${draft.id}`;
      return toast(`Brouillon de facture créé depuis le devis ${q.number}.`);
    }
    case 'compta-tab':
      ui.comptaTab = el.dataset.tab;
      return render();
    case 'validate': {
      const date = document.querySelector('[data-validate-date]').value;
      if (date >= ws.company.fiscalYear.end) return toast('Le dernier jour de l’exercice est validé par la clôture (page Clôture), après les écritures d’inventaire et le résultat.', true);
      if (!confirm(`Valider définitivement toutes les écritures jusqu'au ${frDate(date)} ? Elles ne pourront plus être modifiées.`)) return;
      try {
        const n = ws.ledger.validateThrough(date);
        save();
        render();
        toast(`${n} écriture(s) validée(s).`);
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }
    case 'fec':
      try {
        const fec = exportFEC(ws.ledger, { siren: ws.company.siren });
        const check = checkFEC(fec.content);
        download(fec.fileName, fec.content);
        toast(check.ok ? 'FEC téléchargé (contrôles internes OK).' : `FEC téléchargé avec ${check.errors.length} anomalie(s).`, !check.ok);
      } catch (err) {
        toast(err.message, true);
      }
      return;
    case 'export-receipts': {
      const rows = receiptsBook(microReceipts()).rows;
      const csv = '﻿Date;Facture;Client;Mode;Montant\r\n' + rows.map((r) => [frDate(r.date), r.invoiceNumber, r.clientName, r.method, (r.amount / 100).toFixed(2).replace('.', ',')].join(';')).join('\r\n');
      return download('livre-des-recettes.csv', csv, 'text/csv;charset=utf-8');
    }
    case 'backup':
      return download(`nexus-gestion-${today()}.json`, JSON.stringify(ws.toJSON(), null, 2), 'application/json');
    case 'demo-exit':
      localStorage.removeItem(DEMO_KEY);
      ws = null;
      ui.demo = false;
      ui.screen = 'landing';
      $('app-shell').dataset.ready = '';
      location.hash = '';
      return render();
    case 'sign-out':
      if (cloudState.status.pending && !confirm('Des modifications ne sont pas encore enregistrées. Se déconnecter quand même ?')) return;
      await cloud.signOut();
      Object.assign(cloudState, { session: null, meta: null, outbox: null, synced: null, status: { pending: 0, error: null } });
      ws = null;
      ui.mfa = null;
      ui.ob = freshOnboarding();
      ui.screen = 'login';
      ui.auth = { view: 'login', error: '', info: '', busy: false, email: ui.auth.email };
      $('app-shell').dataset.ready = '';
      location.hash = '';
      return render();
    case 'sync-retry':
      return cloudState.outbox?.flush();
    case 'sync-reload':
      if (!confirm('Recharger depuis la base ? Les modifications non enregistrées de ce navigateur seront abandonnées.')) return;
      cloudState.outbox.clear();
      await openStructure(cloudState.meta.structureId);
      cloudState.status = { pending: 0, error: null };
      render();
      return toast('Données rechargées depuis la base.');
  }
});

window.addEventListener('hashchange', () => {
  if (ui.screen !== 'app') return;
  render();
  window.scrollTo(0, 0);
});

// ------------------------------------------------------------------ démarrage

async function boot() {
  loadPrefs();
  const params = new URLSearchParams(location.search);
  try {
    cloudState.session = await cloud.currentSession();
    if (cloudState.session) {
      ui.booting = false;
      await afterSignIn();
    } else if (params.has('demo')) {
      ui.booting = false;
      return seedDemo();
    } else if (loadDemo()) {
      ui.screen = 'app';
    } else if (URL_AUTH_ERROR || params.has('desktop')) {
      ui.screen = 'login';
    }
  } catch (e) {
    ui.screen = 'login';
    ui.auth.error = cloud.friendly(e);
  }
  ui.booting = false;
  render();
  cloud.onAuthChange((event, session) => {
    cloudState.session = session;
    if (event === 'PASSWORD_RECOVERY') {
      ui.auth = { view: 'new-password', error: '', info: '', busy: false };
      render();
    }
  });
}

boot();
