/**
 * Pages « Fonctionnalités » du site public (une page par carte de la page d'accueil).
 * Les captures (app/features/*.webp) sont prises sur la démonstration par scripts/screenshots.mjs :
 * relancer ce script après toute évolution visible d'un écran.
 * Règle de rédaction : ne décrire que ce que l'application fait réellement aujourd'hui ; ce qui
 * dépend d'un partenaire pas encore branché est annoncé comme tel.
 */
import factures from './site/pages/factures.js?v=a0ee72f';
import devis from './site/pages/devis.js?v=a0ee72f';
import banque from './site/pages/banque.js?v=a0ee72f';
import depenses from './site/pages/depenses.js?v=a0ee72f';
import tva from './site/pages/tva.js?v=a0ee72f';
import micro from './site/pages/micro.js?v=a0ee72f';
import relances from './site/pages/relances.js?v=a0ee72f';
import compta from './site/pages/compta.js?v=a0ee72f';
import cloture from './site/pages/cloture.js?v=a0ee72f';
import securite from './site/pages/securite.js?v=a0ee72f';

/** Ordre d'affichage sur la page d'accueil. */
export const FEATURE_PAGES = [factures, devis, banque, depenses, tva, micro, relances, compta, cloture, securite];

export const featureBySlug = (slug) => FEATURE_PAGES.find((f) => f.slug === slug);
