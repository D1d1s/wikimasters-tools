// ==UserScript==
// @name         WikiMasters Tools
// @namespace    https://www.wiki-masters.com/
// @version      2.5.0
// @description  Boîte à outils WikiMasters : ouverture automatique des paquets, suivi des tirages, cote des cartes et revente.
// @match        https://www.wiki-masters.com/*
// @match        https://wiki-masters.com/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/D1d1s/wikimasters-tools/main/wikimasters-auto.user.js
// @downloadURL  https://raw.githubusercontent.com/D1d1s/wikimasters-tools/main/wikimasters-auto.user.js
// @homepageURL  https://github.com/D1d1s/wikimasters-tools
// ==/UserScript==

/*
 * Fonctionnement
 * --------------
 * Le site crédite les 5 cartes côté serveur dès l'appel POST /api/packs/open.
 * L'animation de révélation est 100 % cosmétique (aucune requête réseau).
 * Ce script se contente donc d'appeler l'endpoint, avec la session déjà
 * authentifiée de l'onglet (cookies same-origin).
 *
 * Le quota est imposé par le serveur (10 paquets max en réserve, 1 régénéré
 * toutes les ~3 min). En cas de 403 le serveur renvoie `next_regen_at` :
 * on dort jusqu'à cette date exacte plutôt que de marteler l'API.
 *
 * Le script s'ARRÊTE et prévient dès qu'il reçoit une réponse inattendue —
 * notamment une demande de vérification humaine, qu'il ne tente jamais de
 * contourner : à toi de la faire à la main dans l'onglet.
 */

(function () {
  'use strict';

  /*
   * Une seule instance par page. Renommer `@name` fait que Tampermonkey
   * installe un SECOND script au lieu de renommer le premier : les deux
   * s'injectent alors et le panneau apparaît en double. Ce drapeau est posé
   * avant tout le reste — JavaScript étant mono-thread, la première instance
   * chargée gagne et les suivantes s'arrêtent net.
   */
  if (window.__wmToolsLoaded) return;
  window.__wmToolsLoaded = true;

  /*
   * Une seule source pour le numéro de version : il vivait en trois exemplaires
   * — l'en-tête, la ligne de console et la poignée de diagnostic — et deux
   * d'entre eux avaient dérivé. La console annonçait 1.66 pendant que l'en-tête
   * disait 1.67 : de quoi chercher longtemps pourquoi un correctif « n'arrive
   * pas ». À tenir à jour avec `@version` en tête de fichier.
   */
  const VERSION = '2.5.0';

  const CFG = {
    /*
     * Délai adaptatif entre deux ouvertures consécutives : on part bas et on
     * remonte au premier 429, plutôt que de figer une valeur à la louche.
     *
     * Le plancher valait 5 s, mesuré à une époque où le serveur refusait en
     * dessous. Le jeu a depuis assoupli ce débit — et une constante écrite en
     * dur redevient fausse au prochain changement. Le plancher de config n'est
     * donc plus qu'une sécurité basse : le vrai plancher est APPRIS sur les
     * 429 (`state.probeFloorMs`) et retesté périodiquement.
     */
    startDelayMs: 2000,
    floorDelayMs: 800,
    ceilDelayMs: 60000,
    decayMs: 250,          // grignoté à chaque succès
    growth: 1.6,           // multiplié à chaque 429
    jitter: 0.2,           // ±20 % pour ne pas taper à intervalle fixe
    // Le plancher appris se détend de 10 % après cette série de succès sans
    // refus : sans quoi un 429 isolé — pic de charge, onglet concurrent — le
    // figerait haut pour toute la session, et un nouvel assouplissement du jeu
    // passerait inaperçu.
    probeAfterHits: 40,
    probeRelax: 0.9,

    // Une seule remise en vente à la fois, espacée au hasard dans cet
    // intervalle : dix annonces publiées dans la même seconde se remarquent, et
    // leurs enchères se termineraient ensemble — donc repartiraient en troupeau.
    // Quelques secondes de décalage suffisent à casser cette simultanéité ; des
    // minutes laissaient surtout les invendus hors du Marché.
    relistGapMs: [7000, 12000],

    regenBufferMs: 3000,   // marge après next_regen_at avant de réessayer
    /*
     * Recul après un 429 quand le serveur n'annonce pas de `Retry-After`.
     * Une minute était le prix de l'ignorance : le délai courant repartait à
     * l'aveugle, donc mieux valait attendre large. Maintenant que le refus
     * relève le plancher appris, la reprise ne retombera pas sur le même mur —
     * dix secondes suffisent, et les 429 consécutifs doublent toujours.
     */
    throttleBackoffMs: 10000,
    maxThrottleRetries: 4,
    maxPacks: 0,           // 0 = illimité ; sinon stop après N paquets
    alertSound: true,      // bip sur vérification humaine uniquement — rare, et il faut le voir
    tickMs: 500,
    historyLength: 1000,   // tirages retenus : journal, pastilles, filtre et export
    bonusEveryMs: 1800000, // vérification des paquets bonus (30 min)
    // Régénération : ~3 min avec le pack PRO, ~10 min sans. Valeur de départ
    // seulement — elle est recalibrée sur les réponses du serveur dès le
    // deuxième refus, quel que soit l'abonnement.
    defaultCadenceMs: 180000,
  };

  const MAX_RESERVE = 10;
  const RIBBON_LENGTH = 60; // encoches affichées dans le ruban des tirages
  const RARITIES = ['L', 'UR', 'SR', 'R', 'PC', 'C'];
  const RARE_ALERT = ['L', 'UR']; // tirages qui déclenchent une notification
  /*
   * Couleurs relevées sur le site lui-même — badge de rareté des cartes et
   * classes `.glow-*`, qui concordent. À ne pas deviner : l'échelle du jeu va
   * du menthe au jaune en passant par le rose, pas du gris au doré.
   */
  const RARITY_COLOR = {
    L: '#FFE144',   // jaune
    UR: '#FA9931',  // orange
    SR: '#ED6FA3',  // rose
    R: '#C6A7F2',   // lavande
    PC: '#B1CFF2',  // bleu clair
    C: '#B8F2D5',   // menthe
  };
  const rank = (r) => {
    const i = RARITIES.indexOf(r);
    return i === -1 ? -1 : RARITIES.length - i;
  };

  const STORE_KEY = 'wm-auto-panel';

  const state = {
    running: false,
    abort: null,
    packs: 0,
    cards: 0,
    history: [],
    throttles: 0,
    since: Date.now(),
    delayMs: CFG.startDelayMs,
    // Plancher appris : juste au-dessus du délai le plus court qui ait valu un
    // 429. 0 tant qu'aucun refus n'a été observé — on descend alors librement
    // jusqu'à `CFG.floorDelayMs`.
    probeFloorMs: 0,
    cleanHits: 0,          // succès d'affilée depuis le dernier 429
    // Attente en cours : bornes absolues, pour un affichage insensible à la dérive.
    waitFrom: 0,
    waitUntil: 0,
    waitLabel: '',
    // Estimation de la réserve.
    reserve: null,
    nextRegenAt: 0,
    lastRegenTs: 0,
    cadenceMs: CFG.defaultCadenceMs,
    blockedAt: 0,          // début du blocage par vérification humaine
    blockedReserve: null,  // réserve au moment du blocage, pour chiffrer la perte
    bonusCheckedAt: 0,
    bonusNote: '',
    packsReadAt: 0,        // dernier relevé de la réserve lu en base
    dbNote: '',            // ce que la base a répondu, pour le voir sans la console
    pity: null,            // compteur de pitié courant, tel que le porte le profil
    pityMax: 0,            // plus haute valeur jamais vue — révèle le palier
    balance: null,         // wikibidous disponibles
    guild: { at: 0 },      // relevé de guilde, voir refreshGuild
    karmaVu: {},           // karma réellement observé par rareté, mesuré
    maCollection: null,    // { at, cartes } — lecture complète, gardée une heure
    aSouhaiter: null,      // dernière liste proposée à la guilde
    publiees: [],          // cartes déjà publiées : le lot suivant en sort d'autres
    guildSeen: {},         // souhaits déjà signalés : id -> horodatage
    guildNote: '',         // dernier don signalé, visible sans notification
    guildSilence: false,   // premier tour après armement : enregistrer sans alerter
    bids: { at: 0, list: [] },
    slots: { used: 0, max: 10, at: 0 },  // emplacements de vente occupés
    journal: [],          // ventes closes : demandé, obtenu, issue
    asks: {},             // prix demandés en attente d'issue
    lastListing: {},      // dernière annonce par carte : prix et durée, pour rejouer
    myAuctions: {},       // annonces qui me concernent : id -> { kind, at }
    watch: {},            // cartes à garder en vente : card_id -> conditions
    nextRelistAt: 0,      // pas deux remises en ligne coup sur coup
    relistLog: [],        // issues des relances, lisibles hors des réglages
    sales: { at: 0, list: [] },
    bidNote: '',
    bidNoteAt: 0,
    owned: { count: 0, rc: {}, at: 0 },
    ownedTrack: [],       // relevés { at, count } récents, pour mesurer la vitesse
    achievements: { done: 0, total: 0, list: [], at: 0 },
    wish: { at: 0, cards: {} },      // liste de souhaits : card_id -> { t, r }
    wishHits: { at: 0, list: [] },   // souhaits actuellement en vente
    wishSeen: {},                    // annonces déjà signalées, pour ne pas re-notifier
    message: 'Prêt.',
    warn: false,
  };

  /**
   * Plancher effectif du délai entre deux ouvertures : la borne de config tant
   * que le serveur n'a rien refusé, le plancher appris dès le premier 429.
   */
  function floorMs() {
    return Math.max(CFG.floorDelayMs, state.probeFloorMs);
  }

  /*
   * Ce que le panneau fait SANS qu'on lui demande.
   *
   * Le défaut est « activé » partout, parce que quelqu'un qui installe l'outil
   * veut ce que l'outil fait — laisser six cases à cocher revenait à livrer un
   * panneau qui ne sert à rien tant qu'on n'a pas fouillé les réglages.
   *
   * Deux exceptions, et elles ne sont pas arbitraires :
   *
   * - `notify` demande une autorisation au navigateur. Une invite système à la
   *   première seconde d'usage, c'est le meilleur moyen de se faire refuser.
   * - `relistUnsold` MET DES CARTES EN VENTE tout seul, et une enchère est
   *   irréversible dès la première mise. Ce qui agit sur le compte de
   *   quelqu'un s'active à la main.
   *
   * Changer un défaut ici ne touche personne qui a déjà coché ou décoché la
   * case : `restore()` ne réécrit que les clés absentes du stockage local.
   */
  const prefs = {
    autostart: true,
    notify: false,
    bonus: true,
    autoclaim: true,     // réclamer les récompenses de succès en attente
    db: true,            // lire la base en direct là où l'API du site ne rend plus rien
    watchGuild: true,    // signaler les souhaits de guilde que tu peux servir
    autoResume: true,    // repartir seul dès que la vérification humaine est passée
    watchBids: true,
    watchWish: false,     // signaler les cartes de la liste de souhaits mises en vente
    relistUnsold: false,  // remettre en vente les invendus, au même prix et durée
    logRarity: null,      // rareté isolée dans le journal, null = tout
    folded: false,
    tab: 'paquets',       // onglet actif : paquets | marche | reglages
    mktSub: 'ench',       // volet du Marché : ench | vent | rel
  };

  // ------------------------------------------------------------- préférences

  function loadStore() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch (_) {
      return {};
    }
  }

  function saveStore(patch) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...loadStore(), ...patch }));
    } catch (_) {
      /* stockage indisponible : on tourne sans mémoriser */
    }
  }

  /** Compteurs, réglages et calibrages survivent aux rechargements de page. */
  function restore() {
    const s = loadStore();
    for (const k of Object.keys(prefs)) {
      if (typeof s[k] === 'boolean') prefs[k] = s[k];
    }
    /*
     * Le plancher appris arrive avant le délai : c'est lui qui le borne.
     * Son absence signale un stockage écrit par une version antérieure à
     * 1.77 — le délai mémorisé y valait au mieux 5 s, plancher d'alors. Le
     * reprendre tel quel condamnerait l'ancien utilisateur à la vieille
     * cadence, sans qu'aucune décrue de 250 ms ne le rattrape avant des
     * dizaines d'ouvertures. On repart donc du départ et on re-sonde.
     */
    if (Number.isFinite(s.probeFloorMs)) {
      state.probeFloorMs = Math.min(CFG.ceilDelayMs, Math.max(0, s.probeFloorMs));
    }
    if (Number.isFinite(s.delayMs) && Number.isFinite(s.probeFloorMs)) {
      state.delayMs = Math.min(CFG.ceilDelayMs, Math.max(floorMs(), s.delayMs));
    }
    if (Number.isFinite(s.cadenceMs)) state.cadenceMs = s.cadenceMs;
    // Le maximum du compteur de pitié s'accumule d'une session à l'autre : c'est
    // le nombre de tirages observés qui lui donne sa valeur, pas leur continuité.
    if (Number.isFinite(s.pityMax)) state.pityMax = s.pityMax;
    if (typeof s.logRarity === 'string' || s.logRarity === null) prefs.logRarity = s.logRarity;
    if (['paquets', 'marche', 'guilde', 'reglages'].includes(s.tab)) prefs.tab = s.tab;
    if (s.karmaVu && typeof s.karmaVu === 'object') state.karmaVu = s.karmaVu;
    // Sans ce registre, un rechargement de page resignalerait tous les souhaits
    // servables déjà vus — l'alerte perdrait son sens dès la deuxième ouverture.
    if (s.guildSeen && typeof s.guildSeen === 'object') state.guildSeen = s.guildSeen;
    if (Array.isArray(s.publiees)) state.publiees = s.publiees;
    if (['ench', 'vent', 'rel', 'souh'].includes(s.mktSub)) prefs.mktSub = s.mktSub;
    // Reprise de l'ancien réglage à étiquette unique.
    if (typeof s.sellHideTag === 'string' && s.sellHideTag) sellPrefs.hideTags = [s.sellHideTag];
    if (Array.isArray(s.sellHideTags)) sellPrefs.hideTags = s.sellHideTags;
    if (typeof s.sellHideTagged === 'boolean') sellPrefs.hideTagged = s.sellHideTagged;
    if (s.bids && Array.isArray(s.bids.list)) state.bids = s.bids;
    if (Array.isArray(s.journal)) state.journal = s.journal;
    if (s.asks && typeof s.asks === 'object') state.asks = s.asks;
    if (s.lastListing && typeof s.lastListing === 'object') state.lastListing = s.lastListing;
    if (s.myAuctions && typeof s.myAuctions === 'object') state.myAuctions = s.myAuctions;
    if (s.watch && typeof s.watch === 'object') state.watch = s.watch;
    // Un créneau écrit sous un intervalle plus long ne doit pas geler la
    // reprise : au plus loin, il vaut un écart complet à partir de maintenant.
    if (Number.isFinite(s.nextRelistAt)) {
      state.nextRelistAt = Math.min(s.nextRelistAt, Date.now() + CFG.relistGapMs[1]);
    }
    if (Array.isArray(s.relistLog)) state.relistLog = s.relistLog;
    if (s.sales && Array.isArray(s.sales.list)) state.sales = s.sales;
    /*
     * Les emplacements de vente n'étaient pas mémorisés : au rechargement, le
     * panneau retombait sur la longueur de la liste relevée et annonçait
     * « 4 ventes » là où le site en montrait 9, jusqu'au premier appel réussi.
     */
    if (s.slots && Number.isFinite(s.slots.used)) state.slots = s.slots;
    if (s.owned && Number.isFinite(s.owned.count)) state.owned = s.owned;
    if (Array.isArray(s.ownedTrack)) state.ownedTrack = s.ownedTrack.filter(
      (p) => p && Number.isFinite(p.at) && Number.isFinite(p.count));
    if (s.achievements && Number.isFinite(s.achievements.done)) {
      state.achievements = { list: [], ...s.achievements };
    }
    if (s.wish && s.wish.cards) state.wish = s.wish;
    if (s.wishHits && Array.isArray(s.wishHits.list)) state.wishHits = s.wishHits;
    if (s.wishSeen && typeof s.wishSeen === 'object') state.wishSeen = s.wishSeen;

    const st = s.stats;
    if (st && typeof st === 'object') {
      state.packs = st.packs || 0;
      state.cards = st.cards || 0;
      state.history = Array.isArray(st.history) ? st.history.slice(0, CFG.historyLength) : [];
      state.since = st.since || Date.now();
    }
  }

  function persistStats() {
    saveStore({
      stats: {
        packs: state.packs, cards: state.cards,
        history: state.history, since: state.since,
      },
    });
  }

  function resetStats() {
    state.packs = 0; state.cards = 0;
    state.history = []; state.since = Date.now();
    persistStats();
    // Sans cela le filtre « Nouveaux » resterait actif sur un ensemble vide.
    onlyNew = false;
    refreshCollection();
    render();
  }

  // ---------------------------------------------------------------- utilitaires

  const sleep = (ms) =>
    new Promise((resolve, reject) => {
      const id = setTimeout(resolve, ms);
      state.abort = () => {
        clearTimeout(id);
        reject(new Error('stopped'));
      };
    });

  const fmtClock = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  /*
   * Au-delà de deux jours, « 907 h 00 » ne se lit plus : les paliers lointains
   * se comptent en jours. En deçà, l'heure reste la bonne unité — une échéance
   * d'enchère ne s'exprime pas en fractions de journée.
   */
  const fmtSpan = (ms) => {
    const m = Math.floor(ms / 60000);
    if (m >= 2880) return `${(m / 1440).toFixed(m < 14400 ? 1 : 0).replace('.', ',')} j`;
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
  };

  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ------------------------------------------------- ouvrir une carte en collection

  /*
   * Le site n'a pas de lien profond par carte : /collection n'accepte aucun
   * paramètre de recherche et le clic sur une carte n'ouvre ni modale ni URL.
   * On passe donc la recherche par localStorage, et on la rejoue dans le champ
   * « Rechercher par titre » au chargement de la collection — c'est le seul
   * moyen d'atterrir sur une carte précise, là où sa cote et la revente vivent.
   */
  const PENDING_KEY = 'wm-auto-pending-search';

  // Les deux pages filtrent en mémoire, via un champ au placeholder « Rechercher ».
  const SEARCHABLE = ['/collection', '/marketplace'];
  const SEARCH_SELECTOR = 'input[placeholder*="Rechercher"]';

  // --------------------------------------------- repérage dans la collection

  /*
   * Dans une rareté donnée, la collection est triée par date d'acquisition
   * décroissante : les cartes qui viennent d'être tirées sont donc déjà en
   * tête. Ce qui manquait, c'était de voir LESQUELLES parmi des centaines.
   *
   * On pose donc une marque sur celles de la session. React remonte ses nœuds
   * à chaque filtre ou changement de page, d'où le guetteur qui repasse — le
   * drapeau `wmNew` évite de marquer deux fois et de boucler sur nos propres
   * insertions.
   */
  const NEW_TAG_COLOR = '#35D68F';
  let onlyNew = false; // vue transitoire : elle ne survit pas à un rechargement

  /*
   * Arriver sur la collection par le menu, c'est vouloir toute sa collection ;
   * y arriver en cliquant une pastille de rareté, c'est vouloir ses tirages.
   * Le panneau pose donc une intention datée juste avant de naviguer, et seule
   * une arrivée qui la suit de près allume le filtre.
   */
  let newIntentAt = 0;
  const INTENT_TTL = 5000;
  let lastPath = location.pathname;

  /*
   * Le bouton lui-même n'existe que si l'on est venu du panneau. Arriver sur
   * la collection par le menu, c'est demander sa collection : un contrôle
   * supplémentaire portant un compteur y serait du bruit, même éteint.
   */
  let showNewFilter = false;

  function syncNavigation() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (location.pathname.startsWith('/collection')) {
      showNewFilter = onlyNew = Date.now() - newIntentAt < INTENT_TTL;
      // L'intention ne vaut que pour cette arrivée : sans quoi un aller-retour
      // rapide par le menu rallumerait le filtre sans l'avoir demandé.
      newIntentAt = 0;
    }
  }

  /*
   * UNE seule définition de « nouveau » : ce que la session a tiré, c'est-à-dire
   * l'historique. Les pastilles, le journal et ce filtre lisent tous ce même
   * tableau — sans quoi la pastille annonce 6 SR, le journal en montre 1 et la
   * collection 3, chacun appliquant sa propre limite.
   *
   * Le bouton « reset » du panneau est le seul moyen de repartir à zéro : une
   * péremption automatique rendrait les trois compteurs à nouveau incohérents.
   */
  const freshTitles = () => new Set(state.history.map((c) => c.title));

  /*
   * Plutôt que de décorer chaque carte d'un badge — bruyant, et il finit par
   * masquer les statistiques — on ajoute un filtre « Nouveaux » à la barre de
   * raretés du site. Chercher devient inutile : les cartes tirées sont les
   * seules affichées, et le geste est celui que tu fais déjà pour filtrer.
   */
  const FILTER_ROW = '.flex.flex-wrap.gap-2';
  const CARD_ITEM = '.relative.isolate.group';

  function injectNewFilter() {
    if (!location.pathname.startsWith('/collection')) return;
    const row = document.querySelector(FILTER_ROW);
    if (!row) return;

    // Venu par le menu : on n'ajoute rien, et on retire un bouton résiduel.
    if (!showNewFilter) {
      row.querySelector('[data-wm-only-new]')?.remove();
      return;
    }
    if (row.querySelector('[data-wm-only-new]')) return;

    const btn = document.createElement('button');
    btn.dataset.wmOnlyNew = '1';
    // Mêmes classes que les filtres du site : la géométrie reste la sienne.
    btn.className = 'px-3 py-1 rounded-full text-xs font-semibold transition-all cursor-pointer';
    btn.addEventListener('click', () => {
      onlyNew = !onlyNew;
      applyNewFilter();
    });
    row.appendChild(btn);
    paintNewFilter(btn, 0);
  }

  function paintNewFilter(btn, count) {
    btn.textContent = count ? `Nouveaux · ${count}` : 'Nouveaux';
    btn.disabled = !count;
    btn.title = count
      ? 'N’afficher que les cartes tirées pendant la session'
      : 'Aucun tirage à afficher — le compteur du panneau est vide';
    btn.style.cssText = !count
      ? 'color:#626B7A;background:transparent;opacity:.35;cursor:default'
      : onlyNew
        ? `background:${NEW_TAG_COLOR};color:#06130C`
        : `color:${NEW_TAG_COLOR};background:transparent;opacity:.6`;
  }

  /** Masque les cartes qui ne sont pas des tirages de la session. */
  function applyNewFilter() {
    if (!location.pathname.startsWith('/collection')) return;
    const fresh = freshTitles();

    const items = [];
    for (const h of document.querySelectorAll('h3')) {
      const item = h.closest(CARD_ITEM);
      if (item) items.push({ item, isNew: fresh.has(h.textContent.trim()) });
    }
    const visible = items.filter((x) => x.isNew).length;

    /*
     * Un filtre qui ne laisserait rien à l'écran donne une collection vide et
     * laisse croire à une panne — c'est ce qui arrive après un reset, ou sur
     * une rareté dont aucune carte n'a été tirée. On le relâche alors.
     */
    if (onlyNew && visible === 0) onlyNew = false;

    for (const { item, isNew } of items) {
      item.style.display = onlyNew && !isNew ? 'none' : '';
    }

    const btn = document.querySelector('[data-wm-only-new]');
    if (btn) paintNewFilter(btn, visible);
  }

  // --------------------------------------------- trier la collection par valeur

  /*
   * La collection est paginée CÔTÉ SERVEUR : 50 cartes par page, N pages pour
   * N cartes, et `/api/my-collection` ne connaît qu'un tri — `sort=rarity`.
   * Réordonner les nœuds affichés ne trierait donc que les 50 cartes sous les
   * yeux : sur N pages, ça ne répond pas à la question posée, « lesquelles de
   * mes cartes valent quelque chose ».
   *
   * On trie donc la collection ENTIÈRE et on laisse le site l'afficher : la
   * réponse de `/api/my-collection` est interceptée, et son tableau `collection`
   * remplacé par la tranche correspondante de notre classement. Le site rend ses
   * propres cartes, sa pagination, son filtre de rareté et sa recherche
   * continuent de fonctionner — seul l'ordre change. Le reste de la réponse est
   * laissé intact, et la moindre anomalie renvoie la réponse d'origine : le tri
   * ne peut pas empêcher la collection de s'afficher.
   *
   * La valeur, c'est la moyenne des ventes RÉELLES déjà relevée par la Revente
   * (`sell.rows`, `/api/marketplace/cards/<id>/sales`) — le site n'expose aucun
   * prix dans la collection, et `sort=value` n'existe pas : essayé, le serveur
   * retombe sur l'ordre alphabétique.
   *
   * Une carte jamais vendue n'a pas de moyenne : elle passe derrière celles qui
   * en ont, dans son ordre d'origine. Aucune carte ne disparaît de la
   * collection — le compteur de pages du site reste donc juste, sans qu'on ait
   * à toucher à `/api/my-collection/stats`.
   */
  const VALUE_COLOR = '#F0A94B';
  const VALUE_TTL = 900000;    // 15 min : la collection grossit à chaque paquet
  const COLLECTION_PAGE = 50;  // taille de page imposée par le site (`limit` est ignoré)

  let byValue = false;
  let valueRows = null;  // collection complète, classée — en mémoire seulement
  let valueAt = 0;
  let valueRead = 0;     // cartes déjà lues, pour la progression du bouton
  let valueTotal = 0;
  let valueBusy = false;
  let valueFail = false;  // dernière lecture ratée : le bouton le dit dans son infobulle

  /**
   * Classe la collection entière. La lecture coûte N requêtes (~15 s) : elle
   * est gardée le temps du `VALUE_TTL`, et refaite au prochain allumage du tri.
   *
   * @returns {Promise<boolean>} faux si la cote manque ou si la lecture échoue.
   */
  async function buildValueOrder() {
    if (valueRows && Date.now() - valueAt < VALUE_TTL) return true;
    if (!sell.rows.length) return false;

    valueBusy = true;
    valueRead = 0;
    valueTotal = 0;
    paintValueSort();
    try {
      // Le total sert uniquement à afficher une progression honnête.
      const { data } = await api('/api/my-collection/stats');
      valueTotal = (data && data.total) || 0;

      const cartes = await fetchCollectionRaw((n) => {
        valueRead = n;
        paintValueSort();
      });
      /*
       * Un classement partiel ferait DISPARAÎTRE des cartes : le site continue
       * d'annoncer ses N pages, et les dernières se retrouveraient vides.
       * Mieux vaut ne pas allumer le tri que d'amputer la collection.
       */
      if (!cartes.length || sell.tronque) return false;

      const moy = new Map(sell.rows.map((r) => [r.id, r.moy]));
      const cotees = [];
      const muettes = [];
      for (const e of cartes) (moy.has(e.card_id) ? cotees : muettes).push(e);
      cotees.sort((a, b) => moy.get(b.card_id) - moy.get(a.card_id));

      valueRows = cotees.concat(muettes);
      valueAt = Date.now();
      return true;
    } catch (_) {
      return false;  // réseau : on reste sur l'ordre du site
    } finally {
      valueBusy = false;
    }
  }

  /*
   * Un seul point d'entrée détourné, posé au premier allumage du tri. Tri
   * éteint, le proxy rend la réponse d'origine sans même la lire.
   *
   * Nos propres lectures de la collection ne portent pas `sort=` — la signature
   * des requêtes du site — donc elles traversent sans être touchées : le
   * classement ne peut pas se nourrir de lui-même.
   */
  let valueProxyOn = false;

  function installValueProxy() {
    if (valueProxyOn) return;
    valueProxyOn = true;
    const passe = window.fetch;
    window.fetch = async function (input, init) {
      const res = await passe.apply(this, arguments);
      try {
        if (!byValue || !valueRows) return res;
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (!url.includes('/api/my-collection?') || !url.includes('sort=')) return res;

        const p = new URL(url, location.origin).searchParams;
        // Une recherche vise une carte précise : le serveur répond mieux que nous,
        // et il cherche aussi dans la catégorie, ce que notre liste ne saurait pas.
        if (p.get('q')) return res;

        const data = await res.clone().json();
        if (!data || !Array.isArray(data.collection)) return res;

        const rarete = p.get('rarity');
        const liste = rarete ? valueRows.filter((e) => e.card && e.card.rarity === rarete) : valueRows;
        const page = Math.max(0, parseInt(p.get('page'), 10) || 0);
        data.collection = liste.slice(page * COLLECTION_PAGE, (page + 1) * COLLECTION_PAGE);

        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (_) {
        return res;  // le tri ne doit jamais coûter l'affichage de la collection
      }
    };
  }

  /*
   * Changer l'ordre ne suffit pas : le site n'affiche que ce qu'il a déjà en
   * mémoire, et il ne redemande une page que si la recherche ou le numéro de
   * page change. On lui fait donc chercher un titre qui n'existe pas, puis on
   * vide le champ : la seconde requête ramène la page 0 — c'est-à-dire la tête
   * du classement, là où sont justement les cartes qui valent quelque chose.
   *
   * Les 400 ms sont mesurées : le champ est amorti à 300 ms côté site, et en
   * dessous les deux frappes n'en font qu'une — la valeur finale égale celle
   * déjà chargée, et rien n'est redemandé. Un simple espace, lui, ne déclenche
   * aucune requête du tout : le site ignore les recherches blanches.
   *
   * Une recherche en cours est laissée telle quelle : le tri ne s'y applique
   * pas, il n'y a donc rien à rafraîchir, et l'effacer serait une perte.
   */
  const NUDGE_TOKEN = 'zzqq';  // aucun titre ne le contient : la page reste vide 400 ms
  const NUDGE_MS = 400;

  function reloadCollectionView() {
    const champ = document.querySelector(SEARCH_SELECTOR);
    if (!champ || champ.value) return;
    setReactInput(champ, NUDGE_TOKEN);
    setTimeout(() => {
      const encore = document.querySelector(SEARCH_SELECTOR);
      // React a pu remplacer le champ entre-temps ; on ne vide que le nôtre.
      if (encore && encore.value === NUDGE_TOKEN) setReactInput(encore, '');
    }, NUDGE_MS);
  }

  async function toggleValueSort() {
    if (valueBusy) return;

    if (byValue) {
      byValue = false;
      paintValueSort();
      paintValueBadges();  // les pastilles tombent tout de suite, pas au prochain rendu
      reloadCollectionView();
      return;
    }
    /*
     * Sans cote, il n'y a rien à trier. Plutôt qu'un bouton éteint qui laisse
     * chercher pourquoi, on ouvre la Revente : c'est elle qui relève les prix,
     * et elle lance le relevé toute seule quand elle n'en a aucun.
     */
    if (!sell.rows.length) {
      openSell();
      return;
    }

    installValueProxy();
    const ok = await buildValueOrder();
    byValue = ok;
    valueFail = !ok;  // un tri qui ne s'allume pas doit dire pourquoi
    paintValueSort();
    if (ok) reloadCollectionView();
  }

  function injectValueSort() {
    if (!location.pathname.startsWith('/collection')) return;
    const row = document.querySelector(FILTER_ROW);
    if (!row) return;

    let btn = row.querySelector('[data-wm-value-sort]');
    if (!btn) {
      btn = document.createElement('button');
      btn.dataset.wmValueSort = '1';
      // Mêmes classes que les filtres du site : la géométrie reste la sienne.
      btn.className = 'px-3 py-1 rounded-full text-xs font-semibold transition-all cursor-pointer';
      btn.addEventListener('click', toggleValueSort);
      row.appendChild(btn);
    }
    paintValueSort(btn);
  }

  function paintValueSort(btn) {
    const b = btn || document.querySelector('[data-wm-value-sort]');
    if (!b) return;

    if (valueBusy) {
      const pct = valueTotal ? Math.min(99, Math.round((valueRead / valueTotal) * 100)) : 0;
      b.textContent = `Valeur ↓ · lecture ${pct} %`;
      b.title = 'Lecture de la collection entière — N pages, une quinzaine de secondes';
    } else if (sell.scanning) {
      const pct = sell.total ? Math.min(99, Math.round((sell.done / sell.total) * 100)) : 0;
      b.textContent = `Valeur ↓ · cote ${pct} %`;
      b.title = 'Relevé des prix en cours dans la Revente — le tri s’allumera dès qu’il sera fini';
    } else if (sell.refusVentes === 403 && !sell.rows.length) {
      /*
       * Compte gratuit : le marché d'une carte — moyenne, min, max, graphique —
       * est vendu avec l'abonnement, le site le dit dans son propre encart. Il
       * n'y a alors aucun prix à classer, et proposer un relevé qui échouera
       * encore serait se moquer du monde.
       */
      b.textContent = 'Valeur ↓ · cote bloquée';
      b.title = 'L’API du marché est réservée aux comptes PRO (403). Coche « Lecture directe de '
        + 'la base » dans les réglages : la cote se relève alors sur la table des enchères, '
        + 'sans abonnement, et ce tri redevient possible.';
    } else if (!sell.rows.length) {
      /*
       * La cote vit dans le `localStorage` : elle est donc vide sur un
       * navigateur qui n'a jamais fait le relevé, même si le compte est le même
       * — c'est le premier clic sur un autre poste. Le bouton doit l'annoncer,
       * sans quoi il ouvre la Revente sans qu'on comprenne pourquoi : un
       * libellé identique à l'état qui trie promettait un tri, pas un relevé.
       */
      b.textContent = 'Valeur ↓ · cote à relever';
      b.title = 'Le classement a besoin du prix de tes cartes, et rien n’a encore été relevé sur '
        + 'ce navigateur. Le clic ouvre la Revente, qui lance le relevé — plusieurs minutes. '
        + 'Le tri s’allume ensuite.';
    } else {
      b.textContent = 'Valeur ↓';
      b.title = byValue
        ? 'Collection entière triée par moyenne des ventes — les cartes jamais vendues passent '
          + `derrière. Classement établi il y a ${fmtSpan(Date.now() - valueAt)} : éteins puis `
          + 'rallume pour le refaire.'
        : valueFail
          ? sell.tronque
            ? 'Lecture de la collection incomplète — le serveur a freiné'
              + `${sell.refus ? ` (statut ${sell.refus})` : ''}. Réessaie, au besoin boucle à l’arrêt.`
            : sell.refus
              ? `Le serveur a refusé la lecture de ta collection (statut ${sell.refus}) — réessaie`
              : 'La lecture de la collection a échoué — réessaie'
          : 'Trier toute la collection par moyenne des ventes, la plus chère en tête';
    }

    b.style.cssText = valueBusy || sell.scanning
      ? `color:${VALUE_COLOR};background:transparent;opacity:.6;cursor:default`
      : byValue
        ? `background:${VALUE_COLOR};color:#1A1206`
        : `color:${VALUE_COLOR};background:transparent;opacity:${sell.rows.length ? '.6' : '.35'}`;
  }

  /*
   * Des cartes réordonnées sans leur prix, c'est un ordre qu'il faut croire sur
   * parole. La pastille le montre, sous le badge de rareté, et seulement quand
   * le tri est allumé : le reste du temps, la collection reste celle du site.
   */
  function paintValueBadges() {
    const prix = byValue && sell.rows.length ? new Map(sell.rows.map((r) => [r.t, r.moy])) : null;
    // Tri éteint et aucune pastille à retirer : rien à parcourir. La collection
    // porte quelques milliers de nœuds, et ce tour passe à chaque rendu.
    if (!prix && !document.querySelector('[data-wm-value]')) return;

    for (const h of document.querySelectorAll('h3')) {
      const item = h.closest(CARD_ITEM);
      if (!item) continue;
      const hote = item.firstElementChild || item;
      const pastille = hote.querySelector('[data-wm-value]');
      const moy = prix ? prix.get(h.textContent.trim()) : null;

      if (moy == null) {
        if (pastille) pastille.remove();
        continue;
      }
      const texte = `⌀ ${fmtWb(moy)}`;
      if (pastille) {
        if (pastille.textContent !== texte) pastille.textContent = texte;
        continue;
      }
      const neuve = document.createElement('div');
      neuve.dataset.wmValue = '1';
      neuve.textContent = texte;
      neuve.title = 'Moyenne des ventes réelles de cette carte';
      neuve.style.cssText =
        'position:absolute;top:28px;left:8px;z-index:30;padding:1px 6px;border-radius:6px;'
        + `background:rgba(0,0,0,.6);color:${VALUE_COLOR};pointer-events:none;`
        + 'font:700 10px ui-sans-serif,system-ui,sans-serif;font-variant-numeric:tabular-nums';
      hote.appendChild(neuve);
    }
  }

  function refreshCollection() {
    syncNavigation();
    injectNewFilter();
    applyNewFilter();
    injectValueSort();
    paintValueBadges();
  }

  /** Répartition par rareté, dérivée de l'historique — jamais comptée à part. */
  function countByRarity() {
    const n = Object.create(null);
    for (const c of state.history) n[c.rarity] = (n[c.rarity] || 0) + 1;
    return n;
  }

  /*
   * Le guetteur s'installe quelle que soit la page : on arrive sur la
   * collection par navigation SPA, sans rechargement, donc sans nouvelle
   * exécution du script. C'est `refreshCollection` qui filtre sur l'URL.
   */
  function watchCollection() {
    let pending = null;
    const observer = new MutationObserver(() => {
      clearTimeout(pending);
      pending = setTimeout(refreshCollection, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(refreshCollection, 1200);
    // La péremption doit tomber même si la page ne bouge plus.
    setInterval(refreshCollection, 60000);
  }

  // ------------------------------------------------------------------ objectifs

  /*
   * Les succès qui ne dépendent que de la collection, tels que la page Succès
   * les énonce. Deux familles : le **total** de cartes possédées, et le nombre
   * de cartes d'une **rareté** donnée.
   *
   * Le panneau ne suivait que la première. Il annonçait donc « 10 000 cartes,
   * +500 » en passant sous silence « 1% — 40 Légendaires, +1500 », trois fois
   * mieux payé. Les deux chiffres arrivent pourtant dans la même réponse :
   * `/api/my-collection/stats` renvoie `total` **et** `rarityCounts`. Suivre
   * les paliers de rareté ne coûte donc pas une requête de plus.
   */
  const GOALS = [
    { at: 5000, of: 'total', name: 'Archiviste', reward: 250 },
    { at: 10000, of: 'total', name: 'Encyclopédiste ultime', reward: 500 },
    { at: 30000, of: 'total', name: 'Wiki Légende', reward: 1000 },
    { at: 50000, of: 'total', name: 'Dieu du wiki', reward: 2000 },
    { at: 100000, of: 'total', name: 'Va donc jouer dehors', reward: 3000 },
    { at: 5, of: 'L', name: 'Trouvailles légendaires', reward: 250 },
    { at: 10, of: 'L', name: 'Panthéon', reward: 500 },
    { at: 40, of: 'L', name: '1%', reward: 1500 },
    { at: 10, of: 'SR', name: "Collectionneur d'élite", reward: 50 },
    { at: 10, of: 'UR', name: 'Ultra collectionneur', reward: 100 },
  ];

  const GOAL_UNIT = {
    total: 'cartes', L: 'Légendaires', UR: 'Ultra Rares',
    SR: 'Super Rares', R: 'Rares', PC: 'Peu Communes', C: 'Communes',
  };

  /*
   * Le total possédé vient de l'API, pas d'une lecture de la page Profil : ce
   * chiffre ne se rafraîchissait qu'en visitant cette page, et dérivait donc
   * de plusieurs centaines de cartes pendant une session — faussant du même
   * coup l'estimation de temps qui s'appuie dessus.
   */
  const OWNED_EVERY_MS = 120000;

  /*
   * Mesure de la vitesse d'acquisition.
   *
   * Le premier modèle gardait un unique repère de départ et divisait le gain
   * total par le temps écoulé depuis. Deux défauts, qui faussaient l'estimation
   * dans le même sens — toujours vers le haut :
   *
   * 1. Le repère était posé au démarrage à partir de `state.owned` **restauré
   *    du stockage local**, dont l'horodatage venait de la session précédente.
   *    Après une nuit navigateur fermé, l'écart de départ valait douze heures
   *    pendant lesquelles rien n'avait été tiré : la vitesse était divisée par
   *    dix et l'estimation multipliée d'autant. Ça arrivait à *chaque*
   *    rechargement de page, pas seulement au premier.
   * 2. Même avec un repère juste, une moyenne depuis un point fixe n'oublie
   *    jamais. Une pause — vérification humaine, `429` en cascade, boucle
   *    arrêtée le temps d'un café — la tirait vers le bas définitivement.
   *
   * On garde donc une fenêtre glissante de relevés et on n'additionne que les
   * intervalles **effectivement travaillés** : deux relevés espacés de plus de
   * TRACK_GAP_MS signalent une interruption, leur durée comme leur gain sont
   * écartés. Ce qui reste répond à la seule question utile : au rythme où ça
   * tourne en ce moment, dans combien de temps ?
   */
  const TRACK_WINDOW_MS = 5400000;  // 1 h 30 de recul : assez pour lisser un trou de paquets
  const TRACK_GAP_MS = OWNED_EVERY_MS * 3;  // au-delà, l'onglet dormait ou la boucle était à l'arrêt
  const TRACK_MIN_MS = 600000;      // en deçà de 10 min de mesure, on n'affiche pas de chiffre

  /*
   * Un relevé n'est retenu que si la boucle tourne : sinon les échantillons
   * continueraient d'arriver toutes les deux minutes avec un gain nul, et
   * l'onglet laissé ouvert sans rien faire écraserait la vitesse mesurée.
   */
  function trackOwned(count, rc, at) {
    const t = state.ownedTrack;
    t.push({ at, count, rc: rc || {} });
    const cut = at - TRACK_WINDOW_MS;
    while (t.length > 2 && t[0].at < cut) t.shift();
  }

  /** Valeur d'une métrique dans un relevé : `total`, ou une rareté. */
  const metric = (s, of) =>
    of === 'total' ? s.count : (s.rc && Number.isFinite(s.rc[of]) ? s.rc[of] : null);

  /**
   * Vitesse en unités/h sur la fenêtre, ou 0 tant qu'on manque de recul.
   * Les intervalles trop longs sont sautés : on ne compte ni leur durée ni
   * leur gain, faute de pouvoir attribuer l'un à l'autre.
   */
  function perHourOf(of) {
    const t = state.ownedTrack;
    let ms = 0;
    let gain = 0;
    for (let i = 1; i < t.length; i++) {
      const dt = t[i].at - t[i - 1].at;
      if (dt <= 0 || dt > TRACK_GAP_MS) continue;
      const a = metric(t[i - 1], of);
      const b = metric(t[i], of);
      if (a == null || b == null) continue;
      ms += dt;
      gain += b - a;
    }
    if (ms < TRACK_MIN_MS || gain <= 0) return 0;
    return gain / (ms / 3600000);
  }

  /*
   * Les raretés sont rares — c'est leur définition. Une Légendaire tous les
   * 460 tirages ne produit aucun gain mesurable en une heure et demie de
   * fenêtre : `perHourOf('L')` renvoie donc 0 la plupart du temps, et le
   * palier « 40 Légendaires » n'afficherait jamais d'estimation.
   *
   * On la déduit alors de la vitesse totale, pondérée par la part que cette
   * rareté occupe **dans la collection entière** — des milliers de tirages,
   * bien plus solide que ce qu'une fenêtre courte peut voir. Le taux observé
   * sur des milliers de cartes est stable ; c'est la meilleure estimation disponible.
   */
  function goalPerHour(of) {
    const direct = perHourOf(of);
    if (direct > 0) return direct;
    if (of === 'total') return 0;
    const tot = perHourOf('total');
    const have = state.owned.rc && state.owned.rc[of];
    if (!tot || !Number.isFinite(have) || !have || !state.owned.count) return 0;
    return tot * (have / state.owned.count);
  }

  async function refreshOwned() {
    if (Date.now() - state.owned.at < OWNED_EVERY_MS) return;
    try {
      const d = await api('/api/my-collection/stats');
      const n = d.data && d.data.total;
      if (!Number.isFinite(n) || n <= 0) return;
      const at = Date.now();
      const rc = (d.data && d.data.rarityCounts) || {};
      state.owned = { count: n, rc, at };
      if (state.running) trackOwned(n, rc, at);
      saveStore({ owned: state.owned, ownedTrack: state.ownedTrack });
      render();
    } catch (_) {
      /* réseau : on retentera au prochain cycle */
    }
  }

  /*
   * Les succès, relevés en entier.
   *
   * On ne lisait que « N / 51 débloqués » — un ratio, donc rien d'actionnable.
   * Or la page porte trois choses qui manquaient au panneau : ce que chaque
   * succès demande, ce qu'il paie, et **s'il attend d'être réclamé**. Les
   * récompenses ne se créditent pas seules : un succès débloqué garde un bouton
   * *Réclamer* jusqu'à ce qu'on clique dessus, et rien ne le signale ailleurs
   * sur le site. Un compte peut donc laisser dormir des wikibidous gagnés.
   *
   * La page se rend côté client et n'a pas d'endpoint propre — elle interroge
   * Supabase directement, avec un jeton qu'on ne veut ni lire ni stocker. On
   * lit donc le DOM, quand tu passes dessus.
   */
  const REWARD_RE = /\+\s*([\d\s  ]+)\s*wikibidous/i;

  /*
   * Le conteneur d'un succès se reconnaît à ce qu'il contient — un titre et une
   * récompense — et non à sa classe : les classes utilitaires du site changent
   * à chaque déploiement, un sélecteur `.card-frame` se périmerait sans bruit.
   */
  function achievementBox(h3) {
    let el = h3;
    for (let i = 0; i < 5 && el.parentElement; i++) {
      el = el.parentElement;
      if (REWARD_RE.test(el.textContent || '')) return el;
    }
    return null;
  }

  const claimButton = (box) =>
    [...box.querySelectorAll('button')].find(
      (b) => /réclamer/i.test(b.textContent || '') && !b.disabled);

  function scrapeAchievements() {
    const vus = new Set();
    const list = [];
    for (const h of document.querySelectorAll('h3')) {
      const box = achievementBox(h);
      if (!box || vus.has(box)) continue;
      vus.add(box);
      const name = (h.textContent || '').trim();
      const txt = box.textContent || '';
      const m = txt.match(REWARD_RE);
      if (!name || !m) continue;
      const ps = [...box.querySelectorAll('p')].map((p) => (p.textContent || '').trim());
      list.push({
        name,
        desc: ps.find((t) => t && !REWARD_RE.test(t)) || '',
        reward: +m[1].replace(/\D/g, ''),
        done: txt.includes('✅'),
        claim: !!claimButton(box),
      });
    }
    return list;
  }

  /** Empreinte du relevé : on ne réécrit le stockage que si quelque chose bouge. */
  const achvSig = (l) => l.map((a) => `${a.name}${a.done ? 1 : 0}${a.claim ? 1 : 0}`).join('|');

  /*
   * Les succès lus en base — deux requêtes, depuis n'importe quelle page.
   *
   * Le relevé au DOM ne fonctionne que si tu es sur `/achievements` : tant que
   * tu n'y passes pas, le panneau ne sait pas qu'une récompense attend d'être
   * réclamée, et c'est précisément ce que rien d'autre ne signale sur le site.
   *
   * `achievements` porte le catalogue (`title`, `wikibidous_reward`),
   * `user_achievements` ce qui te concerne — `unlocked_at` et surtout
   * `claimed_at` : débloqué sans être réclamé, c'est exactement `claim` du
   * relevé au DOM, mais sans dépendre de la page affichée.
   *
   * On produit la MÊME forme d'objet que `scrapeAchievements`, pour que le
   * rendu, la notification et la réclamation automatique n'aient rien à savoir
   * de la provenance.
   */
  async function dbAchievements() {
    const moi = await fetchMyId();
    if (!moi) return null;

    const [cat, miens] = await Promise.all([
      sbGet('achievements?select=id,title,description,wikibidous_reward&limit=200'),
      sbGet(`user_achievements?user_id=eq.${moi}&select=achievement_id,unlocked_at,claimed_at&limit=200`),
    ]);
    if (!Array.isArray(cat) || !Array.isArray(miens) || !cat.length) return null;

    const parId = new Map(miens.map((x) => [x.achievement_id, x]));
    const list = cat.map((a) => {
      const x = parId.get(a.id);
      return {
        name: a.title || '',
        desc: a.description || '',
        reward: Number.isFinite(a.wikibidous_reward) ? a.wikibidous_reward : 0,
        done: !!(x && x.unlocked_at),
        // Débloqué et jamais réclamé : la récompense dort.
        claim: !!(x && x.unlocked_at && !x.claimed_at),
      };
    });
    return { list, done: list.filter((a) => a.done).length, total: list.length };
  }

  /*
   * Le relevé complet, sans avoir à passer sur la page. Appelé au démarrage et
   * après chaque réclamation ; le relevé au DOM reste en place pour la page
   * elle-même, où il voit l'état des boutons en temps réel.
   */
  async function readAchievementsFromDb() {
    const lu = await dbAchievements();
    if (!lu) return false;

    const avant = state.achievements.list || [];
    if (achvSig(lu.list) === achvSig(avant)) return true;

    state.achievements = { ...lu, at: Date.now() };
    saveStore({ achievements: state.achievements });
    render();

    const du = claimable();
    if (du.n && !avant.some((a) => a.claim)) {
      notifyBid('Récompenses à réclamer', `${du.n} succès · +${du.total} wikibidous`);
    }
    return true;
  }

  function readAchievements() {
    if (!location.pathname.startsWith('/achievements')) return;
    const list = scrapeAchievements();
    if (!list.length) return;   // page pas encore rendue

    const avant = state.achievements.list || [];
    if (achvSig(list) === achvSig(avant)) return;

    const m = document.body.innerText.match(/(\d+)\s*\/\s*(\d+)\s*débloqués/i);
    state.achievements = {
      done: m ? +m[1] : list.filter((a) => a.done).length,
      total: m ? +m[2] : list.length,
      list,
      at: Date.now(),
    };
    saveStore({ achievements: state.achievements });
    render();

    const du = claimable();
    if (du.n && !avant.some((a) => a.claim)) {
      notifyBid('Récompenses à réclamer', `${du.n} succès · +${du.total} wikibidous`);
    }
    if (prefs.autoclaim) claimAll();
  }

  /** Ce qui attend d'être réclamé, d'après le dernier relevé. */
  function claimable() {
    const l = (state.achievements.list || []).filter((a) => a.claim);
    return { n: l.length, total: l.reduce((s, a) => s + a.reward, 0), list: l };
  }

  /*
   * Réclamation : on clique le bouton du site, un à la fois, avec une pause.
   * Le bouton ne disparaît qu'une fois la réponse revenue — d'où le garde-fou
   * sur les boutons déjà cliqués, sans lequel la boucle rappuierait sur le
   * même. Le plafond arrête les frais si le site refuse sans rien changer.
   */
  const CLAIM_GAP_MS = 4000;
  let claiming = false;

  async function claimAll() {
    if (claiming || !location.pathname.startsWith('/achievements')) return;
    claiming = true;
    const faits = new WeakSet();
    try {
      for (let i = 0; i < 20; i++) {
        const box = [...document.querySelectorAll('h3')]
          .map(achievementBox)
          .find((b) => b && claimButton(b) && !faits.has(claimButton(b)));
        if (!box) break;
        const btn = claimButton(box);
        faits.add(btn);
        btn.click();
        await sleep(CLAIM_GAP_MS);
      }
    } finally {
      claiming = false;
      readAchievements();
    }
  }

  /**
   * Les paliers encore à atteindre, **du plus proche au plus lointain**, chacun
   * avec ce qu'il reste et le temps qu'il demande au rythme courant.
   *
   * Le classement se fait sur le temps, pas sur l'écart : N cartes à
   * 100 cartes/h arrivent en sept heures, N Légendaires à 0,2/h en quatre
   * jours. Trier sur « N < N » mettrait le second en tête. Un palier sans
   * estimation passe derrière ceux qui en ont, départagé par sa part restante.
   */
  function pendingGoals() {
    if (!state.owned.count) return [];
    const rows = [];
    for (const g of GOALS) {
      const have = g.of === 'total' ? state.owned.count : (state.owned.rc || {})[g.of];
      if (!Number.isFinite(have) || have >= g.at) continue;
      const rate = goalPerHour(g.of);
      rows.push({
        g, have, rate,
        left: g.at - have,
        eta: rate > 0 ? ((g.at - have) / rate) * 3600000 : null,
        part: have / g.at,
      });
    }
    rows.sort((a, b) =>
      a.eta != null && b.eta != null ? a.eta - b.eta
        : a.eta != null ? -1 : b.eta != null ? 1
          : b.part - a.part);
    return rows;
  }

  // --------------------------------------------------------- guetteur d'enchères

  /*
   * Le Marché ne rafraîchit ses données qu'au chargement de la page : rester
   * dessus ne fait pas apparaître les nouvelles ventes ni les surenchères
   * (et si les 50 premières annonces sont expirées, la liste paraît vide).
   * Le guetteur recharge donc lui-même — mais seulement quand l'onglet est en
   * arrière-plan, pour ne jamais recharger sous tes yeux pendant que tu enchéris.
   */
  const BIDS = {
    everyMs: 300000,       // rafraîchissement de l'onglet Marché en arrière-plan
    endingSoonMs: 300000,  // alerte quand une enchère menée finit dans moins de 5 min
  };

  const onMarket = () => location.pathname.startsWith('/marketplace');

  // --------------------------------------------- lecture directe de la base

  /*
   * Pourquoi on lit Supabase, après s'y être refusé
   * ----------------------------------------------
   * Le refus portait sur le jeton, jamais sur le droit : ce sont tes lignes,
   * et la RLS n'en rend aucune autre — la même règle que celle appliquée à la
   * page quand tu la consultes. Ce qui a changé, c'est le prix du détour.
   *
   * `/api/marketplace/mine` a été réduit à deux compteurs et `/api/marketplace`
   * n'accepte aucun filtre par vendeur : retrouver nos propres annonces
   * imposait de balayer six pages de marché au petit bonheur des créations
   * (`discoverSales`), sans garantie d'y arriver — ~15 900 annonces circulent.
   * La base rend la même liste, complète et exacte, en une requête.
   *
   * L'engagement tient là où il compte : le jeton est relu à chaque appel,
   * jamais recopié dans le stockage du script, jamais journalisé, jamais
   * inclus dans un export. Rien ne sort d'ici qui ne fût déjà lisible depuis
   * l'onglet ouvert.
   */

  /*
   * Clé « anon » publique du projet : le site l'expédie dans son propre bundle
   * JavaScript, elle n'ouvre rien par elle-même. C'est ton jeton, adossé à la
   * RLS, qui décide de ce qui est lisible.
   *
   * La référence du projet, elle, se déduit du stockage — une clé
   * `sb-<ref>-auth-token` y traîne forcément si tu es connecté. La constante
   * n'est qu'un repli : un projet renommé casserait un littéral, pas une
   * lecture.
   */
  const SB_ANON =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
    '.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5cnhqZXBwanFzeHhqYXlmcnVyIiwicm9sZSI6ImFub24i' +
    'LCJpYXQiOjE3NzM4ODAzMzksImV4cCI6MjA4OTQ1NjMzOX0' +
    '.BZluyXygNxuQGDPxFX1zG5i-cqp10CVK-8GGtuak4Rg';
  const SB_REF_FALLBACK = 'cyrxjeppjqsxxjayfrur';
  const SB_TOKEN_RE = /^sb-(.+)-auth-token/;

  let sbRefCache = null;
  function sbRef() {
    if (sbRefCache) return sbRefCache;
    /*
     * Les deux emplacements, pas un seul. Relevé sur un compte connecté : le
     * stockage local ne contient AUCUNE clé `sb-…`, la session vit entièrement
     * dans un cookie découpé en `.0`/`.1`. Ne chercher que dans localStorage
     * faisait donc toujours tomber sur la constante de repli — juste ici, mais
     * fausse le jour où le projet change de référence.
     */
    try {
      for (const k of Object.keys(localStorage)) {
        const m = k.match(SB_TOKEN_RE);
        if (m) return (sbRefCache = m[1]);
      }
    } catch (_) {
      /* stockage indisponible */
    }
    try {
      for (const c of document.cookie.split(';')) {
        const m = c.trim().split('=')[0].match(SB_TOKEN_RE);
        if (m) return (sbRefCache = m[1]);
      }
    } catch (_) {
      /* pas de cookies lisibles */
    }
    return (sbRefCache = SB_REF_FALLBACK);
  }

  const sbUrl = () => `https://${sbRef()}.supabase.co/rest/v1`;

  /*
   * Le jeton vit soit dans `localStorage` (client Supabase classique), soit
   * dans un cookie posé par supabase-ssr — parfois découpé en `.0`, `.1`,
   * parfois préfixé `base64-`. Les trois formes existent selon la page qui t'a
   * connecté ; on les lit toutes plutôt que de parier sur une.
   */
  function sbToken() {
    const key = `sb-${sbRef()}-auth-token`;
    const lire = (brut) => {
      if (!brut) return null;
      let texte = brut;
      if (texte.startsWith('base64-')) texte = atob(texte.slice(7));
      const o = JSON.parse(texte);
      if (o && o.access_token) return o.access_token;
      return Array.isArray(o) && typeof o[0] === 'string' ? o[0] : null;
    };

    try {
      const t = lire(localStorage.getItem(key));
      if (t) return t;
    } catch (_) {
      /* forme inattendue : on tente les cookies */
    }

    try {
      const morceaux = {};
      let seul = null;
      for (const c of document.cookie.split(';')) {
        const brut = c.trim();
        const eq = brut.indexOf('=');
        if (eq === -1) continue;
        const nom = brut.slice(0, eq);
        const val = brut.slice(eq + 1);
        if (nom === key) { seul = val; continue; }
        const m = nom.match(/^(.+)\.(\d+)$/);
        if (m && m[1] === key) morceaux[Number(m[2])] = val;
      }
      // Recoller AVANT de décoder : un échappement `%xx` peut enjamber deux
      // morceaux, et décoder chacun séparément le couperait en deux.
      const assemble = seul ||
        Object.keys(morceaux).sort((a, b) => a - b).map((k) => morceaux[k]).join('');
      return lire(assemble ? decodeURIComponent(assemble) : null);
    } catch (_) {
      /* pas de session lisible */
    }
    return null;
  }

  /**
   * Identifiant du compte, lu dans le jeton. La charge utile d'un JWT n'est
   * pas chiffrée — c'est du base64url, pas un secret à casser.
   */
  function sbUserId() {
    const t = sbToken();
    if (!t) return null;
    try {
      const corps = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(corps)).sub || null;
    } catch (_) {
      return null;
    }
  }

  /*
   * `credentials: 'omit'` à dessein : les cookies du site n'ont rien à faire
   * sur le domaine Supabase, l'autorisation passe par l'en-tête. Toute erreur
   * rend `null` — les appelants savent tous retomber sur le chemin d'avant.
   */
  async function sbGet(path) {
    if (!prefs.db) return null;
    const token = sbToken();
    if (!token) return null;
    try {
      const res = await fetch(`${sbUrl()}/${path}`, {
        credentials: 'omit',
        headers: { apikey: SB_ANON, Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  /** Même chose pour une fonction serveur (`/rpc/<nom>`), en POST. */
  async function sbRpc(nom, args) {
    if (!prefs.db) return null;
    const token = sbToken();
    if (!token) return null;
    try {
      const res = await fetch(`${sbUrl()}/rpc/${nom}`, {
        method: 'POST',
        credentials: 'omit',
        headers: {
          apikey: SB_ANON,
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args || {}),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  /*
   * Le descriptif OpenAPI que PostgREST publie à la racine liste les tables
   * exposées et leurs colonnes. Une requête répond à « ce champ existe-t-il ? »
   * là où la deviner coûtait une série d'essais. Réservé à la console :
   * `wmSchema()`, ou `wmSchema('pack')` pour filtrer.
   */
  window.wmSchema = async function (filtre) {
    const token = sbToken();
    if (!token) return 'Aucun jeton lisible — es-tu connecté au site ?';
    const res = await fetch(`${sbUrl()}/`, {
      credentials: 'omit',
      headers: { apikey: SB_ANON, Authorization: `Bearer ${token}`, Accept: 'application/openapi+json' },
    });
    if (!res.ok) return `Introspection : HTTP ${res.status}`;
    const spec = await res.json();
    const defs = spec.definitions || (spec.components && spec.components.schemas) || {};
    const rx = filtre ? new RegExp(filtre, 'i') : null;
    const out = {};
    for (const [table, def] of Object.entries(defs)) {
      if (rx && !rx.test(table)) continue;
      out[table] = Object.keys(def.properties || {});
    }
    return out;
  };

  /*
   * Ce que le compteur de pitié a fait, lu dans le journal : `wmPity()`.
   *
   * On ne suppose rien de sa mécanique — on la lit. Le journal porte une valeur
   * par tirage ; il suffit de regarder de combien elle monte d'un paquet au
   * suivant, quand elle retombe, de quelle hauteur, et ce que contenait le
   * paquet qui l'a fait retomber. Trois cents paquets suffiront à trancher.
   */
  window.wmPity = function () {
    const avecPitie = state.history.filter((e) => Number.isFinite(e.pity));
    if (avecPitie.length < 2) {
      return 'Pas encore de mesure — le compteur est relevé à chaque ouverture, laisse tourner.';
    }

    // Le journal va du plus récent au plus ancien, et porte cinq lignes par
    // paquet : on le remet à l'endroit et on garde une valeur par paquet.
    const paquets = new Map();
    for (const e of avecPitie.slice().reverse()) {
      if (!paquets.has(e.pack)) paquets.set(e.pack, { pity: e.pity, raretes: [] });
      paquets.get(e.pack).raretes.push(e.rarity);
    }

    const suite = [...paquets.entries()].sort((a, b) => a[0] - b[0]);
    const montees = {};
    const remises = [];
    for (let i = 1; i < suite.length; i++) {
      const avant = suite[i - 1][1], apres = suite[i][1];
      const delta = apres.pity - avant.pity;
      if (delta < 0) {
        remises.push({ de: avant.pity, vers: apres.pity, paquet: suite[i][0], raretes: apres.raretes.join('') });
      } else {
        montees[delta] = (montees[delta] || 0) + 1;
      }
    }

    return {
      paquetsMesures: suite.length,
      monteeParPaquet: montees,          // {1: 87} = il monte de 1 à chaque fois
      remisesAZero: remises.slice(-10),  // de quelle hauteur, et sur quel tirage
      maxVu: state.pityMax,
      valeurCourante: state.pity,
      lecture: remises.length
        ? `Retombe depuis ${Math.max(...remises.map((r) => r.de))} au plus haut — palier probable.`
        : `Jamais retombé en ${suite.length} paquets ; max vu ${state.pityMax}.`,
    };
  };

  // ------------------------------------------------------------------ guilde

  /*
   * Ce que la guilde marque, et où il reste du gras.
   *
   * Formule du score hebdomadaire, vérifiée au point près sur les totaux du
   * serveur : `total = 500 × combats + wikibidous_encaissés + karma`.
   * Mesuré le 4 septembre 2026 : 500 × combats + wikibidous + karma,
   * exactement le `total_score` annoncé.
   *
   * Ce que ça dit : le karma pèse 2 % du score, alors que le plafond
   * théorique — une réception par membre et par jour — vaut plusieurs fois le
   * score entier. C'est le seul axe où presque rien n'est pris.
   */
  const GUILD_FRESH_MS = 300000;  // le serveur ne recalcule son classement qu'à cette cadence

  /*
   * Karma par rareté. Ces valeurs viennent d'un relevé antérieur et **ne sont
   * pas prouvées** : seul le 500 est corroboré (une contribution d'un don en
   * valait 500). Elles servent donc de départ, et `apprendKarma` les remplace
   * par ce que le serveur fait réellement.
   */
  const KARMA_SUPPOSE = { C: 100, PC: 200, R: 300, SR: 500, UR: 1000, L: 2000 };
  const karmaDe = (r) => (Number.isFinite(state.karmaVu[r]) ? state.karmaVu[r] : KARMA_SUPPOSE[r] || 0);

  /*
   * La table se mesure toute seule, sur l'activité de la guilde.
   *
   * Entre deux relevés, si le compteur de dons a bougé d'EXACTEMENT un et que
   * le karma a bougé de X, alors ce don valait X — et `recent_donations` dit
   * quelle rareté il portait. Deux dons dans l'intervalle et on ne conclut
   * rien : c'est la condition qui rend la mesure honnête plutôt que moyennée.
   *
   * Quarante-huit dons par semaine dans la guilde suffisent à remplir la table
   * sans qu'on ait à donner quoi que ce soit pour l'établir.
   */
  function apprendKarma(avant, apres, dernier) {
    if (!avant || !avant.at) return;
    const dDons = apres.dons - avant.dons;
    const dKarma = apres.karma - avant.karma;
    if (dDons !== 1 || dKarma <= 0 || !dernier || !dernier.rarete) return;
    if (state.karmaVu[dernier.rarete] === dKarma) return;
    state.karmaVu[dernier.rarete] = dKarma;
    saveStore({ karmaVu: state.karmaVu });
  }

  /*
   * Les seules raretés que le panneau propose et signale.
   *
   * Décidé, mesures à l'appui, puis clos : au-dessus on ne donne pas, en
   * dessous ça ne rapporte pas assez par rencontre. Ce qui est rare n'est pas
   * la place — plusieurs milliers de créneaux par semaine, moins de 0,5 % utilisés — mais
   * qu'un souhait tombe sur une carte détenue. Chaque rencontre doit donc
   * rapporter le plus possible, et la SR est le point d'équilibre : 500 karma
   * pour une carte qui vaut 21 wikibidous à la revente.
   *
   * Le panneau ne réargumente pas ce choix à chaque affichage : il s'y tient.
   */
  const RARETES_UTILES = ['SR', 'UR'];

  /*
   * Cinq cartes par annonce, pas quarante.
   *
   * Quarante titres publiés d'un coup, c'est quarante réservations à suivre
   * dans un fil de discussion et autant de dons à honorer sans savoir où on en
   * est. Cinq tiennent dans un message, se réservent en quelques échanges, et
   * se donnent dans la foulée — après quoi on republie. Le rythme vient du
   * cycle, pas du volume.
   */
  const LOT_SOUHAITS = 5;
  const PUBLIEES_MAX = 300;   // ~60 lots avant recyclage des plus anciens titres

  /*
   * Le message, écrit pour ce que le tchat accepte vraiment.
   *
   * Relevé sur la page : le champ est un `<input type="text" maxlength="1000">`,
   * donc une seule ligne — la touche Entrée envoie, elle ne saute pas de ligne.
   * Les bulles se rendent en `white-space: normal`, si bien qu'un saut de ligne
   * passé par l'API serait écrasé à l'affichage, et le contenu est inséré comme
   * texte : aucune syntaxe n'est interprétée. Sur 200 messages lus, aucun ne
   * contenait de retour à la ligne — ce n'est pas l'usage, c'est la contrainte.
   *
   * D'où une ligne unique, la ponctuation pour toute mise en page, et un
   * plafond à 1 000 caractères qu'on vérifie avant de copier.
   */
  const CHAT_MAX = 1000;

  /*
   * Deux messages, parce qu'ils n'ont pas la même durée de vie.
   *
   * La marche à suivre ne change jamais : elle se poste une fois, et la
   * republier à chaque lot serait du bruit dans un fil où le message moyen fait
   * quarante caractères. Le lot, lui, change à chaque cycle et doit rester
   * court — c'est celui qu'on relira le plus souvent.
   *
   * Les cartes sont numérotées : réserver « la 3 » se tape sans faute, là où
   * « Nuno Mendes (football, 2002) » se recopie mal. Et l'exemple vaut mieux
   * qu'une consigne — personne ne lit une règle, tout le monde imite un modèle.
   */
  function messageGuildeTuto() {
    return `Points de guilde : je poste régulièrement des cartes que je possède ` +
      `et peux donner. Dites ici le numéro de celle que vous prenez ` +
      `(ex. « je prends la 3 »), mettez-la en souhait de guilde, et je vous la ` +
      `donne. Une seule carte reçue par membre et par jour, alors prenez-en ` +
      `chacun une différente.`;
  }

  function messageGuildeLot(lot) {
    return `Nouveau lot : ` +
      lot.map((c, i) => `${i + 1}) ${c.rarete} ${c.titre}`).join(' · ');
  }

  /*
   * Ce que tu peux réellement offrir, lu dans ta collection.
   *
   * Mesuré : N cartes distinctes pour N doublons seulement — à l'échelle
   * de ce catalogue (2,77 M de cartes), le surplus n'existe pas. Donner puise
   * donc dans la collection elle-même, et le jeu l'autorise : les sept souhaits
   * servables du jour portaient tous sur des exemplaires uniques.
   *
   * Le coût d'un don est donc le prix de la carte plus une unité de collection.
   * À 11 wikibidous la Rare, c'est le prix le plus bas pour 300 karma.
   *
   * Une lecture complète coûte une dizaine de requêtes ; elle est donc gardée
   * une heure. Les étiquettes voyagent dans la même requête (`user_card_tags`
   * embarqué), parce que ce sont elles qui disent ce qu'il ne faut pas proposer.
   */
  const COLLECTION_TTL_MS = 3600000;

  /**
   * @param {boolean} force  Ignorer le cache. Indispensable après un étiquetage :
   *   protéger une carte doit se voir tout de suite, pas dans une heure.
   */
  async function dbMyCards(force) {
    const c = state.maCollection;
    if (!force && c && Date.now() - c.at < COLLECTION_TTL_MS) return c.cartes;
    const moi = await fetchMyId();
    if (!moi) return null;

    const cartes = [];
    for (let page = 0; page < 20; page++) {
      const lot = await sbGet(
        `user_cards?user_id=eq.${moi}` +
        `&select=card_id,snapshot_rarity,snapshot_title,starred,user_card_tags(tag_id),` +
        `cards(rarity,wikipedia_title)` +
        `&limit=1000&offset=${page * 1000}`
      );
      if (!Array.isArray(lot)) return null;
      /*
       * La rareté COURANTE, pas celle figée à l'obtention.
       *
       * `snapshot_rarity` date du tirage ; le jeu recalcule ensuite les raretés
       * et l'écart est réel — mesuré sur 1 000 cartes : 17 divergences, dont
       * trois cartes annoncées SR qui sont en fait R ou PC. Publier l'une
       * d'elles, c'était promettre une Super Rare et livrer une Rare.
       *
       * Le titre suit la même règle : c'est celui du catalogue que les membres
       * chercheront pour poser leur souhait, pas celui d'il y a six mois.
       */
      for (const c of lot) {
        c.rarete = (c.cards && c.cards.rarity) || c.snapshot_rarity;
        c.titre = (c.cards && c.cards.wikipedia_title) || c.snapshot_title;
      }
      cartes.push(...lot);
      if (lot.length < 1000) break;
    }
    state.maCollection = { at: Date.now(), cartes };
    return cartes;
  }

  /**
   * La liste à faire souhaiter par la guilde.
   *
   * Le levier n'est pas de donner plus, c'est de rendre le don POSSIBLE : sur
   * 697 souhaits, sept seulement portaient sur une carte que tu détiens. Tant
   * que la demande vise des Légendaires que personne n'a, les créneaux restent
   * vides. Publier des titres que tu possèdes vraiment, dans les raretés au
   * meilleur rendement, suffit à débloquer autant de dons qu'il y a de membres
   * pour les souhaiter — sans que personne n'installe quoi que ce soit.
   */
  async function suggestWishes(combien, force) {
    const cartes = await dbMyCards(force);
    if (!cartes) return null;

    /*
     * Un message qu'on republie ne doit pas être le même.
     *
     * Le levier n'est pas une annonce unique : les souhaits se réalisent, les
     * membres changent, il faut y revenir. Republier les quarante mêmes titres
     * ne servirait qu'à ceux qui n'avaient pas lu la première fois — et les
     * cartes déjà souhaitées par quelqu'un n'ont aucun besoin d'être réclamées
     * une seconde fois. Chaque préparation sort donc un lot neuf, et ne recycle
     * qu'une fois le stock épuisé.
     */
    const dejaPubliees = new Set(state.publiees || []);
    const dejaSouhaitees = new Set(state.guild.cartesSouhaitees || []);

    const vus = new Set();
    const out = [];
    let ecartees = 0;
    let recyclees = 0;
    for (const r of RARETES_UTILES) {
      for (const c of cartes) {
        if (c.rarete !== r) continue;
        if (!c.titre || vus.has(c.card_id)) continue;
        if (dejaSouhaitees.has(c.card_id)) continue;   // quelqu'un la réclame déjà
        if (dejaPubliees.has(c.card_id)) { recyclees += 1; continue; }
        /*
         * Étiquetée ou en favori : on ne la propose pas.
         *
         * Le script traite déjà l'étiquette comme un « je garde » côté revente ;
         * un don étant irréversible, la règle y est au moins aussi ferme. Toute
         * étiquette compte, pas seulement celles filtrées dans la Revente : une
         * étiquette posée après le dernier réglage doit protéger la carte
         * immédiatement, sans qu'on ait à y penser.
         */
        if (c.starred || (c.user_card_tags && c.user_card_tags.length)) {
          ecartees += 1;
          continue;
        }
        vus.add(c.card_id);
        out.push({ id: c.card_id, titre: c.titre, rarete: r });
        if (out.length >= combien) break;
      }
      if (out.length >= combien) break;
    }

    /*
     * Stock épuisé : on repart du début plutôt que de rendre une liste vide.
     * Republier d'anciens titres a du sens — les membres arrivés depuis n'en
     * ont jamais entendu parler.
     */
    if (!out.length && recyclees) {
      state.publiees = [];
      saveStore({ publiees: [] });
      return suggestWishes(combien, false);
    }

    out.ecartees = ecartees;
    out.dejaSouhaitees = dejaSouhaitees.size;
    out.dejaPubliees = dejaPubliees.size;
    return out;
  }

  /**
   * Les cartes protégées parmi celles passées, relues à l'instant.
   *
   * Une étiquette veut dire « je ne la donne pas », quelle que soit la rareté
   * et sans délai. S'appuyer sur la collection en cache — une heure — laissait
   * une carte étiquetée il y a dix minutes déclencher une alerte ou apparaître
   * dans une liste. On ne relit pas pour autant toute la collection : une requête
   * bornée aux identifiants concernés suffit, et elle part à chaque relevé.
   *
   * En cas d'échec réseau, on rend `null` : l'appelant doit alors s'abstenir
   * plutôt que de supposer la carte libre.
   */
  async function protegeesDe(ids) {
    if (!ids.length) return new Set();
    const moi = await fetchMyId();
    if (!moi) return null;
    const lignes = await sbGet(
      `user_cards?user_id=eq.${moi}&card_id=in.(${ids.join(',')})` +
      `&select=card_id,starred,user_card_tags(tag_id)&limit=200`
    );
    if (!Array.isArray(lignes)) return null;
    return new Set(
      lignes
        .filter((c) => c.starred || (c.user_card_tags && c.user_card_tags.length))
        .map((c) => c.card_id)
    );
  }

  /*
   * Prévenir quand un souhait tombe sur une carte que tu peux servir.
   *
   * Publier la liste ne sert à rien si le souhait qu'elle déclenche passe
   * inaperçu : le destinataire ne peut recevoir qu'une carte par jour, et la
   * fenêtre se referme. C'est donc l'alerte qui ferme la boucle.
   *
   * Deux filtres, et ils comptent autant que l'alerte elle-même :
   *   - les raretés au bon rendement seulement (R, SR, PC). Signaler une
   *     Légendaire servable serait signaler ce que tu as décidé de ne pas
   *     donner — du bruit, et le genre de bruit qui fait couper l'option.
   *   - jamais une carte étiquetée ou en favori, même règle que la liste
   *     proposée : ce que tu gardes ne se signale pas comme donnable.
   */
  const GUILD_SEEN_MAX = 400;

  async function signalerDons(servables) {
    if (!prefs.watchGuild) return;

    /*
     * Premier tour après l'armement : on enregistre l'existant sans rien dire.
     * Cocher la case ne doit pas déclencher une volée d'alertes sur des
     * souhaits posés il y a trois jours — l'alerte porte sur ce qui arrive,
     * pas sur ce qui était déjà là.
     *
     * Le drapeau se lève AVANT le test de liste vide. Sinon, cocher la case à
     * un moment où rien n'est servable le laissait armé, et c'est le premier
     * souhait réel — celui qu'on attendait — qui passait sous silence.
     */
    if (state.guildSilence) {
      state.guildSilence = false;
      for (const s of servables) state.guildSeen[s.id] = Date.now();
      saveStore({ guildSeen: state.guildSeen });
      return;
    }

    if (!servables.length) return;

    /*
     * Protection relue à l'instant, jamais depuis le cache : une étiquette
     * posée il y a dix minutes doit déjà faire taire l'alerte. Si la lecture
     * échoue, on ne signale rien ce tour-ci — mieux vaut une alerte en retard
     * qu'une alerte sur une carte que tu gardes.
     */
    const protegees = state.guild.protegees;
    if (!protegees) return;

    const neufs = servables.filter((s) =>
      RARETES_UTILES.includes(s.rarete) &&
      !protegees.has(s.carte) &&
      !state.guildSeen[s.id]
    );
    // Tout souhait servable est marqué vu, y compris ceux qu'on ne signale pas :
    // sans ça, une Légendaire écartée reviendrait à chaque tour de veille.
    for (const s of servables) state.guildSeen[s.id] = Date.now();

    // Le registre ne doit pas gonfler indéfiniment : on garde les plus récents.
    const ids = Object.keys(state.guildSeen);
    if (ids.length > GUILD_SEEN_MAX) {
      const gardes = ids.sort((a, b) => state.guildSeen[b] - state.guildSeen[a]).slice(0, GUILD_SEEN_MAX);
      const frais = {};
      for (const id of gardes) frais[id] = state.guildSeen[id];
      state.guildSeen = frais;
    }
    saveStore({ guildSeen: state.guildSeen });

    if (!neufs.length) return;
    const premier = neufs[0];
    const titre = neufs.length === 1
      ? `Don possible : ${premier.rarete}`
      : `${neufs.length} dons possibles`;
    const corps = neufs.length === 1
      ? `${premier.titre} → ${premier.pour} · +${karmaDe(premier.rarete)} karma`
      : neufs.slice(0, 3).map((s) => `${s.rarete} ${s.titre}`).join(' · ');
    state.guildNote = `${titre} — ${corps}`;
    notifyBid(titre, corps);
    render();
  }

  /*
   * Le lot avance tout seul, sans troisième bouton.
   *
   * « Une fois donné, je reposte » : le panneau peut le savoir sans qu'on le
   * lui dise. Une carte donnée quitte la collection — il suffit donc de relire
   * celle-ci pour marquer ce qui est parti. Encore faut-il ne pas la relire
   * pour rien : la lecture complète coûte une dizaine de requêtes.
   *
   * D'où le déclencheur : le compteur de dons de TA contribution. Tant qu'il
   * ne bouge pas, rien n'a été donné et il n'y a rien à vérifier. Quand il
   * bouge, on relit une fois, on marque, et si le lot est épuisé on prépare le
   * suivant — prêt à copier.
   */
  async function suivreLot(avant, apres) {
    if (!state.aSouhaiter || !state.aSouhaiter.length) return;
    const donsAvant = avant && avant.moi ? avant.moi.donations_this_week : null;
    const donsApres = apres.moi ? apres.moi.donations_this_week : null;
    if (!Number.isFinite(donsAvant) || !Number.isFinite(donsApres) || donsApres <= donsAvant) return;

    const cartes = await dbMyCards(true);
    if (!cartes) return;
    const possedees = new Set(cartes.map((c) => c.card_id));
    for (const c of state.aSouhaiter) {
      if (!possedees.has(c.id)) c.donnee = true;
    }

    // Lot épuisé : on enchaîne, c'est le moment de republier.
    if (state.aSouhaiter.every((c) => c.donnee)) {
      const suivant = await suggestWishes(LOT_SOUHAITS, false);
      if (suivant && suivant.length) {
        state.aSouhaiter = suivant;
        state.guildNote = 'Lot épuisé — le suivant est prêt à publier.';
        notifyBid('Lot donné', 'Le lot suivant est prêt à copier.');
      }
    }
    render();
  }

  async function refreshGuild(force) {
    if (!force && Date.now() - (state.guild.at || 0) < GUILD_FRESH_MS) return;

    let home, lb;
    try {
      home = await api('/api/guilds/home');
      lb = await api('/api/guilds/leaderboard');
    } catch (_) {
      return;   // réseau : le relevé précédent reste affiché, avec son âge
    }
    const h = home.status === 200 ? home.data : null;
    if (!h || !h.guild) return;

    const souhaits = Array.isArray(h.wishlist) ? h.wishlist : [];
    const parRarete = {};
    for (const w of souhaits) {
      const r = (w.card && w.card.rarity) || '?';
      parRarete[r] = (parRarete[r] || 0) + 1;
    }

    /*
     * Ce que je peux servir maintenant. `can_donate` est calculé par le serveur
     * chez le donateur — c'est lui qui fait autorité, pas notre lecture de la
     * collection. On écarte son propre souhait et ceux déjà servis aujourd'hui :
     * un membre ne reçoit qu'une carte par jour, insister ne sert à rien.
     */
    const servables = souhaits
      .filter((w) => w.can_donate && !w.is_self && !w.recipient_received_today)
      .map((w) => ({
        id: w.id,
        carte: w.card && w.card.id,
        titre: (w.card && w.card.wikipedia_title) || '',
        rarete: (w.card && w.card.rarity) || '?',
        pour: w.username || '',
        copies: (w.owned_copy_ids || []).length,
      }));

    const entrees = (lb.status === 200 && lb.data && lb.data.entries) || [];
    const nous = entrees.find((x) => x.guild_id === h.guild.id) || null;
    const tete = entrees[0] || null;

    const avant = state.guild;
    const dernier = (h.recent_donations || [])[0];
    const apres = {
      at: Date.now(),
      nom: h.guild.name || '',
      karma: h.guild.karma_this_week || 0,
      dons: h.guild.donations_this_week || 0,
      souhaits: souhaits.length,
      parRarete,
      servables,
      moi: h.my_contribution || null,
      // Les cartes déjà réclamées par quelqu'un : inutile de les faire souhaiter
      // une seconde fois, elles sont couvertes.
      cartesSouhaitees: souhaits.map((w) => w.card && w.card.id).filter(Boolean),
      rang: nous ? nous.rank : null,
      membres: nous ? nous.member_count : (h.my_contribution && h.my_contribution.eligible_count) || 0,
      total: nous ? nous.total_score : null,
      batailles: nous ? nous.score_battles : null,
      wb: nous ? nous.score_wb : null,
      chef: tete && tete.guild_name,
      chefTotal: tete && tete.total_score,
    };

    // Le relevé lui-même n'est pas mémorisé : il périme en cinq minutes, et un
    // tableau de bord ressorti périmé au rechargement induit en erreur.
    apprendKarma(avant, apres, dernier && { rarete: dernier.card && dernier.card.rarity });
    state.guild = apres;

    /*
     * Une seule requête, à chaque relevé : lesquelles de ces cartes sont
     * étiquetées ou en favori. Elle couvre les souhaits servables ET le lot
     * publié — une carte étiquetée après sa publication doit se voir dans le
     * lot aussi, sinon on la donne sans y penser.
     */
    const aVerifier = [...new Set([
      ...servables.map((s) => s.carte),
      ...((state.aSouhaiter || []).map((c) => c.id)),
    ].filter(Boolean))];
    apres.protegees = await protegeesDe(aVerifier);

    await suivreLot(avant, apres);
    await signalerDons(servables);

    /*
     * Le relevé des prix médians a disparu avec l'arbitrage qu'il servait.
     * Il tranchait « donner ou vendre ? » carte par carte — question qui ne se
     * pose plus depuis qu'on s'en tient aux SR et UR : à 21 wikibidous la SR
     * contre 500 karma, la réponse est toujours la même. Une requête de moins
     * à chaque relevé.
     */
    render();
  }

  /*
   * Colonnes d'une annonce. Les mêmes noms que ceux rendus par l'API du site :
   * `auctionRow`, `rememberListing` et le suivi n'ont donc rien à apprendre —
   * seule la relation `cards` doit être rebaptisée `card`.
   */
  const AUCTION_COLS = 'id,seller_id,card_id,base_amount,current_bid,current_bidder_id,' +
    'end_at,status,winner_id,final_price,settled_at,created_at,snapshot_rarity';

  /**
   * Mes ventes en cours, exactement — ce que `/api/marketplace/mine` ne rend
   * plus. L'embarquement des titres est retenté sans lui en cas d'échec : une
   * relation absente fait répondre 400 à PostgREST, et une liste sans titres
   * vaut mieux qu'une absence de liste.
   */
  async function dbActiveSales() {
    const moi = await fetchMyId();
    if (!moi) return null;
    const maintenant = encodeURIComponent(new Date().toISOString());
    // 50 : le plafond du compte est de dix ventes, la marge absorbe un écart
    // d'horloge sur `end_at` sans jamais ramener le marché entier.
    const filtre = `auctions?seller_id=eq.${moi}&status=eq.active` +
      `&end_at=gt.${maintenant}&order=end_at.asc&limit=50`;
    let rows = await sbGet(`${filtre}&select=${AUCTION_COLS},cards(id,wikipedia_title,rarity)`);
    if (!Array.isArray(rows)) rows = await sbGet(`${filtre}&select=${AUCTION_COLS}`);
    if (!Array.isArray(rows)) return null;
    return rows.map((r) => ({ ...r, card: r.cards || r.card || null }));
  }

  /*
   * Mes ventes passent désormais par l'API, plus par la lecture d'un onglet :
   * l'ancienne méthode dépendait d'un basculement en arrière-plan et ratait
   * la plupart des ventes. `/api/notifications` livre l'identifiant du compte,
   * ce qui évite de le coder en dur.
   */
  let myId = null;

  async function fetchMyId() {
    if (myId) return myId;
    /*
     * Le jeton porte l'identifiant : plus direct, et surtout insensible à une
     * boîte de notifications vide — un compte neuf n'en a aucune, et l'id
     * restait alors introuvable jusqu'à la première notification.
     *
     * Sous condition du réglage : « lecture directe désactivée » doit vouloir
     * dire qu'on ne touche pas au jeton, pas seulement qu'on ne s'en sert pas
     * pour interroger la base.
     */
    if (prefs.db) {
      myId = sbUserId();
      if (myId) return myId;
    }
    try {
      const d = await api('/api/notifications');
      const n = (d.data && d.data.notifications) || [];
      myId = n.length ? n[0].user_id : null;
    } catch (_) {
      /* réessai au prochain cycle */
    }
    return myId;
  }

  /*
   * Le marché renouvelle mille annonces toutes les six minutes : un balayage de
   * `/api/marketplace?sort=recent`, même sur vingt pages, ne remonte que six
   * minutes en arrière. Une vente de dix minutes disparaissait donc du panneau à
   * mi-course — bien vivante, mais hors de la fenêtre — et le panneau annonçait
   * « 1/10 emplacement » au-dessus d'une liste vide. Vingt pages toutes les
   * quinze secondes, en pure perte.
   *
   * On suit désormais les annonces par leur identifiant. `/api/marketplace/<id>`
   * répond `{auction, bids}` quel que soit son âge : une requête par annonce,
   * dix au plus, et le détail reste juste jusqu'à la fin de l'enchère.
   */
  /*
   * Un quota par nature. Avec un plafond global, dix-huit enchères suffisaient à
   * évincer les ventes du suivi, et le panneau retombait sur « 0 vente » sous
   * une jauge à 6/10. Les ventes sont bornées par les emplacements du compte,
   * les enchères par ce qu'on peut raisonnablement relire.
   */
  const AUCTION_CAP = { sale: 16, bid: 44 };

  /** Retenir une annonce qui me concerne, pour la relire ensuite par son id. */
  function trackAuction(id, kind) {
    if (!id) return;
    const deja = state.myAuctions[id];
    if (deja) {
      deja.at = Date.now();
      if (kind) deja.kind = kind;
      return;
    }
    state.myAuctions[id] = { kind, at: Date.now(), seen: 0, end: null };
    const memeNature = Object.keys(state.myAuctions).filter(
      (x) => state.myAuctions[x].kind === kind
    );
    const cap = AUCTION_CAP[kind] || 24;
    if (memeNature.length > cap) {
      // Les plus anciennes d'abord : une annonce close finit par être oubliée.
      memeNature.sort((a, b) => state.myAuctions[a].at - state.myAuctions[b].at);
      for (const vieux of memeNature.slice(0, memeNature.length - cap)) {
        delete state.myAuctions[vieux];
      }
    }
    saveStore({ myAuctions: state.myAuctions });
  }

  const auctionRow = (x, kind, moi, bids) => {
    const titre = x.card?.wikipedia_title || '';
    return {
      title: titre,
      auction: x.id || null,       // la page de l'annonce : /marketplace/<id>
      card: x.card_id || null,
      price: x.base_amount ?? null,
      minutes: x.created_at && x.end_at
        ? Math.max(10, Math.round((Date.parse(x.end_at) - Date.parse(x.created_at)) / 60000))
        : null,
      bid: x.current_bid ?? x.base_amount ?? null,
      offered: x.current_bid != null,
      /*
       * L'échéance est absolue, jamais une durée restante. Une durée n'a de sens
       * que rapportée à l'instant du relevé : dès qu'on mélangeait des lignes
       * relevées à des moments différents, il fallait toutes les recaler, et
       * l'oubli d'un recalage rendait du temps à une enchère qui expirait.
       */
      end: x.end_at ? Date.parse(x.end_at) : null,
      // Côté enchère, seul compte de savoir si je mène encore.
      status: kind === 'bid' ? (x.current_bidder_id === moi ? 'mene' : 'surencheri') : null,
      mise: kind === 'bid' && bids ? (bids.find((b) => b.bidder_id === moi) || {}).amount ?? null : null,
    };
  };

  /** Rejouer une annonce à l'identique : prix de départ et durée, déduite des dates. */
  function rememberListing(x) {
    if (!x.card_id || !x.created_at || !x.end_at) return;
    state.lastListing[x.card_id] = {
      title: x.card?.wikipedia_title || '',
      price: x.base_amount ?? x.current_bid ?? 0,
      minutes: Math.max(10, Math.round((Date.parse(x.end_at) - Date.parse(x.created_at)) / 60000)),
    };
  }

  /*
   * Relit chaque annonce suivie. Celles qui sont closes, ou qui ne me concernent
   * plus, sortent de la liste — c'est ce qui l'empêche de gonfler indéfiniment.
   */
  /*
   * On ne relit pas tout à chaque tour. Une enchère qui se termine dans six
   * heures ne bouge pas en quinze secondes ; celle qui finit dans cinq minutes,
   * si. Chaque annonce porte donc la date de sa dernière lecture, et le tour ne
   * traite qu'un lot des plus anciennes — ce qui borne le trafic quel que soit
   * le nombre d'annonces suivies.
   */
  const REFRESH_BATCH = 12;      // annonces relues par tour, au plus
  const REFRESH_EVERY = 45000;   // au repos, une relecture toutes les 45 s
  const REFRESH_HOT = 600000;    // sauf dans les dix dernières minutes : à chaque tour

  function dueAuctions() {
    const maintenant = Date.now();
    return Object.keys(state.myAuctions)
      .filter((id) => {
        const e = state.myAuctions[id];
        if (!e.seen) return true;
        if (e.end != null && e.end - maintenant < REFRESH_HOT) return true;
        return maintenant - e.seen > REFRESH_EVERY;
      })
      .sort((a, b) => (state.myAuctions[a].seen || 0) - (state.myAuctions[b].seen || 0))
      .slice(0, REFRESH_BATCH);
  }

  async function refreshAuctions() {
    const moi = await fetchMyId();
    if (!moi) return null;
    const ventes = [], encheres = [];
    let bouge = false;

    for (const id of dueAuctions()) {
      let d;
      try {
        d = await api(`/api/marketplace/${id}`);
      } catch (_) {
        continue;                       // réseau : on garde l'annonce pour le tour suivant
      }
      /*
       * On ne retire une annonce que sur une réponse qui tranche. Retirer sur
       * « pas 200 » vidait le suivi au premier 429 ou 500 : le panneau
       * retombait alors sur le balayage récent, donc sur ses six minutes de
       * mémoire, et les ventes disparaissaient de nouveau.
       */
      if (d.status === 429 || d.status >= 500) break;   // on n'insiste pas ce tour-ci
      if (d.status === 404) { delete state.myAuctions[id]; bouge = true; continue; }
      const a = d.data && d.data.auction;
      if (d.status !== 200 || !a) continue;
      if (a.status !== 'active' || (a.end_at && Date.parse(a.end_at) <= Date.now())) {
        /*
         * Une vente conclue doit arrêter le suivi TOUT DE SUITE. On ne s'en
         * remettait qu'à la notification, relevée toutes les quinze secondes et
         * seulement par le guetteur — alors que le tour de relance passe chaque
         * seconde. Entre les deux, la carte n'était plus en vente et repartait :
         * sur une carte possédée en double, le second exemplaire était mis en
         * vente alors que le premier venait de se vendre. L'annonce elle-même
         * porte le verdict, et `/api/notifications` ne garde que 50 lignes.
         */
        if (a.seller_id === moi && a.card_id &&
            (a.winner_id || /sold|vendu/i.test(a.status || ''))) {
          dropWatch(a.card_id, 'vendue');
        }
        delete state.myAuctions[id];
        bouge = true;
        continue;
      }
      const e = state.myAuctions[id];
      e.seen = Date.now();
      e.end = a.end_at ? Date.parse(a.end_at) : null;
      bouge = true;
      if (a.seller_id === moi) {
        e.kind = 'sale';
        ventes.push(auctionRow(a, 'sale', moi));
        rememberListing(a);
      } else if ((d.data.bids || []).some((b) => b.bidder_id === moi)) {
        e.kind = 'bid';
        encheres.push(auctionRow(a, 'bid', moi, d.data.bids));
      } else {
        delete state.myAuctions[id];    // ni vendeur ni enchérisseur : rien à suivre
      }
    }
    if (bouge) saveStore({ myAuctions: state.myAuctions });
    return { ventes, encheres };
  }

  /*
   * La même chose en trois requêtes au lieu de douze — et sans lot.
   *
   * La relecture annonce par annonce coûtait `REFRESH_BATCH` requêtes par tour,
   * soit une douzaine toutes les 45 s, et ne rafraîchissait qu'une partie du
   * suivi à chaque passage : une annonce pouvait rester périmée plusieurs
   * tours. La base rend tout d'un coup, donc plus rien à étaler.
   *
   * Trois lectures :
   *   1. les annonces suivies, quel que soit leur état — c'est ce qui permet de
   *      détecter une clôture ;
   *   2. mes ventes actives, y compris celles que le suivi ignore encore ;
   *   3. mes mises, pour savoir si je mène et à combien.
   *
   * Les décisions — retirer du suivi, `dropWatch` sur une vente conclue — sont
   * exactement celles du chemin API : mêmes champs, mêmes tests. Une requête en
   * échec rend `null` et laisse l'appelant retomber sur ce chemin, plutôt que
   * de faire croire à un suivi vide.
   */
  async function dbRefreshAuctions() {
    const moi = await fetchMyId();
    if (!moi) return null;

    const suivies = Object.keys(state.myAuctions);
    const maintenant = encodeURIComponent(new Date().toISOString());
    const cols = `select=${AUCTION_COLS},cards(id,wikipedia_title,rarity)`;

    const [pistees, miennes, mises] = await Promise.all([
      suivies.length
        ? sbGet(`auctions?id=in.(${suivies.join(',')})&${cols}&limit=200`)
        : Promise.resolve([]),
      sbGet(`auctions?seller_id=eq.${moi}&status=eq.active&end_at=gt.${maintenant}&${cols}&limit=50`),
      sbGet(`auction_bids?bidder_id=eq.${moi}&select=auction_id,amount&order=placed_at.desc&limit=200`),
    ]);

    // Une seule lecture ratée et on ne conclut rien : le suivi vaut mieux que
    // des listes trouées.
    if (!Array.isArray(pistees) || !Array.isArray(miennes) || !Array.isArray(mises)) return null;

    const parId = new Map();
    for (const a of [...pistees, ...miennes]) {
      parId.set(a.id, { ...a, card: a.cards || a.card || null });
    }
    // Ma meilleure mise par annonce : la liste est triée du plus récent au plus
    // ancien, mais le montant qui compte est le plus élevé.
    const maMise = new Map();
    for (const b of mises) {
      const vu = maMise.get(b.auction_id);
      if (vu == null || b.amount > vu) maMise.set(b.auction_id, b.amount);
    }

    const ventes = [], encheres = [];
    let bouge = false;

    for (const a of parId.values()) {
      const close = a.status !== 'active' || (a.end_at && Date.parse(a.end_at) <= Date.now());
      if (close) {
        if (a.seller_id === moi && a.card_id &&
            (a.winner_id || /sold|vendu/i.test(a.status || ''))) {
          dropWatch(a.card_id, 'vendue');
        }
        if (state.myAuctions[a.id]) { delete state.myAuctions[a.id]; bouge = true; }
        continue;
      }

      if (a.seller_id === moi) {
        trackAuction(a.id, 'sale');
        const e = state.myAuctions[a.id];
        if (e) { e.seen = Date.now(); e.end = a.end_at ? Date.parse(a.end_at) : null; bouge = true; }
        ventes.push(auctionRow(a, 'sale', moi));
        rememberListing(a);
      } else if (maMise.has(a.id)) {
        trackAuction(a.id, 'bid');
        const e = state.myAuctions[a.id];
        if (e) { e.seen = Date.now(); e.end = a.end_at ? Date.parse(a.end_at) : null; bouge = true; }
        // `auctionRow` attend la forme de l'API : une liste de mises.
        encheres.push(auctionRow(a, 'bid', moi, [{ bidder_id: moi, amount: maMise.get(a.id) }]));
      } else if (state.myAuctions[a.id]) {
        delete state.myAuctions[a.id];   // ni vendeur ni enchérisseur : rien à suivre
        bouge = true;
      }
    }

    /*
     * Une annonce suivie que la base ne rend pas n'existe plus — l'équivalent
     * du 404 côté API. Les requêtes ayant toutes abouti, l'absence tranche.
     */
    for (const id of suivies) {
      if (!parId.has(id)) { delete state.myAuctions[id]; bouge = true; }
    }

    if (bouge) saveStore({ myAuctions: state.myAuctions });
    return { ventes, encheres };
  }

  /*
   * Découverte des annonces encore inconnues. Le balayage récent ne sert plus
   * qu'à ça, et seulement quand il manque des ventes à l'appel : quelques pages
   * suffisent, puisqu'une annonce inconnue vient forcément d'être créée.
   */
  const DISCOVER_PAGES = 6;             // ~300 annonces, environ deux minutes de marché

  async function discoverSales(moi, manquantes) {
    const trouvees = [];
    for (let page = 0; page < DISCOVER_PAGES && trouvees.length < manquantes; page++) {
      let d;
      try {
        d = await api(`/api/marketplace?page=${page}&limit=50&sort=recent`);
      } catch (_) {
        break;
      }
      const lot = (d.data && d.data.auctions) || [];
      if (!lot.length) break;
      for (const x of lot) {
        if (x.seller_id !== moi || state.myAuctions[x.id]) continue;
        trackAuction(x.id, 'sale');
        rememberListing(x);
        trouvees.push(auctionRow(x, 'sale', moi));
      }
    }
    return trouvees;
  }

  /** Mes ventes en cours : le compte fait foi, le détail vient des annonces suivies. */
  async function fetchMySales() {
    const moi = await fetchMyId();
    if (!moi) return null;

    let attendu = null;
    try {
      const d = await api('/api/marketplace/mine');
      attendu = d.data && d.data.sellingCount;
      if (Number.isFinite(attendu)) {
        state.slots = { used: attendu, max: d.data.maxConcurrentAuctions || 10, at: Date.now() };
        saveStore({ slots: state.slots });
      }
    } catch (_) {
      /* on continue sans borne */
    }

    // La base d'abord : tout le suivi en trois requêtes, et à jour d'un coup.
    // L'API reste le chemin de secours, inchangé.
    const vu = (await dbRefreshAuctions()) || (await refreshAuctions());
    if (!vu) return null;
    /*
     * Les enchères relevées par identifiant valent mieux que celles lues à
     * l'écran : elles ne dépendent ni de la page affichée ni de son onglet. Mais
     * elles ne couvrent que les annonces déjà repérées — on garde donc les
     * autres, en leur rendant le temps écoulé depuis leur propre relevé.
     */
    if (vu.encheres.length) {
      const frais = new Map(vu.encheres.map((b) => [b.auction, b]));
      const restantes = stillRunning(state.bids.list).filter((b) => !frais.has(b.auction));
      state.bids = { at: Date.now(), list: [...frais.values(), ...restantes] };
      saveStore({ bids: state.bids });
    }

    /*
     * Un tour ne relit qu'un lot : les ventes non revues gardent leur ligne
     * précédente, qui reste juste puisque l'échéance y est absolue. Seules
     * sortent celles que le suivi a écartées — enchère close ou plus à moi.
     */
    const frais = new Map(vu.ventes.map((v) => [v.auction, v]));
    const gardees = stillRunning(state.sales.list).filter(
      (v) => v.auction && !frais.has(v.auction) && state.myAuctions[v.auction]
    );
    let ventes = [...frais.values(), ...gardees];

    /*
     * Il manque des ventes à l'appel du serveur. La base les rend toutes d'un
     * coup et sans approximation ; le balayage du marché ne sert plus que si
     * elle se tait — option décochée, ou session Supabase illisible. Il reste
     * en place pour ça, pas comme chemin normal : six pages tirées au hasard
     * des créations récentes ne trouvaient pas une annonce d'une heure.
     */
    if (attendu != null && ventes.length < attendu) {
      const connues = new Set(ventes.map((v) => v.auction));
      const base = await dbActiveSales();
      if (base) {
        for (const a of base) {
          if (connues.has(a.id)) continue;
          trackAuction(a.id, 'sale');
          rememberListing(a);
          ventes.push(auctionRow(a, 'sale', moi));
        }
      } else if (ventes.length < attendu) {
        ventes = ventes.concat(await discoverSales(moi, attendu - ventes.length));
      }
    }
    return ventes;
  }

  /** « 2h 12m », « 5m 19s », « 0s », « Terminée » → millisecondes. */
  function parseDuration(txt) {
    if (!txt) return null;
    if (/termin/i.test(txt)) return 0;
    const units = { j: 86400, d: 86400, h: 3600, m: 60, s: 1 };
    let total = 0;
    let seen = false;
    for (const [, n, u] of txt.matchAll(/(\d+)\s*([jdhms])/gi)) {
      total += Number(n) * units[u.toLowerCase()];
      seen = true;
    }
    return seen ? total * 1000 : null;
  }

  /** Le bon bloc est le plus grand ancêtre ne contenant encore qu'un seul titre. */
  function cardRoot(h) {
    let el = h;
    let best = h;
    for (let i = 0; i < 10 && el.parentElement; i++) {
      el = el.parentElement;
      if (el.querySelectorAll('h3').length === 1) best = el;
      else break;
    }
    return best;
  }

  /*
   * Lecture commune aux deux onglets. Les enchères portent un badge
   * « VOUS MENEZ » ou « SURENCHÉRI » ; les ventes n'en ont pas — c'est ce qui
   * les distingue, et pourquoi on ne peut pas filtrer sur le badge d'emblée.
   */
  /*
   * Chaque annonce porte son lien propre — `/marketplace/<enchère>`. C'est la
   * seule façon d'emmener sur LA vente plutôt que sur le Marché filtré par
   * titre, qui oblige à la retrouver à l'œil parmi les annonces homonymes.
   */
  const auctionId = (root) => {
    const a = root.querySelector('a[href^="/marketplace/"]') ||
              root.closest('a[href^="/marketplace/"]');
    const m = a && /^\/marketplace\/([0-9a-f-]{8,})/i.exec(a.getAttribute('href') || '');
    return m ? m[1] : null;
  };

  function readCards() {
    return [...document.querySelectorAll('h3')]
      .map((h) => {
        const root = cardRoot(h);
        const t = root.innerText;
        if (!/MISE/i.test(t)) return null;
        const bid = (t.match(/MISE (?:ACTUELLE|DE D[\u00c9E]PART)\s*\n?\s*([\d\s\u00a0\u202f]+)/i) || [])[1];
        const dur = (t.match(/DUR[\u00c9E]E\s*\n?\s*([^\n]+)/i) || [])[1];
        return {
          title: h.textContent.trim(),
          auction: auctionId(root),
          status: /SURENCH/i.test(t) ? 'surencheri' : /VOUS MENEZ/i.test(t) ? 'mene' : null,
          // Une vente encore sans offre affiche « MISE DE DÉPART ».
          offered: /MISE ACTUELLE/i.test(t),
          bid: bid ? Number(bid.replace(/\D/g, '')) : null,
          // La page n'affiche qu'une durée : on la fixe tout de suite sur une
          // échéance, tant qu'on sait à quel instant elle a été lue.
          end: dur && parseDuration(dur) != null ? Date.now() + parseDuration(dur) : null,
        };
      })
      .filter(Boolean);
  }

  const readBids = () => readCards().filter((c) => c.status);

  /*
   * L'onglet « Mes ventes » du site liste toutes tes ventes en cours, sans
   * limite d'âge. On n'y prend que les identifiants : le détail vient ensuite
   * de l'API, qui reste juste même quand tu n'es plus sur cette page.
   */
  function scanSalesTab() {
    if (filtering()) return;
    let n = 0;
    for (const c of readCards()) {
      if (c.status || !c.auction) continue;   // un badge signale une enchère, pas une vente
      if (!state.myAuctions[c.auction]) n += 1;
      trackAuction(c.auction, 'sale');
    }
    if (n) scanSales();                        // une inconnue : on la détaille tout de suite
  }

  /*
   * Les deux onglets ne s'affichent jamais ensemble. On en ouvre un par
   * chargement de page, et on alterne à chaque rechargement de fond : au fil
   * des cycles, achats et ventes sont tous deux tenus à jour.
   *
   * L'onglet actif se reconnaît à sa bordure basse ; on ne clique donc que si
   * ce n'est pas déjà le bon, et une seule fois, pour ne pas te reprendre la
   * main si tu consultes autre chose.
   */
  const TABS = { ench: /Mes ench/i, ventes: /Mes ventes/i };
  let tabTries = 0;
  const TAB_MAX_TRIES = 4;

  const tabButton = (which) =>
    [...document.querySelectorAll('button')].find((b) => TABS[which].test(b.textContent));

  const isActive = (btn) => !!btn && /border-b-2/.test(btn.className || '');

  /** Quel onglet est affiché — indépendamment de celui qu'on visait. */
  function activeTab() {
    for (const which of Object.keys(TABS)) if (isActive(tabButton(which))) return which;
    return null;
  }

  /*
   * On réessaie tant que l'onglet n'est pas devenu actif : un clic émis avant
   * que React n'ait attaché ses gestionnaires ne produit rien, et marquer
   * « déjà cliqué » dans ce cas condamnait définitivement le relevé.
   * Quelques essais suffisent, ensuite on renonce pour ne pas te harceler.
   */
  function showTab(which) {
    const btn = tabButton(which);
    if (!btn) return false;
    if (!isActive(btn) && tabTries < TAB_MAX_TRIES) {
      tabTries += 1;
      btn.click();
    }
    return true;
  }

  /*
   * Une recherche en cours filtre la liste affichée : la lire donnerait un
   * relevé tronqué — « 10 menées » retomberait à la seule carte cherchée, et
   * les autres passeraient pour terminées. Mieux vaut garder le relevé précédent.
   */
  const filtering = () => {
    const f = document.querySelector(SEARCH_SELECTOR);
    return !!(f && f.value.trim());
  };

  function scanBids() {
    if (filtering()) return;
    const list = readBids();
    /*
     * L'écran sert désormais à DÉCOUVRIR les annonces ; leur suivi passe ensuite
     * par leur identifiant, qui ne dépend ni de la page affichée ni de son
     * onglet. C'est ce qui manquait : une mise placée depuis la page d'une
     * enchère ne changeait rien au panneau tant qu'on n'était pas retourné sur
     * l'onglet « Mes enchères » du Marché.
     */
    for (const c of list) trackAuction(c.auction, 'bid');
    // Un relevé vide reste un relevé : sans horodatage, « aucune enchère » ne
    // se distinguerait pas de « jamais regardé », et le rechargement en
    // arrière-plan ne saurait pas quand il a eu lieu.
    if (!list.length) {
      state.bids = { at: Date.now(), list: [] };
      saveStore({ bids: state.bids });
      render();
      return;
    }

    const before = new Map((state.bids.list || []).map((b) => [b.title, b]));
    for (const b of list) {
      const prev = before.get(b.title);
      // Surenchère : on ne prévient qu'au basculement, pas à chaque scan.
      if (b.status === 'surencheri' && prev && prev.status === 'mene') {
        notifyBid('Tu es surenchéri', `${b.title} — ${b.bid} wb`);
      }
      if (
        b.status === 'mene' && leftNow(b) != null && leftNow(b) <= BIDS.endingSoonMs &&
        (!prev || leftNow(prev) == null || leftNow(prev) > BIDS.endingSoonMs)
      ) {
        notifyBid('Enchère bientôt gagnée', `${b.title} — fin dans ${fmtClock(leftNow(b))}`);
      }
    }

    state.bids = { at: Date.now(), list };
    saveStore({ bids: state.bids });
    render();
  }

  /*
   * Tes ventes. Pas de badge à surveiller ici : ce qui compte est l'échéance,
   * et le passage d'« aucune offre » à une première mise.
   */
  async function scanSales() {
    const list = await fetchMySales();
    if (!list) return;
    const before = new Map((state.sales.list || []).map((s) => [s.title, s]));

    for (const v of list) {
      const prev = before.get(v.title);
      if (v.offered && prev && !prev.offered) {
        notifyBid('Première mise sur ta vente', `${v.title} — ${v.bid} wb`);
      }
      if (
        leftNow(v) != null && leftNow(v) <= BIDS.endingSoonMs &&
        (!prev || leftNow(prev) == null || leftNow(prev) > BIDS.endingSoonMs)
      ) {
        notifyBid('Ta vente se termine', `${v.title} — ${v.bid} wb, fin dans ${fmtClock(leftNow(v))}`);
      }
    }

    state.sales = { at: Date.now(), list };
    saveStore({ sales: state.sales, lastListing: state.lastListing });
    render();
  }

  /*
   * Sur la page d'une enchère, on relit CETTE annonce toutes les cinq secondes.
   * Une mise que tu viens de placer ne changeait rien au panneau : le relevé des
   * enchères se lisait à l'écran, donc uniquement depuis l'onglet « Mes
   * enchères » du Marché, et au mieux quinze secondes plus tard. Ici une
   * requête suffit, depuis la page où tu viens de miser.
   */
  const openAuctionId = () => {
    const m = /^\/marketplace\/([0-9a-f-]{8,})/i.exec(location.pathname);
    return m ? m[1] : null;
  };

  let openBusy = false;

  async function watchOpenAuction() {
    const id = openAuctionId();
    if (!id || openBusy || !prefs.watchBids || document.visibilityState === 'hidden') return;
    openBusy = true;
    try {
      const moi = await fetchMyId();
      if (!moi) return;
      const d = await api(`/api/marketplace/${id}`);
      const a = d.data && d.data.auction;
      if (!a || a.status !== 'active') return;
      // Sa propre vente n'appelle pas ce raccourci : rien ne s'y passe de ton
      // fait, et le guetteur la relit déjà par son identifiant.
      if (a.seller_id === moi) return;
      if (!(d.data.bids || []).some((b) => b.bidder_id === moi)) return;
      trackAuction(id, 'bid');
      const ligne = auctionRow(a, 'bid', moi, d.data.bids);
      const avant = (state.bids.list || []).find((x) => x.auction === id);
      const liste = (state.bids.list || []).filter((x) => x.auction !== id);
      liste.push(ligne);
      state.bids = { at: Date.now(), list: liste };
      saveStore({ bids: state.bids });
      if (avant && avant.status === 'mene' && ligne.status === 'surencheri') {
        notifyBid('Tu es surenchéri', `${ligne.title} — ${ligne.bid} wb`);
      }
      render();
    } catch (_) {
      /* le tour suivant rattrapera */
    } finally {
      openBusy = false;
    }
  }

  function notifyBid(title, body) {
    state.bidNote = `${title} : ${body}`;
    state.bidNoteAt = Date.now();
    if (!prefs.notify || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    try {
      new Notification(title, { body, icon: '/icon-192.png', tag: 'wm-bid' });
    } catch (_) {
      /* notification refusée : le panneau porte déjà l'info */
    }
  }

  /*
   * Le guetteur s'arme quelle que soit la page et reste armé : on arrive sur
   * le Marché par navigation SPA, sans réexécution du script, et l'option peut
   * être cochée à tout moment. C'est le tick qui décide s'il y a lieu d'agir.
   */
  let lastReload = 0;

  /*
   * Un aller-retour rapide vers un autre onglet ne doit pas déclencher un
   * rechargement : on ne le fait qu'après une absence installée, sinon tu
   * retrouves le Marché ailleurs que là où tu l'avais laissé.
   */
  const AWAY_BEFORE_RELOAD = 60000;
  let hiddenSince = document.visibilityState === 'hidden' ? Date.now() : 0;

  document.addEventListener('visibilitychange', () => {
    hiddenSince = document.visibilityState === 'hidden' ? Date.now() : 0;
  });

  const awayLongEnough = () => hiddenSince && Date.now() - hiddenSince > AWAY_BEFORE_RELOAD;

  function bidTick() {
    if (!prefs.watchBids) return;

    /*
     * Tant que l'onglet est sous tes yeux, le guetteur ne touche à RIEN : il
     * se contente de lire ce que tu affiches. Changer d'onglet à ta place
     * pendant que tu consultes le Marché est insupportable, et c'est ce qu'il
     * faisait. Il ne reprend la main qu'en arrière-plan.
     */
    // Les ventes viennent de l'API : ni onglet ni page particulière.
    (async () => {
      await scanSales();
      await syncJournal();
      await reconcileWatch();
    })();

    /*
     * L'écran reste la seule source pour DÉCOUVRIR une annonce trop ancienne
     * pour la fenêtre de balayage — le marché renouvelle mille annonces toutes
     * les six minutes. Les deux onglets du site les listent toutes, quel que
     * soit leur âge ; il suffit de relever leurs identifiants une fois, la
     * suite se fait par l'API.
     */
    if (awayLongEnough()) showTab('ench');
    const ouvert = activeTab();
    if (ouvert === 'ench') scanBids();
    else if (ouvert === 'ventes') scanSalesTab();

    /*
     * Le Marché ne rafraîchit ses données qu'au chargement. On recharge donc,
     * mais seulement en arrière-plan, et pas avant l'intervalle prévu — la
     * condition portait sur la date du dernier relevé, qui vaut zéro tant
     * qu'aucun scan n'a réussi : l'onglet se serait rechargé sans fin.
     */
    const dernier = state.bids.at;
    if (
      awayLongEnough() &&
      Date.now() - lastReload > BIDS.everyMs &&
      dernier &&
      Date.now() - dernier > BIDS.everyMs
    ) {
      lastReload = Date.now();
      location.reload();
    }
  }

  function startBidWatcher() {
    setTimeout(bidTick, 1800); // laisse le SPA rendre la page
    setInterval(bidTick, 15000);
    // La page d'une enchère mérite son propre rythme : c'est là qu'on mise.
    setInterval(watchOpenAuction, 5000);

    /*
     * Les souhaits ont leur propre horloge, plus lente que le guetteur. La
     * greffer sur le tour de 15 s aurait multiplié par six le nombre de pages
     * lues pour rien : la fenêtre récente que ce balayage couvre dure deux
     * minutes, la relire quatre fois par minute n'apprend rien de plus — et
     * c'est le débit qui déclenche la garde anti-automatisation du site.
     */
    let wishBusy = false;
    setInterval(async () => {
      if (!prefs.watchWish || wishBusy) return;
      wishBusy = true;
      try {
        await scanWishMarket();
      } catch (_) {
        /* le tour suivant rattrapera */
      } finally {
        wishBusy = false;
      }
    }, WISH_SCAN_MS);
  }

  // ------------------------------------------------------- verrou inter-onglets

  /*
   * Le panneau s'affiche sur chaque page du site, et un clic sur un tirage
   * ouvre la collection dans un nouvel onglet. Sans garde-fou, deux onglets
   * lanceraient la boucle en parallèle et se disputeraient l'API — donc des
   * 429. Un seul onglet à la fois détient le verrou ; il le rafraîchit tant
   * qu'il tourne, et un verrou périmé (onglet fermé brutalement) se libère seul.
   */
  const LOCK_KEY = 'wm-auto-lock';
  const LOCK_TTL = 12000;
  const instanceId = Math.random().toString(36).slice(2);

  function lockHolder() {
    try {
      const l = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null');
      if (l && Date.now() - l.at < LOCK_TTL) return l.id;
    } catch (_) {
      /* stockage illisible : on considère le verrou libre */
    }
    return null;
  }

  function takeLock() {
    const holder = lockHolder();
    if (holder && holder !== instanceId) return false;
    try {
      localStorage.setItem(LOCK_KEY, JSON.stringify({ id: instanceId, at: Date.now() }));
    } catch (_) {
      /* sans stockage, on accepte le risque plutôt que de bloquer */
    }
    return true;
  }

  function releaseLock() {
    if (lockHolder() === instanceId) {
      try {
        localStorage.removeItem(LOCK_KEY);
      } catch (_) {}
    }
  }

  function openFilteredOn(title, target, rarity) {
    try {
      localStorage.setItem(
        PENDING_KEY,
        JSON.stringify({ q: title, target, rarity, at: Date.now() })
      );
    } catch (_) {
      /* sans stockage, la page s'ouvrira simplement non filtrée */
    }
  }

  /** React ignore une affectation directe de .value : il faut le setter natif. */
  function setReactInput(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /*
   * Les filtres de rareté de la collection sont des bascules CUMULATIVES : un
   * second clic en ajoute une, un clic sur une rareté active la retire. Pour
   * n'afficher qu'une rareté, il faut donc éteindre les autres une par une.
   * On reclique aussi entre deux vérifications de l'état, parce que React
   * remplace les nœuds à chaque rendu et les références deviennent obsolètes.
   */
  const rarityButtons = () =>
    [...document.querySelectorAll('button')].filter((b) =>
      RARITIES.includes(b.textContent.trim())
    );

  async function applyRarityFilter(target) {
    for (let i = 0; i < 40 && rarityButtons().length < RARITIES.length; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    for (const label of RARITIES) {
      const btn = rarityButtons().find((b) => b.textContent.trim() === label);
      if (!btn) continue;
      const active = /ring-2/.test(btn.className);
      if (active !== (label === target)) {
        btn.click();
        await new Promise((r) => setTimeout(r, 120));
      }
    }
  }

  /*
   * Attente simple, sans lien avec la boucle d'ouverture. `sleep` réassigne
   * `state.abort` : l'employer depuis un gestionnaire d'interface écraserait
   * l'annulation de la boucle en cours.
   */
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  /*
   * Chaque carte a une fiche détaillée, avec un onglet « Marché » qui donne sa
   * vraie cote : nombre de ventes, dernier prix, moyenne, min, max et les dix
   * dernières transactions. C'est bien plus utile que le Marché filtré par
   * titre, qui ne montre que les enchères en cours.
   *
   * Cette fiche n'a pas d'URL : elle s'ouvre en cliquant la carte dans la
   * collection. On y va donc par le chemin de l'interface — recherche, clic sur
   * la carte, puis clic sur l'onglet.
   */
  async function openCardMarket(title) {
    if (!(await openCardDetail(title))) return false;

    for (let i = 0; i < 20; i++) {
      await delay(200);
      // Deux liens de navigation portent aussi « Marché » : seul le bouton
      // situé dans la fiche nous intéresse.
      const tab = [...document.querySelectorAll('button')].find(
        (b) => b.textContent.trim() === 'Marché'
      );
      if (tab) {
        tab.click();
        return true;
      }
    }
    return false;
  }

  /** Attend que le champ de recherche soit rendu par le SPA, puis le remplit. */
  function fillSearchWhenReady(q) {
    let tries = 0;
    const id = setInterval(() => {
      const input = document.querySelector(SEARCH_SELECTOR);
      if (input) {
        clearInterval(id);
        setReactInput(input, q);
      } else if (++tries > 40) {
        clearInterval(id);
      }
    }, 250);
  }

  /**
   * Navigue vers la collection ou le Marché SANS ouvrir d'onglet ni recharger :
   * on clique le lien de la barre latérale, ce qui passe par le routeur du site.
   * La boucle d'ouverture continue donc de tourner pendant que tu consultes.
   */
  function goFilteredTo(path, q, rarity) {
    // L'intention se pose AVANT de naviguer : le changement d'URL peut être
    // détecté dès le clic, donc avant que la suite de cette fonction ne tourne.
    if (rarity) {
      newIntentAt = Date.now();
      onlyNew = true;
      showNewFilter = true; // le clic vient du panneau : le bouton a sa place
    }
    const apply = () => {
      if (q) fillSearchWhenReady(q);
      if (rarity) applyRarityFilter(rarity).then(refreshCollection);
    };
    if (location.pathname.startsWith(path)) {
      apply();
      return;
    }
    const link = [...document.querySelectorAll(`a[href="${path}"]`)]
      .find((a) => !a.closest('#wm-auto-panel'));
    if (link) {
      link.click();
      apply();
    } else {
      // Repli : navigation classique, le filtre est repris au chargement.
      openFilteredOn(q, path, rarity);
      location.href = path;
    }
  }

  /*
   * La page d'une enchère — carte, vendeur, mise en cours, temps restant,
   * formulaire de mise, historique. Elle n'était atteignable que par le Marché
   * filtré sur le titre, à charge pour toi de reconnaître la bonne annonce
   * parmi les homonymes.
   *
   * Le site est un Next.js 16 : `next.router.push` fait la navigation sans
   * rechargement, donc sans interrompre la boucle d'ouverture. Les deux replis
   * couvrent le cas où le routeur changerait de forme — un lien déjà présent
   * dans la page, puis la navigation classique.
   */
  const goAuction = (id) => (id ? goPath(`/marketplace/${id}`) : false);

  function goPath(path) {
    if (!path) return false;
    const r = window.next && window.next.router;
    if (r && typeof r.push === 'function') {
      try {
        r.push(path);
        return true;
      } catch (_) {
        /* on tente les replis */
      }
    }
    const lien = document.querySelector(`a[href="${path}"]`);
    if (lien) {
      lien.click();
      return true;
    }
    location.href = path;
    return true;
  }

  /** Rejoue la recherche en attente une fois la page cible affichée. */
  function applyPendingSearch() {
    const here = SEARCHABLE.find((p) => location.pathname.startsWith(p));
    if (!here) return;

    let pending;
    try {
      pending = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
    } catch (_) {
      return;
    }
    if (!pending || (!pending.q && !pending.rarity)) return;
    if (Date.now() - pending.at > 30000) return;
    // Une recherche destinée au Marché ne doit pas s'appliquer à la collection.
    if (pending.target && !here.startsWith(pending.target)) return;
    localStorage.removeItem(PENDING_KEY);
    if (pending.q) fillSearchWhenReady(pending.q);
    if (pending.rarity) {
      // Même intention, après un rechargement complet plutôt qu'une navigation SPA.
      newIntentAt = Date.now();
      onlyNew = true;
      showNewFilter = true;
      applyRarityFilter(pending.rarity).then(refreshCollection);
    }
  }

  const jittered = (ms) => ms * (1 + (Math.random() * 2 - 1) * CFG.jitter);

  // ------------------------------------------------------------------- réseau

  async function api(url, method = 'GET', body) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      /* réponse non-JSON : traitée comme inattendue par l'appelant */
    }
    return { status: res.status, data, retryMs: retryAfterMs(res, data) };
  }

  /*
   * Combien de temps le serveur demande d'attendre, s'il le dit. Il ne
   * l'annonçait pas quand ce script a été écrit — d'où les reculs devinés.
   * Autant lire les trois formes usuelles : si l'une apparaît un jour, le
   * script cesse de deviner sans qu'on ait à s'en apercevoir.
   *
   * `Retry-After` vaut soit un nombre de secondes, soit une date HTTP.
   */
  function retryAfterMs(res, data) {
    const raw = res.headers.get('Retry-After')
      ?? (data && (data.retry_after ?? data.retry_after_seconds));
    if (raw == null) return 0;
    const secs = Number(raw);
    if (Number.isFinite(secs)) return secs > 0 ? Math.round(secs * 1000) : 0;
    const at = Date.parse(raw);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
  }

  const openPack = () => api('/api/packs/open', 'POST');

  // ------------------------------------------------- relais à l'humain

  /*
   * Détecter la demande de vérification humaine demande de la précision : le
   * jeu distribue des articles Wikipédia, dont les résumés parlent souvent
   * d'humains ou de robots, et la page charge la police « Roboto ». Chercher
   * « human » ou « robot » en vrac déclenche donc des fausses alertes.
   * On ne teste que des formulations complètes, et jamais le contenu des cartes.
   */
  const VERIF_RE = new RegExp(
    [
      'je ne suis pas un robot',
      "i'?m not a robot",
      'captcha',
      'v[ée]rification humaine',
      'human verification',
      "prouve[rz]? qu[e']\\s*(?:tu es|vous [êe]tes|je suis)",
      "confirme[rz]? qu[e']\\s*(?:tu es|vous [êe]tes|je suis)",
    ].join('|'),
    'i'
  );

  /** Ne lit que le message d'erreur, jamais la charge utile des cartes. */
  function errorText(data) {
    if (typeof data === 'string') return data;
    if (!data || typeof data !== 'object') return '';
    return [data.error, data.message, data.code, data.reason]
      .filter((v) => typeof v === 'string')
      .join(' ');
  }

  function needsHuman(status, data) {
    if (status === 200) return false;
    if (status === 428) return true;
    return VERIF_RE.test(errorText(data));
  }

  const MAX_PROMPT_LEN = 300; // au-delà, c'est du contenu de page, pas une invite

  function isVerificationPrompt(node) {
    if (!node || node.nodeType !== 1) return false;
    // <html>/<body> englobent toute la page : leur texte matcherait n'importe quoi.
    if (/^(HTML|BODY|HEAD|SCRIPT|STYLE)$/.test(node.tagName)) return false;

    const box = node.matches('input[type="checkbox"], [role="checkbox"]')
      ? node
      : node.querySelector('input[type="checkbox"], [role="checkbox"]');
    if (!box) return false; // une invite sans case à cocher n'en est pas une

    const text = (node.textContent || '').trim();
    return text.length <= MAX_PROMPT_LEN && VERIF_RE.test(text);
  }

  /*
   * L'invite est-elle encore là ? On part des cases à cocher plutôt que de
   * parcourir la page : sans cette borne, un tour de deux secondes testerait
   * quelques milliers de nœuds sur la page Collection, en pure perte les 99 %
   * du temps où il n'y a rien.
   *
   * Il faut remonter **plusieurs** ancêtres, pas un seul. `isVerificationPrompt`
   * exige que le nœud testé porte lui-même le texte de l'invite ; or une case
   * vit souvent dans un conteneur nu — `<div><input type=checkbox></div>` — dont
   * le texte est vide, la consigne étant dans un frère. Ne tester que le parent
   * immédiat concluait donc « invite partie » alors qu'elle était affichée, et
   * relançait la boucle dans le mur. On s'arrête dès qu'un ancêtre correspond,
   * et la borne de profondeur empêche de remonter jusqu'au corps de page, dont
   * le texte matcherait n'importe quoi.
   */
  const PROMPT_DEPTH = 5;

  function humanPromptPresent() {
    const cases = document.querySelectorAll('input[type="checkbox"], [role="checkbox"]');
    for (const c of cases) {
      let el = c;
      for (let i = 0; i <= PROMPT_DEPTH && el; i++) {
        if (isVerificationPrompt(el)) return true;
        el = el.parentElement;
      }
    }
    return false;
  }

  function watchForHumanCheck() {
    new MutationObserver((records) => {
      if (!state.running) return;
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (isVerificationPrompt(node)) {
            handOver();
            return;
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  function handOver() {
    state.blockedAt = Date.now();
    state.blockedReserve = state.reserve;
    stop(prefs.autoResume
      ? 'Vérification humaine — coche la case dans la page, la boucle repart seule.'
      : 'Vérification humaine — coche la case dans la page, puis relance.', true);
    flashTitle();
    if (CFG.alertSound) beep();
    notifyBid('Vérification humaine', humanCost());
    awaitHuman();
  }

  /*
   * Ce qu'une interruption coûte réellement — parce que « bloqué depuis 4 min »
   * laisse croire à une perte qui n'a pas eu lieu.
   *
   * La réserve continue de se remplir pendant le blocage. Tant qu'elle n'est
   * pas pleine, **rien n'est perdu** : les paquets régénérés attendent et
   * seront ouverts au retour. Ce n'est qu'une fois les dix atteints que chaque
   * régénération part à la poubelle. À la cadence PRO, ça laisse une demi-heure
   * de battement ; sans PRO, plus d'une heure et demie.
   *
   * C'est ce chiffre-là qui dit s'il faut courir cocher la case ou finir sa
   * phrase — et le panneau ne le disait pas.
   */
  function humanCost() {
    const cadence = state.cadenceMs || CFG.defaultCadenceMs;
    if (state.blockedReserve == null) {
      return 'réserve inconnue — coche la case pour reprendre';
    }
    const place = MAX_RESERVE - state.blockedReserve;
    const regen = Math.floor((Date.now() - state.blockedAt) / cadence);
    const perdus = Math.max(0, regen - place);
    if (perdus > 0) {
      return `réserve pleine — ${perdus} paquet${perdus > 1 ? 's' : ''} perdu${perdus > 1 ? 's' : ''}`;
    }
    const reste = (place - regen) * cadence;
    return `réserve pleine dans ~${fmtSpan(reste)} — rien de perdu d'ici là`;
  }

  /*
   * Le relais coûtait deux gestes : cocher la case, puis revenir cliquer
   * *Start*. Le second n'apprend rien au script — la case cochée est déjà la
   * décision. On guette donc sa disparition et on repart.
   *
   * C'est bien **toi** qui coches : le script ne touche jamais à la case, il
   * observe seulement que l'invite a quitté la page. Un plafond de dix minutes
   * évite qu'un onglet oublié redémarre tout seul beaucoup plus tard, dans un
   * contexte que tu n'as plus en tête.
   */
  const HUMAN_WAIT_MS = 3600000;   // on veille une heure : au-delà, l'onglet est oublié
  const HUMAN_NAG_MS = 30000;      // rappel sonore tant que la case attend

  function awaitHuman() {
    const depuis = Date.now();
    let rappel = depuis;
    const id = setInterval(() => {
      if (state.running) {          // relancé à la main entre-temps
        state.blockedAt = 0;
        return clearInterval(id);
      }
      if (Date.now() - depuis > HUMAN_WAIT_MS) {
        setStatus(`Vérification en attente depuis ${fmtSpan(Date.now() - depuis)} — ${humanCost()}`, true);
        return clearInterval(id);
      }

      if (humanPromptPresent()) {
        /*
         * Un seul bip au moment du blocage ne sert à rien si tu n'es pas devant
         * l'écran : c'est précisément l'absence qui coûte la réserve. On répète
         * donc l'alerte toutes les trente secondes, avec le coût courant — pas
         * une alarme de plus, la même information réactualisée.
         */
        if (Date.now() - rappel >= HUMAN_NAG_MS) {
          rappel = Date.now();
          if (CFG.alertSound) beep();
          notifyBid('Vérification humaine', humanCost());
        }
        setStatus(`Vérification humaine — ${humanCost()}`, true);
        return;
      }

      clearInterval(id);
      state.blockedAt = 0;
      if (!prefs.autoResume) {
        return setStatus('Vérification passée — clique Start pour reprendre.');
      }
      setStatus('Vérification passée — reprise.');
      start();
    }, 2000);
  }

  function flashTitle() {
    const original = document.title;
    let on = false;
    const id = setInterval(() => {
      document.title = (on = !on) ? '⚠️ ACTION REQUISE' : original;
    }, 700);
    const restore = () => {
      if (document.visibilityState !== 'visible') return;
      clearInterval(id);
      document.title = original;
      document.removeEventListener('visibilitychange', restore);
    };
    document.addEventListener('visibilitychange', restore);
    setTimeout(restore, 120000);
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.05;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } catch (_) {
      /* pas de son disponible : le panneau et le titre suffisent */
    }
  }

  // ------------------------------------------------------------- notifications

  async function askNotifyPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try {
      return (await Notification.requestPermission()) === 'granted';
    } catch (_) {
      return false;
    }
  }

  function notifyRare(card) {
    if (!prefs.notify || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    try {
      new Notification(`Tirage ${card.rarity} !`, {
        body: card.wikipedia_title || '',
        icon: '/icon-192.png',
        tag: 'wm-rare',
      });
    } catch (_) {
      /* notification refusée par le navigateur : sans conséquence */
    }
  }

  // --------------------------------------------------------- réserve estimée

  /*
   * Le serveur ne donne `packs_remaining` que dans ses réponses 403. Entre deux
   * refus on extrapole donc : on part de la dernière valeur sûre et on ajoute
   * un paquet à chaque échéance de régénération franchie. D'où le « ≈ ».
   */
  /*
   * La cadence dépend de l'abonnement : ~3 min avec le pack PRO, ~10 min sans.
   * On ne peut donc pas la déduire d'un multiple de la valeur courante — parti
   * de 3 min, un écart réel de 10 min donnerait `round(600/180) = 3` étapes,
   * soit 200 s au lieu de 600, et la valeur convergerait vers un chiffre faux.
   *
   * Deux refus consécutifs sont séparés d'exactement une régénération : un
   * écart plausible EST la cadence. On ne divise que si l'écart dépasse la
   * borne haute, signe que plusieurs échéances sont passées entre-temps.
   */
  const CADENCE_MIN = 30000;
  const CADENCE_MAX = 900000;

  function learnCadence(ts) {
    if (state.lastRegenTs && ts > state.lastRegenTs) {
      const delta = ts - state.lastRegenTs;
      let est = delta;
      if (delta > CADENCE_MAX) {
        const steps = Math.round(delta / state.cadenceMs);
        if (steps >= 1) est = delta / steps;
      }
      if (est >= CADENCE_MIN && est <= CADENCE_MAX) {
        state.cadenceMs = Math.round(est);
        saveStore({ cadenceMs: state.cadenceMs });
      }
    }
    state.lastRegenTs = ts;
  }

  /** Fait avancer l'estimation quand des échéances de régénération sont passées. */
  function syncReserve() {
    if (state.reserve == null || !state.nextRegenAt) return;
    let guard = 0;
    while (Date.now() >= state.nextRegenAt && state.reserve < MAX_RESERVE && guard++ < 64) {
      state.reserve += 1;
      state.nextRegenAt += state.cadenceMs;
    }
  }

  /*
   * La réserve lue à la source, plutôt qu'extrapolée.
   *
   * Le serveur ne donne `packs_remaining` que dans ses refus : entre deux 403,
   * le panneau avançait d'un paquet à chaque échéance franchie, d'où le « ≈ ».
   * Le site expose la fonction `get_my_profile` (relevée dans son bundle, cf.
   * README) : elle rend la ligne de profil, où vivent le compte de paquets et
   * l'heure de la prochaine régénération.
   *
   * Colonnes relevées sur le profil réel : `packs_remaining`, `is_pro`,
   * `packs_last_regen_at`, `activity_blocked_until`, `cheat_strikes`. On teste
   * quand même la forme de chaque valeur avant de s'en servir — une colonne
   * renommée doit faire retomber sur l'estimation, pas produire un chiffre
   * faux. Si rien ne correspond, on affiche une fois les colonnes trouvées
   * plutôt que de deviner en silence.
   */
  const PACK_KEYS = ['packs_remaining', 'packs', 'pack_count', 'packs_available'];

  /*
   * La base ne porte pas la prochaine échéance : elle porte l'ANCRE, l'instant
   * de la dernière régénération. Mesuré sur le serveur — `next_regen_at` d'un
   * 403 tombait à `packs_last_regen_at` + 180 s exactement, à la microseconde
   * près, et l'ancre avance d'une cadence pleine à chaque régénération. La
   * prochaine échéance est donc calculable sans jamais essuyer un refus.
   */
  const REGEN_ANCHORS = ['packs_last_regen_at', 'last_pack_regen_at'];
  const CADENCE_PRO = 180000;
  const CADENCE_FREE = 600000;
  const PACKS_FRESH_MS = 60000;

  /**
   * @param {boolean} force  Ignorer le délai de fraîcheur. Utilisé juste après
   *   une ouverture : la valeur du compteur de pitié n'a d'intérêt que si elle
   *   colle au tirage, pas si elle date d'une minute.
   * @returns {Promise<object|null>} La ligne de profil, pour l'appelant qui en
   *   veut un champ précis.
   */
  async function refreshPacks(force) {
    if (!prefs.db) return null;
    if (!force && Date.now() - state.packsReadAt < PACKS_FRESH_MS) return null;
    state.packsReadAt = Date.now();

    if (!sbToken()) {
      state.dbNote = 'Pas de session Supabase lisible — reconnecte-toi au site.';
      render();
      return null;
    }

    const rep = await sbRpc('get_my_profile', {});
    const p = Array.isArray(rep) ? rep[0] : rep;
    if (!p || typeof p !== 'object') {
      // Fonction absente, renommée, ou refusée : on le dit une fois plutôt que
      // de réessayer en silence toutes les minutes sans que rien n'apparaisse.
      state.dbNote = 'get_my_profile : aucune réponse exploitable (essaie wmSchema() dans la console).';
      render();
      return null;
    }

    /*
     * Compteur de pitié et solde : deux valeurs que le profil porte déjà et que
     * rien n'affichait. Le maximum jamais vu est conservé — c'est lui qui
     * révèlera le palier, si palier il y a : un compteur qui ne dépasse jamais
     * 89 dit son seuil tout seul, au bout d'assez de tirages.
     */
    if (Number.isFinite(p.pity_counter)) {
      state.pity = p.pity_counter;
      if (p.pity_counter > state.pityMax) state.pityMax = p.pity_counter;
      saveStore({ pityMax: state.pityMax });
    }
    if (Number.isFinite(p.wikibidous_balance)) state.balance = p.wikibidous_balance;

    let lu = false;

    /*
     * L'abonnement donne la cadence sans avoir à l'attendre : 3 min avec le
     * pack PRO, 10 min sans. La mesure sur les refus reste en place et garde le
     * dernier mot — elle sert à suivre un changement du jeu, plus à découvrir
     * une valeur que le profil annonce déjà.
     */
    if (typeof p.is_pro === 'boolean' && !state.lastRegenTs) {
      const attendue = p.is_pro ? CADENCE_PRO : CADENCE_FREE;
      if (state.cadenceMs !== attendue) {
        state.cadenceMs = attendue;
        saveStore({ cadenceMs: state.cadenceMs });
      }
    }

    const n = PACK_KEYS.map((k) => p[k]).find((v) => Number.isInteger(v) && v >= 0 && v <= MAX_RESERVE);
    if (n !== undefined) {
      state.reserve = n;
      lu = true;
    }

    for (const k of REGEN_ANCHORS) {
      const ancre = p[k] ? Date.parse(p[k]) : NaN;
      if (!Number.isFinite(ancre)) continue;
      const suivante = ancre + state.cadenceMs;
      /*
       * Uniquement si l'échéance est à venir — et surtout, jamais d'avance
       * automatique vers la suivante.
       *
       * L'ancre est mise à jour paresseusement : mesuré, elle affichait encore
       * 20:31:20 à 20:34:39, l'échéance de 20:34:20 étant pourtant passée. Le
       * paquet était dû, la base ne l'avait pas encore inscrit. Avancer d'une
       * cadence dans cette fenêtre aurait fait attendre trois minutes de plus
       * un paquet déjà disponible. Échéance dépassée = paquet à réclamer : on
       * ne programme rien et on laisse l'appel d'ouverture trancher, comme
       * avant.
       */
      if (suivante > Date.now()) {
        state.nextRegenAt = suivante;
        lu = true;
      }
      break;
    }

    /*
     * Le profil dit aussi si le compte est sanctionné — `activity_blocked_until`
     * et `cheat_strikes`. Rien d'autre sur le site ne le montre, et c'est
     * précisément ce qu'un outil d'automatisation doit remonter sans attendre :
     * un blocage se lit ici avant de se deviner sur des réponses qui échouent.
     */
    const bloque = p.activity_blocked_until ? Date.parse(p.activity_blocked_until) : NaN;
    const alertes = [];
    if (Number.isFinite(bloque) && bloque > Date.now()) {
      alertes.push(`compte bridé jusqu'à ${new Date(bloque).toLocaleTimeString()}`);
    }
    if (Number.isFinite(p.cheat_strikes) && p.cheat_strikes > 0) {
      alertes.push(`${p.cheat_strikes} avertissement${p.cheat_strikes > 1 ? 's' : ''} au compteur`);
    }

    /*
     * Le compteur de pitié s'affiche avec le maximum jamais observé. Tant qu'on
     * ne sait pas ce qu'il fait, c'est la paire qui informe : une valeur seule
     * ne dit rien, une valeur suivie d'un plafond stable dit le palier.
     */
    const extra = [];
    if (state.pity != null) {
      extra.push(`pitié ${state.pity}${state.pityMax > state.pity ? ` (max vu ${state.pityMax})` : ''}`);
    }
    if (state.balance != null) extra.push(`${state.balance} wikibidous`);

    const etat = lu
      ? `Réserve lue en base : ${state.reserve == null ? '?' : state.reserve}/${MAX_RESERVE}` +
        ` · cadence ${fmtClock(state.cadenceMs)}${p.is_pro ? ' (PRO)' : ''}` +
        (extra.length ? ` · ${extra.join(' · ')}` : '')
      : `get_my_profile ne porte pas les paquets — colonnes : ${Object.keys(p).slice(0, 12).join(', ')}`;
    state.dbNote = alertes.length ? `⚠ ${alertes.join(' · ')} — ${etat}` : etat;

    /*
     * Un bridage arrête la boucle, il ne se contente pas de s'afficher.
     *
     * `activity_blocked_until` est une sanction posée par le site : continuer à
     * émettre pendant qu'elle court, c'est insister exactement au moment où il
     * ne faut pas — et chaque appel supplémentaire est un argument de plus pour
     * la prolonger. Le script s'arrête donc, en disant jusqu'à quand, et laisse
     * la reprise à ta décision.
     *
     * Ça ne reste pas non plus dans un onglet de réglages qu'on n'ouvre pas :
     * `stop` écrit dans le statut principal du panneau.
     */
    if (Number.isFinite(bloque) && bloque > Date.now()) {
      const jusqua = new Date(bloque).toLocaleTimeString();
      if (state.running) {
        stop(`Compte bridé par le site jusqu'à ${jusqua} — boucle arrêtée.`, true);
      } else {
        setStatus(`Compte bridé par le site jusqu'à ${jusqua}.`, true);
      }
    }
    render();
    return p;
  }

  // ------------------------------------------------------------ paquets bonus

  /*
   * pro-daily et special répondent en GET une simple éligibilité, sans rien
   * consommer. On ne POSTe donc jamais à l'aveugle : uniquement quand le
   * serveur a dit que le paquet est disponible.
   *
   * Le paquet quotidien est réservé aux comptes PRO ; sans abonnement le
   * serveur répond simplement « non éligible », et la vérification reste sans
   * effet — inutile de distinguer les deux cas côté script.
   */
  async function claimBonusPacks() {
    if (!prefs.bonus) return;
    state.bonusCheckedAt = Date.now();

    try {
      /*
       * On tente le POST directement, sans se fier au GET : celui-ci répond
       * `eligible: false, claimed_today: true` alors que le POST réussit et
       * renvoie les cartes — vérifié. Conditionner la réclamation à ce GET
       * revenait à ne jamais réclamer le pack.
       *
       * Le POST est sans risque : il rend 409 quand le pack est réellement
       * déjà pris, sans rien consommer.
       */
      const got = await api('/api/packs/pro-daily', 'POST');
      if (got.status === 200) {
        absorbBonus(got, 'Pack PRO du jour');
      } else if (got.status === 409) {
        state.bonusNote = 'Pack PRO du jour déjà réclamé';
        render();
      }
    } catch (_) {
      /* réseau : on retentera au prochain cycle */
    }

    try {
      const spec = await api('/api/packs/special');
      const list = spec.data && Array.isArray(spec.data.packs) ? spec.data.packs : [];
      if (spec.status === 200 && spec.data && spec.data.available && list.length) {
        const got = await api('/api/packs/special', 'POST');
        absorbBonus(got, 'Paquet spécial');
      }
    } catch (_) {
      /* idem */
    }
  }

  /** Un bonus rend les mêmes cartes qu'une ouverture normale — sinon on le signale. */
  function absorbBonus({ status, data }, label) {
    if (status === 200 && data && Array.isArray(data.cards)) {
      record(data.cards, label);
      state.bonusNote = `${label} réclamé`;
    } else {
      state.bonusNote = `${label} : réponse ${status} non exploitée`;
    }
    render();
  }

  // -------------------------------------------------------------------- boucle

  /*
   * Jeton de génération. `state.running` ne suffit pas à garantir une seule
   * boucle : un *Stop* pendant qu'un `openPack()` est en vol, suivi d'un
   * *Start*, remet le drapeau à vrai AVANT que l'ancienne boucle n'ait relu sa
   * condition — elle repart alors en parallèle de la nouvelle. Deux boucles qui
   * ouvrent ensemble, ce sont deux appels collés : exactement ce que le serveur
   * refuse, et un plancher appris faussé par un 429 qu'on s'est infligé.
   *
   * Chaque `start()` prend un jeton ; toute boucle d'une génération antérieure
   * se retire au premier point de contrôle. Le verrou inter-onglets ne couvrait
   * que le cas de deux onglets — pas celui d'un seul onglet avec deux boucles.
   */
  let loopEpoch = 0;

  async function loop(epoch) {
    // Vrai tant que cette boucle-ci est la boucle courante.
    const mine = () => state.running && epoch === loopEpoch;

    while (mine()) {
      /*
       * Vérification à CHAQUE tour, pas seulement au démarrage : le pack
       * quotidien se libère au changement de jour côté serveur — en UTC, donc
       * pas au minuit de ton fuseau. Une boucle lancée la veille ne l'aurait
       * jamais vu apparaître sans rechargement de page.
       */
      if (prefs.bonus && Date.now() - state.bonusCheckedAt > CFG.bonusEveryMs) {
        await claimBonusPacks();
        if (!mine()) return;
      }

      /*
       * Réserve relue au plus une fois par minute. Ça ne change rien au rythme
       * — le serveur reste le seul à décider — mais le panneau cesse d'annoncer
       * une estimation là où la valeur est disponible.
       */
      await refreshPacks();
      if (!mine()) return;

      if (CFG.maxPacks && state.packs >= CFG.maxPacks) {
        return stop(`Limite atteinte (${CFG.maxPacks} paquets).`);
      }

      let res;
      try {
        res = await openPack();
      } catch (err) {
        return stop(`Réseau indisponible : ${err.message}`, true);
      }

      const { status, data, retryMs } = res;

      /*
       * Boucle remplacée pendant l'appel : c'est la nouvelle qui tient le
       * panneau désormais, et deux boucles qui règlent le délai et la réserve
       * ensemble les dérèglent toutes les deux. On se retire — mais pas sans
       * journaliser : le serveur a bel et bien crédité ces cartes, les taire
       * ferait un trou dans l'historique et dans les taux de rareté.
       */
      if (!mine()) {
        if (status === 200 && data && Array.isArray(data.cards)) {
          record(data.cards, 'Paquet (boucle relancée)');
        }
        return;
      }

      if (needsHuman(status, data)) return handOver();

      if (status === 200 && data && Array.isArray(data.cards)) {
        state.throttles = 0;
        if (state.reserve != null) state.reserve = Math.max(0, state.reserve - 1);
        /*
         * Succès : on grignote le délai pour retrouver le rythme réel, sans
         * repasser sous le plancher appris — inutile de retourner buter dans
         * un mur déjà rencontré.
         *
         * Ce mur bouge, lui : le jeu a déjà assoupli son débit une fois. Après
         * une longue série sans refus on rabote donc le plancher appris de
         * 10 %, ce qui fait redescendre le délai d'un cran. Si c'était trop
         * tôt, le 429 suivant le remonte immédiatement — au pire un aller-
         * retour tous les quarante paquets.
         */
        state.delayMs = Math.max(floorMs(), state.delayMs - CFG.decayMs);
        if (state.probeFloorMs && ++state.cleanHits >= CFG.probeAfterHits) {
          state.cleanHits = 0;
          const relaxed = Math.round(state.probeFloorMs * CFG.probeRelax);
          state.probeFloorMs = relaxed <= CFG.floorDelayMs ? 0 : relaxed;
        }
        saveStore({ delayMs: state.delayMs, probeFloorMs: state.probeFloorMs });

        /*
         * Relecture du profil collée à l'ouverture : elle donne le compteur de
         * pitié de CE tirage, et par la même occasion la réserve exacte qui
         * vient d'être décrémentée. Une requête par paquet — on en a supprimé
         * cinq en passant la cote en base, le solde reste largement positif.
         */
        const prof = await refreshPacks(true);
        // Journalisé avant tout retrait : ces cartes sont créditées, même si
        // une relance de boucle a eu lieu pendant la lecture.
        record(data.cards, undefined, prof && prof.pity_counter);
        if (!mine()) return;
        refreshOwned();
        // Cote des nouvelles cartes, en tâche de fond : la liste de revente
        // reste à jour sans relevé complet.
        priceCards(data.cards.map((c) => ({ id: c.id, t: c.wikipedia_title, r: c.rarity, tags: [] })));
        setStatus('Paquet ouvert');
        await sleep(jittered(state.delayMs));
        continue;
      }

      if (status === 403 && data && data.packs_remaining === 0) {
        state.reserve = 0;
        const target = data.next_regen_at ? Date.parse(data.next_regen_at) : NaN;
        if (Number.isFinite(target)) {
          learnCadence(target);
          state.nextRegenAt = target;
        }
        // Sans échéance annoncée, on attend une cadence mesurée plutôt qu'un
        // délai fixe : 90 s de repli feraient sept sondages inutiles par cycle
        // sur un compte sans PRO, où la régénération prend dix minutes.
        const deadline = Number.isFinite(target) ? target : Date.now() + state.cadenceMs;
        await waitUntil(deadline, 'Prochain paquet dans', mine);
        continue;
      }

      if (status === 401) {
        return stop('Session expirée — reconnecte-toi puis relance.', true);
      }

      /*
       * Le serveur throttle les appels rapprochés. On ralentit durablement au
       * lieu d'insister — et surtout on RETIENT le délai qui vient d'être
       * refusé : c'est la seule mesure fiable du débit autorisé, et le jeu
       * l'a déjà changé une fois. Le plancher se pose 10 % au-dessus de ce
       * délai, le délai courant recule plus largement puis redescend jusqu'à
       * ce plancher au fil des succès.
       */
      if (status === 429) {
        state.throttles += 1;
        state.cleanHits = 0;
        state.probeFloorMs = Math.min(CFG.ceilDelayMs, Math.round(state.delayMs * 1.1));
        state.delayMs = Math.min(CFG.ceilDelayMs, Math.round(state.delayMs * CFG.growth));
        saveStore({ delayMs: state.delayMs, probeFloorMs: state.probeFloorMs });
        if (state.throttles > CFG.maxThrottleRetries) {
          return stop(`Toujours limité après ${CFG.maxThrottleRetries} tentatives.`, true);
        }
        // Le recul deviné double à chaque refus consécutif ; une consigne
        // explicite du serveur, elle, se suit telle quelle.
        const wait = retryMs || CFG.throttleBackoffMs * 2 ** (state.throttles - 1);
        await waitUntil(Date.now() + wait, 'Débit limité — reprise dans', mine);
        continue;
      }

      return stop(`Réponse inattendue (${status}) : ${JSON.stringify(data).slice(0, 120)}`, true);
    }
  }

  /**
   * Attend une échéance ABSOLUE. L'affichage se recalcule à chaque tick depuis
   * `waitUntil` et non par décompte : il reste juste même si les timers dérivent
   * ou si Chrome ralentit l'onglet en arrière-plan.
   *
   * `regenBufferMs` ne décale que le réveil, jamais l'affichage — sans quoi le
   * panneau afficherait systématiquement 3 s de plus que le compteur du site.
   *
   * `alive` permet à l'appelant d'ajouter sa propre condition de sortie : une
   * boucle remplacée doit lâcher le décompte tout de suite, sinon elle continue
   * d'écrire `state.waitUntil` et le panneau affiche l'échéance de la boucle
   * morte par-dessus celle de la vivante.
   */
  async function waitUntil(deadline, label, alive = () => state.running) {
    state.waitFrom = Date.now();
    state.waitUntil = deadline;
    state.waitLabel = label;
    const wake = deadline + CFG.regenBufferMs;
    while (alive() && Date.now() < wake) {
      render();
      await sleep(Math.min(CFG.tickMs, wake - Date.now()));
    }
    if (alive()) state.waitUntil = 0;
  }

  function record(cards, source, pity) {
    state.packs += 1;
    state.cards += cards.length;

    for (const c of cards) {
      const r = c.rarity || '?';
      state.history.unshift({
        at: new Date().toISOString(),
        pack: state.packs,
        id: c.id || '',
        rarity: r,
        title: c.wikipedia_title || '',
        url: c.wikipedia_url || '',
        category: c.category || '',
        atk: c.atk ?? '',
        def: c.def ?? '',
        source: source || 'paquet',
        /*
         * Le compteur de pitié APRÈS le tirage. C'est la seule façon d'établir
         * ce qu'il fait : sa valeur seule ne dit rien, sa valeur en regard de
         * la rareté obtenue dit tout — de combien il monte, sur quoi il retombe,
         * et à quel palier. Vide tant que la lecture en base est coupée.
         */
        pity: Number.isFinite(pity) ? pity : '',
      });
      if (RARE_ALERT.includes(r)) notifyRare(c);
    }
    state.history = state.history.slice(0, CFG.historyLength);
    persistStats();
  }

  // -------------------------------------------------------------------- export

  function download(filename, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  function exportJson() {
    download(
      `wikimasters-${stamp()}.json`,
      JSON.stringify(
        { exporte: new Date().toISOString(), paquets: state.packs, cartes: state.cards,
          raretes: countByRarity(), tirages: state.history },
        null,
        2
      ),
      'application/json'
    );
  }

  function exportCsv() {
    const cols = ['at', 'pack', 'id', 'rarity', 'title', 'url', 'category', 'atk', 'def', 'source', 'pity'];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [cols.join(',')].concat(
      state.history.map((row) => cols.map((c) => cell(row[c])).join(','))
    );
    // BOM : sans lui Excel lit l'UTF-8 en latin-1 et casse les accents.
    download(`wikimasters-${stamp()}.csv`, '﻿' + lines.join('\r\n'), 'text/csv');
  }

  // ------------------------------------------------------------------ contrôle

  function start() {
    if (state.running) return;
    if (!takeLock()) {
      return setStatus('Déjà actif dans un autre onglet.', true);
    }
    state.running = true;
    state.throttles = 0;
    setStatus('Démarrage…');
    // Nouvelle génération : toute boucle encore en vol se retirera d'elle-même.
    const epoch = ++loopEpoch;
    loop(epoch).catch((err) => {
      // Une boucle périmée qui casse ne doit pas arrêter la boucle courante.
      if (err.message !== 'stopped' && epoch === loopEpoch) {
        stop(`Erreur : ${err.message}`, true);
      }
    });
  }

  function stop(reason = 'Arrêté.', warn = false) {
    state.running = false;
    state.waitUntil = 0;
    releaseLock();
    if (state.abort) {
      const a = state.abort;
      state.abort = null;
      try {
        a();
      } catch (_) {}
    }
    setStatus(reason, warn);
  }

  function setStatus(text, warn = false) {
    state.message = text;
    state.warn = warn;
    render();
  }

  // --------------------------------------------------------------------- panel

  /*
   * Parti pris visuel — le panneau parle la langue du jeu, en plus soigné.
   *
   * Fond sombre neutre et translucide, formes rondes, une seule sans-serif :
   * l'interface doit avoir l'air d'appartenir à WikiMasters, pas d'y avoir été
   * collée. La couleur reste réservée aux raretés et à l'état « en marche » ;
   * tout le reste vit en niveaux de gris pour ne pas leur disputer l'œil.
   *
   * Les chiffres sont en chasse tabulaire : ils cessent de danser au décompte.
   *
   * La réglette de dix pastilles remplace la barre de progression : les pleines
   * sont les paquets en réserve, la suivante se remplit au rythme du compte à
   * rebours. Réserve, cadence et progression en un seul objet — et dix, c'est
   * exactement le plafond du jeu.
   *
   * Le tout vit dans un Shadow DOM : le CSS du site ne peut pas le déformer,
   * et le nôtre ne fuit pas sur le site.
   */
  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; }

    .panel {
      --bg: rgba(13,15,19,.94);
      --raise: rgba(255,255,255,.045);
      --line: rgba(255,255,255,.07);
      --text: #F1F4F8;
      --muted: #949DAD;
      --dim: #626B7A;
      --live: #35D68F;
      --warn: #F0A94B;
      --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI Variable", "Segoe UI", sans-serif;

      background: var(--bg);
      backdrop-filter: blur(18px) saturate(1.3);
      border: 1px solid var(--line);
      border-radius: 16px;
      color: var(--text);
      font: 13px/1.5 var(--sans);
      box-shadow: 0 24px 64px rgba(0,0,0,.6), 0 2px 8px rgba(0,0,0,.4);
      overflow: hidden;
      /* Le panneau ne dépasse jamais de l'écran : au-delà, le corps défile. */
      max-height: calc(100vh - 24px);
      display: flex;
      flex-direction: column;
    }
    /* Chasse tabulaire partout où un chiffre change en place : sans elle,
       le décompte fait danser tout ce qui l'entoure à chaque seconde. */
    .status b, .legend b, .fig b, .goal .cnt, .bids { font-variant-numeric: tabular-nums; }

    .head { display: flex; align-items: center; gap: 9px; padding: 13px 14px; cursor: grab; }
    .head:active { cursor: grabbing; }
    .panel:not(.folded) .head { border-bottom: 1px solid var(--line); }

    .mark { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--dim); transition: .25s; }
    .panel.live .mark { background: var(--live); box-shadow: 0 0 0 3px rgba(53,214,143,.18); }
    .panel.warn .mark { background: var(--warn); box-shadow: 0 0 0 3px rgba(240,169,75,.18); }

    .title { font-size: 13px; font-weight: 600; letter-spacing: -.01em; }
    /* Replié, l'en-tête doit suffire : il affiche le compte à rebours. */
    /* Le décompte vit dans l'onglet Paquets ; ailleurs il remonte dans l'en-tête
       pour rester sous les yeux sans dupliquer l'affichage. */
    .mini { display: none; margin-left: auto; font-size: 12px; font-weight: 600;
            font-variant-numeric: tabular-nums; color: var(--muted); }
    .panel.folded .mini, .panel:not(.tab-paquets) .mini { display: inline; }

    .icon {
      width: 26px; height: 26px; flex: none; border: 0; border-radius: 8px;
      background: var(--raise); color: var(--muted); cursor: pointer;
      font-size: 12px; line-height: 1; transition: .16s;
    }
    .icon:first-of-type { margin-left: auto; }
    .icon:hover { background: rgba(255,255,255,.09); color: var(--text); }

    .run {
      padding: 7px 14px; border-radius: 999px; border: 0; cursor: pointer;
      background: var(--live); color: #06130C;
      font: 600 12px/1 var(--sans); letter-spacing: -.01em; transition: .16s;
    }
    .run:hover { filter: brightness(1.08); }
    .panel.live .run { background: var(--raise); color: var(--text); }
    .panel.live .run:hover { background: rgba(255,255,255,.1); }

    .body { padding: 14px; display: flex; flex-direction: column; gap: 14px;
            overflow-y: auto; scrollbar-gutter: stable;
            scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.26) transparent; }
    .head { flex: none; }

    .status { display: flex; gap: 10px; align-items: baseline; color: var(--muted); min-height: 20px; }
    .status b { margin-left: auto; font-size: 15px; font-weight: 600; color: var(--text); }
    .panel.warn .status { color: var(--warn); }

    /* Progression vers la prochaine régénération. */
    .bar { height: 3px; border-radius: 2px; background: var(--raise); margin-top: -8px; overflow: hidden; }
    .bar i { display: block; height: 100%; border-radius: 2px; background: var(--live);
             width: 0; transition: width .5s linear; }
    .bar.idle { opacity: 0; }

    /* La réserve n'apparaît que si elle contient quelque chose : le script la
       vide en continu, une jauge permanente n'afficherait jamais rien. */
    .stock {
      padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, var(--live) 15%, transparent);
      color: var(--live); font-size: 11px; font-weight: 600;
    }

    /* Ruban des derniers tirages : une encoche par carte, teintée par rareté.
       Les communes restent sourdes, donc une trouvaille saute aux yeux. */
    .ribbon { display: flex; gap: 2px; align-items: flex-end; height: 18px; }
    .tick { flex: 1; min-width: 2px; border-radius: 1px; background: var(--c); height: 40%; opacity: .35; }
    .tick.hi { height: 100%; opacity: 1; }
    .tick.mid { height: 70%; opacity: .8; }

    .figs { display: flex; align-items: flex-end; gap: 22px; }
    .fig b { display: block; font-size: 23px; font-weight: 650; letter-spacing: -.02em; line-height: 1; }
    .fig span { display: block; margin-top: 4px; color: var(--dim); font-size: 11px; }
    /*
     * Le bouton portait le ton le plus effacé de la palette, sans bordure ni
     * fond : on ne le trouvait qu'en le cherchant. Il a maintenant un contour,
     * donc une surface — mais il efface l'historique, et le rendre visible
     * rend aussi le clic accidentel possible. D'où la confirmation en deux
     * temps ci-dessous : la visibilité s'accompagne d'un cran d'arrêt, sinon
     * l'un des deux défauts ne fait que remplacer l'autre.
     */
    .reset {
      margin-left: auto; padding: 3px 9px; border: 1px solid var(--line); border-radius: 7px;
      background: none; color: var(--muted); cursor: pointer; font: 11px var(--sans);
      transition: .14s;
    }
    .reset:hover { color: var(--text); border-color: var(--dim); background: var(--raise); }
    .reset.arme {
      color: var(--warn); border-color: var(--warn);
      background: color-mix(in srgb, var(--warn) 12%, transparent);
    }
    .rate { margin-top: -10px; color: var(--dim); font-size: 11px; }

    .chips { display: flex; flex-wrap: wrap; gap: 5px; }
    .openrar {
      margin-top: -6px; padding: 0; border: 0; background: none; text-align: left;
      color: var(--dim); font: 11px var(--sans); cursor: pointer; transition: .16s;
    }
    .openrar:hover { color: var(--text); }
    .openrar[hidden] { display: none; }
    /* Les teintes du jeu sont des pastels : la plus commune (menthe) est aussi
       la plus lumineuse. On rétablit la hiérarchie par l'opacité, comme le site
       le fait par l'intensité de son halo. */
    .chip {
      padding: 3px 9px; border-radius: 999px; color: var(--c);
      background: color-mix(in srgb, var(--c) 15%, transparent);
      border: 0; font: 600 11px var(--sans); cursor: pointer; transition: .16s;
      opacity: var(--w, 1);
    }
    .chip:hover { background: color-mix(in srgb, var(--c) 28%, transparent); opacity: 1; }
    .chip.on {
      opacity: 1; background: color-mix(in srgb, var(--c) 30%, transparent);
      box-shadow: inset 0 0 0 1px var(--c);
    }


    /* Journal : gouttière stable pour que l'ascenseur ne rogne pas la dernière colonne. */
    .log { max-height: var(--logh, 128px); overflow-y: auto; overscroll-behavior: contain;
           scrollbar-gutter: stable; margin: -2px -4px -2px 0; padding-right: 4px; }
    /* Une poignée de 4 px à 12 % d'opacité ne se voit pas et ne s'attrape pas. */
    .log::-webkit-scrollbar, .body::-webkit-scrollbar { width: 8px; }
    .log::-webkit-scrollbar-thumb, .body::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,.26); border-radius: 4px;
      border: 2px solid transparent; background-clip: content-box;
    }
    .log::-webkit-scrollbar-thumb:hover, .body::-webkit-scrollbar-thumb:hover {
      background: rgba(255,255,255,.45); background-clip: content-box;
    }
    .log::-webkit-scrollbar-track, .body::-webkit-scrollbar-track { background: transparent; }
    .row { display: flex; gap: 9px; align-items: center; padding: 4px 0; }
    .row .r { width: 22px; flex: none; color: var(--c); font-size: 10px; font-weight: 700; }
    .row .n {
      flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--muted); font-size: 12px; text-decoration: none; cursor: pointer; transition: .14s;
    }
    .row:hover .n { color: var(--text); }
    /*
     * Le prix reste discret : c'est un repère, pas le sujet de la ligne. Chiffres
     * tabulaires pour qu'une colonne de montants s'aligne à la lecture.
     */
    .row .px {
      flex: none; font-size: 10px; color: var(--dim);
      font-variant-numeric: tabular-nums; cursor: default;
    }
    .row:hover .px { color: var(--muted); }
    .row .go {
      flex: none; width: 18px; height: 18px; border-radius: 6px; display: grid; place-items: center;
      color: var(--dim); font-size: 10px; font-weight: 600; text-decoration: none;
      cursor: pointer; opacity: 0; transition: .14s;
    }
    .row:hover .go { opacity: 1; }
    .row .go:hover { background: var(--raise); color: var(--text); }

    .bids { display: flex; gap: 10px; align-items: baseline; font-size: 12px; text-decoration: none; cursor: pointer; }
    .bids .lead { color: var(--text); }
    .bids .out { color: var(--warn); }
    .bids .end { margin-left: auto; color: var(--dim); }
    .bids .free { color: var(--live); }
    .note { margin-top: 4px; color: var(--warn); font-size: 11px; }

    /* ------------------------------------------------------------ Marché
       Enchères, ventes, relances et journal empilés faisaient un panneau haut
       comme l'écran, avec un ascenseur par liste. Trois volets : on n'en montre
       qu'un, et le corps du panneau redevient le seul à défiler. */
    .subs { display: flex; gap: 3px; padding: 2px; border-radius: 9px; background: rgba(255,255,255,.03); }
    .subs button {
      flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 4px;
      padding: 5px 4px; border: 0; border-radius: 7px; background: transparent; color: var(--dim);
      font: 600 10.5px/1 var(--sans); letter-spacing: -.005em; cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      transition: background .15s, color .15s;
    }
    .subs button:hover { color: var(--text); }
    .subs button.on { color: var(--text); background: var(--raise); }
    .subs .cnt {
      flex: none; padding: 1px 4px; border-radius: 999px; background: rgba(255,255,255,.08);
      color: var(--muted); font: 600 9px/1.4 var(--sans); font-variant-numeric: tabular-nums;
      font-style: normal;
    }
    .subs .cnt.hot { background: color-mix(in srgb, var(--warn) 22%, transparent); color: var(--warn); }
    .subs button.on .cnt { color: var(--text); }

    .mkt { display: flex; flex-direction: column; }
    .mkt:empty { display: none; }
    /* En-tête du volet : la synthèse à gauche, l'âge du relevé à droite. */
    .mkh2 { display: flex; align-items: baseline; gap: 6px; padding: 0 2px 6px;
            font-size: 11px; color: var(--muted); }
    .mkh2 .sum { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mkh2 .n { color: var(--text); font-variant-numeric: tabular-nums; }
    .mkh2 .hot { color: var(--warn); font-variant-numeric: tabular-nums; }
    .mkh2 .free { color: var(--live); font-variant-numeric: tabular-nums; }
    .mkh2 .age { flex: none; color: var(--dim); font-size: 10px; }

    /*
     * Un seul ascenseur à l'écran, et c'est celui de la liste. Avant, trois
     * boîtes défilantes s'imbriquaient dans une quatrième : la molette agissait
     * sur celle qu'on ne visait pas et la poignée, large de 6 px à 16 % d'opacité,
     * ne s'attrapait pas. Ici l'en-tête, le pied et les options ne bougent plus,
     * la liste défile seule, et sa poignée est visible.
     */
    .mkt ul, .relist {
      max-height: 40vh; overflow-y: auto; overscroll-behavior: contain;
      scrollbar-gutter: stable;
      scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.26) transparent;
    }
    .mkt ul::-webkit-scrollbar, .relist::-webkit-scrollbar { width: 8px; }
    .mkt ul::-webkit-scrollbar-track, .relist::-webkit-scrollbar-track { background: transparent; }
    .mkt ul::-webkit-scrollbar-thumb, .relist::-webkit-scrollbar-thumb {
      background: rgba(255,255,255,.26); border-radius: 4px;
      border: 2px solid transparent; background-clip: content-box;
    }
    .mkt ul::-webkit-scrollbar-thumb:hover, .relist::-webkit-scrollbar-thumb:hover {
      background: rgba(255,255,255,.45); background-clip: content-box;
    }
    .mkt ul { list-style: none; margin: 0; padding: 0; }
    .mkt li { display: flex; align-items: baseline; gap: 7px; padding: 4px; border-top: 1px solid var(--line);
              border-radius: 5px; cursor: pointer; }
    .mkt li:hover { background: var(--raise); }
    .mkt li:first-child { border-top: 0; }
    .mkt .dot { width: 5px; height: 5px; flex: none; border-radius: 50%; background: var(--live); }
    .mkt li.out .dot { background: var(--warn); }
    .mkt li.done .dot { background: var(--dim); }
    .mkt .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
              font-size: 11px; color: var(--text); }
    .mkt .tag { flex: none; font-size: 9px; color: var(--live); }
    .mkt li.out .tag { color: var(--warn); }
    .mkt .v { flex: none; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .mkt .e { flex: none; min-width: 40px; text-align: right; font-size: 10px; color: var(--dim);
              font-variant-numeric: tabular-nums; }
    /* Une échéance proche est la seule chose qui appelle un geste tout de suite. */
    .mkt li.soon .e { color: var(--warn); }
    .mkt .none { padding: 2px 2px 4px; font-size: 11px; color: var(--dim); line-height: 1.45; }
    .mkt .none em { color: var(--muted); font-style: normal; }
    /* Jauge d'emplacements : dix cases valent mieux qu'une phrase, et elles
       passent en orange quand il n'en reste plus. */
    .mkt .gauge { display: flex; gap: 2px; padding: 0 2px 7px; }
    .mkt .gauge i { flex: 1; height: 3px; border-radius: 2px; background: var(--raise); }
    .mkt .gauge i.on { background: var(--live); }
    .mkt .gauge i.full { background: var(--warn); }

    .mkoff {
      padding: 9px 10px; border: 1px dashed var(--line); border-radius: 10px;
      color: var(--dim); font-size: 11px; line-height: 1.5;
    }
    .mkoff b { color: var(--muted); font-weight: 600; }
    /*
     * Guilde. Le résumé porte les chiffres qui décident — score, écart au
     * premier, taux d'exploitation — et doit rester lisible d'un coup d'œil :
     * une ligne par idée, la valeur en gras, le reste en sourdine.
     */
    /*
     * L'onglet répond à une question — « y a-t-il un don à faire, et lequel ».
     * Toute la hiérarchie découle de là : l'action d'abord, en grand ; le
     * contexte de guilde ensuite, en sourdine ; les cartes qu'il vaut mieux
     * vendre réduites à une ligne, parce qu'une non-action n'est pas une ligne
     * de liste. La première version alignait les seize à égalité et enterrait
     * le seul don utile au milieu.
     *
     * Deux lignes par carte, jamais une : dans 190 px, titre + destinataire +
     * chiffres sur un seul rang écrasait le titre à un caractère.
     */
    .gdon { display: grid; gap: 2px; padding: 8px 10px; margin-bottom: 6px;
            border: 1px solid color-mix(in srgb, var(--live) 35%, transparent);
            border-radius: 10px; background: color-mix(in srgb, var(--live) 7%, transparent); }
    .gdon .t { display: flex; align-items: baseline; gap: 6px; font-size: 12px; color: var(--text); }
    .gdon .t i { flex: none; font-style: normal; font-size: 10px; font-weight: 700; color: var(--c); }
    .gdon .t b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
                 white-space: nowrap; font-weight: 600; }
    .gdon .m { font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .gdon .m b { color: var(--live); font-weight: 600; }

    .gskip { padding: 7px 10px; border: 1px dashed var(--line); border-radius: 10px;
             font-size: 10px; line-height: 1.5; color: var(--dim); }
    .gskip b { color: var(--muted); font-weight: 600; }

    /*
     * Le bloc qui porte le levier : ce n'est pas une statistique, c'est un
     * geste — copier une liste et la coller dans le canal de la guilde. Il est
     * donc en tête, et c'est le seul endroit de l'onglet avec un bouton.
     */
    .gwish { padding: 9px 10px; margin-bottom: 8px; border: 1px solid var(--line);
             border-radius: 10px; font-size: 10px; line-height: 1.55; color: var(--dim); }
    .gwish .h { display: flex; align-items: baseline; gap: 6px;
                font-size: 11px; color: var(--text); font-weight: 600; margin-bottom: 3px; }
    /*
     * Rafraîchir n'est pas un troisième bouton : c'est une reprise, pas une
     * action du cycle. Une poignée discrète en bout de titre, à la même place
     * que celle du Marché — on la trouve quand on la cherche, elle ne dispute
     * rien aux deux boutons de copie.
     */
    .gwish .h .rf {
      margin: 0 0 0 auto; padding: 0; width: auto; border: 0; background: none;
      color: var(--dim); font-size: 11px; line-height: 1; cursor: pointer; transition: .14s;
    }
    .gwish .h .rf:hover { color: var(--live); background: none; }
    .gwish b { color: var(--muted); font-weight: 600; font-variant-numeric: tabular-nums; }
    .gwish em { font-style: normal; color: var(--live); font-weight: 600; }
    .gwish button {
      margin-top: 7px; width: 100%; padding: 6px 8px; border: 1px solid var(--line);
      border-radius: 8px; background: color-mix(in srgb, var(--live) 10%, transparent);
      color: var(--live); font: inherit; font-size: 11px; font-weight: 600;
      cursor: pointer; transition: .14s;
    }
    .gwish button:hover { background: color-mix(in srgb, var(--live) 18%, transparent); }
    .gwish button:disabled { opacity: .5; cursor: default; }
    /* Le second geste est occasionnel : même place, moins de poids. */
    .gwish button[data-gtuto] {
      margin-top: 4px; background: none; color: var(--dim); font-weight: 500; font-size: 10px;
    }
    .gwish button[data-gtuto]:hover { background: none; color: var(--muted); }

    /*
     * Le lot publié, avec l'état de chaque carte. Les numéros sont ceux du
     * message posté dans le tchat : c'est par eux que les membres réservent,
     * donc ils doivent se lire ici à l'identique.
     */
    .glot { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 3px; }
    .glot li { display: flex; align-items: baseline; gap: 6px; font-size: 11px; color: var(--muted); }
    .glot .num {
      flex: none; width: 13px; font-style: normal; font-size: 9px; text-align: center;
      color: var(--dim); font-variant-numeric: tabular-nums;
    }
    .glot b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
              white-space: nowrap; font-weight: 500; color: var(--text); }
    .glot span { flex: none; font-size: 9px; color: var(--dim); }
    .glot .prete b { color: var(--c); }
    .glot .prete span { color: var(--live); }
    .glot .fait b { color: var(--dim); text-decoration: line-through; }
    .gmeta { margin-top: 6px; font-size: 9px; color: var(--dim); }


    .mkfoot { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px;
              padding-top: 8px; border-top: 1px solid var(--line); font-size: 11px; color: var(--dim); }
    .mkfoot:empty { display: none; }
    .mkfoot span { white-space: nowrap; }
    .mkfoot .g { color: var(--live); font-variant-numeric: tabular-nums; }
    .mkfoot .rf {
      margin-left: auto; flex: none; padding: 0; border: 0; background: none;
      color: var(--dim); font: 11px var(--sans); cursor: pointer;
    }
    .mkfoot .rf:hover { color: var(--text); }
    .mkfoot .rf[disabled] { cursor: default; opacity: .6; }
    .mkfoot .note { flex-basis: 100%; margin: 0; }
    /* Les deux options qui pilotent cet onglet vivaient dans « Réglages » : on
       ne pouvait ni comprendre un panneau vide, ni y remédier sur place. Côte à
       côte, elles tiennent sur une ligne au lieu de deux. */
    .mopt { display: flex; flex-wrap: wrap; gap: 2px 14px; }
    .mopt .opt { padding: 0; font-size: 11px; }

    /* Le panneau se redimensionne à la souris, de 260 à 640 px : à la borne
       basse, les colonnes de précision mangeaient le titre — « A… 500 wb en
       pause 20 échecs ». On les retire, le titre passe avant, et la pastille
       de couleur dit déjà l'essentiel. */
    .panel { container-type: inline-size; }
    @container (max-width: 310px) {
      .mkt .tag { display: none; }
      .relist .suivi .w { display: none; }
      .subs button { font-size: 10px; gap: 3px; }
    }

    .relist[hidden] { display: none; }
    /* Le volet défile d'un bloc : sans cela, l'état — « 8 en pause » — et le
       titre de section disparaissaient dès le premier tour de molette. */
    .relist .rh { position: sticky; top: 0; z-index: 1; background: rgb(13,15,19);
                  display: flex; align-items: baseline; gap: 8px; font-size: 11px; color: var(--muted);
                  margin-bottom: 5px; padding: 2px 0; }
    .relist .rh b { color: var(--text); font-weight: 600; font-size: 12px; }
    .relist .rh .wait { margin-left: auto; color: var(--dim); font-variant-numeric: tabular-nums; }
    /* Un blocage — option décochée, emplacements pleins — n'est pas une attente. */
    .relist .rh .wait.hot { color: var(--warn); }
    /* Plus d'ascenseur imbriqué : deux listes dans une boîte qui défilait elle
       aussi, à côté d'une troisième, ne se manœuvraient pas. Le corps du
       panneau est le seul à défiler. */
    .relist ul { list-style: none; margin: 0; padding: 0; }
    .relist li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; padding: 4px 0;
                 border-top: 1px solid var(--line); }
    .relist li:first-child { border-top: 0; }
    /* Le verbe manquait : une ligne de journal montrait un titre, un prix et un
       âge, sans jamais dire ce qui était arrivé à la carte. */
    .relist .act { flex: none; font-size: 10px; color: var(--dim); }
    .relist li.ok .act { color: var(--live); }
    .relist li.refus .act { color: var(--warn); }
    .relist .dot { width: 5px; height: 5px; flex: none; border-radius: 50%; background: var(--dim); }
    .relist li.ok .dot { background: var(--live); }
    .relist li.refus .dot { background: var(--warn); }
    .relist .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                 font-size: 11px; color: var(--text); }
    .relist .p { flex: none; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .relist .w { flex: none; font-size: 10px; color: var(--dim); font-variant-numeric: tabular-nums; }
    /* Le motif d'un refus tenait dans une infobulle : invisible, donc inutile.
       Il prend sa propre ligne, sous le titre auquel il se rapporte. */
    .relist .why { flex-basis: 100%; margin: -2px 0 1px 13px; font-size: 10px; line-height: 1.4; color: var(--warn); }
    .relist .empty { font-size: 11px; color: var(--dim); line-height: 1.45; }
    .relist li.wait .dot { background: var(--dim); }
    .relist li.pause .dot { background: var(--warn); opacity: .5; }
    .relist li.stop .dot { background: var(--dim); }
    .relist .st { flex: none; font-size: 10px; color: var(--dim); }
    .relist li.ok .st { color: var(--live); }
    .relist li.pause .st { color: var(--warn); }
    .relist .x {
      flex: none; width: 16px; height: 16px; padding: 0; line-height: 1;
      font: 10px/1 var(--sans); color: var(--dim); background: transparent;
      border: 0; border-radius: 4px; cursor: pointer;
    }
    .relist .x:hover { color: var(--text); background: var(--raise); }
    .relist .rh.sub { margin: 9px 0 4px; padding-top: 8px; border-top: 1px solid var(--line); }
    .relist .rh.sub b { font-size: 11px; color: var(--muted); font-weight: 600; }
    .relist .ra { display: flex; gap: 6px; margin-bottom: 7px; }
    .relist .ra button {
      flex: 1; padding: 5px 6px; font: 500 10.5px/1.3 var(--sans); color: var(--muted);
      background: var(--raise); border: 1px solid var(--line); border-radius: 7px; cursor: pointer;
    }
    .relist .ra button:hover { color: var(--text); background: rgba(255,255,255,.09); }

    .goal .top { display: flex; gap: 8px; align-items: baseline; }
    .goal .name { font-size: 12px; font-weight: 600; }
    .goal .fee { color: var(--live); font-size: 11px; font-weight: 600; }
    .goal .cnt { margin-left: auto; color: var(--dim); font-size: 11px; }
    .goal .track { height: 3px; border-radius: 2px; background: var(--raise); margin-top: 8px; overflow: hidden; }
    .goal .track i { display: block; height: 100%; border-radius: 2px; background: var(--muted); }
    .goal .left { margin-top: 5px; color: var(--dim); font-size: 11px; }
    .goal .rate { color: var(--muted); font-variant-numeric: tabular-nums; }
    .goal .more { margin-top: 7px; display: flex; flex-direction: column; gap: 3px; }
    .goal .more .g { display: flex; gap: 6px; align-items: baseline; font-size: 10px; color: var(--muted); }
    .goal .more .g b { color: var(--live); font-weight: 600; font-variant-numeric: tabular-nums; }
    .goal .more .g i { margin-left: auto; font-style: normal; font-variant-numeric: tabular-nums; }
    .achv { margin-top: 9px; padding-top: 8px; border-top: 1px solid var(--raise); }
    .achv .top { display: flex; gap: 8px; align-items: baseline; }
    .achv .name { font-size: 12px; font-weight: 600; }
    .achv .cnt { color: var(--dim); font-size: 11px; font-variant-numeric: tabular-nums; }
    .achv .age { margin-left: auto; color: var(--muted); font-size: 10px; }
    .achv .none { margin-top: 5px; color: var(--muted); font-size: 10px; line-height: 1.45; }
    .achv .none b { color: var(--live); }
    .achv .claim {
      display: block; margin-top: 6px; padding: 5px 8px; border-radius: 6px;
      border: 1px solid var(--live); background: color-mix(in srgb, var(--live) 12%, transparent);
      color: var(--live); font-size: 11px; font-weight: 600; text-decoration: none; cursor: pointer;
    }
    .achv .claim b { font-variant-numeric: tabular-nums; }
    .achv .claim:hover { background: color-mix(in srgb, var(--live) 22%, transparent); }

    /* Le panneau accumulait tirages, enchères, relances et réglages dans une
       seule colonne : plus rien ne se lisait. Trois onglets séparent ce qu'on
       consulte pour des raisons différentes. */
    .tabs { flex: none; display: flex; gap: 3px; padding: 10px 14px 0; }
    .tabs button {
      flex: 1; position: relative; padding: 7px 4px;
      font: 600 11.5px/1 var(--sans); letter-spacing: -.005em;
      color: var(--muted); background: transparent; border: 0; border-radius: 8px;
      cursor: pointer; transition: background .15s, color .15s;
    }
    .tabs button:hover { color: var(--text); background: var(--raise); }
    .tabs button.on { color: var(--text); background: var(--raise); }
    .tabs .badge {
      position: absolute; top: 5px; right: 7px; width: 5px; height: 5px;
      border-radius: 50%; background: var(--warn);
    }
    .tabs .badge[hidden] { display: none; }

    .tab { display: none; }
    .tab.on { display: flex; flex-direction: column; gap: 14px; }
    /* Le Marché empile plus de blocs que les autres onglets : ils se serrent. */
    .tab[data-tab="marche"].on { gap: 10px; }
    .panel.folded .tabs { display: none; }
    .opt { display: flex; gap: 9px; align-items: center; padding: 5px 0; cursor: pointer; color: var(--muted); font-size: 12px; }
    .opt:hover { color: var(--text); }
    .opt input { accent-color: var(--live); margin: 0; width: 14px; height: 14px; }
    .tune { margin-top: 9px; color: var(--dim); font-size: 11px; }
    .revente {
      width: 100%; padding: 8px 0; border: 1px solid var(--live);
      border-radius: 9px; background: color-mix(in srgb, var(--live) 12%, transparent);
      color: var(--live); cursor: pointer; font: 600 11px var(--sans); transition: .16s;
    }
    .revente:hover { background: color-mix(in srgb, var(--live) 22%, transparent); }
    .revente[hidden] { display: none; }
    .acts { display: flex; gap: 7px; margin-top: 7px; }
    .acts button {
      flex: 1; padding: 8px 0; border: 0; border-radius: 9px; background: var(--raise);
      color: var(--muted); cursor: pointer; font: 500 11px var(--sans); transition: .16s;
    }
    .acts button:hover { background: rgba(255,255,255,.09); color: var(--text); }

    .panel { position: relative; }
    /* Poignée de redimensionnement : largeur du panneau et hauteur du journal. */
    .grip {
      position: absolute; right: 2px; bottom: 2px; width: 14px; height: 14px;
      cursor: nwse-resize; z-index: 5;
      background:
        linear-gradient(135deg, transparent 45%, var(--dim) 45%, var(--dim) 55%, transparent 55%),
        linear-gradient(135deg, transparent 70%, var(--dim) 70%, var(--dim) 80%, transparent 80%);
      opacity: .5;
    }
    .grip:hover { opacity: 1; }
    .panel.folded .grip { display: none; }
    .panel.folded .body { display: none; }
    :focus-visible { outline: 2px solid var(--live); outline-offset: 2px; }
    /* Écran étroit : le site passe en présentation mobile, le panneau aussi. */
    @media (max-width: 640px) {
      .panel { font-size: 12px; }
      .body { padding: 11px; gap: 11px; }
      .fig b { font-size: 19px; }
      .log { max-height: 96px; }
    }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  `;

  const ui = {};

  function buildPanel() {
    const host = document.createElement('div');
    host.id = 'wm-auto-panel';
    host.style.cssText =
      'position:fixed;z-index:2147483647;user-select:none;' +
      // Jamais plus large que la fenêtre : sur un écran étroit le panneau
      // recouvrait tout le contenu du site.
      'width:min(var(--w,300px),calc(100vw - 24px));max-width:calc(100vw - 24px)';
    const root = host.attachShadow({ mode: 'open' });

    root.innerHTML = `
      <style>${PANEL_CSS}</style>
      <div class="panel" data-panel>
        <span class="grip" data-grip title="Redimensionner"></span>
        <div class="head" data-head>
          <span class="mark"></span>
          <span class="title">WikiMasters Tools</span>
          <b class="mini" data-mini></b>
          <button class="icon" data-fold title="Replier">–</button>
          <button class="run" data-toggle>Start</button>
        </div>

        <nav class="tabs" data-tabs>
          <button data-tab-btn="paquets">Paquets</button>
          <button data-tab-btn="marche">Marché<i class="badge" data-badge hidden></i></button>
          <button data-tab-btn="guilde">Guilde</button>
          <button data-tab-btn="reglages">Réglages</button>
        </nav>

        <div class="body" data-body>
          <section class="tab" data-tab="paquets">
          <div class="status" data-status></div>
          <div class="bar idle" data-bar><i></i></div>
          <div class="ribbon" data-ribbon title="Derniers tirages, teintés par rareté"></div>

          <div class="rule figs">
            <span class="fig"><b data-packs>0</b><span>paquets</span></span>
            <span class="fig"><b data-cards>0</b><span>cartes</span></span>
            <button class="reset" data-reset title="Remet les compteurs à zéro et vide le journal des tirages. Deux clics : le premier demande confirmation.">Réinitialiser</button>
          </div>
          <div class="rate" data-rate></div>

          <div class="chips" data-rar></div>
          <button class="openrar" data-open-rar hidden></button>
          <div class="log" data-log></div>
          <div class="goal" data-goal></div>
          <div class="achv" data-achv></div>
          </section>

          <section class="tab" data-tab="marche">
            <nav class="subs" data-subs></nav>
            <div class="mkt" data-market></div>
            <div class="relist" data-relist></div>
            <button class="revente" data-revente>Revente — cote de mes cartes</button>
            <div class="mkfoot" data-mkfoot></div>
            <div class="mopt">
              <label class="opt" title="Relève enchères et ventes. Ne touche à rien tant que tu regardes : il ne change d’onglet et ne recharge qu’en arrière-plan, après une minute d’absence.">
                <input type="checkbox" data-opt-bids> Surveillance</label>
              <label class="opt" title="Une vente terminée sans acheteur est relancée au même prix et pour la même durée">
                <input type="checkbox" data-opt-relist> Relances auto</label>
              <label class="opt" title="Signale les cartes de ta liste de souhaits mises aux enchères. Lit le marché récent, sans rien y publier.">
                <input type="checkbox" data-opt-wish> Souhaits</label>
            </div>
          </section>

          <section class="tab" data-tab="guilde">
            <label class="opt" title="Relève les souhaits de la guilde toutes les 5 minutes, même hors de cet onglet, et te prévient dès qu'un souhait porte sur une de tes Super Rares ou Ultra Rares. Les cartes étiquetées et les favoris ne déclenchent jamais d'alerte.">
              <input type="checkbox" data-opt-gwatch> Alerter sur mes SR / UR demandées</label>
            <div class="gwish" data-gwish></div>
            <div data-gdons></div>
          </section>

          <section class="tab" data-tab="reglages">
            <label class="opt"><input type="checkbox" data-opt-autostart> Démarrer automatiquement</label>
            <label class="opt" title="Après une vérification humaine, repart dès que tu as coché la case — sans repasser par Start. Le script ne coche jamais la case lui-même."><input type="checkbox" data-opt-autoresume> Reprise après vérification</label>
            <label class="opt"><input type="checkbox" data-opt-notify> Notifications bureau</label>
            <label class="opt"><input type="checkbox" data-opt-bonus> Réclamer les paquets bonus</label>
            <label class="opt" title="Clique le bouton Réclamer du site pour chaque succès débloqué, quand tu es sur la page Succès"><input type="checkbox" data-opt-autoclaim> Réclamer les récompenses de succès</label>
            <label class="opt" title="Lit tes propres lignes dans la base du jeu, avec la session déjà ouverte dans cet onglet : réserve exacte et liste complète des ventes, là où l'API du site ne renvoie plus que des compteurs. Le jeton n'est ni stocké, ni journalisé, ni exporté."><input type="checkbox" data-opt-db> Lecture directe de la base</label>
            <div class="tune" data-tuning></div>
            <div class="tune" data-bonusnote></div>
            <div class="tune" data-dbnote></div>
            <div class="acts">
              <button data-csv>Export CSV</button>
              <button data-json>Export JSON</button>
            </div>
          </section>
        </div>
      </div>`;

    document.body.appendChild(host);
    const q = (sel) => root.querySelector(sel);
    Object.assign(ui, {
      box: host,
      root,
      panel: q('[data-panel]'),
      head: q('[data-head]'),
      fold: q('[data-fold]'),
      toggle: q('[data-toggle]'),
      body: q('[data-body]'),
      status: q('[data-status]'),
      bar: q('[data-bar]'),
      barFill: q('[data-bar] i'),
      ribbon: q('[data-ribbon]'),
      packs: q('[data-packs]'),
      cards: q('[data-cards]'),
      rate: q('[data-rate]'),
      rar: q('[data-rar]'),
      openRar: q('[data-open-rar]'),
      log: q('[data-log]'),
      reset: q('[data-reset]'),
      tuning: q('[data-tuning]'),
      bonusnote: q('[data-bonusnote]'),
      dbnote: q('[data-dbnote]'),
      gwish: q('[data-gwish]'),
      optGwatch: q('[data-opt-gwatch]'),
      gdons: q('[data-gdons]'),
      optDb: q('[data-opt-db]'),
      optAutostart: q('[data-opt-autostart]'),
      optNotify: q('[data-opt-notify]'),
      optBonus: q('[data-opt-bonus]'),
      optWish: q('[data-opt-wish]'),
      optAutoclaim: q('[data-opt-autoclaim]'),
      optAutoresume: q('[data-opt-autoresume]'),
      optBids: q('[data-opt-bids]'),
      optRelist: q('[data-opt-relist]'),
      relist: q('[data-relist]'),
      tabs: q('[data-tabs]'),
      badge: q('[data-badge]'),
      subs: q('[data-subs]'),
      market: q('[data-market]'),
      mkfoot: q('[data-mkfoot]'),
      goal: q('[data-goal]'),
      achv: q('[data-achv]'),
      grip: q('[data-grip]'),
      mini: q('[data-mini]'),
      revente: q('[data-revente]'),
      csv: q('[data-csv]'),
      json: q('[data-json]'),
    });


    placePanel(loadStore().pos);
    /*
     * Écran étroit : on démarre replié. Rétrécir ne suffit pas — à 520 px de
     * large, un panneau de 300 px couvre 58 % de la page. Replié, il se réduit
     * à son en-tête, qui porte l'essentiel : état et compte à rebours. Tu le
     * déplies quand tu en as besoin, et il le reste jusqu'au rechargement.
     */
    setFolded(innerWidth < NARROW ? true : prefs.folded, innerWidth >= NARROW);
    setTab(prefs.tab);

    // Une référence absente ne doit pas interrompre le montage : c'est ainsi
    // qu'un simple oubli de balisage a fait disparaître tout le panneau.
    for (const [nom, el] of Object.entries(ui)) {
      if (el === null) console.warn(`[WikiMasters Tools] élément introuvable : ${nom}`);
    }

    ui.optAutostart.checked = prefs.autostart;
    ui.optNotify.checked = prefs.notify;
    ui.optBonus.checked = prefs.bonus;
    ui.optWish.checked = prefs.watchWish;
    ui.optAutoclaim.checked = prefs.autoclaim;
    ui.optDb.checked = prefs.db;
    ui.optGwatch.checked = prefs.watchGuild;
    ui.optAutoresume.checked = prefs.autoResume;
    ui.optBids.checked = prefs.watchBids;
    ui.optRelist.checked = prefs.relistUnsold;

    ui.toggle.addEventListener('click', () =>
      state.running ? stop('Arrêté manuellement.') : start()
    );
    ui.fold.addEventListener('click', () => setFolded(!ui.panel.classList.contains('folded')));
    ui.relist.addEventListener('click', (e) => {
      const off = e.target.closest('[data-unwatch]');
      if (off) return dropWatch(off.dataset.unwatch, 'retirée'), render();
      /*
       * Une mise en pause était sans retour : après vingt échecs, la seule
       * issue offerte était de retirer la carte. Or le motif le plus fréquent
       * — la carte que le serveur n'a pas encore rendue — finit par se
       * résoudre tout seul.
       */
      const again = e.target.closest('[data-retry]');
      if (again) {
        const w = state.watch[again.dataset.retry];
        if (w) {
          w.paused = false;
          w.fails = 0;
          saveStore({ watch: state.watch });
        }
        return render();
      }
      if (e.target.closest('[data-watch-all]')) return void watchCurrentSales();
      if (e.target.closest('[data-unwatch-all]')) {
        for (const c of Object.keys(state.watch)) dropWatch(c, null);
        return render();
      }
    });

    ui.subs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sub]');
      if (!b || b.dataset.sub === prefs.mktSub) return;
      // Le volet consulté est une préférence, pas un état de session.
      prefs.mktSub = b.dataset.sub;
      saveStore({ mktSub: prefs.mktSub });
      ui.body.scrollTop = 0;
      renderMarket();
      renderRelist();
      // Les volets n'ont pas la même hauteur : le panneau, ancré en bas,
      // grandit vers le haut et doit rester dans le cadre.
      requestAnimationFrame(clampPanel);
    });

    ui.market.addEventListener('click', (e) => {
      // Une ligne mène à SA vente ; à défaut d'identifiant, au Marché filtré
      // sur le titre — dans les deux cas par le routeur du site, donc sans
      // rechargement : la boucle d'ouverture continue de tourner.
      const ench = e.target.closest('[data-auction]');
      if (ench) return void goAuction(ench.dataset.auction);
      const row = e.target.closest('[data-open]');
      if (row) return void goFilteredTo('/marketplace', row.dataset.open);
    });

    ui.mkfoot.addEventListener('click', (e) => {
      if (e.target.closest('[data-mk-refresh]')) refreshMarket();
    });

    ui.tabs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab-btn]');
      if (b) setTab(b.dataset.tabBtn);
    });
    /*
     * Confirmation en deux temps, sans boîte de dialogue : `confirm()` bloque
     * la page entière, et le panneau vit dans l'onglet du jeu. Le premier clic
     * arme le bouton en annonçant ce qui va disparaître ; le second, dans les
     * quatre secondes, exécute. Passé ce délai il se désarme tout seul — un
     * bouton laissé armé finirait par être cliqué sans qu'on sache pourquoi.
     */
    let resetArme = 0;
    ui.reset.addEventListener('click', () => {
      if (Date.now() < resetArme) {
        resetArme = 0;
        ui.reset.classList.remove('arme');
        ui.reset.textContent = 'Réinitialiser';
        resetStats();
        return;
      }
      resetArme = Date.now() + 4000;
      ui.reset.classList.add('arme');
      ui.reset.textContent = state.history.length
        ? `Effacer ${state.history.length} tirages ?`
        : 'Confirmer ?';
      setTimeout(() => {
        if (!resetArme) return;
        resetArme = 0;
        ui.reset.classList.remove('arme');
        ui.reset.textContent = 'Réinitialiser';
      }, 4000);
    });
    ui.revente.addEventListener('click', openSell);
    ui.csv.addEventListener('click', exportCsv);
    ui.json.addEventListener('click', exportJson);

    // Le titre d'un tirage ouvre la collection filtrée sur cette carte.
    // L'écriture est synchrone, donc faite avant que l'onglet ne s'ouvre.
    ui.log.addEventListener('click', (e) => {
      const link = e.target.closest('[data-card]');
      if (!link) return;
      e.preventDefault(); // on navigue via le routeur du site, pas via le href
      if (link.dataset.cote) openCardMarket(link.dataset.card);
      else goFilteredTo(link.dataset.target, link.dataset.card);
    });

    ui.optAutostart.addEventListener('change', (e) => {
      prefs.autostart = e.target.checked;
      saveStore({ autostart: prefs.autostart });
    });

    // La permission navigateur ne peut être demandée que sur un geste de l'utilisateur.
    ui.optNotify.addEventListener('change', async (e) => {
      if (e.target.checked && !(await askNotifyPermission())) {
        e.target.checked = false;
        state.bonusNote = 'Notifications refusées par le navigateur.';
        render();
      }
      prefs.notify = e.target.checked;
      saveStore({ notify: prefs.notify });
    });

    ui.optBonus.addEventListener('change', (e) => {
      prefs.bonus = e.target.checked;
      saveStore({ bonus: prefs.bonus });
    });

    ui.optWish.addEventListener('change', (e) => {
      prefs.watchWish = e.target.checked;
      saveStore({ watchWish: prefs.watchWish });
      render();
      if (prefs.watchWish) scanWishMarket();
    });

    ui.optAutoresume.addEventListener('change', (e) => {
      prefs.autoResume = e.target.checked;
      saveStore({ autoResume: prefs.autoResume });
    });

    ui.optAutoclaim.addEventListener('change', (e) => {
      prefs.autoclaim = e.target.checked;
      saveStore({ autoclaim: prefs.autoclaim });
      if (prefs.autoclaim) claimAll();
    });

    ui.optGwatch.addEventListener('change', (e) => {
      prefs.watchGuild = e.target.checked;
      saveStore({ watchGuild: prefs.watchGuild });
      /*
       * Premier armement : on relève tout de suite, mais sans rien signaler du
       * passé. Cocher la case ne doit pas déclencher une volée d'alertes sur
       * des souhaits posés il y a trois jours — seul ce qui arrive ensuite
       * mérite qu'on te dérange.
       */
      if (prefs.watchGuild) {
        state.guildSilence = true;
        refreshGuild(true);
      }
    });

    /*
     * Préparer, puis copier. Deux temps volontairement : la première lecture
     * de la collection coûte une dizaine de requêtes, on ne la déclenche pas
     * en ouvrant l'onglet. Le texte copié se colle tel quel dans le canal de la
     * guilde — c'est le livrable, le panneau n'écrit nulle part à ta place.
     */
    ui.gwish.addEventListener('click', async (e) => {
      const tuto = e.target.closest('[data-gtuto]');
      const refaire = e.target.closest('[data-gnext]');
      const bouton = tuto || refaire || e.target.closest('[data-gcopy]');
      if (!bouton) return;
      bouton.disabled = true;
      try {
        /*
         * Refaire le lot : relecture sans cache. Une carte étiquetée il y a
         * deux minutes doit en sortir maintenant, pas à l'expiration du cache
         * d'une heure — et c'est justement après un étiquetage qu'on clique.
         */
        if (refaire) {
          bouton.textContent = '…';
          const neuf = await suggestWishes(LOT_SOUHAITS, true);
          if (neuf && neuf.length) state.aSouhaiter = neuf;
          renderGuild();
          return;
        }
        /*
         * Le mode d'emploi ne marque rien comme publié : il ne consomme aucune
         * carte, et on peut vouloir le reposter quand de nouveaux membres
         * arrivent.
         */
        if (tuto) {
          await navigator.clipboard.writeText(messageGuildeTuto());
          bouton.textContent = 'Copié — à poster une fois';
          return;
        }
        /*
         * Pas de lot en cours : on en prépare un, en relisant la collection
         * sans passer par le cache. Une carte étiquetée il y a deux minutes
         * doit en être absente maintenant, pas à l'expiration du cache.
         */
        if (!state.aSouhaiter || !state.aSouhaiter.length) {
          bouton.textContent = 'Lecture de ta collection…';
          state.aSouhaiter = await suggestWishes(LOT_SOUHAITS, true);
          if (!state.aSouhaiter) {
            bouton.textContent = 'Collection illisible — active la lecture de la base';
            return;
          }
          renderGuild();
          return;
        }
        const texte = messageGuildeLot(state.aSouhaiter);
        await navigator.clipboard.writeText(texte);
        /*
         * Copié vaut publié : le lot suivant en sortira d'autres. Sans ce
         * marquage, republier une semaine plus tard recollerait exactement les
         * mêmes quarante titres.
         */
        /*
         * Borné comme le registre des souhaits vus : sans plafond, la liste
         * grossirait d'un lot par publication et finirait par occuper le
         * stockage pour rien. Au-delà, les plus anciennes cartes redeviennent
         * publiables — ce qui est exactement le recyclage voulu.
         */
        state.publiees = [...new Set([...(state.publiees || []), ...state.aSouhaiter.map((c) => c.id)])]
          .slice(-PUBLIEES_MAX);
        saveStore({ publiees: state.publiees });
        bouton.textContent = 'Copié — à coller dans le canal de la guilde';
      } catch (_) {
        bouton.textContent = 'Copie refusée par le navigateur';
      } finally {
        setTimeout(() => { bouton.disabled = false; renderGuild(); }, 2500);
      }
    });

    ui.optDb.addEventListener('change', (e) => {
      prefs.db = e.target.checked;
      saveStore({ db: prefs.db });
      // Relire tout de suite : cocher la case sans rien voir changer pendant
      // une minute donnerait l'impression que le réglage ne fait rien.
      state.packsReadAt = 0;
      state.dbNote = prefs.db ? '' : 'Lecture directe désactivée.';
      // La cote refusée par l'API redevient possible par la base : on lève le
      // verrou posé par le 403, sans quoi le relevé refuserait de repartir.
      if (prefs.db) {
        sell.refusVentes = 0;
        sell.refusVentesN = 0;
        refreshPacks();
      }
      render();
    });

    // Les raccourcis du panneau restent des navigations internes, sans onglet.
    ui.box.addEventListener('click', (e) => {
      const go = e.target.closest('[data-goto]');
      if (!go) return;
      e.preventDefault();
      goFilteredTo(go.dataset.goto, '');
    });

    /*
     * Une pastille ne fait que trier le journal, sur place. Ouvrir la
     * collection est un geste distinct, offert juste en dessous : trier ne
     * devrait pas obliger à quitter la page où l'on est.
     */
    ui.rar.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-rarity]');
      if (!chip) return;
      const r = chip.dataset.rarity;
      prefs.logRarity = prefs.logRarity === r ? null : r;
      saveStore({ logRarity: prefs.logRarity });
      render();
    });

    ui.openRar.addEventListener('click', () => {
      if (prefs.logRarity) goFilteredTo('/collection', '', prefs.logRarity);
    });

    ui.optRelist.addEventListener('change', (e) => {
      prefs.relistUnsold = e.target.checked;
      saveStore({ relistUnsold: prefs.relistUnsold });
    });

    ui.optBids.addEventListener('change', (e) => {
      prefs.watchBids = e.target.checked;
      saveStore({ watchBids: prefs.watchBids });
      if (prefs.watchBids && onMarket()) scanBids();
    });

    makeDraggable();
    makeResizable();
    applySize(loadStore().size);

    /*
     * Le panneau change de hauteur tout seul : un volet plus long, une liste
     * qui s'allonge, un relevé qui arrive. Ancré en bas à droite, il grandit
     * vers le haut — et passait au-dessus du bord de l'écran, en-tête compris.
     * On le rappelle dans le cadre à chaque changement de taille ; le
     * repositionnement ne modifie pas les dimensions, donc pas de boucle.
     */
    if ('ResizeObserver' in window) {
      // La référence est conservée : un observateur qu'on n'accroche à rien
      // peut être ramassé, et cesse alors de prévenir sans le dire.
      ui.watcher = new ResizeObserver(() => clampPanel());
      ui.watcher.observe(ui.box);
    }
  }

  /*
   * Taille mémorisée : la largeur du panneau et la hauteur du journal. Les
   * bornes évitent qu'un glissement trop enthousiaste rende le panneau
   * inutilisable ou le fasse déborder de l'écran.
   */
  const SIZE = { wMin: 260, wMax: 640, hMin: 80, hMax: 600 };

  function applySize(size) {
    const w = Math.min(SIZE.wMax, Math.max(SIZE.wMin, (size && size.w) || 300));
    const h = Math.min(SIZE.hMax, Math.max(SIZE.hMin, (size && size.h) || 128));
    ui.box.style.setProperty('--w', `${w}px`);
    ui.panel.style.setProperty('--logh', `${h}px`);
    requestAnimationFrame(clampPanel);
  }

  /** Glisser la poignée élargit le panneau et allonge le journal. */
  function makeResizable() {
    let x0 = 0, y0 = 0, w0 = 0, h0 = 0, actif = false;

    ui.grip.addEventListener('mousedown', (e) => {
      actif = true;
      x0 = e.clientX;
      y0 = e.clientY;
      w0 = ui.box.offsetWidth;
      h0 = parseInt(getComputedStyle(ui.panel).getPropertyValue('--logh')) || 128;
      e.preventDefault();
      e.stopPropagation(); // sinon l'en-tête croirait qu'on déplace le panneau
    });

    addEventListener('mousemove', (e) => {
      if (!actif) return;
      applySize({ w: w0 + (e.clientX - x0), h: h0 + (e.clientY - y0) });
    });

    addEventListener('mouseup', () => {
      if (!actif) return;
      actif = false;
      saveStore({
        size: {
          w: ui.box.offsetWidth,
          h: parseInt(getComputedStyle(ui.panel).getPropertyValue('--logh')) || 128,
        },
      });
    });
  }

  /*
   * Le panneau s'ancre au coin BAS-DROIT, pas en haut à gauche. Sa hauteur
   * varie beaucoup — réglages ouverts ou non, journal plus ou moins long — et
   * une position en `top` le faisait flotter au milieu de la page dès que le
   * contenu changeait de taille. En mémorisant l'écart aux bords droit et bas,
   * il reste collé au coin quoi qu'il arrive, y compris au redimensionnement
   * de la fenêtre.
   */
  const MARGE = 16;
  const NARROW = 640; // en dessous, le site passe en présentation mobile

  function placePanel(pos) {
    ui.box.style.left = 'auto';
    ui.box.style.top = 'auto';
    ui.box.style.right = `${pos && Number.isFinite(pos.r) ? pos.r : MARGE}px`;
    ui.box.style.bottom = `${pos && Number.isFinite(pos.b) ? pos.b : MARGE}px`;
    clampPanel();
  }

  /*
   * Le panneau doit rester ENTIÈREMENT visible. Borner l'écart aux bords sans
   * tenir compte de sa taille l'a fait sortir par le haut : son en-tête, seule
   * prise pour le déplacer, devenait inatteignable. On mesure donc sa hauteur
   * réelle — elle change sans cesse — et on replace dans la fenêtre.
   */
  function clampPanel() {
    const w = ui.box.offsetWidth;
    const h = ui.box.offsetHeight;
    const r = parseFloat(ui.box.style.right) || 0;
    const b = parseFloat(ui.box.style.bottom) || 0;
    ui.box.style.right = `${Math.min(Math.max(4, r), Math.max(4, innerWidth - w - 4))}px`;
    ui.box.style.bottom = `${Math.min(Math.max(4, b), Math.max(4, innerHeight - h - 4))}px`;
  }

  const panelPos = () => ({
    r: Math.round(innerWidth - ui.box.offsetLeft - ui.box.offsetWidth),
    b: Math.round(innerHeight - ui.box.offsetTop - ui.box.offsetHeight),
  });

  function setFolded(folded, memoriser = true) {
    ui.panel.classList.toggle('folded', folded);
    requestAnimationFrame(clampPanel);
    ui.fold.textContent = folded ? '+' : '–';
    ui.fold.title = folded ? 'Déplier' : 'Replier';
    if (!memoriser) return;
    prefs.folded = folded;
    saveStore({ folded });
  }

  function setTab(nom) {
    prefs.tab = nom;
    saveStore({ tab: nom });
    for (const b of ui.tabs.querySelectorAll('[data-tab-btn]')) {
      b.classList.toggle('on', b.dataset.tabBtn === nom);
    }
    for (const sec of ui.body.querySelectorAll('[data-tab]')) {
      sec.classList.toggle('on', sec.dataset.tab === nom);
    }
    for (const n of ['paquets', 'marche', 'guilde', 'reglages']) {
      ui.panel.classList.toggle(`tab-${n}`, n === nom);
    }
    ui.body.scrollTop = 0;
    requestAnimationFrame(clampPanel);
    render();
    // Ouvrir le Marché suffit à le rendre juste : une liste vieille d'une heure
    // affichée telle quelle est ce qui lui donnait son air d'inachevé.
    if (nom === 'marche') freshenMarket();
    // Même principe pour la Guilde, à la cadence que le serveur tolère.
    if (nom === 'guilde') refreshGuild();
  }

  /** Le panneau se déplace à la souris ; sa position est mémorisée. */
  function makeDraggable() {
    let dx = 0, dy = 0, dragging = false;

    ui.head.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return; // les boutons gardent leur rôle
      dragging = true;
      dx = e.clientX - ui.box.offsetLeft;
      dy = e.clientY - ui.box.offsetTop;
      ui.head.style.cursor = 'grabbing';
      e.preventDefault();
    });

    addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const left = e.clientX - dx;
      const top = e.clientY - dy;
      placePanel({
        r: innerWidth - left - ui.box.offsetWidth,
        b: innerHeight - top - ui.box.offsetHeight,
      });
    });

    addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      ui.head.style.cursor = 'grab';
      saveStore({ pos: panelPos() });
    });
  }

  // ------------------------------------------------------------------- rendu

  /*
   * Réécrire innerHTML à l'identique n'est pas gratuit : le navigateur jette
   * les nœuds, l'ascenseur repart en haut et la liste se dérobe sous la main
   * en plein glissé — or le panneau se redessine tout seul, plusieurs fois par
   * minute. On ne touche donc au DOM que si le balisage a bougé, et on rend
   * alors sa position à l'ascenseur : celui du bloc comme ceux des listes
   * qu'il contient.
   */
  function paint(el, html) {
    if (!el || el.innerHTML === html) return;
    const dedans = [...el.querySelectorAll('ul, table, .scroll')]
      .map((n, i) => [i, n.scrollTop])
      .filter(([, y]) => y);
    const haut = el.scrollTop;
    el.innerHTML = html;
    el.scrollTop = haut;
    if (dedans.length) {
      const apres = el.querySelectorAll('ul, table, .scroll');
      for (const [i, y] of dedans) if (apres[i]) apres[i].scrollTop = y;
    }
  }

  function render() {
    if (!ui.box) return;

    ui.panel.classList.toggle('live', state.running);
    ui.panel.classList.toggle('warn', !state.running && state.warn);
    ui.toggle.textContent = state.running ? 'Stop' : 'Start';

    renderStatus();
    renderRibbon();

    ui.packs.textContent = state.packs;
    ui.cards.textContent = state.cards;

    const elapsed = Date.now() - state.since;
    ui.rate.textContent = state.packs ? `depuis ${fmtSpan(elapsed)}` : '';

    renderMarket();
    renderRelist();
    renderGoal();
    renderAchievements();
    renderBadge();

    // Le compteur porte sur la session ; le clic montre TOUTES tes cartes de
    // cette rareté dans la collection, d'où l'infobulle explicite.
    const byRarity = countByRarity();
    paint(ui.rar, RARITIES.filter((r) => byRarity[r])
      .map(
        (r) =>
          `<button class="chip${prefs.logRarity === r ? ' on' : ''}" data-rarity="${r}"
             style="--c:${RARITY_COLOR[r]};--w:${(0.58 + rank(r) * 0.07).toFixed(2)}"
             title="${
               prefs.logRarity === r
                 ? 'Cliquer à nouveau pour réafficher toutes les raretés'
                 : `Trier le journal sur tes ${byRarity[r]} carte(s) ${r}`
             }">${r} ${byRarity[r]}</button>`
      )
      .join(''));

    // Le raccourci vers la collection n'apparaît qu'une fois une rareté isolée.
    const r = prefs.logRarity;
    ui.openRar.hidden = !r;
    if (r) {
      const n = byRarity[r] || 0;
      ui.openRar.textContent = `Voir les ${n} ${r} dans la collection →`;
    }

    renderLog();

    if (prefs.tab === 'guilde') renderGuild();

    if (prefs.tab === 'reglages') {
      /*
       * Le plancher appris n'apparaît qu'une fois mesuré : tant qu'aucun 429
       * n'est tombé, l'annoncer laisserait croire à une limite constatée là où
       * il n'y a qu'une borne de sécurité jamais atteinte.
       */
      const mur = state.probeFloorMs
        ? ` · plancher mesuré ${(state.probeFloorMs / 1000).toFixed(1)} s`
        : '';
      ui.tuning.textContent =
        `Délai ${(state.delayMs / 1000).toFixed(1)} s${mur} · régénération ${fmtClock(state.cadenceMs)}`;
      ui.bonusnote.textContent = state.bonusNote;
      ui.dbnote.textContent = state.dbNote;
    }
  }

  /**
   * Journal au niveau de la carte — et non du paquet, sinon quatre cartes sur
   * cinq resteraient invisibles.
   *
   * Ce sont les pastilles de rareté qui le filtrent : un sélecteur de tri à
   * part faisait doublon avec elles, pour un geste de plus. Cliquer « SR »
   * isole les SR ici et les montre dans la collection — une intention, un clic.
   */
  /*
   * Les raretés dont le prix vaut la peine d'être affiché au fil des tirages.
   *
   * En dessous, la médiane du marché tourne autour de dix wikibidous quelle que
   * soit la carte — une colonne qui répéterait « 10 wb » sur des centaines de
   * lignes n'apprendrait rien. Le prix n'est une information que là où il varie :
   * une SR se vend 21 en médiane mais certaines montent à plusieurs centaines,
   * et une Légendaire va de quelques dizaines à plusieurs milliers.
   */
  const RARETES_COTEES = ['SR', 'UR', 'L'];

  function renderLog() {
    // Tout l'historique : le tronquer ferait diverger le journal des pastilles.
    const cards = prefs.logRarity
      ? state.history.filter((c) => c.rarity === prefs.logRarity)
      : state.history;

    /*
     * La cote est déjà relevée pour chaque carte tirée — `priceCards` part à
     * chaque paquet ouvert. On la lit ici, sans requête supplémentaire ; une
     * carte sans historique de vente n'affiche simplement rien.
     */
    const cote = new Map((sell.rows || []).map((r) => [r.id, r]));

    paint(ui.log, cards
      .map((e) => {
        const col = RARITY_COLOR[e.rarity] || '#8C8275';
        const wiki = e.url
          ? `<a class="go" href="${esc(e.url)}" target="_blank" rel="noopener"
               title="Article Wikipédia">W</a>`
          : '';
        /*
         * Le compteur de pitié en infobulle, pas en colonne : il n'a de sens
         * que le jour où l'on cherche à comprendre ce qu'il fait, et une
         * colonne de plus abîmerait un journal qu'on lit d'un coup d'œil.
         */
        const pitie = e.pity === '' || e.pity == null ? '' : ` · pitié ${e.pity}`;

        // Prix moyen des ventes closes, pour les raretés où il varie vraiment.
        const c = RARETES_COTEES.includes(e.rarity) ? cote.get(e.id) : null;
        const prix = c
          ? `<span class="px" title="${c.n} vente${c.n > 1 ? 's' : ''} · moyenne ${c.moy} wb
              · médiane ${c.med} wb · de ${c.min} à ${c.max}">${c.moy}</span>`
          : '';

        return `<div class="row" style="--c:${col}" title="Tirage ${e.rarity}${pitie}">
            <span class="r">${e.rarity}</span>
            <a class="n" href="/collection" data-card="${esc(e.title)}" data-target="/collection"
               title="Voir cette carte dans ta collection">${esc(e.title)}</a>
            ${prix}
            <a class="go" href="/collection" data-card="${esc(e.title)}" data-cote="1"
               title="Voir sa cote : ventes, moyenne, min/max">M</a>
            ${wiki}
          </div>`;
      })
      .join(''));
  }

  /*
   * L'onglet Guilde répond à une seule question : où sont les points qu'on ne
   * prend pas, et que puis-je faire là, maintenant.
   *
   * Il ne donne jamais à ta place. Un exemplaire donné ne revient pas, et le
   * bon destinataire dépend de choses que le script ne sait pas — il classe,
   * chiffre l'arbitrage, et te mène à la page.
   */
  function renderGuild() {
    const g = state.guild;
    if (!g || !g.at) {
      paint(ui.gdons, `<div class="gskip">Relevé de la guilde en cours…</div>`);
      paint(ui.gwish, '');
      return;
    }

    /*
     * L'onglet suit le cycle, dans son ordre : le lot publié et son état, puis
     * ce qu'il y a à donner tout de suite, puis le contexte de guilde.
     *
     * Chaque carte du lot porte son état — en attente, réclamée par quelqu'un,
     * donnée. C'est ce qui remplace le bouton « lot suivant » : on voit où en
     * est le cycle au lieu de devoir s'en souvenir.
     */
    const lot = state.aSouhaiter;
    const reclamees = new Set(g.cartesSouhaitees || []);
    const parCarte = new Map((g.servables || []).map((s) => [s.carte, s.pour]));

    /*
     * Protection inconnue — la lecture a échoué — : on n'affiche aucune carte
     * comme donnable. La même prudence que l'alerte, pour la même raison :
     * mieux vaut une liste vide qu'une carte étiquetée présentée comme libre.
     */
    const protegees = g.protegees;
    const etatCarte = (c, i) => {
      const num = `<i class="num">${i + 1}</i>`;
      const nom = `<b>${esc(c.titre)}</b>`;
      if (c.donnee) return `<li class="fait">${num}${nom}<span>donnée</span></li>`;
      /*
       * Étiquetée après la publication : le numéro reste, pour que le message
       * déjà posté garde son sens, mais la carte est barrée. À toi de refaire
       * le lot avec ↻ — le script ne republie pas à ta place.
       */
      if (protegees && protegees.has(c.id)) {
        return `<li class="fait">${num}${nom}<span>étiquetée — ne pas donner</span></li>`;
      }
      if (parCarte.has(c.id)) {
        return `<li class="prete" style="--c:${RARITY_COLOR[c.rarete]}">${num}${nom}
          <span>à donner → ${esc(parCarte.get(c.id))}</span></li>`;
      }
      if (reclamees.has(c.id)) return `<li>${num}${nom}<span>souhaitée, pas encore servable</span></li>`;
      return `<li>${num}${nom}<span>en attente</span></li>`;
    };

    const restantes = lot ? lot.filter((c) => !c.donnee).length : 0;
    paint(ui.gwish, lot && lot.length
      ? `<div class="h">Lot en cours · ${restantes}/${lot.length} à placer
           <button class="rf" data-gnext title="Relit ta collection et refait le lot — à faire après avoir étiqueté des cartes, ou pour changer de sélection">↻</button></div>
         <ol class="glot">${lot.map(etatCarte).join('')}</ol>
         <div class="gmeta">${messageGuildeLot(lot).length}/${CHAT_MAX} caractères ·
           <b>${lot.reduce((s, c) => s + (c.donnee ? 0 : karmaDe(c.rarete)), 0).toLocaleString('fr-FR')}</b>
           karma restant · ${lot.ecartees} écartées (étiquetées ou favorites)</div>
         <button data-gcopy>Copier le lot</button>
         <button data-gtuto title="La marche à suivre ne change pas d'un lot à l'autre : une fois suffit, ou quand de nouveaux membres arrivent">Copier le mode d'emploi</button>`
      : `<div class="h">Aucun lot en cours</div>
         Cinq de tes Super Rares et Ultra Rares, à publier dans le tchat. Le lot suivant se
         prépare seul une fois celles-ci données.
         <button data-gcopy>Préparer le premier lot</button>
         <button data-gtuto>Copier le mode d'emploi</button>`);

    /*
     * Sous les boutons : rien, sauf ce qui appelle un geste.
     *
     * Il y avait ici un tableau de bord de guilde, une liste des cartes qu'il
     * valait mieux vendre, et une ligne de diagnostic. Le premier motive une
     * fois puis devient du papier peint ; la deuxième énumère des non-actions ;
     * la troisième ne parle qu'au script. Trois blocs relus chaque jour sans
     * que rien n'en découle jamais.
     *
     * Ne reste que la file : les souhaits servables qui ne sont PAS dans le lot
     * en cours — celui-ci porte déjà leur état. Mêmes filtres que l'alerte, pour
     * qu'un souhait ne soit jamais montré ici et tu par là : SR et UR seulement,
     * jamais une carte étiquetée ou en favori.
     */
    const dansLeLot = new Set((lot || []).map((c) => c.id));
    const file = new Map();
    for (const s of protegees ? g.servables || [] : []) {
      if (dansLeLot.has(s.carte) || protegees.has(s.carte)) continue;
      if (!RARETES_UTILES.includes(s.rarete)) continue;
      if (!file.has(s.carte)) file.set(s.carte, { ...s, pours: [] });
      file.get(s.carte).pours.push(s.pour);
    }

    paint(ui.gdons, file.size
      ? `<div class="rh sub">Hors lot, à donner aussi</div>` +
        [...file.values()].map((s) => `
          <div class="gdon" style="--c:${RARITY_COLOR[s.rarete] || '#8C8275'}"
               title="${esc(s.pours.join(', '))}">
            <div class="t"><i>${s.rarete}</i><b>${esc(s.titre)}</b></div>
            <div class="m">${s.pours.length === 1
              ? `→ ${esc(s.pours[0])}`
              : `${s.pours.length} demandeurs`} · <b>+${karmaDe(s.rarete)} karma</b></div>
          </div>`).join('')
      : '');
  }

  /**
   * Le palier le plus proche en détail, puis les suivants en une ligne chacun.
   *
   * N'afficher que le premier revenait à cacher les récompenses : « 10 000
   * cartes » paie 500 et arrive en sept heures, « 40 Légendaires » paie 1 500.
   * Savoir que le second existe et ce qu'il coûte est précisément ce qui
   * permet d'arbitrer.
   */
  function renderGoal() {
    const rows = pendingGoals();
    if (!rows.length) {
      paint(ui.goal, state.owned.count
        ? `<div class="left">Tous les paliers de collection sont atteints.</div>`
        : '');
      return;
    }
    const [top, ...rest] = rows;
    const unit = GOAL_UNIT[top.g.of] || 'cartes';

    /*
     * La vitesse se mesure sur la croissance réelle de la collection entre
     * deux relevés, pas sur le nombre de cartes tirées : un tirage déjà
     * possédé ne fait pas avancer le palier, et une carte vendue le fait
     * reculer. Tant qu'on manque de recul, on n'affiche rien plutôt qu'un
     * chiffre inventé — voir `perHourOf`.
     *
     * La cadence est affichée à côté de l'estimation : un délai sans le rythme
     * dont il découle ne se vérifie pas. « 4 h » à 180 cartes/h se comprend et
     * se conteste ; « 4 h » seul ne dit pas s'il faut le croire.
     */
    const eta = top.eta != null
      ? ` · ~${fmtSpan(top.eta)} <span class="rate">${fmtRate(top.rate)}/h</span>`
      : '';

    const suite = rest.length ? `<div class="more">${rest.map((r) => `
      <span class="g" title="${esc(r.g.name)} — ${r.have.toLocaleString('fr-FR')} / ${r.g.at.toLocaleString('fr-FR')} ${GOAL_UNIT[r.g.of] || ''}">
        <b>+${r.g.reward}</b> ${esc(r.g.name)}
        <i>${r.left.toLocaleString('fr-FR')} ${GOAL_UNIT[r.g.of] || ''}${r.eta != null ? ` · ~${fmtSpan(r.eta)}` : ''}</i>
      </span>`).join('')}</div>` : '';

    paint(ui.goal, `
      <div class="top">
        <span class="name">${esc(top.g.name)}</span>
        <span class="fee">+${top.g.reward}</span>
        <span class="cnt">${top.have.toLocaleString('fr-FR')} / ${top.g.at.toLocaleString('fr-FR')}</span>
      </div>
      <div class="track"><i style="width:${Math.min(100, top.part * 100).toFixed(1)}%"></i></div>
      <div class="left">${top.left.toLocaleString('fr-FR')} ${unit} restantes${eta}</div>
      ${suite}`);
  }

  /**
   * Les succès : la progression, et surtout ce qui attend d'être réclamé.
   *
   * Le relevé date de ton dernier passage sur la page — on affiche donc son
   * âge. Un « N / 51 » sans fraîcheur ne dit pas s'il vaut encore.
   */
  function renderAchievements() {
    const a = state.achievements;
    if (!a.at) {
      paint(ui.achv, `<div class="none">Succès : <a class="go" href="/achievements"
        data-goto="/achievements" title="Relever la liste des succès">ouvrir la page</a></div>`);
      return;
    }
    const du = claimable();
    const reste = (a.list || []).filter((x) => !x.done);
    const gros = reste.slice().sort((x, y) => y.reward - x.reward)[0];

    paint(ui.achv, `
      <div class="top">
        <span class="name">Succès</span>
        <span class="cnt">${a.done} / ${a.total}</span>
        <span class="age">${fmtAge(a.at)}</span>
      </div>
      ${du.n ? `<a class="claim" href="/achievements" data-goto="/achievements"
          title="${esc(du.list.map((x) => `${x.name} +${x.reward}`).join(' · '))}">
          ${du.n} récompense${du.n > 1 ? 's' : ''} à réclamer <b>+${du.total.toLocaleString('fr-FR')}</b></a>` : ''}
      ${gros ? `<div class="none">Mieux payé encore verrouillé :
          <b>+${gros.reward}</b> ${esc(gros.name)} — ${esc(gros.desc)}</div>` : ''}`);
  }

  /*
   * Une Légendaire toutes les cinq heures ne s'écrit pas « 0/h ». Sous l'unité,
   * on passe à la décimale plutôt que d'arrondir un rythme réel à zéro.
   */
  const fmtRate = (r) =>
    r >= 10 ? Math.round(r).toLocaleString('fr-FR')
      : r >= 1 ? r.toFixed(1).replace('.', ',')
        : r.toFixed(2).replace('.', ',');

  /**
   * Enchères et ventes sont mémorisées, donc lisibles depuis n'importe quelle
   * page du site — pas seulement depuis le Marché où elles ont été relevées.
   */
  /*
   * Achats et ventes sont relevés en alternance : l'un des deux a toujours un
   * cycle de retard. On écarte donc ce dont l'échéance est passée depuis le
   * relevé, sinon une enchère déjà close resterait affichée à « 0:00 ».
   */
  const stillRunning = (list) => (list || []).filter((x) => x.end == null || x.end > Date.now());

  /** Temps restant, calculé sur l'échéance absolue : rien à recaler. */
  const leftNow = (x) => (x && x.end != null ? x.end - Date.now() : null);

  // Au-delà de l'heure, « 61:56 » se lit mal : on bascule en heures.
  const fmtLeft = (ms) =>
    ms == null ? '—' : ms <= 0 ? '0:00' : ms > 3600000 ? fmtSpan(ms) : fmtClock(ms);

  const fmtWb = (n) => (n == null ? '—' : Number(n).toLocaleString('fr-FR'));

  /*
   * La fraîcheur d'un relevé, en trois caractères : l'en-tête n'a pas la place
   * d'une phrase, et « il y a 15 min » y poussait le titre sur deux lignes.
   * La phrase entière reste en infobulle.
   */
  const fmtAge = (at) => (!at ? '—' : Date.now() - at < 60000 ? 'à jour' : fmtSpan(Date.now() - at));
  const ageTitle = (at) =>
    at ? `Dernier relevé ${Date.now() - at < 60000 ? "à l'instant" : `il y a ${fmtSpan(Date.now() - at)}`}`
       : 'Jamais relevé';

  const MKT_SOON_MS = 300000;   // même seuil que l'alerte « bientôt terminée »

  /*
   * Une ligne par enchère ou par vente. Ce qui finit en premier se lit en
   * premier, et une surenchère passe devant tout le reste : c'est la seule
   * chose qui appelle un geste immédiat.
   */
  function mktRows(list, kind) {
    return list
      .map((x) => ({ x, ms: leftNow(x) }))
      .sort((a, b) => {
        const sa = a.x.status === 'surencheri', sb = b.x.status === 'surencheri';
        if (sa !== sb) return sa ? -1 : 1;
        return (a.ms == null ? Infinity : a.ms) - (b.ms == null ? Infinity : b.ms);
      })
      .map(({ x, ms }) => {
        const out = x.status === 'surencheri';
        const fini = ms != null && ms <= 0;
        const cls = [out ? 'out' : '', fini ? 'done' : ms != null && ms <= MKT_SOON_MS ? 'soon' : '']
          .filter(Boolean).join(' ');
        // Côté ventes, savoir si quelqu'un a misé vaut autant que le prix.
        const tag = kind === 'bids'
          ? (out ? '<span class="tag">surenchéri</span>' : '')
          : (x.offered ? '<span class="tag">offre</span>' : '');
        const montant = kind === 'bids' ? x.bid : (x.offered ? x.bid : x.price);
        /*
         * Chaque ligne mène à SA vente : la page de l'annonce, avec la mise en
         * cours, le temps restant et le formulaire. Sans identifiant d'enchère
         * — un relevé antérieur à cette version — on retombe sur le Marché
         * filtré par titre, ce qui reste mieux que rien.
         */
        const cible = x.auction
          ? `data-auction="${esc(x.auction)}" title="${esc(x.title)} — ouvrir la page de l'enchère"`
          : `data-open="${esc(x.title)}" title="${esc(x.title)} — chercher sur le Marché"`;
        return `<li class="${cls}" ${cible}>
          <span class="dot"></span>
          <span class="t">${esc(x.title)}</span>
          ${tag}
          <span class="v">${fmtWb(montant)} wb</span>
          <span class="e">${fmtLeft(ms)}</span>
        </li>`;
      })
      .join('');
  }

  /*
   * L'en-tête d'un volet : la synthèse à gauche, l'âge du relevé à droite. Le
   * résumé tient dans UN élément — dans une ligne en flex, chaque nœud de texte
   * devient un élément à part entière, écarté par le `gap` et libre de passer à
   * la ligne, ce qui coupait les titres en deux.
   */
  const mktHead = (resume, at) =>
    `<div class="mkh2"><span class="sum">${resume}</span>` +
    `<span class="age" title="${ageTitle(at)}">${fmtAge(at)}</span></div>`;

  // ------------------------------------------------------ liste de souhaits

  /*
   * Le site tient une liste de souhaits — les cartes que tu as marquées comme
   * voulues — et le panneau l'ignorait complètement. C'est pourtant la seule
   * déclaration explicite de ce que tu cherches, et le guetteur balaie déjà le
   * marché : croiser les deux ne demande aucune information nouvelle.
   *
   * `/api/cards?wishlist=1` renvoie la liste paginée par 50, avec `total`.
   * Cent cinquante cartes tiennent en quatre pages — on la relit rarement,
   * elle ne bouge qu'à ta main.
   */
  const WISH_TTL_MS = 900000;      // 15 min : une liste de souhaits ne bouge pas seule
  const WISH_MAX_PAGES = 12;       // garde-fou si `total` mentait
  const WISH_SCAN_PAGES = 8;       // ~400 annonces, la fenêtre récente du marché
  const WISH_SCAN_MS = 100000;     // sous les deux minutes que couvrent ces pages

  async function refreshWishlist(force) {
    if (!force && Date.now() - state.wish.at < WISH_TTL_MS) return state.wish;
    const cartes = {};
    try {
      for (let page = 0; page < WISH_MAX_PAGES; page++) {
        const d = await api(`/api/cards?page=${page}&wishlist=1`);
        const lot = (d.data && d.data.cards) || [];
        if (!lot.length) break;
        for (const c of lot) {
          cartes[c.id] = { t: c.wikipedia_title || c.title || c.id, r: c.rarity || '?' };
        }
        if (d.data && Number.isFinite(d.data.total)
            && Object.keys(cartes).length >= d.data.total) break;
      }
    } catch (_) {
      return state.wish;   // réseau : on garde la liste précédente
    }
    /*
     * Un balayage vide n'efface pas la liste : une réponse ratée ne doit pas
     * faire croire que tu ne veux plus rien, ce qui éteindrait les alertes.
     */
    if (!Object.keys(cartes).length) return state.wish;
    state.wish = { at: Date.now(), cards: cartes };
    saveStore({ wish: state.wish });
    return state.wish;
  }

  /*
   * Le marché ne se filtre pas par carte : ni recherche, ni `card_id`. On lit
   * donc la fenêtre récente — les mêmes pages que la découverte des ventes —
   * et on garde ce qui tombe dans la liste. Huit pages couvrent environ deux
   * minutes de marché, d'où un passage toutes les 100 s : sans recouvrement,
   * une annonce parue entre deux balayages passerait inaperçue.
   */
  async function scanWishMarket() {
    const wish = await refreshWishlist(false);
    const voulues = wish.cards || {};
    if (!Object.keys(voulues).length) return;

    const trouvees = [];
    const vus = new Set();
    for (let page = 0; page < WISH_SCAN_PAGES; page++) {
      let d;
      try {
        d = await api(`/api/marketplace?page=${page}&limit=50&sort=recent`);
      } catch (_) {
        break;
      }
      if (d.status !== 200) break;
      const lot = (d.data && d.data.auctions) || [];
      if (!lot.length) break;
      for (const x of lot) {
        const c = voulues[x.card_id];
        if (!c || vus.has(x.id)) continue;
        vus.add(x.id);
        trouvees.push({
          auction: x.id,
          title: c.t,
          rarity: x.snapshot_rarity || c.r,
          bid: Number(x.current_bid || x.effective_bid || x.base_amount) || 0,
          bids: !!x.current_bidder_id,
          end: x.end_at ? Date.parse(x.end_at) : null,
        });
      }
    }

    /*
     * On fusionne au lieu de remplacer : une annonce sortie de la fenêtre
     * récente court toujours, et la voir disparaître du volet à mi-parcours
     * était exactement le défaut du premier modèle de suivi des ventes.
     * Ce qui a expiré s'en va tout seul, sur son échéance.
     */
    const avant = new Map((state.wishHits.list || []).map((h) => [h.auction, h]));
    for (const h of trouvees) avant.set(h.auction, h);
    const list = [...avant.values()].filter((h) => h.end == null || h.end > Date.now());

    const nouvelles = trouvees.filter((h) => !state.wishSeen[h.auction]);
    for (const h of trouvees) state.wishSeen[h.auction] = 1;

    state.wishHits = { at: Date.now(), list };
    saveStore({ wishHits: state.wishHits, wishSeen: state.wishSeen });

    // `notifyBid` porte déjà la note du panneau : une seule voie, donc pas de
    // divergence possible entre ce que dit la notification et ce qu'affiche le pied.
    if (nouvelles.length) {
      const t = nouvelles[0];
      notifyBid('Carte souhaitée en vente',
        nouvelles.length === 1 ? `${t.title} — ${fmtWb(t.bid)} wb` : `${nouvelles.length} annonces`);
    }
    render();
  }

  /*
   * Même forme que les autres volets : échéance absolue, clic vers la page de
   * l'enchère. La pastille *offre* dit qu'une mise est déjà posée — sur une
   * carte qu'on veut, savoir qu'on n'est pas seul change ce qu'on propose.
   */
  function wishRows(list) {
    return list
      .map((x) => ({ x, ms: leftNow(x) }))
      .sort((a, b) => (a.ms == null ? Infinity : a.ms) - (b.ms == null ? Infinity : b.ms))
      .map(({ x, ms }) => {
        const fini = ms != null && ms <= 0;
        const cls = [fini ? 'done' : ms != null && ms <= MKT_SOON_MS ? 'soon' : ''].filter(Boolean).join(' ');
        return `<li class="${cls}" data-auction="${esc(x.auction)}"
            title="${esc(x.title)} — ouvrir la page de l'enchère"
            style="--c:${RARITY_COLOR[x.rarity] || '#8C8275'}">
          <span class="dot"></span>
          <span class="t">${esc(x.title)}</span>
          ${x.bids ? '<span class="tag">offre</span>' : ''}
          <span class="v">${fmtWb(x.bid)} wb</span>
          <span class="e">${fmtLeft(ms)}</span>
        </li>`;
      })
      .join('');
  }

  const SUBS = [
    { key: 'ench', label: 'Enchères' },
    { key: 'vent', label: 'Ventes' },
    { key: 'rel', label: 'Relances' },
    { key: 'souh', label: 'Souhaits' },
  ];

  /*
   * Trois volets plutôt qu'une colonne. Empilés, enchères, ventes, relances et
   * journal faisaient un panneau haut comme l'écran, avec un ascenseur par
   * liste : impossible à parcourir sans se perdre. On n'en montre qu'un, et le
   * corps du panneau redevient le seul à défiler.
   */
  function renderSubs(compteurs) {
    paint(ui.subs, SUBS.map((s) => {
      const c = compteurs[s.key] || {};
      return `<button data-sub="${s.key}"${prefs.mktSub === s.key ? ' class="on"' : ''}` +
        `${c.title ? ` title="${esc(c.title)}"` : ''}>${s.label}` +
        (c.n ? `<i class="cnt${c.hot ? ' hot' : ''}">${c.n}</i>` : '') +
        `</button>`;
    }).join(''));
  }

  /*
   * Le Marché n'affichait que trois nombres — « 8 menées · 2 surenchéries ·
   * fin 32:17 » — alors que le relevé porte, pour chaque enchère et chaque
   * vente, le titre, le montant et l'échéance. Chaque volet montre donc la
   * liste qui justifie sa synthèse : savoir que deux enchères sont perdues
   * n'apprend pas lesquelles.
   */
  function renderMarket() {
    const sub = prefs.mktSub;
    const bids = stillRunning(state.bids.list);
    const sales = stillRunning(state.sales.list);
    const souhaits = stillRunning(state.wishHits.list);
    const perdues = bids.filter((b) => b.status === 'surencheri').length;
    const menees = bids.length - perdues;

    /*
     * Le nombre de ventes et celui des emplacements libres venaient de deux
     * sources distinctes : la liste balayée, qui se périme entre deux relevés,
     * et le compte du serveur, lui à jour. D'où des affichages incohérents du
     * genre « 6 ventes · 1 emplacement libre » sur un compte à dix. Le compte
     * du serveur fait foi ; la liste ne sert qu'au détail.
     */
    const max = state.slots.max || 10;
    const occupes = state.slots.at ? state.slots.used : sales.length;
    const libres = Math.max(0, max - occupes);

    const suivies = Object.keys(state.watch || {}).length;
    const pausees = Object.values(state.watch || {}).filter((w) => w.paused).length;
    renderSubs({
      ench: { n: bids.length, hot: perdues > 0,
              title: perdues ? `${perdues} enchère(s) surenchérie(s)` : 'Tes mises en cours' },
      vent: { n: occupes, hot: !libres,
              title: `${occupes} vente(s) sur ${max} emplacements` },
      rel: { n: suivies, hot: pausees > 0,
             title: pausees ? `${pausees} carte(s) en pause` : 'Cartes remises en vente automatiquement' },
      souh: { n: souhaits.length, hot: souhaits.length > 0,
              title: souhaits.length
                ? `${souhaits.length} carte(s) de ta liste de souhaits en vente`
                : 'Cartes de ta liste de souhaits actuellement aux enchères' },
    });

    // Les deux volets de relevé n'ont de sens que si le guetteur tourne.
    if (!prefs.watchBids && sub !== 'rel' && sub !== 'souh') {
      ui.relist.hidden = true;
      ui.revente.hidden = sub !== 'vent';
      paint(ui.market,
        `<div class="mkoff"><b>Surveillance désactivée.</b> Coche ` +
        `« Surveillance » en bas de cet onglet pour suivre ici tes mises, ` +
        `tes ventes en cours et leurs échéances.</div>`);
      paint(ui.mkfoot, '');
      return;
    }

    const resumeEnch = bids.length
      ? `<span class="n">${menees}</span> menée${menees > 1 ? 's' : ''}` +
        (perdues ? ` · <span class="hot">${perdues} surenchérie${perdues > 1 ? 's' : ''}</span>` : '')
      : `aucune enchère en cours`;

    const resumeVentes =
      `<span class="n">${occupes}/${max}</span> emplacement${occupes > 1 ? 's' : ''}` +
      (libres
        ? ` · <span class="free">${libres} libre${libres > 1 ? 's' : ''}</span>`
        : ` · <span class="hot">complet</span>`);

    const jauge =
      `<div class="gauge" title="${occupes} vente${occupes > 1 ? 's' : ''} en cours sur ${max} emplacements">` +
      Array.from({ length: max }, (_, i) =>
        `<i class="${i < occupes ? (libres ? 'on' : 'full') : ''}"></i>`).join('') +
      `</div>`;

    const corpsEnch = mktHead(resumeEnch, state.bids.at) + (bids.length
      ? `<ul>${mktRows(bids, 'bids')}</ul>`
      : `<div class="none">Aucune enchère relevée. Elles ne se lisent que depuis ` +
        `la page Marché, onglet « Mes enchères » — <em>rafraîchir</em> l'ouvre ` +
        `pour toi si tu y es.</div>`);

    /*
     * Le compte du serveur et la liste balayée peuvent diverger le temps d'un
     * cycle. Annoncer « 3/10 » au-dessus de « aucune vente en cours » se lit
     * comme une panne : on dit alors que c'est le détail qui manque, pas les
     * ventes.
     */
    const corpsVentes = mktHead(resumeVentes, state.sales.at) + jauge + (sales.length
      ? `<ul>${mktRows(sales, 'sales')}</ul>`
      : occupes
        ? `<div class="none">${occupes} vente${occupes > 1 ? 's' : ''} en cours d'après le ` +
          `serveur : le détail arrive au prochain relevé.</div>`
        : `<div class="none">Aucune vente en cours. Le bouton ci-dessous donne la ` +
          `cote de tes cartes et pré-remplit le prix de vente.</div>`);

    /*
     * Ce que les ventes closes ont rapporté : chiffre déjà tenu, jamais montré
     * hors de la page Revente. `final_price` arrive en chaîne de caractères —
     * sans conversion, la somme concaténait « 1050 » et « 2500 » au lieu de
     * les additionner.
     */
    const vendues = state.journal.filter((e) => e.vendue);
    const gains = vendues.reduce((s, e) => s + (Number(e.final) || 0), 0);
    const bilan = `${vendues.length} vente${vendues.length > 1 ? 's' : ''} conclue${
      vendues.length > 1 ? 's' : ''} sur les ${state.journal.length} dernières enchères closes`;

    // Un seul volet à l'écran ; les relances ont leur propre conteneur, qui
    // porte déjà son en-tête et ses actions.
    /*
     * Le volet Souhaits vit sans le guetteur d'enchères : il ne lit ni tes
     * mises ni tes ventes, seulement le marché récent. Le coupler à
     * « Surveillance » aurait caché la liste derrière une option qui parle
     * d'autre chose.
     */
    const nbSouh = Object.keys(state.wish.cards || {}).length;
    const corpsSouh = !prefs.watchWish
      ? `<div class="mkoff"><b>Souhaits non surveillés.</b> Coche « Souhaits » en ` +
        `bas de cet onglet : le panneau signalera les cartes de ta liste de ` +
        `souhaits mises aux enchères.</div>`
      : mktHead(souhaits.length
          ? `<span class="n">${souhaits.length}</span> en vente sur ${nbSouh} souhaitée${nbSouh > 1 ? 's' : ''}`
          : `aucun souhait en vente · ${nbSouh} carte${nbSouh > 1 ? 's' : ''} suivie${nbSouh > 1 ? 's' : ''}`,
          state.wishHits.at) +
        (souhaits.length
          ? `<ul>${wishRows(souhaits)}</ul>`
          : `<div class="none">Rien de ta liste de souhaits aux enchères en ce ` +
            `moment. Le marché récent est relu toutes les 100 s ; ajoute des ` +
            `cartes depuis <em>Toutes les cartes</em> sur le site.</div>`);

    ui.relist.hidden = sub !== 'rel';
    ui.revente.hidden = sub !== 'vent';
    paint(ui.market, sub === 'ench' ? corpsEnch
      : sub === 'vent' ? corpsVentes
        : sub === 'souh' ? corpsSouh : '');

    paint(ui.mkfoot,
      (state.journal.length
        ? `<span title="${esc(bilan)}">${vendues.length}/${state.journal.length} vendues</span>` +
          `<span class="g" title="Total encaissé sur ces ventes">${fmtWb(gains)} wb</span>`
        : `<span>Aucune vente conclue pour l'instant</span>`) +
      `<button class="rf" data-mk-refresh${mktBusy ? ' disabled' : ''}` +
      ` title="Relever ventes et enchères maintenant. Les enchères ne se lisent que depuis la page Marché.">` +
      `${mktBusy ? 'relevé…' : 'rafraîchir'}</button>` +
      // Le dernier événement notifié, tant qu'il est encore d'actualité : une
      // alerte « fin dans 4:14 » vieille d'une heure ne renseigne plus personne.
      (state.bidNote && Date.now() - state.bidNoteAt < 600000
        ? `<div class="note">${esc(state.bidNote)}</div>` : ''));
  }

  /*
   * Relevé à la demande. Les ventes passent par l'API et marchent de partout ;
   * les enchères ne se lisent que dans leur onglet du Marché — c'est un geste
   * explicite, donc on s'autorise ici le changement d'onglet que le guetteur
   * s'interdit tant que tu regardes.
   */
  let mktBusy = false;

  async function refreshMarket() {
    if (mktBusy) return;
    mktBusy = true;
    renderMarket();
    try {
      await scanSales();
      await syncJournal();
      if (onMarket() && !filtering()) {
        // Le compteur d'essais sert à ne pas te harceler tout seul ; un clic
        // sur « rafraîchir » est justement une demande explicite.
        tabTries = 0;
        /*
         * S'il manque des ventes à l'appel du serveur, elles sont trop
         * anciennes pour le balayage : seul l'onglet du site les liste encore.
         * On va donc les y chercher en priorité, sinon on relève les enchères.
         */
        const manque = state.slots.at &&
          state.slots.used > (state.sales.list || []).length;
        showTab(manque ? 'ventes' : 'ench');
        // React attache ses gestionnaires après coup : on laisse la liste venir.
        await delay(900);
        const ouvert = activeTab();
        if (ouvert === 'ench') scanBids();
        else if (ouvert === 'ventes') scanSalesTab();
      }
    } catch (_) {
      /* le relevé suivant rattrapera */
    } finally {
      mktBusy = false;
      render();
    }
  }

  /*
   * Ouvrir l'onglet doit suffire à le rendre juste : une liste vieille d'une
   * heure affichée sans un geste de plus est ce qui donnait au Marché son air
   * d'inachevé. On ne relève que si le relevé est périmé.
   */
  function freshenMarket() {
    if (!prefs.watchBids || mktBusy) return;
    if (Date.now() - state.sales.at < 60000) return;
    refreshMarket();
  }

  /*
   * Séparer en onglets cache ce qu'on ne regarde pas : une pastille signale
   * donc sur « Marché » les deux seules choses qui appellent une action — une
   * enchère perdue, ou une relance refusée.
   */
  function renderBadge() {
    const perdues = (state.bids.list || []).filter((b) => b.status === 'surencheri').length;
    const refus = (state.relistLog || []).some(
      (e) => e.issue === 'refus' && Date.now() - e.at < 3600000
    );
    ui.badge.hidden = !(perdues || refus);
    ui.badge.title = perdues
      ? `${perdues} enchère${perdues > 1 ? 's' : ''} surenchérie${perdues > 1 ? 's' : ''}`
      : 'Une relance a été refusée';
  }

  function renderRelist() {
    // Le volet est masqué par `renderMarket` : inutile de peindre ce qu'on ne
    // regarde pas, et le battement à la seconde passe alors sur trois tests.
    if (prefs.mktSub !== 'rel' || !ui.relist || ui.relist.hidden) return;
    const log = state.relistLog || [];
    const suivies = Object.entries(state.watch || {});

    /*
     * L'état d'une carte se lit sur le relevé des ventes. À une minute de
     * péremption, le bouton « Suivre mes N ventes » apparaissait et disparaissait
     * sans cesse et les états retombaient tous sur « à replacer » ; à deux
     * minutes il tient, et l'âge du relevé est désormais affiché juste au-dessus.
     */
    const frais = Date.now() - state.sales.at < 120000;
    const ventes = frais ? (state.sales.list || []).filter((v) => v.card && v.price) : [];
    const enVente = new Map(ventes.map((v) => [v.card, v]));
    const aInscrire = ventes.filter((v) => !state.watch[v.card]).length;

    const lignes = suivies.map(([card, w]) => {
      const vente = enVente.get(card);
      // Une carte bloquée par la garde « une annonce à la fois » est bien en
      // vente, même si le relevé ne l'a pas encore vue : l'annoncer « à
      // replacer » laisserait croire à une panne.
      const enLigne = !!vente || dejaEnLigne(card, enVente);
      const etat = w.paused ? 'en pause' : enLigne ? 'en vente' : frais ? 'à replacer' : 'état inconnu';
      const cls = w.paused ? 'pause' : enLigne ? 'ok' : 'wait';
      /*
       * Une carte en vente a une échéance : c'est elle qui dit quand la relance
       * reprendra la main. Le nombre d'échecs, lui, ne mérite pas sa colonne —
       * la mise en pause survient exactement au seuil, il affichait donc « 20 »
       * pour toutes les cartes en pause, au détriment du titre.
       */
      const info = vente ? fmtLeft(leftNow(vente)) : '';
      const infobulle = `${w.title} — annonce de ${w.minutes || 10} min à ${w.price} wb` +
        (w.paused ? ` · en pause après ${w.fails} tentatives` : '');
      return `<li class="${cls}" title="${esc(infobulle)}">
        <span class="dot"></span>
        <span class="t">${esc(w.title)}</span>
        <span class="p">${w.price} wb</span>
        <span class="st">${etat}</span>
        <span class="w">${info}</span>
        ${w.paused
          ? `<button class="x" data-retry="${esc(card)}" title="Reprendre le suivi : remet le compteur d'échecs à zéro">↻</button>`
          : ''}
        <button class="x" data-unwatch="${esc(card)}" title="Ne plus suivre cette carte">✕</button>
      </li>`;
    });

    const actions =
      (aInscrire ? `<button data-watch-all>+ Suivre mes ${aInscrire} vente${aInscrire > 1 ? 's' : ''}</button>` : '') +
      (suivies.length ? `<button data-unwatch-all>Tout arrêter</button>` : '');

    /*
     * Une ligne de journal montrait un titre, un prix et un âge — jamais ce qui
     * était arrivé à la carte, et le motif d'un refus restait dans l'infobulle,
     * là où personne ne va le chercher. Les deux sont maintenant écrits.
     */
    const VERBES = { ok: 'remise en vente', refus: 'refusée', stop: 'retirée' };
    const journal = log.slice(0, 6).map((e) => {
      const age = Date.now() - e.at;
      const verbe = e.issue === 'ok' && e.motif === 'vendue' ? 'vendue'
        : e.issue === 'stop' && e.motif ? e.motif        // « retirée », « étiquetée »
        : (VERBES[e.issue] || e.issue);
      return `<li class="${e.issue}">
        <span class="dot"></span>
        <span class="t">${esc(e.title)}</span>
        <span class="act">${verbe}</span>
        ${e.prix != null ? `<span class="p">${e.prix} wb</span>` : ''}
        <span class="w">${age < 60000 ? "à l'instant" : fmtSpan(age)}</span>
        ${e.issue === 'refus' && e.motif ? `<span class="why">${esc(e.motif)}</span>` : ''}
      </li>`;
    });

    /*
     * Une carte « à replacer » qui ne bouge pas doit s'expliquer, et les trois
     * raisons possibles sont différentes : l'option est décochée et rien ne
     * tournera jamais, les emplacements sont pleins, ou c'est simplement le
     * tour de la suivante qui n'est pas venu.
     */
    const aPlacer = suivies.filter(([c, w]) => !dejaEnLigne(c, enVente) && !w.paused).length;
    const dans = state.nextRelistAt - Date.now();
    const complet = state.slots.at && state.slots.used >= state.slots.max;
    // Une carte en pause ne repart jamais seule : « 10 suivies » laissait croire
    // que dix cartes attendaient leur tour alors que dix étaient à l'arrêt.
    const pausees = suivies.filter(([, w]) => w.paused).length;
    let entete = suivies.length ? `${suivies.length} suivie${suivies.length > 1 ? 's' : ''}` : '';
    let entCls = 'wait';
    if (pausees) { entete += ` · ${pausees} en pause`; entCls = 'wait hot'; }
    if (aPlacer && !prefs.relistUnsold) { entete = 'option décochée'; entCls = 'wait hot'; }
    else if (aPlacer && complet) { entete = 'emplacements pleins'; entCls = 'wait hot'; }
    // Une attente chiffrée reprend le pas sur l'alerte : elle est plus utile.
    else if (aPlacer && dans > 0) { entete = `prochaine dans ${fmtClock(dans)}`; entCls = 'wait'; }

    // Le titre de la section ferait doublon avec l'onglet : seul l'état reste.
    paint(ui.relist,
      `<div class="rh"><b>Cartes suivies</b>` +
      (entete ? `<span class="${entCls}">${entete}</span>` : '') +
      `</div>` +
      (actions ? `<div class="ra">${actions}</div>` : '') +
      (lignes.length
        ? `<ul class="suivi">${lignes.join('')}</ul>`
        : `<div class="empty">Aucune carte suivie. ${prefs.relistUnsold
            ? `Une vente qui se termine sans acheteur s'inscrit toute seule.`
            : `Coche « Relances auto » en bas pour que les ventes sans acheteur s'inscrivent seules.`}</div>`) +
      (journal.length ? `<div class="rh sub">Journal</div><ul class="jour">${journal.join('')}</ul>` : ''));
  }

  /** Compte à rebours recalculé depuis l'échéance absolue, jamais décrémenté. */
  function renderStatus() {
    syncReserve();

    const waiting = state.running && state.waitUntil;
    const left = waiting ? state.waitUntil - Date.now() : 0;
    const span = waiting ? Math.max(1, state.waitUntil - state.waitFrom) : 1;
    const held = state.reserve == null ? 0 : state.reserve;

    // La réserve ne s'affiche que si elle a de quoi le justifier : en régime
    // normal le script la vide aussitôt, et un « 0/10 » permanent n'apprend rien.
    const stock = held > 0 ? `<span class="stock">${held} en réserve</span>` : '';

    paint(ui.status, waiting
      ? `<span>${esc(state.waitLabel)}</span>${stock}<b>${left > 0 ? fmtClock(left) : '0:00'}</b>`
      : `<span>${esc(state.message)}</span>${stock}`);

    ui.mini.textContent = waiting && left > 0 ? fmtClock(left) : '';
    ui.bar.classList.toggle('idle', !waiting);
    if (waiting) {
      const progress = Math.min(1, Math.max(0, 1 - left / span));
      ui.barFill.style.width = `${(progress * 100).toFixed(1)}%`;
    }
  }

  /**
   * Ruban des derniers tirages : une encoche par carte, la plus récente à
   * droite. Les communes sont sourdes et basses, les raretés hautes et vives —
   * la trouvaille se repère sans lire un chiffre.
   */
  function renderRibbon() {
    const recent = state.history.slice(0, RIBBON_LENGTH).reverse();
    if (!recent.length) {
      paint(ui.ribbon, '');
      return;
    }
    paint(ui.ribbon, recent
      .map((c) => {
        const r = rank(c.rarity);
        const size = r >= 4 ? 'hi' : r === 3 ? 'mid' : '';
        return `<i class="tick ${size}" style="--c:${RARITY_COLOR[c.rarity] || '#626B7A'}"></i>`;
      })
      .join(''));
  }

  // ------------------------------------------------------------------- revente

  /*
   * Page « Revente » : la cote de chaque carte possédée, pour décider quoi
   * vendre. Deux principes.
   *
   * D'abord la fiabilité : une moyenne calculée sur une ou deux ventes ne veut
   * rien dire, d'où un seuil minimal de transactions, réglable.
   *
   * Ensuite la prudence : mettre une carte aux enchères est irréversible, donc
   * ce tableau ne vend RIEN. Le bouton amène au formulaire du site, sur la
   * fiche de la carte, avec un prix suggéré. C'est toi qui choisis la durée et
   * qui lances l'enchère.
   */
  /*
   * Thèmes de collection. Dans les basses raretés la notoriété ne fait pas le
   * prix — elle ne fait que la probabilité de trouver preneur. Ce sont des
   * collectionneurs thématiques qui achètent, d'où ce classement : jeu vidéo
   * et espèces vivantes s'écoulent une fois sur trois, le cinéma une sur
   * trente. Le thème vaut donc autant que le prix pour décider quoi vendre.
   */
  const THEMES = [
    ['jeu vidéo', /jeu vidéo|compilation de jeux/i],
    ['manga / animé', /manga|anim[ée]|série télévisée d.animation/i],
    ['espèce vivante', /espèce de|genre de|famille de|plante|oiseau|insecte|poisson/i],
    ['dinosaure / fossile', /dinosaure|fossile|genre éteint|espèce éteinte/i],
    ['religion', /pape|dieu|saint|église|catholique|évêque|théolog/i],
    ['musique', /rappeur|chanteur|groupe de musique|album|musicien|chanson/i],
    ['art / peinture', /peinture|tableau|peintre|sculpture|musée/i],
    ['football', /footballeur|football|club de foot/i],
    ['sport', /cycliste|tour de france|athlète|joueur de|boxeur|nageur/i],
    ['cinéma / série', /film |réalisateur|acteur|actrice|série télévisée/i],
    ['science', /mathémat|physique|astrono|chimie|nombre|théorème/i],
    ['géographie', /commune |village|rivière|montagne|département|ville/i],
  ];

  const themeOf = (cat) => {
    for (const [nom, re] of THEMES) if (re.test(cat || '')) return nom;
    return '';
  };

  const SELL_KEY = 'wm-auto-cote';
  /*
   * Journal des ventes. Les notifications du serveur font foi pour l'issue et
   * le prix obtenu ; le prix DEMANDÉ, lui, n'existe nulle part côté serveur, on
   * le note donc au moment de préparer la vente. C'est la confrontation des
   * deux qui rend le journal utile : « Andragogie demandée 2 000, invendue »
   * en apprend plus qu'une cote calculée sur deux transactions.
   */
  const JOURNAL_MAX = 100;

  /*
   * Remise en vente automatique. C'est la seule action sortante que le script
   * effectue seul, et elle reste encadrée : uniquement les cartes que tu as
   * explicitement inscrites, au prix que tu as fixé, et l'inscription s'arrête
   * d'elle-même dès que la carte est vendue. Rien ne s'inscrit tout seul.
   */

  /*
   * Les conditions à rejouer viennent de l'annonce terminée elle-même :
   * /api/marketplace/<enchère> renvoie prix de départ et dates même une fois
   * réglée. On dépendait avant d'un cache en mémoire rempli par le balayage des
   * ventes EN COURS — donc vidé à chaque rechargement, et jamais réalimenté une
   * fois la dernière vente close. La relance ne pouvait alors plus rien rejouer.
   */
  async function listingTerms(cardId, auctionId) {
    if (auctionId) {
      try {
        const res = await api(`/api/marketplace/${auctionId}`);
        const a = res.data && res.data.auction;
        if (a && a.base_amount != null && a.created_at && a.end_at) {
          return {
            price: Number(a.listing_base_amount ?? a.base_amount),
            minutes: Math.max(10, Math.round((Date.parse(a.end_at) - Date.parse(a.created_at)) / 60000)),
          };
        }
      } catch (_) {
        /* réseau : on tentera le cache, sinon on réessaiera au tour suivant */
      }
    }
    const r = state.lastListing[cardId];
    return r && r.price ? { price: r.price, minutes: r.minutes } : null;
  }

  /*
   * POST /api/marketplace attend, dans son champ « card_id », l'identifiant de
   * TON EXEMPLAIRE en collection — pas celui de la carte. Les deux diffèrent, et
   * l'enchère ne porte que le second : poster celui-là fait répondre 409
   * « Vous ne possédez pas cette carte ». C'est ce qui empêchait toute remise
   * en vente. On indexe donc la collection pour faire la correspondance.
   */
  const OWNED_TTL = 300000;  // fraîcheur normale de l'index
  const OWNED_MIN = 30000;   // deux reconstructions forcées ne se suivent pas de plus près
  /*
   * Les étiquettes se relèvent dans le même balayage que l'index : elles sont
   * portées par l'exemplaire en collection, à côté de son identifiant. Aucune
   * requête de plus, et la protection est aussi fraîche que l'index lui-même.
   */
  const owned = { map: new Map(), tagged: new Set(), at: 0, tried: 0 };

  /*
   * Une carte étiquetée ne se vend pas. L'étiquette est posée sur l'exemplaire,
   * mais la protection vaut pour la CARTE : la relance choisit un exemplaire
   * quelconque parmi ceux que tu possèdes, une protection par exemplaire ne
   * protégerait donc rien. Étiqueter une carte la met hors de portée du script.
   */
  const isTagged = (card) => owned.tagged.has(card);

  async function ownedIndex(force) {
    const age = owned.at ? Date.now() - owned.at : Infinity;
    if (age < (force ? OWNED_MIN : OWNED_TTL)) return owned.map;
    /*
     * Un balayage incomplet ne rafraîchit pas l'index — c'est voulu — mais il a
     * bien coûté ses quatre-vingts requêtes. Sans cette seconde garde, le tour
     * suivant le refaisait aussitôt, et une seule page en échec suffisait à
     * relancer la collection entière à chaque passage.
     */
    if (Date.now() - owned.tried < OWNED_MIN) return owned.map;
    owned.tried = Date.now();

    const m = new Map();
    const etiquetees = new Set();
    let complet = true;
    let fini = false;
    for (let base = 0; base < 80 && !fini; base += 8) {
      const lot = await Promise.all(
        Array.from({ length: 8 }, (_, k) =>
          fetch(`/api/my-collection?page=${base + k}`, { credentials: 'same-origin' })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
        )
      );
      for (const d of lot) {
        /*
         * Une requête ratée renvoyait null, qu'on lisait comme une page vide :
         * le balayage s'arrêtait là et l'index était tronqué en silence. Les
         * cartes des pages manquantes passaient alors pour « plus possédées ».
         */
        if (d === null) { complet = false; continue; }
        const col = d.collection || [];
        for (const c of col) {
          if (!c.card_id) continue;
          if (c.id) m.set(c.card_id, c.id);
          if ((c.tags || []).length) etiquetees.add(c.card_id);
        }
        if (col.length < 50) fini = true;
      }
    }
    if (complet && m.size) {
      owned.map = m;
      owned.tagged = etiquetees;
      owned.at = Date.now();
      return m;
    }
    /*
     * Balayage incomplet : on ne le mémorise pas, et on complète avec l'ancien.
     * Les étiquettes, elles, s'ajoutent sans jamais se retirer sur un relevé
     * partiel — une page manquante ne doit pas déprotéger une carte.
     */
    for (const c of etiquetees) owned.tagged.add(c);
    return new Map([...owned.map, ...m]);
  }

  const RELIST_LOG_MAX = 40;

  /* Une relance est une action sortante : son issue doit se lire d'un coup
   * d'œil, dans le corps du panneau. Elle n'était signalée que par une ligne
   * fugace enfouie dans les réglages — invisible en pratique. */
  function logRelist(title, issue, prix, motif) {
    state.relistLog.unshift({ title, issue, prix: prix ?? null, motif: motif || '', at: Date.now() });
    state.relistLog = state.relistLog.slice(0, RELIST_LOG_MAX);
    saveStore({ relistLog: state.relistLog });
  }

  /*
   * Liste de surveillance, et non file d'événements. Une carte inscrite y reste
   * jusqu'à ce qu'elle se vende ou que tu la retires ; à chaque tour on compare
   * ce qui devrait être en vente à ce qui l'est, et on replace ce qui manque.
   *
   * L'ancien modèle ne réagissait qu'à la notification d'invendu, lue une seule
   * fois : onglet fermé, coupure réseau ou verdict erroné, et la carte était
   * perdue pour toujours. Ici rien ne dépend d'avoir vu passer l'événement — un
   * tour manqué est rattrapé au suivant.
   */
  const WATCH_FAILS = 20;   // échecs consécutifs avant mise en pause d'une carte
  const SLOTS_FRESH_MS = 20000;  // durée de validité du compte d'emplacements
  const SETTLE_MS = 60000;       // délai laissé au serveur pour trancher une enchère close
  const IDLE_RELIST_MS = 15000;  // repos quand un tour n'a rien à replacer

  /*
   * Une carte, une annonce à la fois. Le relevé des ventes ne suffisait pas à
   * le garantir : quand une annonce sortait de sa vue — le balayage récent ne
   * remontait que six minutes — la carte passait pour absente et repartait en
   * vente alors qu'elle y était déjà. Sur une carte possédée en double, la
   * seconde était mise en vente à son tour, et les deux exemplaires partaient.
   * Constaté sur « Bande de Gaza » : deux annonces simultanées, même carte,
   * même prix.
   *
   * Trois garanties, de la plus sûre à la plus prudente :
   *   1. le relevé des ventes la montre en ligne ;
   *   2. l'annonce que le script a publiée est encore suivie comme active ;
   *   3. elle a été publiée depuis moins longtemps que sa propre durée — une
   *      annonce de dix minutes ne peut pas réclamer une relance au bout de
   *      trois, quoi que dise un relevé incomplet.
   */
  function dejaEnLigne(card, enVente) {
    if (enVente.has(card)) return true;
    const w = state.watch[card];
    if (!w) return false;
    if (w.auction && state.myAuctions[w.auction]) return true;
    /*
     * Et on ne replace rien tant que l'issue de l'annonce précédente n'est pas
     * établie. À l'instant où l'enchère se clôt, la carte quitte les ventes
     * sans qu'on sache encore si elle a trouvé preneur : replacer là revient à
     * remettre un second exemplaire en vente alors que le premier vient de se
     * vendre. Le serveur met quelques dizaines de secondes à trancher.
     */
    if (w.seenListedAt && Date.now() - w.seenListedAt < SETTLE_MS) return true;
    const finPrevue = w.endsAt || (w.listedAt && w.listedAt + (w.minutes || 10) * 60000);
    if (finPrevue && Date.now() < finPrevue + SETTLE_MS) return true;
    return false;
  }

  /*
   * L'identifiant de l'annonce qu'on vient de publier. Le `POST` ne le renvoie
   * pas — vérifié, sa réponse ne porte aucun identifiant — mais l'annonce est
   * par construction la plus récente du marché : la première page de
   * `sort=recent` la contient forcément. Une requête, et la garantie « une
   * annonce à la fois » ne dépend plus d'une horloge.
   */
  async function bindAuction(res, card) {
    const direct = res.data && (res.data.id || (res.data.auction && res.data.auction.id));
    if (direct) { trackAuction(direct, 'sale'); return { id: direct, end: null }; }
    const moi = await fetchMyId();
    if (!moi) return { id: null, end: null };
    try {
      const d = await api('/api/marketplace?page=0&limit=50&sort=recent');
      const lot = (d.data && d.data.auctions) || [];
      const nee = lot.find(
        (x) => x.seller_id === moi && x.card_id === card && x.status === 'active'
      );
      if (nee && nee.id) {
        trackAuction(nee.id, 'sale');
        rememberListing(nee);
        return { id: nee.id, end: nee.end_at ? Date.parse(nee.end_at) : null };
      }
    } catch (_) {
      /* le garde-fou retombe sur la durée de l'annonce, ce qui suffit */
    }
    return { id: null, end: null };
  }

  /** Prochain créneau de remise en vente, tiré au hasard dans l'intervalle. */
  function spaceRelist() {
    const [bas, haut] = CFG.relistGapMs;
    state.nextRelistAt = Date.now() + bas + Math.random() * (haut - bas);
    saveStore({ nextRelistAt: state.nextRelistAt });
  }

  function enrolWatch(card, title, price, minutes) {
    if (!card || !price) return false;
    /*
     * Une carte étiquetée ne s'inscrit pas. C'est la première des deux barrières
     * — la seconde est au moment de publier — parce qu'une carte peut être
     * étiquetée après son inscription, et qu'on ne veut pas non plus la voir
     * traîner dans la liste de surveillance en donnant à croire qu'elle partira.
     */
    if (isTagged(card)) {
      if (state.watch[card]) dropWatch(card, 'étiquetée');
      return false;
    }
    const dejaLa = state.watch[card];
    state.watch[card] = {
      title: title || (dejaLa && dejaLa.title) || '',
      price,
      minutes: minutes || 10,
      since: dejaLa ? dejaLa.since : Date.now(),
      fails: 0,
      paused: false,
      /*
       * On garde la trace de la dernière annonce publiée. La réinscription
       * l'effaçait, et avec elle la garantie « une annonce à la fois » : une
       * carte réinscrite pendant que son annonce courait repartait en vente.
       * Les deux repères expirent d'eux-mêmes quand l'enchère se termine.
       */
      auction: dejaLa ? dejaLa.auction || null : null,
      listedAt: dejaLa ? dejaLa.listedAt || 0 : 0,
      endsAt: dejaLa ? dejaLa.endsAt || 0 : 0,
      seenListedAt: dejaLa ? dejaLa.seenListedAt || 0 : 0,
    };
    saveStore({ watch: state.watch });
    return !dejaLa;
  }

  function dropWatch(card, motif) {
    const e = state.watch[card];
    if (!e) return;
    delete state.watch[card];
    saveStore({ watch: state.watch });
    if (motif) logRelist(e.title, motif === 'vendue' ? 'ok' : 'stop', e.price, motif);
  }

  async function reconcileWatch() {
    const ids = Object.keys(state.watch);
    if (!prefs.relistUnsold || !ids.length || reconcileWatch.busy) return;
    reconcileWatch.busy = true;
    try {
      /*
       * Le serveur fait foi sur les emplacements occupés — mais son compte ne
       * change pas d'une seconde à l'autre. Ce tour-ci passe toutes les
       * secondes ; sans cette garde il appelait l'API à la même cadence, soit
       * une soixantaine de requêtes par minute pour un chiffre inchangé.
       */
      if (Date.now() - state.slots.at > SLOTS_FRESH_MS) {
        try {
          const d = await api('/api/marketplace/mine');
          if (d.data && Number.isFinite(d.data.sellingCount)) {
            state.slots = {
              used: d.data.sellingCount,
              max: d.data.maxConcurrentAuctions || 10,
              at: Date.now(),
            };
            saveStore({ slots: state.slots });
          }
        } catch (_) {
          /* on se fie au dernier relevé */
        }
      }
      let libres = Math.max(0, state.slots.max - state.slots.used);

      /*
       * Sans relevé frais des ventes, on ne sait pas ce qui est déjà en ligne :
       * on croirait tout manquant et on compterait un échec par carte, jusqu'à
       * mettre en pause des cartes parfaitement en vente. Mieux vaut ne rien
       * faire ce tour-ci — le suivant rattrapera.
       */
      if (Date.now() - state.sales.at > 60000) return;
      const enVente = new Set((state.sales.list || []).map((v) => v.card).filter(Boolean));

      for (const c of ids) {
        if (!enVente.has(c)) continue;
        // Une carte de retour en vente repart d'un compteur d'échecs vierge.
        if (state.watch[c].fails) state.watch[c].fails = 0;
        /*
         * On note qu'on vient de la voir en ligne. C'est ce repère qui empêche
         * de la replacer dans la minute qui suit la clôture : à cet instant elle
         * a quitté les ventes sans qu'on sache encore si elle a trouvé preneur.
         * Il vaut pour les annonces posées à la main comme pour les nôtres.
         */
        state.watch[c].seenListedAt = Date.now();
      }

      const manquantes = ids.filter(
        (c) => !dejaEnLigne(c, enVente) && !state.watch[c].paused
      );
      /*
       * Rien à replacer : on repousse le créneau, sinon ce tour repasserait à
       * la seconde suivante — et rappellerait l'API — jusqu'à ce qu'une vente
       * se termine. Le report reste bien sous l'écart minimal entre annonces.
       */
      if (!manquantes.length) {
        state.nextRelistAt = Date.now() + IDLE_RELIST_MS;
        return;
      }

      // On tient le rythme même quand tout est prêt : une annonce à la fois.
      if (Date.now() < state.nextRelistAt) { render(); return; }

      let index = libres > 0 ? await ownedIndex(false) : owned.map;
      let rebati = false;
      let bouge = false;

      for (const card of manquantes) {
        if (libres <= 0) break;               // les autres attendront un emplacement
        const w = state.watch[card];
        /*
         * Dernière barrière avant de publier, et la seule qui compte vraiment :
         * l'index vient d'être relu, ses étiquettes sont donc à jour. Une carte
         * étiquetée entre-temps sort du suivi ici, et l'écart est visible au
         * journal plutôt que silencieux.
         */
        if (isTagged(card)) {
          dropWatch(card, 'étiquetée');
          bouge = true;
          continue;
        }
        let copie = index.get(card);
        if (!copie && !rebati) {
          rebati = true;                      // une seule reconstruction par passage
          index = await ownedIndex(true);
          copie = index.get(card);
        }
        if (!copie) {
          /*
           * Le serveur rend la carte quelques secondes après avoir clos
           * l'enchère : absente ne veut pas dire perdue. On la garde inscrite
           * et on retentera — c'est tout l'intérêt de réconcilier.
           */
          w.fails = (w.fails || 0) + 1;
          if (w.fails >= WATCH_FAILS) {
            w.paused = true;
            logRelist(w.title, 'refus', w.price, 'introuvable en collection — suivi en pause');
          }
          bouge = true;
          continue;
        }
        const res = await api('/api/marketplace', 'POST', {
          card_id: copie,
          base_amount: w.price,
          duration_minutes: w.minutes,
        });
        if (res.status === 200 || res.status === 201) {
          libres -= 1;
          state.slots.used += 1;
          w.fails = 0;
          state.asks[w.title] = { prix: w.price, at: Date.now() };
          /*
           * On note l'instant de publication : c'est lui qui interdit une
           * seconde annonce de la même carte tant que celle-ci court. Puis on
           * va chercher son identifiant, pour la suivre et rendre la garantie
           * indépendante de l'horloge.
           */
          w.listedAt = Date.now();
          const nee = await bindAuction(res, card);
          w.auction = nee.id;
          w.endsAt = nee.end || w.listedAt + (w.minutes || 10) * 60000;
          logRelist(w.title, 'ok', w.price, w.minutes + ' min');
        } else {
          w.fails = (w.fails || 0) + 1;
          if (w.fails >= WATCH_FAILS) {
            w.paused = true;
            logRelist(w.title, 'refus', w.price,
              String((res.data && res.data.error) || res.status) + ' — suivi en pause');
          }
        }
        bouge = true;
        /*
         * Une annonce publiée, on s'arrête là et on reprogramme. Les cartes
         * restantes attendront leur tour : c'est ce qui désynchronise aussi les
         * fins d'enchère, et empêche le troupeau de se reformer.
         */
        spaceRelist();
        break;
      }
      if (bouge) {
        saveStore({ watch: state.watch, asks: state.asks });
        render();
      }
    } finally {
      reconcileWatch.busy = false;
    }
  }

  /** Inscrire d'un geste toutes les ventes en cours. */
  function watchCurrentSales() {
    let n = 0;
    for (const v of state.sales.list || []) {
      if (v.card && v.price && enrolWatch(v.card, v.title, v.price, v.minutes)) n += 1;
    }
    render();
    return n;
  }

  async function syncJournal() {
    let notifs;
    try {
      const d = await api('/api/notifications');
      notifs = (d.data && d.data.notifications) || [];
    } catch (_) {
      return;
    }
    const connus = new Set(state.journal.map((e) => e.id));
    let ajout = 0;

    for (const n of notifs) {
      if (n.type !== 'marketplace_auction_sold' && n.type !== 'marketplace_auction_unsold') continue;
      if (connus.has(n.id)) continue;
      const titre = n.data?.card_title || '';
      const demande = state.asks[titre];
      state.journal.unshift({
        id: n.id,
        title: titre,
        vendue: n.type === 'marketplace_auction_sold',
        final: n.data?.final_price ?? null,
        ask: demande ? demande.prix : null,
        at: Date.parse(n.created_at) || Date.now(),
      });
      delete state.asks[titre];
      ajout += 1;

      const id = n.data?.card_id;
      if (!id) continue;
      if (n.type === 'marketplace_auction_sold') {
        delete state.lastListing[id];
        dropWatch(id, 'vendue');              // objectif atteint : on cesse de la suivre
      } else if (prefs.relistUnsold) {
        // Invendue : on l'inscrit, la réconciliation se charge du reste.
        const t = await listingTerms(id, n.data?.auction_id || null);
        if (t) enrolWatch(id, titre, t.price, t.minutes);
      }
    }
    if (!ajout) return;
    state.journal.sort((a, b) => b.at - a.at);
    state.journal = state.journal.slice(0, JOURNAL_MAX);
    saveStore({ journal: state.journal, asks: state.asks });
    if (sell.open) renderSell();
  }

  const THIN_SALES = 5;  // en dessous, la cote repose sur trop peu de transactions
  const SELL_POOL = 6;   // requêtes simultanées pour la cotation
  const SELL_MAX_PAGES = 1000;  // garde-fou : la lecture s'arrête d'elle-même à la fin

  /*
   * Concurrence : combien d'exemplaires d'une carte sont mis en vente en ce
   * moment par d'autres joueurs. Le marché est dispersé — 14 500 enchères pour
   * 13 600 cartes distinctes — donc une carte sans concurrence peut être
   * proposée haut et attendre son acheteur, ce qui est tout l'intérêt.
   */
  const MARKET_TTL = 600000;

  async function fetchCompetition() {
    const counts = new Map();
    for (let base = 0; base < 400; base += 8) {
      const lot = await Promise.all(
        Array.from({ length: 8 }, (_, k) =>
          fetch(`/api/marketplace?page=${base + k}&limit=50`, { credentials: 'same-origin' })
            .then((r) => r.json())
            .catch(() => null)
        )
      );
      let fini = false;
      for (const d of lot) {
        const a = (d && d.auctions) || [];
        if (!a.length) { fini = true; continue; }
        for (const x of a) counts.set(x.card_id, (counts.get(x.card_id) || 0) + 1);
        if (a.length < 50) fini = true;
      }
      if (fini) break;
    }
    return counts;
  }

  const sell = { open: false, scanning: false, done: 0, total: 0, read: 0, rows: [], at: 0, tags: [],
                 checked: new Set(), themes: {}, comp: new Map(), compAt: 0,
                 // Pourquoi le tableau est vide — ou incomplet — quand il l'est.
                 note: '', refus: 0, tronque: false, freinages: 0,
                 // Refus rencontrés sur l'historique des ventes, carte par carte.
                 refusVentes: 0, refusVentesN: 0 };

  function loadCote() {
    try {
      const d = JSON.parse(localStorage.getItem(SELL_KEY) || 'null');
      if (d && Array.isArray(d.rows)) {
        sell.rows = d.rows;
        sell.at = d.at || 0;
        sell.tags = d.tags || [];
        sell.themes = d.themes || {};
        for (const r of sell.rows) if (r.id) sell.checked.add(r.id);
      }
    } catch (_) {
      /* cache illisible : on rescannera */
    }
  }

  function saveCote() {
    try {
      localStorage.setItem(
        SELL_KEY,
        JSON.stringify({ rows: sell.rows, at: sell.at, tags: sell.tags, themes: sell.themes })
      );
    } catch (_) {
      /* trop volumineux ou stockage plein : le scan reste en mémoire */
    }
  }

  /**
   * Toute la collection, entrées BRUTES de l'API, étiquettes comprises.
   * Pagination indexée à ZÉRO.
   *
   * La forme brute est celle que le site attend : c'est elle que le tri par
   * valeur lui rend, telle quelle, sans rien inventer.
   *
   * La lecture s'arrête à la première page incomplète. La borne fixe qui la
   * remplaçait — 200 pages — laissait la queue de la collection non cotée dès
   * qu'elle dépassait 10 000 cartes, ce qui est le cas depuis longtemps.
   *
   * Un refus du serveur est RETENU (`sell.refus`), pas avalé : une collection
   * qui revient vide et un serveur qui dit non produisent le même tableau vide,
   * et sans le statut la Revente reste sur « 0 » sans que personne puisse dire
   * lequel des deux on regarde.
   *
   * LA PANNE QUI A COÛTÉ LE PLUS CHER — une page ratée n'est PAS une fin de
   * collection. Le lecteur confondait les deux : toute page qui ne renvoyait
   * rien, y compris un 429, arrêtait la lecture. Or ce script ouvre des paquets
   * en même temps ; sur un compte où la boucle tourne, le serveur freine, la
   * toute première page part en 429 et la collection revient VIDE. La cotation
   * portait alors sur zéro carte, et l'ancienne cote — bonne — était remplacée
   * par un tableau vide et sauvée telle quelle. Le relevé « ne cotait rien »
   * sans qu'aucun message ne le dise, et recommencer n'y changeait rien tant
   * que la boucle tournait.
   *
   * Chaque page est donc retentée, avec un recul croissant, et seule une page
   * REÇUE et incomplète marque la fin. Si une page reste inaccessible, la
   * lecture s'arrête en le sachant (`sell.tronque`) plutôt qu'en prétendant
   * avoir tout lu.
   *
   * @param {(lues: number) => void} [onProgress] Appelé après chaque lot.
   */
  const SELL_TRIES = 4;
  const SELL_RETRY_MS = 1500;
  const REFUS_MAX = 25;  // refus d'affilée au-delà desquels le relevé renonce

  /** Le marché d'une carte, tel que ce compte a le droit de le voir. */
  async function probeSales(cardId) {
    try {
      const r = await fetch(`/api/marketplace/cards/${cardId}/sales`, { credentials: 'same-origin' });
      let data = null;
      try { data = await r.json(); } catch (_) { /* réponse non-JSON */ }
      return { status: r.status, data };
    } catch (_) {
      return { status: 0, data: null };
    }
  }

  /*
   * La moyenne, quand l'historique n'est pas donné. On ne devine pas le nom du
   * champ : on prend le premier nombre dont le nom parle de moyenne ou de prix,
   * et on le dit dans le panneau. Un site qui renomme sa colonne ne doit pas
   * nous rendre muets.
   */
  const AVG_KEY = /^(avg|average|mean|moy)|(_avg|_average|avg_price|average_price|moyenne)/i;

  function avgOf(d) {
    if (!d || typeof d !== 'object') return null;
    for (const [k, v] of Object.entries(d)) {
      if (Number.isFinite(v) && v > 0 && AVG_KEY.test(k)) return Math.round(v);
    }
    return null;
  }

  async function fetchCollectionPage(page) {
    for (let essai = 0; essai < SELL_TRIES; essai++) {
      try {
        const r = await fetch(`/api/my-collection?page=${page}`, { credentials: 'same-origin' });
        if (r.ok) return await r.json();
        sell.refus = r.status;
        if (r.status === 429) sell.freinages += 1;
        // 401/403 : insister ne servirait à rien, c'est la session qui manque.
        if (r.status !== 429 && r.status < 500) return null;
      } catch (_) {
        /* coupure réseau : on retente */
      }
      await delay(SELL_RETRY_MS * (essai + 1));
    }
    return null;
  }

  async function fetchCollectionRaw(onProgress) {
    const out = [];
    sell.refus = 0;
    sell.tronque = false;
    sell.freinages = 0;
    for (let base = 0; base < SELL_MAX_PAGES; base += SELL_POOL) {
      const avant = sell.freinages;
      const lot = await Promise.all(
        Array.from({ length: SELL_POOL }, (_, k) => fetchCollectionPage(base + k))
      );
      // Le serveur vient de freiner : six requêtes de plus dans la foulée le
      // feraient recommencer. On lui laisse le temps de reprendre son souffle.
      if (sell.freinages > avant) await delay(3000);
      let fini = false;
      let manque = false;
      for (const d of lot) {
        if (!d || !Array.isArray(d.collection)) {
          manque = true;  // page jamais reçue : elle ne dit rien de la suite
          continue;
        }
        if (!d.collection.length) {
          fini = true;
          continue;
        }
        out.push(...d.collection);
        if (d.collection.length < COLLECTION_PAGE) fini = true;
      }
      if (onProgress) onProgress(out.length);
      if (manque) {
        sell.tronque = true;
        break;
      }
      if (fini) break;
    }
    return out;
  }

  /** La même collection, réduite à ce dont la cote a besoin. */
  async function fetchCollection(onProgress) {
    const brut = await fetchCollectionRaw(onProgress);
    return brut.map((e) => ({
      id: e.card_id,
      t: e.card?.wikipedia_title || '',
      r: e.card?.rarity || '?',
      cat: e.card?.category || '',
      vues: e.card?.pageviews || 0,
      tags: (e.tags || []).map((x) => (typeof x === 'string' ? x : x.name)).filter(Boolean),
    }));
  }

  /*
   * Cotation par pool de promesses, sans minuteur : Chrome bride les timers
   * des onglets en arrière-plan, ce qui transformait des pauses de 80 ms en
   * secondes et rendait le scan interminable.
   */
  async function scanCote() {
    if (sell.scanning) return;
    sell.scanning = true;
    sell.done = 0;
    sell.read = 0;
    renderSell();

    /*
     * La cotation ne peut commencer qu'une fois la collection lue — N pages,
     * plus longtemps encore quand le serveur freine. Sans compteur pendant ce
     * temps-là, le panneau affichait « cotation 0 / … » figé : impossible de
     * distinguer une lecture en cours d'un relevé en panne. On montre donc les
     * cartes lues au fil de l'eau.
     */
    sell.note = '';
    sell.refusVentes = 0;
    sell.refusVentesN = 0;
    let cards = [];
    try {
      cards = await fetchCollection((n) => {
        sell.read = n;
        renderSell();
      });
    } catch (err) {
      cards = [];
      sell.note = `La lecture de ta collection s’est interrompue : ${(err && err.message) || 'erreur inconnue'}.`;
    }

    /*
     * Rien à coter : on s'arrête ici en DISANT pourquoi. Sans ça, le relevé
     * repartait dans une cotation à vide et la Revente affichait « 0 » — le
     * même écran qu'un serveur qui refuse, qu'une session expirée et qu'une
     * collection réellement vide.
     */
    if (!cards.length) {
      sell.scanning = false;
      if (!sell.note) {
        sell.note = sell.refus
          ? `Le serveur a refusé la lecture de ta collection (statut ${sell.refus}). `
            + 'Recharge la page ; si ça persiste, reconnecte-toi au site.'
          : 'Ta collection est revenue vide : rien à coter.';
      }
      renderSell();
      return;
    }

    sell.total = cards.length;

    /*
     * La BASE d'abord. La table `auctions` porte les mêmes ventes closes que
     * l'API du marché, mais elle se lit avec la session du joueur : ni
     * abonnement, ni N requêtes. C'est le seul chemin qui coter un
     * compte sans PRO, et sur un compte PRO il remplace des minutes de scan par
     * quelques secondes.
     */
    if (prefs.db) {
      const parCarte = await dbSalesBulk(cards.map((c) => c.id), (n) => {
        sell.done = n;
        renderSell();
      });
      if (parCarte) {
        const enBase = [];
        for (const c of cards) {
          const px = parCarte.get(c.id) || [];
          if (px.length) enBase.push(coteRow(c, px));
        }
        sell.done = cards.length;
        finirScan(cards, enBase);
        return;
      }
      // Base illisible (session, RLS, colonne renommée) : on retombe sur l'API.
    }

    /*
     * UNE requête avant les N. Le marché d'une carte n'a pas la même
     * forme pour tout le monde : un compte PRO reçoit l'historique complet, un
     * compte gratuit voit la moyenne sur la page de vente — donc une charge
     * réduite — et un compte freiné se fait refuser. Ces trois cas rendaient le
     * même tableau vide au bout de plusieurs minutes de requêtes inutiles.
     * La sonde tranche en une seconde, et dit ce qu'elle a trouvé.
     */
    const sonde = await probeSales(cards[0].id);
    if (sonde.status !== 200) {
      sell.scanning = false;
      sell.refusVentes = sonde.status;
      sell.refusVentesN = 1;
      sell.note = sonde.status === 403
        ? 'le marché des cartes est réservé aux comptes PRO (403) — coche « Lecture directe de '
          + 'la base » dans les réglages : la cote passe alors par la table des enchères, '
          + 'sans l’abonnement'
        : `le serveur a refusé le marché des cartes (statut ${sonde.status || 'réseau'})`;
      renderSell();
      return;
    }
    if (!Array.isArray(sonde.data && sonde.data.sales) && avgOf(sonde.data) == null) {
      sell.scanning = false;
      sell.note = 'le serveur répond sans historique ni moyenne (champs reçus : '
        + `${Object.keys(sonde.data || {}).join(', ') || 'aucun'})`;
      renderSell();
      return;
    }

    const queue = cards.slice();
    const rows = [];

    const worker = async () => {
      while (queue.length) {
        const c = queue.pop();
        try {
          const r = await fetch(`/api/marketplace/cards/${c.id}/sales`, { credentials: 'same-origin' });
          if (r.status === 429) {
            queue.push(c);
            await delay(3000);
            continue;
          }
          /*
           * Un refus ne ressemblait à rien : la réponse d'erreur se parse en
           * JSON, `sales` y est absent, et la carte sortait « sans historique »
           * exactement comme une carte jamais vendue. N refus de
           * suite donnaient donc un tableau vide et aucun message — le relevé
           * « chargeait les cartes puis ne rendait rien ». On retient le statut.
           */
          if (!r.ok) {
            sell.refusVentes = r.status;
            sell.refusVentesN += 1;
            sell.done += 1;
            /*
             * Un refus qui se répète n'est pas un accident de carte : c'est le
             * compte ou le serveur qui dit non. Continuer, c'était envoyer
             * N requêtes refusées — sans rien apprendre de plus, et
             * en s'enfonçant si c'est une garde anti-automatisation qui répond.
             * On s'arrête au bout de vingt-cinq, tant qu'aucune n'a abouti.
             */
            if (!rows.length && sell.refusVentesN >= REFUS_MAX) queue.length = 0;
            continue;
          }
          const d = await r.json();
          const px = (d.sales || []).map((s) => s.final_price).filter(Number.isFinite);
          if (px.length) {
            const sorted = px.slice().sort((a, b) => a - b);
            rows.push({
              id: c.id, t: c.t, r: c.r, tags: c.tags, n: px.length,
              theme: themeOf(c.cat), vues: c.vues || 0,
              moy: Math.round(px.reduce((a, b) => a + b, 0) / px.length),
              // La médiane résiste aux ventes aberrantes, fréquentes ici.
              med: sorted[Math.floor(sorted.length / 2)],
          q3: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))],
              // 3e quartile : on vend à la patience, pas au prix courant.
              q3: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))],
              min: sorted[0], max: sorted[sorted.length - 1],
            });
          } else {
            /*
             * Pas d'historique, mais une moyenne : c'est ce que le site donne
             * sans l'abonnement. Une seule valeur, donc médiane et 3e quartile
             * valent la moyenne — et `seule` le dit, pour que le tableau ne
             * fasse pas passer une estimation pour une statistique.
             */
            const seule = avgOf(d);
            if (seule != null) {
              rows.push({
                id: c.id, t: c.t, r: c.r, tags: c.tags, n: 0, seule: true,
                theme: themeOf(c.cat), vues: c.vues || 0,
                moy: seule, med: seule, q3: seule, min: seule, max: seule,
              });
            }
          }
        } catch (_) {
          /* carte ignorée */
        }
        sell.done += 1;
        if (sell.done % 50 === 0) renderSell();
      }
    };

    await Promise.all(Array.from({ length: SELL_POOL }, worker));
    finirScan(cards, rows);
  }

  /**
   * Clôture d'un relevé, quelle que soit la source — base ou API du site.
   * @param {object[]} cards Toute la collection lue.
   * @param {object[]} rows  Les cartes effectivement cotées.
   */
  function finirScan(cards, rows) {
    /*
     * Liquidité par thème : la part des cartes d'un thème qui ont déjà trouvé
     * preneur. Le dénominateur doit compter TOUTES les cartes possédées, pas
     * seulement les cotées — c'est pourquoi ce calcul vit dans le scan complet.
     */
    const vendues = new Set(rows.map((r) => r.id));
    const parTheme = Object.create(null);
    for (const c of cards) {
      const th = themeOf(c.cat);
      if (!th) continue;
      const o = (parTheme[th] = parTheme[th] || { cards: 0, sold: 0, prix: [] });
      o.cards += 1;
      if (vendues.has(c.id)) o.sold += 1;
    }
    for (const r of rows) if (r.theme && parTheme[r.theme]) parTheme[r.theme].prix.push(r.med);
    sell.themes = Object.fromEntries(
      Object.entries(parTheme).map(([th, o]) => {
        const p = o.prix.slice().sort((a, b) => a - b);
        return [th, { cards: o.cards, sold: o.sold, rate: o.cards ? o.sold / o.cards : 0,
                      med: p.length ? p[Math.floor(p.length / 2)] : 0 }];
      })
    );

    /*
     * Lecture tronquée : ce relevé ne connaît qu'une partie de la collection.
     * L'écraser avec, c'était perdre la cote des cartes qu'il n'a pas vues —
     * une panne réseau passagère effaçait des minutes de relevé. On fusionne
     * donc sur l'identifiant : le neuf remplace l'ancien, l'ancien survit là
     * où le neuf n'a rien à dire.
     */
    if (sell.tronque) {
      const parId = new Map(sell.rows.map((r) => [r.id, r]));
      for (const r of rows) parId.set(r.id, r);
      sell.rows = [...parId.values()];
      sell.note = `relevé partiel : lecture interrompue à ${cards.length} cartes`
        + `${sell.refus ? ` (statut ${sell.refus})` : ''}, les cotes déjà connues sont gardées`;
    } else if (!rows.length) {
      /*
       * Zéro ligne, trois causes possibles et un seul écran vide : le serveur
       * refuse l'historique des ventes, aucune carte n'a jamais été vendue, ou
       * la lecture a échoué. On tranche ici, compteurs en main — et on ne
       * remplace SURTOUT pas une cote qui existait par ce vide.
       */
      /*
       * Le 403 dit que l'API du marché est vendue avec l'abonnement — pas que
       * les prix sont hors de portée : la table des enchères, elle, se lit avec
       * la session du joueur. C'est donc vers ce réglage qu'il faut envoyer,
       * pas vers une page d'abonnement.
       */
      sell.note = sell.refusVentes === 403
        ? 'le marché des cartes est réservé aux comptes PRO (403) — coche « Lecture directe de '
          + 'la base » dans les réglages : la cote passe alors par la table des enchères, '
          + 'sans l’abonnement'
        : sell.refusVentesN
          ? `le serveur a refusé l’historique des ventes (statut ${sell.refusVentes}) — `
            + `relevé arrêté après ${sell.refusVentesN} cartes sur ${cards.length}`
          : `aucune de tes ${cards.length} cartes n’a d’historique de vente`;
      if (!sell.rows.length) sell.rows = rows;
    } else {
      sell.rows = rows;
      sell.note = '';
    }
    sell.checked = new Set(cards.map((c) => c.id));
    sell.at = Date.now();
    sell.tags = [...new Set(cards.flatMap((c) => c.tags))];
    sell.scanning = false;
    saveCote();
    renderSell();
  }

  /*
   * Aucune étiquette masquée par défaut : les étiquettes appartiennent au
   * compte, on ne peut en présumer aucune. La liste proposée est celle des
   * étiquettes réellement rencontrées dans la collection, et le choix est
   * mémorisé. Un compte qui n'en utilise pas ne voit pas le sélecteur.
   */
  const sellPrefs = { minSales: 2, hideTags: [], hideTagged: false, rarity: '', onlyFree: true };

  function sellRows() {
    return sell.rows
      // Une cote sans historique n'a pas de nombre de ventes : le seuil ne
      // s'applique pas à elle, sinon elle serait toujours masquée.
      .filter((x) => x.seule || x.n >= sellPrefs.minSales)
      // « Toutes » couvre aussi les étiquettes créées depuis le dernier scan,
      // ce qu'une sélection nom par nom ne ferait pas.
      .filter((x) => !(sellPrefs.hideTagged && x.tags.length))
      .filter((x) => sellPrefs.hideTagged || !x.tags.some((t) => sellPrefs.hideTags.includes(t)))
      .filter((x) => !sellPrefs.rarity || x.r === sellPrefs.rarity)
      // Sans concurrence d'abord, puis par prix visé.
      .filter((x) => !sellPrefs.onlyFree || !sell.comp.get(x.id))
      .sort((a, b) => (b.q3 || b.med) - (a.q3 || a.med));
  }

  /** Ouvre la fiche de la carte au formulaire d'enchère, prix pré-rempli. */
  async function prepareSale(title, price) {
    closeSell();
    const ok = await openCardDetail(title);
    if (!ok) return;
    const bouton = [...document.querySelectorAll('button')].find((b) => /enchères/i.test(b.textContent));
    if (!bouton) return;
    bouton.click();
    await delay(900);
    const champ = [...document.querySelectorAll('input[type="number"]')].pop();
    if (champ) setReactInput(champ, String(price));
    // Le serveur ne gardera pas trace du prix demandé : on le note ici.
    state.asks[title] = { prix: Number(price), at: Date.now() };
    saveStore({ asks: state.asks });
  }

  /** Recherche la carte dans la collection et ouvre sa fiche. */
  async function openCardDetail(title) {
    goFilteredTo('/collection', title);
    for (let i = 0; i < 40; i++) {
      await delay(250);
      const h = [...document.querySelectorAll('h3')].find((x) => x.textContent.trim() === title);
      const card = h && h.closest(CARD_ITEM);
      if (card) {
        (card.firstElementChild || card).click();
        await delay(900);
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------- interface de la revente

  let sellUI = null;


  /*
   * Cote au fil de l'eau. Refaire un relevé complet pour quelques cartes
   * neuves est absurde : il dure des minutes alors qu'une carte se cote en une
   * requête. Chaque paquet ouvert fait donc coter ses cinq cartes dans la
   * foulée — cinq appels de plus toutes les trois minutes, imperceptible — et
   * la liste reste à jour sans jamais rien relancer à la main.
   *
   * `checked` évite de redemander une carte sans historique de ventes : elle
   * n'entre pas dans `rows`, on la redemanderait donc indéfiniment.
   */
  /** Statistiques d'une série de prix — identiques quelle que soit la source. */
  function coteRow(c, px) {
    const sorted = px.slice().sort((a, b) => a - b);
    return {
      id: c.id, t: c.t || c.title, r: c.r || c.rarity, tags: c.tags || [], n: px.length,
      theme: themeOf(c.cat || ''), vues: c.vues || 0,
      moy: Math.round(px.reduce((a, b) => a + b, 0) / px.length),
      med: sorted[Math.floor(sorted.length / 2)],
      q3: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))],
      min: sorted[0], max: sorted[sorted.length - 1],
    };
  }

  /*
   * Les ventes closes d'un lot de cartes, en UNE requête.
   *
   * `/api/marketplace/cards/<id>/sales` en demande une par carte : cinq par
   * paquet ouvert. Tant que la boucle attendait six secondes entre deux
   * paquets, ça passait inaperçu ; à une seconde, ce trafic est six fois plus
   * dense — et c'est le débit cumulé, tous endpoints confondus, qui déclenche
   * la garde anti-automatisation du site.
   *
   * Le critère de « vendue » est `final_price` non nul, et non une valeur de
   * `status` : vérifié en comparant les deux sources sur la même carte, elles
   * rendent la même liste de prix.
   */
  async function dbSales(ids) {
    if (!ids.length) return null;
    const rows = await sbGet(
      `auctions?card_id=in.(${ids.join(',')})&final_price=not.is.null` +
      `&select=card_id,final_price&order=settled_at.desc&limit=1000`
    );
    if (!Array.isArray(rows)) return null;
    const parCarte = new Map(ids.map((id) => [id, []]));
    for (const r of rows) {
      if (!Number.isFinite(r.final_price)) continue;
      const l = parCarte.get(r.card_id);
      if (l) l.push(r.final_price);
    }
    return parCarte;
  }

  /*
   * La cote de TOUTE la collection, lue en base.
   *
   * C'est la découverte qui a débloqué les comptes sans abonnement : l'onglet
   * Marché d'une carte est vendu avec le PRO, et `/api/marketplace/cards/<id>/
   * sales` répond 403 à un compte gratuit — mais la table `auctions`, elle, se
   * lit avec la session du joueur, sans passer par cette API. Les prix sont les
   * mêmes : ce sont les ventes closes du jeu.
   *
   * Le gain est double. Sans abonnement, le relevé devient possible ; avec, il
   * passe de N requêtes à quelques centaines.
   *
   * `limit` borne chaque réponse : un lot qui la touche est peut-être tronqué,
   * et une moyenne calculée sur une moitié de ventes serait fausse sans le
   * dire. On le recoupe alors en deux, jusqu'à passer sous la borne.
   *
   * @returns {Promise<Map|null>} null si la base n'est pas lisible : l'appelant
   *   retombe sur l'API du site.
   */
  const DB_LOT = 50;      // cartes par requête
  const DB_LIMIT = 1000;  // lignes par réponse, borne de PostgREST

  async function dbSalesBulk(ids, onProgress) {
    const parCarte = new Map();
    let lus = 0;

    const lire = async (lot) => {
      const rows = await sbGet(
        `auctions?card_id=in.(${lot.join(',')})&final_price=not.is.null` +
        `&select=card_id,final_price&order=settled_at.desc&limit=${DB_LIMIT}`
      );
      if (!Array.isArray(rows)) return false;
      // Réponse pleine : on ne peut pas savoir ce qui manque, on recoupe.
      if (rows.length >= DB_LIMIT && lot.length > 1) {
        const moitie = Math.ceil(lot.length / 2);
        return (await lire(lot.slice(0, moitie))) && (await lire(lot.slice(moitie)));
      }
      for (const r of rows) {
        if (!Number.isFinite(r.final_price)) continue;
        const l = parCarte.get(r.card_id) || [];
        l.push(r.final_price);
        parCarte.set(r.card_id, l);
      }
      return true;
    };

    for (let i = 0; i < ids.length; i += DB_LOT) {
      const lot = ids.slice(i, i + DB_LOT);
      if (!(await lire(lot))) return null;  // base illisible : repli sur l'API
      lus += lot.length;
      if (onProgress) onProgress(lus);
    }
    return parCarte;
  }

  async function priceCards(cards) {
    const todo = cards.filter((c) => c.id && !sell.checked.has(c.id));
    if (!todo.length) return;
    let ajout = 0;

    // Chemin direct : un aller-retour pour tout le lot.
    const lot = await dbSales(todo.map((c) => c.id));
    if (lot) {
      for (const c of todo) {
        sell.checked.add(c.id);
        const px = lot.get(c.id) || [];
        if (!px.length) continue;
        sell.rows.push(coteRow(c, px));
        ajout += 1;
      }
    } else {
      // Repli : l'endpoint du site, une requête par carte.
      for (const c of todo) {
        sell.checked.add(c.id);
        try {
          const r = await fetch(`/api/marketplace/cards/${c.id}/sales`, { credentials: 'same-origin' });
          if (r.status === 429) {
            sell.checked.delete(c.id); // on retentera plus tard
            continue;
          }
          const d = await r.json();
          const px = (d.sales || []).map((s) => s.final_price).filter(Number.isFinite);
          if (px.length) {
            sell.rows.push(coteRow(c, px));
            ajout += 1;
            continue;
          }
          // Même repli que le relevé complet : sans historique, la moyenne seule.
          const seule = avgOf(d);
          if (seule == null) continue;
          sell.rows.push({ id: c.id, t: c.t, r: c.r, tags: c.tags || [], n: 0, seule: true,
                           theme: themeOf(c.cat || ''), vues: c.vues || 0,
                           moy: seule, med: seule, q3: seule, min: seule, max: seule });
          ajout += 1;
        } catch (_) {
          sell.checked.delete(c.id);
        }
      }
    }

    if (ajout) {
      sell.at = Date.now();
      saveCote();
      if (sell.open) renderSell();
    }
  }

  /*
   * La cote se périme lentement, la possession change vite : une carte vendue
   * restait listée parce que le cache ne savait pas qu'elle avait quitté la
   * collection. À l'ouverture on revérifie donc ce que tu possèdes encore,
   * sans refaire le relevé des prix — c'est lui qui prend des minutes.
   */
  async function pruneSold() {
    if (sell.scanning || !sell.rows.length) return;
    let cards;
    try {
      cards = await fetchCollection();
    } catch (_) {
      return; // réseau : on garde la liste telle quelle plutôt que de la vider
    }
    if (!cards.length) return;
    const owned = new Set(cards.map((c) => c.id));
    const before = sell.rows.length;
    sell.rows = sell.rows.filter((r) => owned.has(r.id));
    // Les étiquettes ont pu bouger aussi : on les reprend au passage.
    const tagsById = new Map(cards.map((c) => [c.id, c.tags]));
    for (const r of sell.rows) r.tags = tagsById.get(r.id) || r.tags;
    sell.tags = [...new Set(cards.flatMap((c) => c.tags))];
    if (sell.rows.length !== before) saveCote();
    renderSell();
  }

  async function refreshCompetition() {
    if (Date.now() - sell.compAt < MARKET_TTL) return;
    try {
      sell.comp = await fetchCompetition();
      sell.compAt = Date.now();
      renderSell();
    } catch (_) {
      /* réseau : on garde le relevé précédent */
    }
  }

  function openSell() {
    sell.open = true;
    syncJournal();
    refreshCompetition();
    /*
     * Un compte gratuit s'est déjà vu refuser le marché : relancer le relevé à
     * chaque ouverture, c'est vingt-cinq requêtes refusées de plus pour le même
     * message. Le bouton « Rafraîchir la cote » reste là si l'abonnement change.
     */
    if (!sell.rows.length && !sell.scanning && sell.refusVentes !== 403) scanCote();
    else pruneSold().then(() =>
      priceCards(state.history.map((c) => ({ id: c.id, t: c.title, r: c.rarity, tags: [] })))
    );
    renderSell();
  }

  function closeSell() {
    sell.open = false;
    renderSell();
  }

  function buildSellUI() {
    const host = document.createElement('div');
    host.id = 'wm-sell-page';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:none';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; margin: 0; }
        .wrap {
          position: absolute; inset: 0; background: rgba(8,10,13,.86);
          backdrop-filter: blur(10px); display: flex; align-items: center; justify-content: center;
          padding: 28px; font: 13px/1.5 ui-sans-serif, system-ui, sans-serif; color: #F1F4F8;
        }
        .box {
          width: min(980px, 100%); max-height: 100%; display: flex; flex-direction: column;
          background: #0D0F13; border: 1px solid rgba(255,255,255,.08); border-radius: 16px;
          box-shadow: 0 30px 80px rgba(0,0,0,.6); overflow: hidden;
        }
        .top { display: flex; align-items: center; gap: 12px; padding: 16px 18px; border-bottom: 1px solid rgba(255,255,255,.07); }
        .top h2 { font-size: 16px; font-weight: 650; letter-spacing: -.01em; }
        .sum { color: #949DAD; font-size: 12px; }
        .x { margin-left: auto; width: 28px; height: 28px; border: 0; border-radius: 8px;
             background: rgba(255,255,255,.05); color: #949DAD; cursor: pointer; font-size: 14px; }
        .x:hover { color: #F1F4F8; }
        .bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
               padding: 12px 18px; border-bottom: 1px solid rgba(255,255,255,.07); color: #949DAD; font-size: 12px; }
        .bar label { display: flex; align-items: center; gap: 6px; }
        .bar input[type=number] { width: 56px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08);
              border-radius: 6px; color: #F1F4F8; padding: 4px 6px; font: 12px ui-sans-serif, system-ui, sans-serif; }
        .tags { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .tags > [data-tag] { display: flex; gap: 6px; flex-wrap: wrap; }
        .tagchip {
          padding: 3px 9px; border-radius: 999px; border: 1px solid rgba(255,255,255,.12);
          background: none; color: #949DAD; cursor: pointer;
          font: 500 11px ui-sans-serif, system-ui, sans-serif; transition: .16s;
        }
        .tagchip:hover { color: #F1F4F8; }
        .tagchip.on { background: rgba(53,214,143,.18); border-color: #35D68F; color: #35D68F; }
        .bar select { background: #14171C; border: 1px solid rgba(255,255,255,.08); border-radius: 6px;
              color: #F1F4F8; padding: 4px 6px; font: 12px ui-sans-serif, system-ui, sans-serif; }
        .bar button { margin-left: auto; padding: 6px 12px; border: 0; border-radius: 8px;
              background: rgba(255,255,255,.06); color: #949DAD; cursor: pointer; font: 500 12px ui-sans-serif, system-ui, sans-serif; }
        .bar button:hover { color: #F1F4F8; }
        .scroll { overflow: auto; }
        table { width: 100%; border-collapse: collapse; }
        th { position: sticky; top: 0; background: #0D0F13; text-align: left; color: #626B7A;
             font-size: 11px; font-weight: 500; padding: 9px 12px; border-bottom: 1px solid rgba(255,255,255,.07); }
        td { padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,.04); font-variant-numeric: tabular-nums; }
        tr:hover td { background: rgba(255,255,255,.03); }
        .r { font-weight: 700; font-size: 11px; }
        .t { max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .num { text-align: right; }
        .med { font-weight: 650; }
        .amp { color: #626B7A; font-size: 11px; }
        .th { color: #949DAD; font-size: 11px; white-space: nowrap; }
        .free { color: #35D68F; }
        .busy { color: #F0A94B; }
        /* Peu de ventes : le prix visé n'est pas un prix de marché. */
        .thin { color: #F0A94B; cursor: help; }
        .th .liq { color: #626B7A; margin-left: 6px; }
        .tag { padding: 1px 6px; border-radius: 999px; background: rgba(53,214,143,.15); color: #35D68F; font-size: 10px; }
        .go { padding: 5px 11px; border: 1px solid rgba(255,255,255,.12); border-radius: 7px;
              background: none; color: #F1F4F8; cursor: pointer; font: 500 11px ui-sans-serif, system-ui, sans-serif; }
        .go:hover { background: rgba(53,214,143,.15); border-color: #35D68F; color: #35D68F; }
        /* Une carte étiquetée n'a pas de bouton : rien à cliquer par mégarde. */
        .protege { display: inline-block; padding: 5px 9px; border: 1px dashed rgba(255,255,255,.14);
                   border-radius: 7px; color: #626B7A; font: 500 11px ui-sans-serif, system-ui, sans-serif; }
        .note { padding: 12px 18px; color: #626B7A; font-size: 11px; border-top: 1px solid rgba(255,255,255,.07); }
        .empty { padding: 40px; text-align: center; color: #626B7A; }
        .slots { color: #35D68F; font-weight: 600; }
        /* Autant de lignes surlignées que d'emplacements libres : ce sont les
           cartes à lister maintenant, sans avoir à compter soi-même. */
        tr.next td { background: rgba(53,214,143,.06); }
        tr.next td:first-child { box-shadow: inset 2px 0 0 #35D68F; }
        .journal { border-top: 1px solid rgba(255,255,255,.07); padding: 12px 18px; }
        .journal h3 { font-size: 12px; font-weight: 600; color: #949DAD; margin-bottom: 8px; }
        .journal .j { display: flex; gap: 10px; align-items: baseline; padding: 3px 0; font-size: 12px; }
        .journal .n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
                      white-space: nowrap; color: #F1F4F8; }
        .journal .ok { color: #35D68F; }
        .journal .ko { color: #F0A94B; }
        .journal .ask { color: #626B7A; font-variant-numeric: tabular-nums; }
      </style>
      <div class="wrap" data-wrap>
        <div class="box">
          <div class="top">
            <h2>Revente</h2><span class="sum" data-sum></span>
            <button class="x" data-close>✕</button>
          </div>
          <div class="bar">
            <label>Ventes mini <input type="number" data-min min="1" max="50"></label>
            <label>Rareté <select data-rar></select></label>
            <label title="N'afficher que les cartes que personne d'autre ne propose en ce moment">
              <input type="checkbox" data-free> Sans concurrence</label>
            <span class="tags" data-taglabel hidden>Masquer <button class="tagchip" data-all>toutes les étiquetées</button><span data-tag></span></span>
            <button data-rescan>Rafraîchir la cote</button>
          </div>
          <div class="scroll" data-scroll></div>
          <div class="journal" data-journal></div>
          <div class="note">
            ⚠ signale une cote établie sur moins de 5 ventes : le prix peut être
            une coïncidence. Rien n'est mis en vente depuis cette page. « Vendre » ouvre la fiche de la carte
            sur le formulaire du site, avec le 3e quartile des ventes pré-rempli — tu choisis la durée
            et tu lances l'enchère toi-même.
          </div>
        </div>
      </div>`;
    document.body.appendChild(host);

    const q = (s) => root.querySelector(s);
    sellUI = { host, root, sum: q('[data-sum]'), scroll: q('[data-scroll]'),
      journal: q('[data-journal]'), min: q('[data-min]'), rar: q('[data-rar]'), free: q('[data-free]'), tag: q('[data-tag]'),
      taglabel: q('[data-taglabel]'), all: q('[data-all]') };

    q('[data-close]').addEventListener('click', closeSell);
    q('[data-wrap]').addEventListener('click', (e) => { if (e.target === q('[data-wrap]')) closeSell(); });
    q('[data-rescan]').addEventListener('click', scanCote);
    sellUI.min.value = sellPrefs.minSales;
    sellUI.min.addEventListener('change', (e) => {
      sellPrefs.minSales = Math.max(1, +e.target.value || 1);
      renderSell();
    });
    sellUI.rar.innerHTML = '<option value="">toutes</option>' + RARITIES.map((r) => `<option>${r}</option>`).join('');
    sellUI.rar.addEventListener('change', (e) => { sellPrefs.rarity = e.target.value; renderSell(); });
    sellUI.free.checked = sellPrefs.onlyFree;
    sellUI.free.addEventListener('change', (e) => { sellPrefs.onlyFree = e.target.checked; renderSell(); });
    sellUI.all.addEventListener('click', () => {
      sellPrefs.hideTagged = !sellPrefs.hideTagged;
      saveStore({ sellHideTagged: sellPrefs.hideTagged });
      renderSell();
    });

    // Chaque étiquette se masque ou se réaffiche indépendamment des autres.
    sellUI.tag.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-tagname]');
      if (!chip) return;
      const nom = chip.dataset.tagname;
      sellPrefs.hideTags = sellPrefs.hideTags.includes(nom)
        ? sellPrefs.hideTags.filter((t) => t !== nom)
        : sellPrefs.hideTags.concat(nom);
      saveStore({ sellHideTags: sellPrefs.hideTags });
      renderSell();
    });
    sellUI.scroll.addEventListener('click', (e) => {
      /*
       * Sortie de secours du tableau vide : des cartes cotées qu'aucun filtre
       * ne laisse passer, c'est un cul-de-sac — surtout sur un petit compte,
       * où « ventes mini 2 » et « sans concurrence » écartent tout. Le bouton
       * remet les filtres à plat en un clic, plutôt que de laisser chercher
       * lequel des quatre est en cause.
       */
      if (e.target.closest('[data-relache]')) {
        sellPrefs.minSales = 1;
        sellPrefs.onlyFree = false;
        sellPrefs.rarity = '';
        sellPrefs.hideTagged = false;
        sellPrefs.hideTags = [];
        sellUI.min.value = 1;
        sellUI.free.checked = false;
        sellUI.rar.value = '';
        saveStore({ sellHideTagged: false, sellHideTags: [] });
        renderSell();
        return;
      }
      const b = e.target.closest('[data-sell]');
      if (!b) return;
      // L'étiquette a pu être posée depuis le dernier rendu du tableau.
      const ligne = sell.rows.find((x) => x.t === b.dataset.sell);
      if (ligne && ligne.tags && ligne.tags.length) return;
      prepareSale(b.dataset.sell, b.dataset.prix);
    });
  }

  /** Ce que tu as demandé, ce que tu as obtenu. La seule référence qui soit tienne. */
  function renderJournal() {
    const j = state.journal.slice(0, 12);
    if (!j.length) {
      paint(sellUI.journal, '');
      return;
    }
    const vendues = state.journal.filter((e) => e.vendue).length;
    paint(sellUI.journal,
      `<h3>Tes ventes — ${vendues} vendue${vendues > 1 ? 's' : ''} sur ${state.journal.length}</h3>` +
      j
        .map(
          (e) => `<div class="j">
            <span class="${e.vendue ? 'ok' : 'ko'}">${e.vendue ? '✓' : '✕'}</span>
            <span class="n">${esc(e.title)}</span>
            <span class="ask">${e.ask != null ? `demandé ${e.ask.toLocaleString('fr-FR')}` : ''}</span>
            <span class="${e.vendue ? 'ok' : 'ko'}">${
              e.vendue ? `vendu ${(e.final ?? 0).toLocaleString('fr-FR')}` : 'sans acheteur'
            }</span>
          </div>`
        )
        .join(''));
  }


  function renderSell() {
    if (!sellUI) return;
    sellUI.host.style.display = sell.open ? '' : 'none';
    if (!sell.open) return;

    // Le sélecteur n'apparaît que si le compte utilise des étiquettes.
    sellUI.taglabel.hidden = !sell.tags.length;
    sellUI.all.classList.toggle('on', sellPrefs.hideTagged);
    // Le détail par étiquette n'a plus de sens quand tout est masqué.
    sellUI.tag.style.opacity = sellPrefs.hideTagged ? '.35' : '';
    sellUI.tag.style.pointerEvents = sellPrefs.hideTagged ? 'none' : '';
    paint(sellUI.tag, sell.tags
      .map(
        (t) =>
          `<button class="tagchip${sellPrefs.hideTags.includes(t) ? ' on' : ''}"
             data-tagname="${esc(t)}">${esc(t)}</button>`
      )
      .join(''));

    if (sell.scanning) {
      // Deux temps distincts, et il faut les distinguer : on lit d'abord la
      // collection, on cote ensuite. Un compteur figé sur « 0 » n'a jamais dit
      // lequel des deux était en cours.
      if (!sell.total) {
        sellUI.sum.textContent = `lecture de ta collection · ${sell.read} cartes`;
        paint(sellUI.scroll,
          '<div class="empty">Lecture de ta collection, 50 cartes par page…</div>');
        return;
      }
      sellUI.sum.textContent = `cotation ${sell.done} / ${sell.total}`;
      paint(sellUI.scroll, '<div class="empty">Lecture de l’historique des ventes, carte par carte…</div>');
      return;
    }

    const rows = sellRows();
    const valeur = rows.reduce((a, x) => a + (x.q3 || x.med), 0);
    const libres = state.slots.at ? state.slots.max - state.slots.used : null;
    const age = sell.at ? ` · cote il y a ${fmtSpan(Date.now() - sell.at)}` : '';
    const conc = sell.compAt
      ? ` · concurrence il y a ${fmtSpan(Date.now() - sell.compAt)}`
      : ' · relevé de la concurrence en cours…';
    sellUI.sum.textContent = `${rows.length} cartes · ~${valeur.toLocaleString('fr-FR')} wb${age}${conc}`
      + (sell.note ? ` · ${sell.note}` : '');

    if (!rows.length) {
      /*
       * Trois vides très différents s'affichaient pareil : un refus du serveur,
       * une cote qui n'existe pas, et un filtre trop serré. Le dernier se
       * corrige en un clic — encore faut-il savoir que c'est lui.
       */
      const filtres = [`ventes mini ${sellPrefs.minSales}`]
        .concat(sellPrefs.onlyFree ? ['sans concurrence'] : [])
        .concat(sellPrefs.rarity ? [`rareté ${sellPrefs.rarity}`] : [])
        .concat(sellPrefs.hideTagged ? ['étiquetées masquées'] : []);
      const filtrees = !sell.note && sell.rows.length;
      paint(sellUI.scroll, `<div class="empty">${esc(
        sell.note
          || (filtrees
            ? `${sell.rows.length} cartes cotées, mais aucune ne passe les filtres (${filtres.join(' · ')}).`
            : 'Aucune carte cotée pour l’instant.')
      )}${filtrees ? '<div style="margin-top:14px"><button class="go" data-relache>Relâcher les filtres</button></div>' : ''}</div>`);
      renderJournal();
      return;
    }

    renderJournal();

    paint(sellUI.scroll,
      `<table><thead><tr>
         <th>Rareté</th><th>Carte</th><th>Thème</th><th class="num">Ventes</th>
         <th class="num">En vente</th><th class="num">Prix visé</th>
         <th class="num">Médiane</th><th>Amplitude</th><th></th>
       </tr></thead><tbody>` +
      rows
        .map(
          (x, i) => `<tr class="${libres && i < libres ? 'next' : ''}">
            <td class="r" style="color:${RARITY_COLOR[x.r] || '#949DAD'}">${x.r}</td>
            <td class="t">${esc(x.t)} ${x.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</td>
            <td class="th">${
              x.theme
                ? `${esc(x.theme)}<span class="liq">${Math.round(((sell.themes[x.theme] || {}).rate || 0) * 100)} %</span>`
                : ''
            }</td>
            <td class="num${x.seule || x.n < THIN_SALES ? ' thin' : ''}"${
              x.seule
                ? ' title="Le site n’a donné que la moyenne, sans le détail des ventes : impossible de savoir sur combien de transactions elle repose."'
                : x.n < THIN_SALES
                  ? ' title="Cote établie sur moins de 5 ventes : le prix visé peut être une coïncidence plutôt qu’un prix de marché."'
                  : ''
            }>${x.seule ? '⌀' : `${x.n}${x.n < THIN_SALES ? ' ⚠' : ''}`}</td>
            <td class="num ${sell.comp.get(x.id) ? 'busy' : 'free'}">${sell.comp.get(x.id) || '—'}</td>
            <td class="num med">${(x.q3 || x.med).toLocaleString('fr-FR')}</td>
            <td class="num">${x.med.toLocaleString('fr-FR')}</td>
            <td class="amp">${x.min.toLocaleString('fr-FR')} – ${x.max.toLocaleString('fr-FR')}</td>
            <td>${x.tags.length
              ? `<span class="protege" title="Carte étiquetée : hors de portée de la revente. Retire l’étiquette sur le site pour pouvoir la vendre.">protégée</span>`
              : `<button class="go" data-sell="${esc(x.t)}" data-prix="${x.q3 || x.med}">Vendre</button>`}</td>
          </tr>`
        )
        .join('') +
      '</tbody></table>');
  }

  // ------------------------------------------------------------------ montage

  /*
   * Le montage est bavard, volontairement. Un panneau qui n'apparaît pas est
   * indiagnosticable à distance : sans cette trace, impossible de distinguer
   * « Tampermonkey n'exécute pas le script » d'une erreur au démarrage.
   */
  console.info(`[WikiMasters Tools] ${VERSION} — démarrage`);

  try {
    restore();
    loadCote();
    buildPanel();
    buildSellUI();
    render();
    watchForHumanCheck();
    applyPendingSearch();
    watchCollection();
    startBidWatcher(); // armé en permanence ; le tick vérifie l'option et la page
    console.info('[WikiMasters Tools] panneau monté');
  } catch (err) {
    console.error('[WikiMasters Tools] échec au démarrage :', err);
    throw err;
  }

  // Les pages Profil et Succès se rendent côté client : on relève après montage.
  setTimeout(() => {
    refreshOwned();
    readAchievements();
  }, 1800);

  /*
   * La page Succès se rend côté client, et son bouton *Réclamer* n'apparaît
   * qu'une fois les données arrivées : une lecture unique après 1,8 s tombait
   * souvent avant. Le relevé repasse donc tant que tu es sur cette page. Il ne
   * touche pas au réseau et ne réécrit le stockage que si quelque chose a
   * bougé — `readAchievements` compare l'empreinte avant d'agir.
   */
  setInterval(() => {
    if (location.pathname.startsWith('/achievements')) readAchievements();
  }, 3000);

  /*
   * Et le même relevé en base, depuis n'importe quelle page. Le DOM ne parle
   * que si tu es sur `/achievements` : une récompense débloquée pouvait donc
   * dormir des jours sans que rien ne le dise. Deux requêtes au démarrage, puis
   * toutes les vingt minutes — un succès ne se débloque pas plus vite que ça.
   */
  const ACHV_EVERY_MS = 1200000;
  readAchievementsFromDb();
  setInterval(() => {
    if (!location.pathname.startsWith('/achievements')) readAchievementsFromDb();
  }, ACHV_EVERY_MS);

  /*
   * Veille de guilde : elle doit tourner même quand l'onglet Guilde n'est pas
   * ouvert, sinon l'alerte ne sert qu'à ceux qui regardaient déjà. Le tour
   * passe chaque minute, mais `refreshGuild` ne touche au réseau qu'au-delà de
   * sa fraîcheur — la cadence réelle reste celle que le serveur tolère.
   */
  setInterval(() => {
    if (prefs.watchGuild) refreshGuild();
  }, 60000);

  // Le compte à rebours doit rester juste même quand la boucle dort longtemps,
  // et le verrou doit rester frais tant que cet onglet travaille.
  let beat = 0;
  setInterval(() => {
    if (!state.running) return;
    if (state.waitUntil) renderStatus();
    if (++beat % 8 === 0) takeLock(); // ~4 s, bien sous le TTL de 12 s
  }, CFG.tickMs);

  /*
   * Les échéances du Marché s'écoulent en continu, mais rien ne les redessinait :
   * « fin 4:11 » restait figé jusqu'au relevé suivant, quinze secondes plus
   * tard, puis sautait d'un bloc. Le rendu est diffé — un tour par seconde ne
   * coûte qu'une comparaison de chaînes tant que rien ne bouge — et on ne
   * l'exécute que si l'onglet Marché est effectivement sous les yeux.
   */
  setInterval(() => {
    if (!ui.box || ui.panel.classList.contains('folded')) return;
    if (prefs.tab === 'marche') {
      renderMarket();
      renderRelist();
    } else if (prefs.tab === 'guilde') {
      // Le relevé réseau est borné par sa propre fraîcheur (5 min) ; ce tour-ci
      // ne fait que garder l'âge affiché honnête entre deux.
      refreshGuild();
      renderGuild();
    }
  }, 1000);

  setInterval(refreshOwned, OWNED_EVERY_MS);

  /*
   * Les remises en vente ont leur propre horloge. Elles passaient par le
   * guetteur d'enchères, qui ne repasse que toutes les 15 s : un créneau tiré
   * à quelques secondes était de fait arrondi à son rythme à lui. Ce tick ne
   * touche au réseau qu'une fois le créneau atteint — le reste du temps, il
   * s'arrête sur trois comparaisons.
   */
  const RELIST_TICK_MS = 1000;
  let relistTickBusy = false;

  setInterval(async () => {
    if (relistTickBusy || !prefs.relistUnsold) return;
    if (!Object.keys(state.watch).length) return;
    if (Date.now() < state.nextRelistAt) return;
    relistTickBusy = true;
    try {
      // reconcileWatch refuse d'agir sur un relevé de ventes périmé.
      if (Date.now() - state.sales.at > 45000) await scanSales();
      await reconcileWatch();
    } catch (_) {
      /* le tour suivant rattrapera */
    } finally {
      relistTickBusy = false;
    }
  }, RELIST_TICK_MS);

  addEventListener('resize', clampPanel);

  addEventListener('pagehide', releaseLock);

  /*
   * Un rechargement libère le verrou via `pagehide`, mais un onglet tué
   * brutalement le laisse traîner jusqu'à expiration. L'auto-démarrage patiente
   * donc au lieu d'abandonner : il part dès que le verrou se libère, et ne
   * renonce que si un autre onglet le tient vraiment.
   */
  function startWhenFree(tries = 0) {
    if (state.running) return;
    const holder = lockHolder();
    if (!holder || holder === instanceId) return start();
    if (tries * 1000 > LOCK_TTL + 2000) {
      return setStatus('Déjà actif dans un autre onglet.', true);
    }
    setStatus('Un autre onglet tient la main…');
    setTimeout(() => startWhenFree(tries + 1), 1000);
  }

  if (prefs.autostart) startWhenFree();

  /*
   * Diagnostic de la cote — `__wmAuto.diagCote()` dans la console.
   *
   * « La Revente ne charge pas » recouvre trois pannes très différentes, et
   * elles rendent toutes le même écran vide : le serveur refuse la collection,
   * il refuse l'historique des ventes, ou il ne refuse rien et le relevé est
   * simplement long. On sépare donc ce que le script croit — son compteur — de
   * ce que le serveur répond vraiment, en deux requêtes qui ne consomment rien.
   *
   * Utile surtout à distance : sur un autre compte, c'est la seule façon de
   * savoir laquelle des trois on regarde.
   */
  async function diagCote() {
    const rapport = {
      version: VERSION,
      relevé: { en_cours: sell.scanning, cartes_lues: sell.read, cartes_cotées: sell.done,
                à_coter: sell.total, lignes_gardées: sell.rows.length, âge: sell.at || null,
                refus_serveur: sell.refus || null, freinages_429: sell.freinages,
                lecture_tronquée: sell.tronque, message: sell.note || null,
                refus_sur_les_ventes: sell.refusVentes || null,
                cartes_refusées: sell.refusVentesN },
      refus_429_depuis_le_départ: state.throttles,
    };

    const col = await api('/api/my-collection?page=0');
    const cartes = (col.data && col.data.collection) || [];
    rapport.collection = { status: col.status, cartes_page_0: cartes.length };

    if (cartes.length) {
      const v = await api(`/api/marketplace/cards/${cartes[0].card_id}/sales`);
      rapport.historique_des_ventes = { status: v.status, ventes: ((v.data && v.data.sales) || []).length };
    } else {
      rapport.historique_des_ventes = 'pas de carte à tester : la collection n’a rien renvoyé';
    }

    /*
     * Un 403 sur l'historique des ventes a deux causes possibles et opposées :
     * un compte sanctionné, ou une fonction réservée. Seule la ligne de profil
     * tranche — `is_pro` d'un côté, `cheat_strikes` et `activity_blocked_until`
     * de l'autre. Elle n'est lisible que si la lecture directe est autorisée.
     */
    if (prefs.db) {
      const p = await refreshPacks(true);
      rapport.compte = p
        ? { pro: p.is_pro ?? null, avertissements: p.cheat_strikes ?? null,
            bridé_jusqu_à: p.activity_blocked_until || null }
        : state.dbNote || 'profil illisible';
    } else {
      rapport.compte = 'coche « Lecture directe de la base » dans les réglages pour lire '
        + 'is_pro et les sanctions du compte';
    }

    console.info('[WikiMasters Tools] diagnostic cote', rapport);
    return rapport;
  }

  // Poignée de diagnostic : `__wmAuto.version`, `__wmAuto.state`, `__wmAuto.prefs`.
  window.__wmAuto = {
    version: VERSION,
    start, stop, resetStats, exportCsv, exportJson, claimBonusPacks,
    state, prefs, CFG, sell, openSell, diagCote,
    // De quoi vérifier la protection par étiquette sans lire le code :
    // `__wmAuto.ownedIndex(true)` reconstruit l'index, `__wmAuto.owned.tagged`
    // liste les cartes hors de portée, `__wmAuto.isTagged(id)` tranche.
    ownedIndex, owned, isTagged,
  };
})();
