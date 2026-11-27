/**
 * Pages « Fonctionnalités » du site public (une page par carte de la page d'accueil).
 * Les captures (app/features/*.webp) sont prises sur la démonstration par scripts/screenshots.mjs :
 * relancer ce script après toute évolution visible d'un écran.
 * Règle de rédaction : ne décrire que ce que l'application fait réellement aujourd'hui ; ce qui
 * dépend d'un partenaire pas encore branché est annoncé comme tel.
 */
import factures from './site/pages/factures.js?v=d9f2509';
import devis from './site/pages/devis.js?v=d9f2509';
import banque from './site/pages/banque.js?v=d9f2509';
import depenses from './site/pages/depenses.js?v=d9f2509';
import tva from './site/pages/tva.js?v=d9f2509';
import micro from './site/pages/micro.js?v=d9f2509';
import relances from './site/pages/relances.js?v=d9f2509';
import compta from './site/pages/compta.js?v=d9f2509';
import cloture from './site/pages/cloture.js?v=d9f2509';
import securite from './site/pages/securite.js?v=d9f2509';
import conformite from './site/pages/conformite.js?v=d9f2509';
import pilotage from './site/pages/pilotage.js?v=d9f2509';

/** Ordre d'affichage sur la page d'accueil. */
export const FEATURE_PAGES = [factures, devis, banque, depenses, tva, micro, relances, compta, cloture, pilotage, securite, conformite];

export const featureBySlug = (slug) => FEATURE_PAGES.find((f) => f.slug === slug);
