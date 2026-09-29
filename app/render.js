/**
 * Rendu général : choix de l’écran, cadre de l’application, recherche globale, repères d’accessibilité.
 */

import { html, raw } from './html.js?v=e64ad2c';
import { ICONS } from './icons.js?v=e64ad2c';
import { featureBySlug, featureSlug, features, loadFeatures, viewFeature, viewLanding } from './site/landing.js?v=e64ad2c';
import { cloudState, eur, frDate, ui, ws } from './state.js?v=e64ad2c';
import { getTheme } from './store.js?v=e64ad2c';
import { syncStatusHtml } from './sync-ui.js?v=e64ad2c';
import { LOGO, badge, brand } from './ui/common.js?v=e64ad2c';
import { viewAuth, viewMfa, viewStructurePicker } from './views/auth.js?v=e64ad2c';
import { viewBank } from './views/bank.js?v=e64ad2c';
import { viewClosing } from './views/closing.js?v=e64ad2c';
import { viewCompta } from './views/compta.js?v=e64ad2c';
import { viewExpenses } from './views/expenses.js?v=e64ad2c';
import { viewHome } from './views/home.js?v=e64ad2c';
import { viewUrssaf } from './views/micro.js?v=e64ad2c';
import { viewOnboarding } from './views/onboarding.js?v=e64ad2c';
import { runRecurring, viewSales } from './views/sales.js?v=e64ad2c';
import { viewSettings } from './views/settings.js?v=e64ad2c';
import { viewVat } from './views/vat.js?v=e64ad2c';

// ------------------------------------------------------------------ rendu général

export const $ = (id) => document.getElementById(id);

export function show(rootId) {
  $('landing-root').style.display = rootId === 'landing-root' ? 'block' : 'none';
  $('login-root').style.display = rootId === 'login-root' ? 'flex' : 'none';
  $('app-shell').style.display = rootId === 'app-shell' ? 'flex' : 'none';
}

export function render() {
  if (ui.booting) {
    show('login-root');
    $('login-root').innerHTML = html`<div class="login-card">
      <div class="login-logo">${brand}</div>
      <p class="text-muted">Chargement…</p>
    </div>`.s;
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
    $('login-root').innerHTML = (ui.mfa ? viewMfa() : ui.picking ? viewStructurePicker() : viewOnboarding()).s;
    return;
  }
  if (ui.screen === 'login') {
    show('login-root');
    $('login-root').innerHTML = viewAuth().s;
    return;
  }
  if (!features) {
    loadFeatures().then(() => render());
    return;
  }
  show('landing-root');
  const slug = featureSlug();
  document.title = slug ? `${featureBySlug(slug).title} · Nexus Gestion` : LANDING_TITLE;
  $('landing-root').innerHTML = (slug ? viewFeature(slug) : viewLanding()).s;
}

export const LANDING_TITLE = document.title;

// ------------------------------------------------------------------ application (cadre Nexus RH)

export const routes = {
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

export function route() {
  const [name = 'accueil', arg] = location.hash.replace(/^#\/?/, '').split('/');
  return { name: routes[name] ? name : 'accueil', arg };
}

export const isMicro = () => ws.company.taxRegime?.startsWith('micro');

export function navItems() {
  const items = [
    { key: 'accueil', label: 'Accueil', icon: 'home' },
    { key: 'ventes', label: 'Factures', icon: 'receipt' },
    { key: 'depenses', label: 'Dépenses', icon: 'paperclip' },
    { key: 'banque', label: 'Banque', icon: 'card' },
    isMicro() ? { key: 'urssaf', label: 'URSSAF et seuils', icon: 'scale' } : { key: 'tva', label: 'TVA', icon: 'percent' },
  ];
  if (ui.mode === 'avance' && !isMicro())
    items.push({ section: 'Expert' }, { key: 'compta', label: 'Comptabilité', icon: 'chart' }, { key: 'cloture', label: 'Clôture', icon: 'lock' });
  // Mode standard : la clôture reste accessible, en langage courant.
  else if (!isMicro()) items.push({ key: 'cloture', label: 'Préparer ma clôture', icon: 'lock' });
  return items;
}

export function initials(name) {
  return (name || 'N')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

export function renderApp() {
  runRecurring();
  const { name, arg } = route();
  const shell = $('app-shell');
  if (!shell.dataset.ready) {
    shell.innerHTML = html` <a class="skip-link" href="#view-root">Aller au contenu</a>
      <aside id="sidebar">
        <div class="sidebar-logo">
          ${LOGO}<span class="logo-text">Nexus <span class="brand-suffix">Gestion</span></span>
        </div>
        <nav id="sidebar-nav"></nav>
        <div id="sidebar-nav-pinned"></div>
      </aside>
      <div id="main-column">
        <header id="topbar">
          <button type="button" id="btn-mobile-nav-toggle" class="mobile-nav-toggle" data-action="toggle-nav" aria-label="Menu" aria-expanded="false">
            ${raw(ICONS.menu)}
          </button>
          <div class="topbar-search">
            <input
              type="text"
              id="global-search-input"
              class="input"
              placeholder="Rechercher une facture, un client, une dépense... (Ctrl+K)"
              autocomplete="off"
              role="combobox"
              aria-label="Rechercher une facture, un client, une dépense"
              aria-autocomplete="list"
              aria-expanded="false"
              aria-controls="global-search-results"
            />
            <div id="global-search-results" class="search-results" role="listbox" aria-label="Résultats de recherche"></div>
          </div>
          <div class="topbar-user">
            <button class="btn-icon" data-action="reload" title="Recharger la page">${raw(ICONS.refresh)}</button>
            <div class="user-menu-wrapper">
              <button
                class="avatar avatar-initials"
                id="btn-user-menu"
                data-action="user-menu"
                title="Mon compte"
                aria-haspopup="true"
                aria-expanded="false"
                aria-controls="user-menu-panel"
              ></button>
              <div id="user-menu-panel" class="user-menu-panel"></div>
            </div>
          </div>
        </header>
        <main id="view-root"></main>
      </div>`.s;
    shell.dataset.ready = '1';
  }
  $('sidebar-nav').innerHTML = html`${navItems().map((item) =>
    item.section
      ? html`<div class="nav-section-label">${item.section}</div>`
      : html`<button class="nav-item ${name === item.key ? 'active' : ''}" data-href="#/${item.key}" ${name === item.key ? raw('aria-current="page"') : ''}>
          <span class="nav-icon">${raw(ICONS[item.icon])}</span><span class="nav-label">${item.label}</span>
        </button>`,
  )}`.s;
  $('sidebar-nav').classList.remove('open');
  $('sidebar-nav-pinned').innerHTML = syncStatusHtml().s;
  $('btn-user-menu').textContent = initials(ws.company.name);
  $('user-menu-panel').innerHTML = html` <div class="user-menu-header">
      <div class="user-menu-name">${ws.company.name}</div>
      ${badge(ui.demo ? 'Démonstration' : 'Dirigeant', 'primary')}
      <span class="text-muted" style="font-size:12px;">${cloudState.session?.user?.email || ''}</span>
    </div>
    <div class="theme-toggle-group" role="group" aria-label="Thème de l'application">
      ${[
        ['system', 'Système'],
        ['light', 'Clair'],
        ['dark', 'Sombre'],
      ].map(
        ([v, l]) =>
          html`<button type="button" class="theme-toggle-btn ${getTheme() === v ? 'active' : ''}" data-action="theme" data-value="${v}">${l}</button>`,
      )}
    </div>
    <div class="user-menu-divider"></div>
    <button type="button" class="user-menu-item" data-href="#/parametres">Paramètres</button>
    ${!ui.demo && ui.structures?.length > 1 ? html`<button type="button" class="user-menu-item" data-action="structure-switch">Changer d’entreprise</button>` : ''}
    <button type="button" class="user-menu-item" data-action="${ui.demo ? 'demo-exit' : 'sign-out'}">
      ${ui.demo ? 'Quitter la démonstration' : 'Se déconnecter'}
    </button>`.s;
  $('view-root').innerHTML = routes[name](arg).s;
  focusableScrollRegions($('view-root'));
  enhanceKeyboard($('view-root'));
  markInvalidFields($('view-root'));
  announceScreen(`${name}/${arg || ''}`);
  // La mise en page (polices, barre latérale) peut encore changer : second passage à l'image suivante.
  requestAnimationFrame(() => focusableScrollRegions($('view-root')));
}

/** Champ du formulaire de facture visé par un problème de conformité (sélecteur), s'il est affiché. */
export function issueTarget(fieldName, d) {
  if (!fieldName) return null;
  if (fieldName.startsWith('client.')) return `[name="${d.clientId === '__new' ? 'newClient' : 'clientEdit'}.${fieldName.slice(7)}"]`;
  if (fieldName === 'issueDate' || fieldName === 'dueDate') return `[name="${fieldName}"]`;
  if (fieldName === 'lines') return '[name="lines.0.label"]';
  return null;
}

/** Problème du récapitulatif : lien vers le champ à corriger (ou vers les Paramètres pour l'entreprise). */
export function issueLink(issue, d) {
  if (issue.field?.startsWith('company.')) return html`<a href="#/parametres">${issue.message}</a>`;
  const target = issueTarget(issue.field, d);
  return target ? html`<a href="#" data-focus="${target}">${issue.message}</a>` : issue.message;
}

/** Champs signalés en erreur (aria-invalid), reliés au récapitulatif qui explique quoi corriger. */
export function markInvalidFields(root) {
  for (const a of root.querySelectorAll('#invoice-issues a[data-focus]')) {
    const input = root.querySelector(a.dataset.focus);
    if (!input) continue;
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), 'invoice-issues'].filter(Boolean).join(' '));
  }
}

/**
 * Titre de l'onglet du navigateur = titre de l'écran ; à chaque changement d'écran (pas à chaque
 * rafraîchissement), le focus va sur ce titre pour que les lecteurs d'écran l'annoncent.
 */
export function announceScreen(key) {
  const h1 = $('view-root').querySelector('h1');
  if (!h1) return;
  document.title = `${h1.textContent.trim()} · Nexus Gestion`;
  const issues = $('invoice-issues');
  if (issues && ui.draft?.focusIssues) {
    ui.draft.focusIssues = false;
    ui.lastScreen = key;
    issues.focus();
    return;
  }
  // Même écran : on ne déplace le focus que s'il a été perdu (élément remplacé par le rendu).
  const lost = !document.activeElement || document.activeElement === document.body;
  if (ui.lastScreen === key && !lost) return;
  ui.lastScreen = key;
  h1.tabIndex = -1;
  h1.focus({ preventScroll: true });
}

/** Onglets annoncés comme tels ; lignes de tableau cliquables atteignables au clavier. */
export function enhanceKeyboard(root) {
  for (const list of root.querySelectorAll('.tabs')) {
    list.setAttribute('role', 'tablist');
    for (const tab of list.querySelectorAll('button.tab')) {
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(tab.classList.contains('active')));
    }
  }
  for (const row of root.querySelectorAll('tr[data-href]')) row.tabIndex = 0;
}

/**
 * Tableau plus large que l'écran (téléphone) : la zone qui défile doit être atteignable au clavier
 * et annoncée (WCAG 2.1.1). Appelé après chaque rendu.
 */
export function focusableScrollRegions(root) {
  for (const el of root.querySelectorAll('.table-card, .table-scroll, .tabs, .invoice-sheet')) {
    const s = getComputedStyle(el);
    const scrolls =
      (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(s.overflowX)) || (el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(s.overflowY));
    if (!scrolls || el.querySelector('a[href], button, input, select, textarea, [tabindex]')) continue;
    el.tabIndex = 0;
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', el.querySelector('h2, h3, caption')?.textContent.trim() || 'Tableau');
  }
}

// ------------------------------------------------------------------ recherche globale (barre du haut)

export function searchResults(q) {
  const n = q.trim().toLowerCase();
  if (n.length < 2) return [];
  const out = [];
  for (const i of ws.book.invoices) {
    if (`${i.number || ''} ${i.client?.name || ''}`.toLowerCase().includes(n))
      out.push({
        icon: 'receipt',
        label: i.number || 'Brouillon de facture',
        sub: `${i.client?.name || ''} · ${frDate(i.issueDate)}`,
        href: `#/ventes/${i.id}`,
      });
  }
  for (const p of ws.purchases) {
    if (`${p.supplier.name} ${p.number}`.toLowerCase().includes(n))
      out.push({ icon: 'paperclip', label: p.supplier.name, sub: `Dépense ${p.number || ''} · ${eur(p.totalTtc)}`, href: '#/depenses' });
  }
  for (const t of ws.transactions) {
    if (t.label.toLowerCase().includes(n)) out.push({ icon: 'card', label: t.label, sub: `${frDate(t.date)} · ${eur(t.amount)}`, href: '#/banque' });
  }
  return out.slice(0, 12);
}
