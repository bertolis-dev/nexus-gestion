import * as cloud from './cloud.js?v=ab27222';
import { seedDemo } from './demo.js?v=ab27222';
import { render } from './render.js?v=ab27222';
import { featureSlug } from './site/landing.js?v=ab27222';
import { URL_AUTH_ERROR, cloudState, ui } from './state.js?v=ab27222';
import { loadDemo, loadPrefs } from './store.js?v=ab27222';
import { afterSignIn } from './sync-ui.js?v=ab27222';
// Modules à effets de bord : écouteurs d'événements du document, installation (PWA).
import './actions/events.js';
import './pwa.js';

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
      // Sans le paramètre dans l'adresse, un rechargement garde la démonstration en cours au lieu de la réinitialiser.
      history.replaceState(null, '', location.pathname + location.hash);
      return seedDemo();
    } else if (featureSlug()) {
      ui.screen = 'landing';
    } else if (await loadDemo()) {
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
