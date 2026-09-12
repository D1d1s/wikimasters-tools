// ==UserScript==
// @name         WikiMasters Tools
// @namespace    https://www.wiki-masters.com/
// @version      3.8.0
// @description  Boîte à outils WikiMasters : ouverture automatique des paquets, suivi des tirages, cote des cartes et revente.
// @match        https://www.wiki-masters.com/*
// @match        https://wiki-masters.com/*
// @run-at       document-start
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
   * Une seule source pour le numéro de version : il vivait en trois exemplaires
   * — l'en-tête, la ligne de console et la poignée de diagnostic — et deux
   * d'entre eux avaient dérivé. La console annonçait 1.66 pendant que l'en-tête
   * disait 1.67 : de quoi chercher longtemps pourquoi un correctif « n'arrive
   * pas ». À tenir à jour avec `@version` en tête de fichier.
   *
   * Il est lu par le garde juste en dessous, d'où sa place en tête.
   */
  const VERSION = '3.8.0';

  /*
   * Une seule instance par page — et savoir laquelle
   * ------------------------------------------------
   * Renommer `@name` fait que Tampermonkey installe un SECOND script au lieu
   * de renommer le premier : les deux s'injectent alors et le panneau
   * apparaît en double. Ce drapeau est donc posé avant tout le reste —
   * JavaScript étant mono-thread, la première instance chargée gagne et les
   * suivantes s'arrêtent net.
   *
   * S'arrêter EN SILENCE était le défaut, et il s'est vu en vrai : quelqu'un
   * met à jour, actualise la page, et voit toujours l'ancien panneau — parce
   * qu'un script d'avant le renommage tenait encore la page et gagnait la
   * course. Tampermonkey annonçait la nouvelle version, l'écran montrait
   * l'ancienne, et rien ne reliait les deux. Une mise à jour qui ne change
   * rien sans dire pourquoi est indiagnosticable à distance : c'est la panne
   * la plus coûteuse du projet, et celle-ci ne laissait même pas de trace.
   *
   * L'instance qui se retire l'annonce donc. Elle sait souvent qui l'a
   * devancée : la poignée de diagnostic de l'autre porte son numéro, dès lors
   * qu'il est allé au bout de son exécution.
   *
   * On n'avertit que si l'autre est PLUS ANCIEN, ou si son numéro est
   * illisible. Deux copies d'une même version se recouvrent sans dommage —
   * le panneau affiché est le bon, il n'y a rien à signaler.
   */
  if (window.__wmToolsLoaded) {
    const autre = (window.__wmAuto && window.__wmAuto.version) || null;
    if (!autre || plusVieux(autre, VERSION)) signalerDoublon(autre);
    return;
  }
  window.__wmToolsLoaded = true;

  /*
   * Le script démarre AVANT la page (`@run-at document-start`), et il le fait
   * pour une seule raison : le site lit ses notifications une fois, au
   * chargement, et ne les redemande jamais — ouvrir la cloche ne déclenche
   * aucune requête. Démarré après lui, le filtre des invendus arrivait trop
   * tard et ne voyait jamais cette lecture. Mesuré sur un compte réel : le
   * filtre rendait bien 0 invendu quand on l'appelait, et la cloche du site
   * les montrait tous.
   *
   * Ce que ça coûte : à cet instant, `document.body` n'existe pas encore. Tout
   * ce qui touche à l'écran passe donc par ici, et attend. Le reste — le
   * filtre, les réglages relus, les minuteries — part tout de suite, ce qui
   * est justement le point.
   */
  function quandLeDomEstPret(fn) {
    // `readyState` absent : banc d'essai, où le DOM factice est prêt d'emblée.
    if (document.readyState && document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  /** `a` est-il antérieur à `b` ? Comparaison segment par segment. */
  function plusVieux(a, b) {
    const na = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const nb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(na.length, nb.length); i++) {
      const x = na[i] || 0;
      const y = nb[i] || 0;
      if (x !== y) return x < y;
    }
    return false;
  }

  /*
   * Le bandeau est autonome : l'instance qui l'affiche ne monte pas le
   * panneau, donc rien de ce qui suit dans ce fichier n'existe pour elle. Ni
   * gabarit partagé, ni variable de thème — seulement de quoi être lu.
   *
   * En haut au centre, parce que le panneau de l'autre instance vit en bas à
   * droite : se recouvrir aurait caché celui des deux qui explique.
   *
   * Refermé, il se tait pour la session. Il revient à la visite suivante tant
   * que le doublon est là — le taire pour de bon rendrait au problème
   * exactement le silence qui le rendait introuvable.
   */
  function signalerDoublon(autre) {
    try {
      if (sessionStorage.getItem('wm-doublon-tu')) return;
    } catch (_) {
      /* stockage refusé : on avertit quand même, c'est le sens du bandeau */
    }

    const poser = () => {
      if (!document.body || document.getElementById('wm-doublon')) return;

      const boite = document.createElement('div');
      boite.id = 'wm-doublon';
      boite.style.cssText =
        'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483000;'
        + 'max-width:560px;padding:12px 14px;border-radius:10px;'
        + 'background:rgba(13,15,19,.96);border:1px solid rgba(255,255,255,.10);'
        + 'border-left:3px solid #F5A524;box-shadow:0 8px 28px rgba(0,0,0,.45);'
        + 'color:#F1F4F8;font:13px/1.45 ui-sans-serif,system-ui,sans-serif';

      const titre = document.createElement('div');
      titre.textContent = 'Deux versions de WikiMasters Tools sont installées';
      titre.style.cssText = 'font-weight:700;margin-bottom:5px';

      const corps = document.createElement('div');
      corps.style.cssText = 'color:#C7CEDA';
      corps.textContent =
        `Une ancienne (${autre || 'numéro illisible'}) a pris la page avant la ${VERSION}, `
        + 'et c\'est elle que tu vois — celle-ci s\'est retirée pour ne pas afficher deux '
        + 'panneaux. Ouvre le tableau de bord Tampermonkey, supprime le script qui n\'est '
        + `pas en ${VERSION}, puis actualise la page.`;

      const fermer = document.createElement('button');
      fermer.textContent = 'Compris';
      fermer.style.cssText =
        'margin-top:9px;padding:5px 12px;border-radius:7px;cursor:pointer;'
        + 'border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);'
        + 'color:#F1F4F8;font:600 12px ui-sans-serif,system-ui,sans-serif';
      fermer.addEventListener('click', () => {
        try {
          sessionStorage.setItem('wm-doublon-tu', '1');
        } catch (_) {
          /* rien à retenir : il reviendra au prochain chargement */
        }
        boite.remove();
      });

      boite.append(titre, corps, fermer);
      document.body.appendChild(boite);
    };

    if (document.body) poser();
    else document.addEventListener('DOMContentLoaded', poser, { once: true });
  }

  /*
   * Un appel réseau qui n'aboutit pas doit finir par renoncer
   * ---------------------------------------------------------
   * Il n'y avait AUCUN délai de garde dans ce fichier : pas un
   * `AbortController`. Or `fetch` ne renonce jamais de lui-même. Un serveur
   * qui accepte la connexion et ne répond plus — la panne la plus banale d'un
   * jeu en ligne, plus fréquente qu'un refus franc — laissait l'`await` en
   * suspens indéfiniment. Le panneau restait sur « Ouverture… » : pas
   * d'erreur, pas d'expiration, pas de message. Rien ne distinguait « ça
   * travaille » de « c'est mort ».
   *
   * Vingt secondes. Le site répond en dessous de la seconde en régime normal,
   * et la plus lourde de nos lectures — une page de collection de 50 cartes —
   * n'a jamais dépassé trois secondes au banc. Vingt laisse donc largement la
   * place à un hoquet sans laisser la place à une pendaison.
   *
   * L'abandon est signalé comme tel : `expiration` sur l'erreur, pour que la
   * boucle dise « le serveur n'a pas répondu » plutôt que « injoignable » —
   * les deux pannes ne se cherchent pas au même endroit.
   */
  const RESEAU_TIMEOUT_MS = 20000;

  /**
   * @param {Function} [via] l'émetteur à employer, quand l'appelant tient à
   *   court-circuiter nos propres filtres de réponse — voir `api()`. Le délai
   *   de garde vaut pour lui aussi : c'est le serveur qui pend, pas le filtre.
   */
  function fetchBorne(url, opts = {}, via) {
    const emettre = via || fetch;
    // Un navigateur sans `AbortController` garde le comportement d'avant :
    // mieux vaut un appel sans garde qu'un appel qui ne part pas.
    if (typeof AbortController !== 'function') return emettre(url, opts);
    const ctrl = new AbortController();
    const minuteur = setTimeout(() => ctrl.abort(), RESEAU_TIMEOUT_MS);
    return emettre(url, { ...opts, signal: ctrl.signal })
      .catch((err) => {
        if (err && err.name === 'AbortError') {
          const e = new Error(
            `Le serveur n’a pas répondu en ${Math.round(RESEAU_TIMEOUT_MS / 1000)} s.`
          );
          e.expiration = true;
          throw e;
        }
        throw err;
      })
      .finally(() => clearTimeout(minuteur));
  }

  /*
   * Savoir qu'on est en retard
   * --------------------------
   * Tampermonkey décide seul quand vérifier — jamais plus d'une fois par heure,
   * en pratique une fois par jour. Rien ne le dit à l'écran : entre la
   * publication et l'installation, l'utilisateur ignore simplement qu'une
   * version corrige ce qu'il subit. La 2.9.0 rend au prix de vente son sens ;
   * la savoir disponible vaut autant que l'avoir écrite.
   *
   * Le panneau va donc lire lui-même le numéro en ligne. Trois mesures, prises
   * sur le site avant d'écrire ceci :
   *
   *   - `wiki-masters.com` n'envoie AUCUNE politique de sécurité de contenu,
   *     ni en-tête ni balise : `fetch` vers GitHub passe depuis la page, sans
   *     `@grant`, donc sans toucher au bac à sable actuel.
   *   - le raw GitHub honore les requêtes partielles — HTTP 206 — : 400 octets
   *     suffisent à lire l'en-tête, au lieu des 400 Ko du fichier.
   *   - il se met en cache cinq minutes : une publication est visible aussitôt.
   *
   * Ce que ça ne fait PAS : installer. Aucune API ne permet à un script de se
   * mettre à jour lui-même, et le sien reste `@grant none`. Le gain n'est pas
   * l'automatisation, c'est de savoir — ensuite un clic ouvre la page
   * d'installation de Tampermonkey, qui propose la mise à jour.
   *
   * Une panne ici ne doit RIEN changer : pas de message, pas d'état modifié,
   * pas de trace. Le pire cas est celui d'aujourd'hui — on attend Tampermonkey.
   */
  const MAJ_URL =
    'https://raw.githubusercontent.com/D1d1s/wikimasters-tools/main/wikimasters-auto.user.js';
  const MAJ_TOUTES_LES_MS = 3600000;   // une fois par heure : le cache dure cinq minutes
  const MAJ_OCTETS = 400;              // de quoi couvrir l'en-tête, jamais le corps
  const MAJ_PREMIER_DELAI = 20000;     // laisser la page se poser avant de sortir

  async function chercherMaj() {
    if (Date.now() - (state.majAt || 0) < MAJ_TOUTES_LES_MS) return;
    // L'horodatage est posé AVANT l'appel : un réseau qui pend ne doit pas
    // laisser le tour suivant repartir aussitôt.
    state.majAt = Date.now();
    saveStore({ majAt: state.majAt });
    try {
      const r = await fetchBorne(MAJ_URL, {
        headers: { Range: `bytes=0-${MAJ_OCTETS}` },
        cache: 'no-store',
      });
      if (r.status !== 200 && r.status !== 206) return;
      const tete = await r.text();
      const dispo = (tete.match(/@version\s+(\S+)/) || [])[1];
      /*
       * On ne retient que ce qui est PLUS RÉCENT. Un numéro illisible, égal, ou
       * plus ancien — le temps qu'un cache se vide — ne doit pas allumer un
       * bandeau qui enverrait réinstaller ce qui est déjà là.
       */
      if (!dispo || !plusVieux(VERSION, dispo)) return;
      state.majDispo = dispo;
      render();
    } catch (_) {
      /* hors ligne, bloqué, rien : on attend Tampermonkey, comme avant */
    }
  }

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
    // Le plancher appris se détend d'un cran après cette série de succès sans
    // refus : sans quoi un 429 isolé — pic de charge, onglet concurrent — le
    // figerait haut pour toute la session, et un nouvel assouplissement du jeu
    // passerait inaperçu.
    probeAfterHits: 40,
    /*
     * Marge au-dessus d'un délai refusé, et pas de détente — les deux ADDITIFS,
     * et c'est le point.
     *
     * Ils valaient « +10 % » et « 35 % de l'écart au plancher de sécurité ».
     * Deux pas de tailles sans rapport, et le grand traversait ce que le petit
     * défendait : depuis un plancher de 3 136 ms, la détente faisait un bond de
     * 818 ms et atterrissait à 2 318 — sous un seuil serveur de 2 500. Elle ne
     * sondait pas le mur, elle entrait dedans, à tous les coups.
     *
     * Mesuré sur le banc, une heure de boucle réelle contre un serveur refusant
     * en dessous de 2 500 ms : 39 refus, un tous les 24 paquets, 11 % du temps
     * passé à reculer pour rien — et un plancher stabilisé 25 % au-dessus de ce
     * que le serveur tolérait. Le plus lent des deux mondes.
     *
     * Pire, le multiplicatif dérivait vers le haut : chaque contact ajoutait
     * 10 % (~300 ms à cette hauteur) qu'il fallait 48 paquets propres pour
     * regagner. C'est cet engrenage qui a porté un compte réel jusqu'au plafond
     * de 60 s ; les doubles boucles ne faisaient que fournir les contacts.
     *
     * En additif, l'écart au seuil réel ne peut plus dépasser la marge : le
     * plancher oscille juste au-dessus au lieu de s'en éloigner. La détente est
     * volontairement plus PETITE que la marge — sans quoi le système repart en
     * dents de scie, chaque détente annulant plus que ce qu'un contact corrige.
     *
     * 300 plutôt que 200 : les deux ont été mesurés en répétition, parce qu'un
     * seul essai ne départage pas deux réglages séparés par cinq refus. À 200,
     * trois essais donnent 19, 19 et 20 refus par heure ; à 300, 14, 15 et 14 —
     * soit 19,3 contre 14,3 de moyenne, pour un débit qui ne baisse pas (1 041
     * contre 1 051 paquets). La marge plus large fait toucher le mur un quart
     * de fois en moins sans rien coûter, le plancher ne s'établissant que
     * 100 ms plus haut.
     */
    probeMarginMs: 300,
    probeRelaxMs: 150,

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

  /*
   * Le numéro de schéma du stockage local.
   *
   *   0  avant tout marqueur
   *   1  `debitRecalibre`  — recalibrage du débit, 1.77
   *   2  `debitVerrou`     — après le correctif du verrou inter-onglets
   *   3  `debitCliquet`    — après le cliquet du plancher appris
   *   4  ce numéro lui-même : les migrations se comparent au lieu de se deviner
   *   5  la limite quotidienne, que la boucle prenait pour un mur de débit
   *   6  la guilde retirée : `lot`, `publiees`, `watchGuild`, `karmaVu`, `guildSeen`
   *
   * À incrémenter quand une migration s'ajoute, et à traiter dans `restore()`.
   * Les trois marqueurs booléens restent lus une dernière fois, pour déduire
   * le numéro d'un stockage écrit avant lui — voir `restore()`.
   */
  const SCHEMA = 6;

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
    majAt: 0,              // dernière vérification du numéro en ligne
    majDispo: '',          // version publiée, si elle est plus récente que la nôtre
    packsReadAt: 0,        // dernier relevé de la réserve lu en base
    dbNote: '',            // ce que la base a répondu, pour le voir sans la console
    pity: null,            // compteur de pitié courant, tel que le porte le profil
    pityMax: 0,            // plus haute valeur jamais vue — révèle le palier
    balance: null,         // wikibidous disponibles
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
    /*
     * Les souhaits qu'un ami détient. Dérivé de la MÊME lecture que `wish` :
     * chaque réponse de la liste de souhaits porte déjà `friendOwners`, et
     * l'ignorer revenait à jeter la moitié de ce qu'on venait de payer.
     */
    troc: { at: 0, lignes: [], amis: 0, enAttente: 0 },
    /*
     * Le haut du classement, gardé un jour : il bouge lentement, et chaque
     * page coûte une seconde et demie au serveur. `amis` est le dernier relevé
     * de la liste d'amis — seulement sa date et le nombre de demandes reçues ;
     * le reste vit dans la mémoire des demandes, voir `lireVus`.
     */
    classement: { at: 0, prof: 0, lignes: [] },
    amis: { at: 0, recues: 0 },
    message: 'Prêt.',
    warn: false,
    /*
     * Ce que chaque sous-système a fait de son dernier tour. Voir `noterEchec`.
     * nom -> { echecs, depuis, dernier, arret, ok }
     */
    sains: {},
    // Anneau des derniers événements de sous-système, pour le diagnostic.
    faits: [],
    // Ce que chaque sélecteur du site trouve, ou ne trouve plus. Voir `vu`.
    selecteurs: {},
  };

  /**
   * Plancher effectif du délai entre deux ouvertures : la borne de config tant
   * que le serveur n'a rien refusé, le plancher appris dès le premier 429.
   */
  function floorMs() {
    return Math.max(CFG.floorDelayMs, state.probeFloorMs);
  }

  // ------------------------------------------------ filet des tours secondaires

  /*
   * Pourquoi ce filet, alors que la boucle principale a déjà le sien.
   *
   * La boucle d'ouverture compte ses refus, plafonne son recul, abandonne au
   * bout de quatre et le DIT dans le panneau. Les tours secondaires — relance
   * des invendus, guetteur d'enchères, guetteur de souhaits — n'avaient qu'un
   * `catch` vide, commenté « le tour suivant rattrapera ». Tant que le tour
   * suivant rattrape, c'est vrai.
   *
   * Le jour où le site change la forme de sa mise en vente, le tour suivant
   * échoue lui aussi, et le suivant, et celui d'après. Quelqu'un qui a coché
   * « relances automatiques » croit ses invendus remis en vente alors qu'ils
   * ne le sont plus, et RIEN ne le lui dit — ni le panneau, ni la console. Il
   * peut le découvrir des jours plus tard. C'est le défaut le plus grave du
   * fichier, parce qu'il touche une fonction qui agit sur le compte et qu'il
   * est parfaitement muet.
   *
   * Le filet est celui de la boucle principale, transposé : on compte les
   * échecs d'affilée, on remet à zéro au premier succès, et au-delà du seuil
   * on arrête CE tour-là — pas l'outil — avec une note dans le panneau et un
   * bouton pour réessayer. Le seuil vaut quatre, comme `maxThrottleRetries` :
   * la même question, la même réponse.
   */
  const MAX_ECHECS = 4;

  /*
   * Trente événements retenus. C'est ce qui manque au diagnostic pour répondre
   * à « depuis quand ? » : un instantané dit où on est, pas comment on y est
   * arrivé. Trente couvre plusieurs heures de tours secondaires sans peser.
   */
  const FAITS_GARDES = 30;

  /*
   * Le nom que porte chaque tour à l'écran. Il est écrit ici et pas à l'appel
   * pour qu'une note du panneau et une ligne de diagnostic disent la MÊME
   * chose du même sous-système.
   */
  const SOUS_SYSTEMES = {
    relances: 'Les relances automatiques',
    marche: 'La surveillance du Marché',
    souhaits: 'La veille des souhaits',
    stockage: 'La mémoire du navigateur',
  };

  /*
   * Ce que la panne coûte, dit dans les mots du jeu. Une note qui annonce
   * « relances arrêtées » sans dire ce que ça change laisse chercher ; c'est
   * la deuxième phrase qui fait décider de réessayer ou d'aller voir ailleurs.
   */
  const PLAINTES = {
    relances: 'ne repartent plus : vos invendus restent hors du Marché tant que rien ne les relance',
    marche: 'est arrêtée : ni relevé des enchères, ni journal des ventes',
    souhaits: 'est arrêtée : les cartes souhaitées mises en vente ne seront plus signalées',
    stockage: 'refuse d’écrire — le navigateur est plein. Réglages, cote et cartes suivies '
      + 'ne survivront pas au rechargement de la page',
  };

  const suivi = (nom) => (state.sains[nom]
    || (state.sains[nom] = { echecs: 0, depuis: 0, dernier: '', arret: false, ok: 0 }));

  /** Le message d'une exception, borné : la ligne va au panneau et au diagnostic. */
  const raison = (err) => String((err && err.message) || err || 'sans détail').slice(0, 120);

  function noterFait(nom, verdict, detail) {
    state.faits.push({ at: Date.now(), nom, verdict, detail: detail || '' });
    if (state.faits.length > FAITS_GARDES) state.faits.splice(0, state.faits.length - FAITS_GARDES);
  }

  /** Un tour a abouti : le compteur repart, et un rétablissement se dit. */
  function noterSucces(nom) {
    const s = suivi(nom);
    const relevait = s.arret;
    if (s.echecs || s.arret) noterFait(nom, 'rétabli', `après ${s.echecs} échec(s)`);
    s.echecs = 0;
    s.depuis = 0;
    s.dernier = '';
    s.arret = false;
    s.ok = Date.now();
    /*
     * Et l'écran suit tout de suite. Le panneau ne se redessine sur aucune
     * horloge : il attend un événement. Sans cet appel, la note d'un tour
     * rétabli restait affichée jusqu'à ce que tout autre chose provoque un
     * rendu — c'est-à-dire indéfiniment sur un panneau qu'on ne touche pas.
     * Une note qui ment dans ce sens-là est pire que pas de note : elle est
     * écrite, donc on la croit.
     */
    if (relevait) renderPannes();
  }

  /**
   * Un tour a échoué. Rend `true` quand le seuil est franchi, c'est-à-dire
   * quand l'appelant doit cesser de réessayer.
   *
   * @param {number} [seuil] pour les pannes qui n'ont pas de tour suivant —
   *   le stockage refuse tout de suite ou jamais, il ne se compte pas.
   */
  function noterEchec(nom, err, seuil = MAX_ECHECS) {
    const s = suivi(nom);
    s.echecs += 1;
    if (!s.depuis) s.depuis = Date.now();
    s.dernier = raison(err);
    noterFait(nom, 'échec', s.dernier);
    console.warn(
      `[WikiMasters Tools] ${SOUS_SYSTEMES[nom] || nom} — échec ${s.echecs}/${seuil} :`,
      err
    );
    if (s.echecs >= seuil && !s.arret) {
      s.arret = true;
      noterFait(nom, 'arrêté', `${s.echecs} échec(s) d’affilée`);
      console.error(
        `[WikiMasters Tools] ${SOUS_SYSTEMES[nom] || nom} — arrêté après `
        + `${s.echecs} échec(s) d’affilée. Dernier : ${s.dernier}`
      );
      renderPannes();
    }
    return s.arret;
  }

  const enPanne = (nom) => !!(state.sains[nom] && state.sains[nom].arret);

  /*
   * Ce que « le tour a réussi » veut dire — et pourquoi un `catch` ne suffit
   * pas. C'est le piège de ce fichier, et il a failli faire poser un filet
   * qui n'attrape rien.
   *
   * Le code est très défensif, chaque étage rattrape le sien : `scanSales()`
   * avale son échec réseau, `fetchMySales()` rend `null` plutôt que de lever,
   * et `reconcileWatch()` se retire poliment quand le relevé des ventes est
   * périmé — « le tour suivant rattrapera ». Trois `try` bien élevés, zéro
   * exception, et une relance qui ne relance plus rien. Éprouvé au banc : en
   * coupant tout le réseau sauf l'ouverture des paquets, la relance échouait
   * soixante fois par minute et le compteur d'échecs restait à ZÉRO.
   *
   * Le verdict porte donc sur le RÉSULTAT, pas sur l'absence d'exception : le
   * relevé des ventes est-il frais ? C'est la donnée dont dépendent la relance
   * et la surveillance du Marché ; si elle cesse de se rafraîchir, les deux
   * tournent à vide, qu'il y ait eu exception ou non.
   *
   * La même borne sert à `reconcileWatch`, qui refuse d'agir en dessous : deux
   * chiffres séparés dériveraient, et le tour serait alors jugé bon pendant
   * que la fonction qu'il appelle refuse de travailler.
   */
  const VENTES_POUR_AGIR_MS = 60000;
  const ventesSuresPourAgir = () => Date.now() - state.sales.at < VENTES_POUR_AGIR_MS;

  /** Le bouton « Réessayer » de la note : on repart, sans rien effacer du journal. */
  function relancerSousSysteme(nom) {
    const s = suivi(nom);
    s.echecs = 0;
    s.depuis = 0;
    s.arret = false;
    noterFait(nom, 'relancé', 'à la main');
    renderPannes();
  }

  // -------------------------------------------- les sélecteurs du site, surveillés

  /*
   * La dépendance la plus fragile du fichier, et ce n'est pas celle qu'on
   * croit.
   *
   * `FILTER_ROW` (« .flex.flex-wrap.gap-2 ») et `CARD_ITEM`
   * (« .relative.isolate.group ») ne sont faits que de classes utilitaires
   * Tailwind. Une recompilation du site avec une purge différente, ou un autre
   * bloc qui porte les mêmes trois classes, et le script vise le mauvais
   * élément — ou plus rien. Dans ce cas la fonction ne fait SIMPLEMENT RIEN :
   * pas d'exception, pas de trace, pas de message. Le filtre « Nouveaux » ne
   * paraît plus, la recherche ne s'applique plus, et rien ne dit pourquoi.
   *
   * (La lecture directe des jetons Supabase, qui a l'air bien plus risquée,
   * est en comparaison la mieux défendue du fichier : trois formats tolérés,
   * tout sous `try/catch`, et un repli documenté pour chaque appelant.)
   *
   * On ne peut pas rendre ces sélecteurs robustes — ils décrivent un balisage
   * qui ne nous appartient pas. On peut rendre leur perte RACONTABLE : un
   * compteur d'échecs d'affilée, et une ligne au diagnostic. Ce qui arrivera
   * un jour cesse alors d'être « le panneau ne fait plus rien » pour devenir
   * « le sélecteur de la barre de filtres n'a rien trouvé 40 fois ».
   *
   * Le seuil est haut à dessein : ces sélecteurs manquent LÉGITIMEMENT tant
   * que React n'a pas rendu la page, ou juste après une navigation. Dix
   * passages à vide d'affilée, en revanche, ne s'expliquent plus par un
   * retard de rendu.
   */
  const SELECTEUR_ALERTE = 10;

  /*
   * Les noms sont ceux qu'on lirait à voix haute, pas ceux des constantes :
   * le compteur finit dans un diagnostic collé sur le Discord, où « la barre
   * de filtres » se comprend et « FILTER_ROW » ne se comprend pas.
   */
  const NOM_FILTRES = 'la barre de filtres';
  const NOM_TUILE = 'la tuile d’une carte';
  const NOM_RECHERCHE = 'le champ de recherche';

  /**
   * Retient ce qu'un sélecteur du site vient de donner, et rend l'élément tel
   * quel — pour s'insérer dans une expression sans rien changer à son sens.
   */
  function marquerSelecteur(nom, sel, el) {
    const s = state.selecteurs[nom]
      || (state.selecteurs[nom] = { sel, vus: 0, manques: 0, depuis: 0, perdu: false });
    if (el) {
      if (s.perdu) {
        noterFait('sélecteur', 'rétabli', nom);
        console.info(`[WikiMasters Tools] le sélecteur « ${nom} » retrouve son élément.`);
      }
      s.vus += 1;
      s.manques = 0;
      s.depuis = 0;
      s.perdu = false;
      return el;
    }
    s.manques += 1;
    if (!s.depuis) s.depuis = Date.now();
    if (s.manques >= SELECTEUR_ALERTE && !s.perdu) {
      s.perdu = true;
      noterFait('sélecteur', 'perdu', `${nom} (${sel})`);
      console.warn(
        `[WikiMasters Tools] le sélecteur « ${nom} » (${sel}) n’a rien trouvé `
        + `${s.manques} fois de suite. Le site a probablement changé son balisage : `
        + 'c’est à signaler, la fonction qui en dépend ne fait plus rien.'
      );
    }
    return null;
  }

  /** `document.querySelector`, mais qui se souvient de ses échecs. */
  const vu = (nom, sel, racine) =>
    marquerSelecteur(nom, sel, (racine || document).querySelector(sel));

  /** `Element.closest`, même mémoire. */
  const vuAutour = (nom, sel, depuis) =>
    marquerSelecteur(nom, sel, (depuis && depuis.closest(sel)) || null);

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
    autoResume: true,    // repartir seul dès que la vérification humaine est passée
    watchBids: true,
    watchWish: false,     // signaler les cartes de la liste de souhaits mises en vente
    relistUnsold: false,  // remettre en vente les invendus, au même prix et durée
    masquerInvendus: true, // retirer les fins d'enchère sans preneur du panneau du site
    logRarity: null,      // rareté isolée dans le journal, null = tout
    folded: false,
    tab: 'paquets',       // onglet actif : paquets | succes | marche | guilde | reglages
    mktSub: 'ench',       // volet du Marché : ench | vent | rel
    /*
     * Le journal des relances, replié par défaut.
     *
     * Six issues, dont les refus et les baisses prennent deux lignes chacun :
     * il occupait la moitié du volet en permanence, au-dessus du bouton
     * Revente et sous les cartes suivies — soit entre les deux choses qu'on
     * vient y faire. On le consulte de temps en temps, pas à chaque coup d'œil.
     * Son intitulé porte le compte, donc replié il dit encore s'il s'est passé
     * quelque chose.
     */
    relistLogOuvert: false,
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
      noterSucces('stockage');
    } catch (err) {
      /*
       * « on tourne sans mémoriser » : c'est vrai, et c'était muet.
       *
       * Sur les grosses collections, le quota du navigateur se remplit, et ce
       * qui cesse d'être écrit ne se voit pas : on constate juste que « ça
       * rescanne à chaque fois », ou qu'un réglage ne tient pas au rechargement,
       * sans jamais savoir pourquoi. La cause est ici, et elle tient en une
       * ligne à l'écran.
       *
       * Seuil de 1 : le stockage ne se compte pas en tours. Il refuse tout de
       * suite ou jamais, et un deuxième essai ne dirait rien de plus.
       */
      noterEchec('stockage', err, 1);
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
    /*
     * Un plancher écrit par l'ancienne règle n'est pas une mesure : il enflait
     * à CHAQUE refus d'une série, alors qu'une série ne renseigne qu'une fois.
     * Sept refus d'affilée le portaient à 40 s — près du plafond — sans que le
     * serveur ait jamais refusé un délai de 40 s. Ces valeurs-là sont des
     * artefacts, on les jette une bonne fois ; le prochain refus réel le
     * réapprendra proprement. Même raisonnement que pour le délai d'avant 1.77
     * juste en dessous.
     */
    /*
     * Le DÉLAI part avec le plancher. Vu sur un compte réel : plancher remis à
     * zéro mais délai laissé à 40 s, il redescend alors de 250 ms par paquet
     * réussi — cent cinquante-sept paquets, soit huit heures, pour revenir d'un
     * chiffre qui n'avait jamais rien mesuré. Les deux sont le même artefact ;
     * le premier refus réel les rétablira ensemble.
     *
     * Le marqueur porte un nom neuf. Une première version ne remettait que le
     * plancher et posait déjà `planchersRelus` : là où elle est passée, la
     * migration complète n'aurait jamais pu s'exécuter. Un marqueur à demi
     * consommé ne se rattrape pas — il se remplace.
     */
    /*
     * Deuxième remise à zéro, et pour une raison neuve : tant que le verrou ne
     * tenait pas, une partie des 429 était FABRIQUÉE par deux boucles ouvrant
     * ensemble depuis deux onglets. Le plancher qu'ils ont appris ne mesure
     * donc pas le débit du serveur, il mesure un défaut de l'outil — et il se
     * transmettait de session en session, `delayMs` étant persisté et ne
     * reculant que de 250 ms par succès.
     *
     * Relevé sur un compte réel avant le correctif : `delayMs` et
     * `probeFloorMs` tous deux à 60 000 ms, le plafond, sur un compte qui
     * ouvrait ses paquets à une minute d'intervalle. Aucun serveur n'a jamais
     * refusé ce rythme-là. On repart du départ, et le prochain refus — un vrai,
     * cette fois — le réapprendra proprement.
     *
     * Marqueur neuf plutôt que réutilisation de `debitRecalibre` : là où
     * l'ancien est déjà posé, une condition qui le relit ne s'exécuterait
     * jamais. C'est la leçon de la migration précédente, écrite juste au-dessus.
     */
    /*
     * Troisième remise à zéro, et la deuxième en une journée — ce qui mérite
     * d'être dit plutôt que masqué. Celle de la 2.13.0 a été effectuée, puis le
     * plancher est remonté au plafond en moins d'une heure sur un compte réel :
     * le correctif d'alors bornait le pas du plancher, pas la base sur laquelle
     * il se calculait. Ces valeurs-là ne mesurent donc toujours rien.
     *
     * Marqueur neuf, encore : `debitVerrou` est déjà posé partout où la 2.13.0
     * est passée, et une condition qui le relit ne s'exécuterait jamais.
     */
    /*
     * ET C'EST LA DERNIÈRE MIGRATION QUI SE DEVINE.
     *
     * Les trois commentaires ci-dessus racontent la même mésaventure trois
     * fois : un marqueur booléen posé pour une migration, puis inutilisable
     * pour la suivante parce qu'il est DÉJÀ posé là où la précédente est
     * passée. D'où `debitRecalibre`, puis `debitVerrou`, puis `debitCliquet` —
     * trois clés dans le même blob, dont deux ne servent plus à rien et que
     * personne n'osera jamais retirer, faute de savoir qui les lit encore.
     * Chaque migration coûtait plus cher que la précédente.
     *
     * Un numéro règle ça une bonne fois : une migration se compare, elle ne se
     * devine plus. La suivante s'écrit `if (schemaLu < 5)` — juste en
     * dessous —, sans qu'aucun marqueur ait eu à être inventé.
     *
     * Le numéro est DÉDUIT des anciens marqueurs quand il manque, et c'est le
     * point délicat : traiter « pas de numéro » comme « schéma 0 » rejouerait
     * les trois recalibrages chez tout le monde, c'est-à-dire effacerait un
     * plancher légitimement appris. On ne migre que ce qui n'a pas migré.
     */
    const schemaLu = Number.isFinite(s.schema)
      ? s.schema
      : (s.debitCliquet ? 3 : s.debitVerrou ? 2 : s.debitRecalibre ? 1 : 0);

    /*
     * Quatrième remise à zéro — la première qui se compare au lieu de se
     * deviner. Le serveur a désormais une limite QUOTIDIENNE : relevé sur un
     * compte réel le 12 septembre 2026, un 429 « Limite quotidienne de paquets
     * atteinte » à chaque régénération, deux minutes après l'appel précédent.
     * La boucle le prenait pour un mur de débit, et chaque cycle de trois
     * minutes relevait le plancher de 300 ms : plancher et délai étaient au
     * plafond de 60 s. Un plancher appris avant `surLimiteQuotidienne` a pu
     * l'être ainsi, et rien ne permet de distinguer le vrai du faux : il part,
     * et le prochain refus de débit — un vrai — le réapprendra.
     */
    if (schemaLu < 5) {
      saveStore({ debitCliquet: true, probeFloorMs: 0, delayMs: CFG.startDelayMs });
    } else {
      if (Number.isFinite(s.probeFloorMs)) {
        state.probeFloorMs = Math.min(CFG.ceilDelayMs, Math.max(0, s.probeFloorMs));
      }
      /*
       * Le PLANCHER se relit, le DÉLAI non — et c'est une distinction de nature,
       * pas un raccourci.
       *
       * Le plancher est une mesure : le serveur a refusé, on a retenu où. Le
       * délai courant, lui, n'est qu'un recul temporaire — la valeur qu'il a au
       * moment où l'onglet se ferme est celle d'un incident en cours, gonflée
       * de 60 % par refus, pas un rythme constaté.
       *
       * Le relire était le dernier engrenage vers le haut. Une série de refus
       * portait le délai à 20 s, la page se rechargeait, et la session suivante
       * repartait à 20 s pour ne regagner que 250 ms par succès : huit heures
       * pour effacer un incident de trente secondes. Le plancher, lui, ne peut
       * plus s'emballer depuis que la marge est additive ; il n'y avait plus de
       * raison de laisser le délai le faire.
       *
       * On repart donc du départ, borné par le plancher appris : c'est lui qui
       * porte ce qu'on sait du serveur, et il suffit.
       *
       * Il continue d'être ÉCRIT dans le stockage, et ce n'est pas un oubli :
       * c'est en l'y lisant sur un compte réel qu'on a vu l'emballement. Écrit
       * pour le diagnostic, jamais relu pour agir.
       */
      state.delayMs = Math.max(floorMs(), CFG.startDelayMs);
    }
    /*
     * La guilde est retirée — le lot à publier, l'alerte, la table de karma :
     * leurs clés n'ont plus de lecteur. La liste des cartes publiées pesait
     * jusqu'à trois cents identifiants, le registre des souhaits vus jusqu'à
     * quatre cents, dans un stockage qu'on sait proche du plafond sur les
     * grosses collections. Une clé à `undefined` disparaît au `JSON.stringify`.
     */
    if (schemaLu < 6) {
      saveStore({ lot: undefined, publiees: undefined, watchGuild: undefined,
                  karmaVu: undefined, guildSeen: undefined });
    }
    if (Number.isFinite(s.cadenceMs)) state.cadenceMs = s.cadenceMs;
    // Le maximum du compteur de pitié s'accumule d'une session à l'autre : c'est
    // le nombre de tirages observés qui lui donne sa valeur, pas leur continuité.
    if (Number.isFinite(s.pityMax)) state.pityMax = s.pityMax;
    if (typeof s.logRarity === 'string' || s.logRarity === null) prefs.logRarity = s.logRarity;
    if (['paquets', 'marche', 'guilde', 'reglages'].includes(s.tab)) prefs.tab = s.tab;
    if (s.classement && Array.isArray(s.classement.lignes) && Number.isFinite(s.classement.at)) {
      state.classement = s.classement;
    }
    if (['ench', 'vent', 'rel', 'souh'].includes(s.mktSub)) prefs.mktSub = s.mktSub;
    if (typeof s.relistLogOuvert === 'boolean') prefs.relistLogOuvert = s.relistLogOuvert;
    // Reprise de l'ancien réglage à étiquette unique.
    if (typeof s.sellHideTag === 'string' && s.sellHideTag) sellPrefs.hideTags = [s.sellHideTag];
    if (Array.isArray(s.sellHideTags)) sellPrefs.hideTags = s.sellHideTags;
    if (typeof s.sellHideTagged === 'boolean') sellPrefs.hideTagged = s.sellHideTagged;
    // Les trois autres filtres de la Revente, oubliés à chaque rechargement.
    if (Number.isFinite(s.sellMin) && s.sellMin >= 1) sellPrefs.minSales = s.sellMin;
    if (s.sellRar === '' || RARITIES.includes(s.sellRar)) sellPrefs.rarity = s.sellRar;
    if (typeof s.sellFree === 'boolean') sellPrefs.onlyFree = s.sellFree;
    if (typeof s.sellJournal === 'boolean') sellPrefs.journalOuvert = s.sellJournal;
    if (typeof s.sellAide === 'boolean') sellPrefs.aide = s.sellAide;
    if (s.sellTri === '' || (typeof s.sellTri === 'string' && s.sellTri in VALEUR_TRI)) sellPrefs.tri = s.sellTri;
    if (s.sellSens === 1 || s.sellSens === -1) sellPrefs.sens = s.sellSens;
    if (s.bids && Array.isArray(s.bids.list)) state.bids = s.bids;
    if (Array.isArray(s.journal)) state.journal = s.journal;
    /*
     * Un prix demandé n'est effacé que par la notification qui tranche la
     * vente — et `/api/notifications` n'en garde que cinquante. Une
     * notification manquée laissait donc l'entrée à vie. On oublie ce qui
     * n'aura plus jamais d'issue à confronter.
     */
    if (s.asks && typeof s.asks === 'object') {
      for (const [titre, a] of Object.entries(s.asks)) {
        if (a && Number.isFinite(a.at) && Date.now() - a.at < ASK_TTL) state.asks[titre] = a;
      }
    }
    if (s.lastListing && typeof s.lastListing === 'object') state.lastListing = s.lastListing;
    if (s.myAuctions && typeof s.myAuctions === 'object') state.myAuctions = s.myAuctions;
    /*
     * Une carte en pause ne repart jamais d'elle-même : sans purge, le volet
     * Relances devient un cimetière que seul « Tout arrêter » vide. Au-delà de
     * `WATCH_PAUSE_TTL`, l'inscription a perdu son sens — la carte a été vendue
     * ailleurs, retirée à la main, ou n'existe plus.
     */
    if (s.watch && typeof s.watch === 'object') {
      for (const [card, w] of Object.entries(s.watch)) {
        if (!w) continue;
        /*
         * Mise en pause par une version qui ne datait pas l'événement. Sans
         * horodatage, la purge ne pouvait pas s'y appliquer : ces cartes-là
         * étaient immortelles, et un compte réel en portait sept. On les date
         * de maintenant — elles ont donc sept jours à partir de la mise à
         * jour, plutôt que l'éternité.
         */
        if (w.paused && !Number.isFinite(w.pausedAt)) w.pausedAt = Date.now();
        if (w.paused && Date.now() - w.pausedAt > WATCH_PAUSE_TTL) continue;
        state.watch[card] = w;
      }
    }
    // Un créneau écrit sous un intervalle plus long ne doit pas geler la
    // reprise : au plus loin, il vaut un écart complet à partir de maintenant.
    if (Number.isFinite(s.nextRelistAt)) {
      state.nextRelistAt = Math.min(s.nextRelistAt, Date.now() + CFG.relistGapMs[1]);
    }
    if (Array.isArray(s.relistLog)) state.relistLog = s.relistLog;
    /*
     * L'heure de la dernière vérification survit au rechargement : sans elle,
     * ouvrir dix onglets ferait dix requêtes. Un horodatage venu du futur —
     * horloge reculée, stockage recopié — vaut « jamais vérifié » plutôt que de
     * bloquer la vérification pour toujours.
     */
    if (Number.isFinite(s.majAt) && s.majAt <= Date.now()) state.majAt = s.majAt;
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
    if (s.troc && Array.isArray(s.troc.lignes)) state.troc = s.troc;

    const st = s.stats;
    if (st && typeof st === 'object') {
      state.packs = st.packs || 0;
      state.cards = st.cards || 0;
      state.history = Array.isArray(st.history) ? st.history.slice(0, CFG.historyLength) : [];
      state.since = st.since || Date.now();
    }

    /*
     * Et on inscrit le numéro, une fois la relecture faite. Écrit en dernier,
     * pas en premier : si quoi que ce soit au-dessus lève, le stockage garde
     * son ancien numéro et la migration se rejouera au prochain démarrage —
     * ce qui est le bon sens de l'erreur.
     */
    if (schemaLu !== SCHEMA) saveStore({ schema: SCHEMA });
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
    /*
     * Et la pastille de rareté isolée aussi, pour la même raison — elle ne
     * l'était pas. Les pastilles disparaissaient avec l'historique, mais le
     * filtre restait armé : le journal se vidait sans dire pourquoi, sous un
     * « Voir les 0 R dans la collection → » qui ne menait nulle part. Aucune
     * pastille à recliquer pour le désarmer, puisqu'il n'y en avait plus.
     */
    prefs.logRarity = null;
    saveStore({ logRarity: null });
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
  /*
   * UN seul sélecteur pour le champ de recherche du site.
   *
   * Il en existait deux : celui-ci, et un « Recherch » écrit en dur dans la
   * navigation vers les échanges — préfixe plus court, sans explication.
   * Personne ne savait plus lequel disait vrai, et une page du site qui
   * renomme son champ en aurait cassé un sans toucher l'autre. Deux vérités
   * pour un même fait, c'est une de trop.
   */
  const SEARCH_SELECTOR = 'input[placeholder*="Rechercher"]';

  /*
   * La marque que le site pose sur un filtre actif. Le prédicat était écrit
   * deux fois, dans deux fonctions sans lien — la sélection d'une rareté dans
   * la collection, et la lecture de la barre des souhaits — et il n'y a
   * pourtant qu'un seul fait à connaître.
   */
  const chipActive = (btn) => /ring-2/.test((btn && btn.className) || '');

  /*
   * Combien de temps un bouton reste ARMÉ entre le premier clic et sa
   * confirmation.
   *
   * Trois boutons du panneau demandent deux clics — la remise à zéro des
   * compteurs, « Tout repasser en X minutes », « Tout souhaiter » — et ils
   * portaient trois valeurs : 4 000, 6 000, 6 000. Rien n'expliquait le
   * 4 000, et dans un fichier où chaque constante est justifiée, une valeur
   * sans raison est le signe d'une accrétion, pas d'un choix.
   *
   * On tranche pour 6 000, la seule des trois qui portait une raison : le
   * compte annoncé doit avoir le temps d'être LU. Ce délai ne dépend pas du
   * bouton, il dépend de l'œil qui lit — et c'est le même œil.
   */
  const ARME_MS = 6000;

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
    const row = vu(NOM_FILTRES, FILTER_ROW);
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
    const titres = document.querySelectorAll('h3');
    for (const h of titres) {
      const item = h.closest(CARD_ITEM);
      if (item) items.push({ item, isNew: fresh.has(h.textContent.trim()) });
    }
    /*
     * Une marque par PASSAGE, pas une par carte : la collection en porte des
     * milliers, et le compteur ne mesurerait plus que leur nombre. Et rien
     * n'est marqué tant que la page n'a pas rendu ses titres — sans eux, il
     * n'y a pas de tuile à trouver, c'est un fait sur le rendu, pas sur nous.
     */
    if (titres.length) marquerSelecteur(NOM_TUILE, CARD_ITEM, items.length ? items[0].item : null);
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
   * La collection est paginée CÔTÉ SERVEUR : 50 cartes par page, et
   * `/api/my-collection` ne connaît qu'un tri — `sort=rarity`. Réordonner les
   * nœuds affichés ne trierait donc que les 50 cartes sous les yeux : sur une
   * collection qui tient en centaines de pages, ça ne répond pas à la question
   * posée, « lesquelles de mes cartes valent quelque chose ».
   *
   * On trie donc la collection ENTIÈRE et on laisse le site l'afficher : la
   * réponse de `/api/my-collection` est interceptée, et son tableau `collection`
   * remplacé par la tranche correspondante de notre classement. Le site rend ses
   * propres cartes ; sa pagination, ses filtres de rareté et d'étiquette et sa
   * recherche continuent de fonctionner — seul l'ordre change. Ces filtres-là,
   * le classement doit les reproduire lui-même : voir `filterValueRows`, et ce
   * qu'il en coûte de n'en oublier un. Le reste de la réponse est
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
   * Classe la collection entière. La lecture coûte une requête par page : elle
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
      /*
       * Le même nombre sert à dire ce que la cote couvre. Le prendre au passage
       * évite une seconde requête, et surtout : sans lui, l'avertissement du
       * tri par prix ne pourrait s'afficher qu'après une ouverture de la
       * Revente — c'est-à-dire jamais, pour qui trie sa collection sans jamais
       * passer par elle.
       */
      if (valueTotal > 0) sell.owned = { n: valueTotal, at: Date.now() };

      const cartes = await fetchCollectionRaw((n) => {
        valueRead = n;
        paintValueSort();
      });
      /*
       * Un classement partiel ferait DISPARAÎTRE des cartes : le site continue
       * d'annoncer toutes ses pages, et les dernières se retrouveraient vides.
       * Mieux vaut ne pas allumer le tri que d'amputer la collection.
       */
      if (!cartes.length || sell.tronque) return false;

      /*
       * Le compte, maintenant qu'il veut dire quelque chose.
       *
       * Les doublons masquaient ce contrôle : la liste était plus LONGUE que la
       * collection, quoi qu'il arrive. Dédoublonnée, elle peut être plus courte
       * — c'est le cas symétrique, une carte vendue ou donnée pendant les vingt
       * secondes de lecture, qui décale vers l'arrière et fait sauter une
       * entrée. Rare, mais plus masqué.
       *
       * Le total est relevé AVANT la lecture, et la collection ne fait que
       * grossir pendant : en régime normal on en a donc plus, jamais moins. Un
       * manque d'une page entière signale autre chose, et là on n'allume pas —
       * même règle que pour une lecture tronquée, pour la même raison : une
       * page vide dans la collection du site est pire qu'un tri absent.
       */
      if (valueTotal && cartes.length < valueTotal - COLLECTION_PAGE) {
        console.info('[WikiMasters Tools] tri par valeur : lecture incomplète —',
          `${cartes.length} lignes pour ${valueTotal} annoncées, ${sell.doublons} doublon(s) écarté(s).`);
        return false;
      }

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

  /*
   * Les filtres du site, reproduits sur le classement.
   *
   * LE PIÈGE : le proxy rend une tranche de SA liste, pas de celle du serveur.
   * Un filtre qu'il ne reproduit pas est donc purement et simplement perdu —
   * « Sans étiquette » sélectionnée, la collection continuait d'afficher les
   * cartes étiquetées, et le tri avait l'air d'ignorer le filtre. Il l'ignorait.
   *
   * Relevé sur les requêtes du site :
   *   `rarity=SR&rarity=R`  la rareté est RÉPÉTÉE, une occurrence par rareté
   *                         cochée. `get()` n'en lisait que la première : à deux
   *                         raretés, la seconde disparaissait de la page.
   *   `tag_id=<uuid>`       une étiquette précise
   *   `untagged=1`          « Sans étiquette »
   *
   * Les étiquettes voyagent avec chaque entrée de `/api/my-collection` — `tags`,
   * un tableau d'objets `{id, name, …}` — donc le classement les porte déjà et
   * les reproduire ne coûte aucune requête. Vérifié sur une collection
   * entière : le prédicat local et `untagged=1` désignent exactement le même
   * ensemble, à un exemplaire près aucun écart.
   *
   * Un paramètre inconnu rend la main au site plutôt que d'afficher les mauvaises
   * cartes : un filtre ajouté demain éteindra le tri sur cette vue-là, il ne
   * mentira pas dessus.
   */
  const COLLECTION_PARAMS = new Set(
    ['sort', 'page', 'stats', 'limit', 'q', 'rarity', 'tag_id', 'untagged']
  );

  /** @returns {Array|null} le classement filtré, ou `null` si un filtre échappe. */
  function filterValueRows(p) {
    for (const [cle, val] of p) if (val && !COLLECTION_PARAMS.has(cle)) return null;

    const raretes = p.getAll('rarity').filter(Boolean);
    const untagged = p.get('untagged');
    const tag = p.get('tag_id');

    let out = valueRows;
    if (raretes.length) {
      const voulues = new Set(raretes);
      out = out.filter((e) => e.card && voulues.has(e.card.rarity));
    }
    if (untagged && untagged !== '0') out = out.filter((e) => !e.tags || !e.tags.length);
    else if (tag) out = out.filter((e) => e.tags && e.tags.some((t) => t && t.id === tag));
    return out;
  }

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

        const liste = filterValueRows(p);
        if (!liste) return res;  // un filtre qu'on ne sait pas reproduire
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
    const row = vu(NOM_FILTRES, FILTER_ROW);
    if (!row) return;
    /*
     * L'avertissement doit être là AVANT qu'on se fie au tri, pas après l'avoir
     * allumé une fois. Une requête, gardée deux minutes, et seulement s'il y a
     * une cote dont on puisse dire quelque chose.
     */
    if (sell.rows.length) refreshOwned();

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

    /*
     * « Prix », et non « Valeur ».
     *
     * Chaque carte du site porte déjà deux nombres, attaque et défense, qui
     * servent aux batailles. Poser « Valeur ↓ » au milieu de leurs filtres
     * laissait croire à un tri sur ces statistiques-là, alors qu'il porte sur
     * le prix de revente. Le mot juste lève l'ambiguïté à lui seul.
     */
    if (valueBusy) {
      const pct = valueTotal ? Math.min(99, Math.round((valueRead / valueTotal) * 100)) : 0;
      b.textContent = `Prix ↓ · lecture ${pct} %`;
      /*
       * Le nombre de pages venait d'une constante, c'est-à-dire de la
       * collection de qui a écrit la ligne. Sur un compte qui débute, il y en a
       * quatre. On annonce ce qu'on lit vraiment, et rien tant qu'on ne le sait
       * pas encore.
       */
      b.title = valueTotal
        ? `Lecture de la collection entière — ${Math.ceil(valueTotal / COLLECTION_PAGE)
            .toLocaleString('fr-FR')} pages, quelques secondes`
        : 'Lecture de la collection entière — quelques secondes';
    } else if (sell.scanning) {
      const pct = sell.total ? Math.min(99, Math.round((sell.done / sell.total) * 100)) : 0;
      b.textContent = `Prix ↓ · cote ${pct} %`;
      b.title = 'Relevé des prix en cours dans la Revente — le tri s’allumera dès qu’il sera fini';
    } else if (sell.refusVentes === 403 && !sell.rows.length) {
      /*
       * Compte gratuit : le marché d'une carte — moyenne, min, max, graphique —
       * est vendu avec l'abonnement, le site le dit dans son propre encart. Il
       * n'y a alors aucun prix à classer, et proposer un relevé qui échouera
       * encore serait se moquer du monde.
       */
      b.textContent = 'Prix ↓ · réservé aux comptes PRO';
      b.title = 'Le site réserve les prix aux comptes PRO. Cochez « Accès direct à '
        + 'la base » dans les réglages : les prix redeviennent lisibles sans abonnement, '
        + 'et ce tri avec eux.';
    } else if (!sell.rows.length) {
      /*
       * La cote vit dans le `localStorage` : elle est donc vide sur un
       * navigateur qui n'a jamais fait le relevé, même si le compte est le même
       * — c'est le premier clic sur un autre poste. Le bouton doit l'annoncer,
       * sans quoi il ouvre la Revente sans qu'on comprenne pourquoi : un
       * libellé identique à l'état qui trie promettait un tri, pas un relevé.
       */
      b.textContent = 'Prix ↓ · à relever';
      b.title = 'Le classement a besoin du prix de vos cartes, et rien n’a encore été relevé sur '
        + 'ce navigateur. Le clic ouvre la Revente, qui lance le relevé — plusieurs minutes. '
        + 'Le tri s’allume ensuite.';
    } else {
      b.textContent = 'Prix ↓';
      /*
       * « les cartes jamais vendues passent derrière » était vrai et
       * insuffisant : il laissait croire que le reste, lui, est classé. Quand
       * la cote couvre 17 % de la collection, ce sont quatre cartes sur cinq
       * qui tombent en fin de liste, et l'infobulle promettait un tri de tout.
       * Le chiffre est ici parce que c'est ici qu'on décide de s'y fier.
       */
      const cv = couvertureDistancee();
      const part = cv
        ? ` Attention : la cote ne couvre que ${cv.vues.toLocaleString('fr-FR')} de vos `
          + `${cv.total.toLocaleString('fr-FR')} cartes — les ${cv.manquantes.toLocaleString('fr-FR')} `
          + 'autres tombent en fin de liste faute de prix. « Rafraîchir la cote », dans la Revente, les relève.'
        : '';
      b.title = byValue
        ? 'Collection entière triée par moyenne des ventes — les cartes jamais vendues passent '
          + `derrière. Classement établi il y a ${fmtSpan(Date.now() - valueAt)} : éteignez puis `
          + 'rallumez pour le refaire.' + part
        : valueFail
          ? sell.tronque
            ? 'Lecture de la collection incomplète — le serveur a ralenti l’outil. '
              + 'Réessayez, au besoin boucle à l’arrêt.'
            : sell.refus
              ? 'Le serveur a refusé de lire votre collection — réessayez'
              : 'La lecture de la collection a échoué — réessayez'
          // Le point : sans lui, l'avertissement se collait à la phrase —
          // « la plus chère en tête Attention : la cote… », relevé à l'écran.
          : 'Trier toute la collection par moyenne des ventes, la plus chère en tête.' + part;
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
   *
   * Sur la page des échanges, elle s'affiche TOUJOURS.
   * -------------------------------------------------
   * Il n'y a pas de tri à y allumer, et surtout la question ne se pose pas de
   * la même façon : sur la collection on cherche « lesquelles valent quelque
   * chose », ici on répond à « est-ce que j'accepte ». Un échange est
   * irréversible et engage une carte contre une autre ; le prix de chacune est
   * exactement ce qu'on veut savoir avant de cliquer, et aller le chercher
   * ailleurs pendant qu'une offre attend, personne ne le fait.
   *
   * La règle « le reste du temps, la collection reste celle du site » tient
   * toujours : elle porte sur la collection, où le site propose son propre
   * ordre et où nos pastilles seraient une surcouche non demandée. La page des
   * échanges n'affiche rien de tel.
   *
   * Ce que la pastille NE fait pas : totaliser les deux côtés de la table.
   * Demandé explicitement — « le prix moyen de chaque carte, pas le prix moyen
   * total des cartes échangées ». Un total sous-entendrait d'ailleurs qu'un
   * échange se juge à la somme, alors qu'on troque le plus souvent pour une
   * carte précise qui manque.
   *
   * Limite connue, et elle est réelle : le prix vient des cotes déjà relevées,
   * qui portent sur TA collection. Une carte qu'on te propose et que tu n'as
   * jamais eue n'a donc pas de pastille. Les tiennes en ont une, ce qui répond
   * déjà à la moitié de la question — ce que tu donnes.
   */
  const onTrades = () => location.pathname.startsWith('/trades');

  function paintValueBadges() {
    const montrer = (byValue || onTrades()) && sell.rows.length;
    const prix = montrer ? new Map(sell.rows.map((r) => [r.t, r.moy])) : null;
    /*
     * Sur les échanges, la carte affichée n'est pas forcément à toi — c'est
     * même le cas le plus intéressant. La cote par titre ne couvre que ta
     * collection ; les prix relevés pour les cartes d'échange, eux, sont
     * indexés par `card_id`. `tradeCards` porte la correspondance des deux, on
     * s'en sert pour les rendre atteignables par titre.
     *
     * Vu à l'écran sans ça : le détail d'une offre montrait une carte sans
     * prix alors que la liste juste derrière l'affichait.
     */
    if (prix && onTrades()) {
      for (const l of tradeCards.lignes) {
        if (prix.has(l.t)) continue;
        const moy = tradePrix.get(l.id);
        if (moy != null) prix.set(l.t, moy);
      }
    }
    // Tri éteint et aucune pastille à retirer : rien à parcourir. La collection
    // porte quelques milliers de nœuds, et ce tour passe à chaque rendu.
    if (!prix && !document.querySelector('[data-wm-value]')) return;

    for (const h of document.querySelectorAll('h3')) {
      /*
       * Les échanges n'habillent pas leurs cartes comme la collection :
       * relevé sur la vraie page, `CARD_ITEM` n'y trouve RIEN.
       *
       * Et ils ne les habillent pas d'une seule façon. Le composeur enveloppe
       * sa tuile dans un `<button>` — on choisit une carte en cliquant dessus.
       * La modale de détail montre la MÊME tuile, sans bouton : il n'y a rien à
       * y choisir. Chercher un `<button>` marchait donc dans le composeur et
       * nulle part ailleurs, ce qui s'est vu tout de suite : le détail d'une
       * offre n'affichait aucun prix.
       *
       * On vise donc la propriété qui compte réellement — un ancêtre
       * `position: relative`, seul endroit où une pastille posée en absolu
       * atterrit dans la carte plutôt qu'au coin de la page. Les deux
       * habillages le portent, sur la même boîte à `w-[clamp(…)]`, et un
       * changement de classes du site n'y peut rien.
       *
       * Quatre niveaux suffisent — mesuré, la boîte est à deux — et bornent la
       * remontée : sans borne on finirait par accrocher un conteneur de page,
       * et la pastille irait se poser à des centaines de pixels de sa carte.
       */
      let item = h.closest(CARD_ITEM);
      let tuileEchange = false;
      if (!item && onTrades()) {
        let n = h.parentElement;
        for (let i = 0; i < 4 && n && !item; i++, n = n.parentElement) {
          if (getComputedStyle(n).position === 'relative') { item = n; tuileEchange = true; }
        }
      }
      if (!item) continue;
      /*
       * L'hôte est la tuile ELLE-MÊME sur les échanges, et non son premier
       * enfant. Ce détour vient de la collection, où le premier enfant est le
       * cadre positionné ; sur les échanges c'est l'IMAGE de la carte — et une
       * `<img>` ne contient rien. La pastille était bien créée, mesurée à
       * 0 × 0 pixel, invisible : le pire des cas, un correctif qui a l'air posé
       * et qui n'affiche rien.
       */
      const hote = tuileEchange ? item : (item.firstElementChild || item);
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

  /*
   * Le prix dans le DÉTAIL d'un échange — reçu, envoyé, ou dans l'historique.
   * ----------------------------------------------------------------------
   * Le composeur affiche des cartes entières, avec leur titre dans un `h3` :
   * la pastille du dessus suffit. La LISTE des offres, elle, ne montre qu'une
   * étiquette de texte par carte, « R · Mobile Legends: Ba… ».
   *
   * Et ce titre-là est tronqué DANS LE DOM, pas par CSS : `textContent` rend
   * bien « Mobile Legends: Ba… ». Une correspondance par titre exact échoue
   * donc toujours, et par préfixe elle est dangereuse — relevé sur un vrai
   * compte, « Paris Saint-Germai… » a huit correspondances dans la cote, à des
   * prix différents. Afficher l'une d'elles au hasard serait pire que rien :
   * un échange se décide là-dessus.
   *
   * `/api/trades` porte les titres ENTIERS et les `card_id` de chaque offre.
   * On lit donc cette liste — une requête, gardée une minute — et on ne
   * retient un prix que si le préfixe ET la rareté ne désignent qu'une seule
   * valeur. Deux cartes homonymes au même prix restent affichables ; deux
   * cartes homonymes à des prix différents n'affichent rien.
   */
  /*
   * Et surtout : coter les cartes qu'on ne possède PAS.
   * --------------------------------------------------
   * La cote porte sur ta collection — c'est ce qu'elle sert à vendre. Or dans
   * un échange, les cartes qui comptent le plus sont justement celles que tu
   * n'as pas : celles qu'on te propose. Mesuré sur un vrai compte, l'onglet
   * « Envoyées » n'affichait AUCUN prix, ses trois cartes étant toutes
   * demandées, donc absentes de la cote.
   *
   * Les `card_id` viennent de `/api/trades`, et la table des ventes closes se
   * lit en masse — c'est déjà ce que fait le relevé complet. Une poignée de
   * requêtes couvre tout l'historique des échanges, une fois, et le résultat
   * vit à part : ces cartes ne t'appartiennent pas, elles n'ont rien à faire
   * dans la liste de revente.
   */
  const TRADES_TTL = 60000;
  let tradeCards = { at: 0, lignes: [] };
  let tradeEnCours = false;
  const tradePrix = new Map();   // card_id → moyenne, pour les cartes non possédées
  let tradeCoteEnCours = false;

  /*
   * Les cartes des AUTRES, cotées elles aussi.
   * -----------------------------------------
   * `/api/trades` ne donne que les cartes déjà engagées dans une offre. Le
   * composeur, lui, montre la collection entière de l'ami — 484 cartes sur le
   * compte où ç'a été relevé — et c'est là qu'on choisit ce qu'on va demander.
   * Sans prix, on choisit à l'aveugle.
   *
   * Ces cartes arrivent dans une réponse de la même forme que la nôtre :
   * `collection[]`, chaque entrée portant son `card_id`. Et l'historique des
   * ventes se lit par `card_id`, sans se soucier de qui détient la carte — le
   * marché est public.
   *
   * On observe donc la FORME plutôt que la route. Le chemin de la collection
   * d'autrui porte un identifiant et n'est documenté nulle part ; l'écrire en
   * dur, c'est reprendre le pari qui a déjà coûté deux corrections aujourd'hui.
   * Toute réponse qui ressemble à une collection nourrit l'index, d'où qu'elle
   * vienne — la nôtre, celle d'un ami, celle d'un profil visité.
   *
   * On ne modifie rien de la réponse : on la lit au passage sur un clone, et
   * la moindre anomalie est avalée. Observer ne doit jamais coûter la requête
   * observée.
   */
  const VUES_MAX = 4000;   // borne mémoire : au-delà on cesse d'indexer
  let cardsProxyOn = false;

  function installCardsProxy() {
    if (cardsProxyOn) return;
    cardsProxyOn = true;
    const passe = window.fetch;
    window.fetch = async function (input) {
      const res = await passe.apply(this, arguments);
      try {
        if (!onTrades() || tradeCards.lignes.length >= VUES_MAX) return res;
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (!/\/api\//.test(url) || !/collection/i.test(url)) return res;
        const data = await res.clone().json();
        const lot = data && data.collection;
        if (!Array.isArray(lot) || !lot.length) return res;
        const connus = new Set(tradeCards.lignes.map((l) => l.id));
        for (const e of lot) {
          const titre = e && e.card && (e.card.wikipedia_title || e.card.title);
          if (!e || !e.card_id || !titre || connus.has(e.card_id)) continue;
          connus.add(e.card_id);
          tradeCards.lignes.push({ id: e.card_id, t: titre, r: (e.card && e.card.rarity) || '' });
        }
        coterCartesEchangees();
      } catch (_) {
        /* réponse illisible ou non-JSON : rien à indexer, et rien à casser */
      }
      return res;
    };
  }

  async function coterCartesEchangees() {
    if (tradeCoteEnCours || !prefs.db) return;
    const parId = new Set(sell.rows.map((r) => r.id));
    const manquants = tradeCards.lignes
      .map((l) => l.id)
      .filter((id) => !parId.has(id) && !tradePrix.has(id));
    if (!manquants.length) return;
    tradeCoteEnCours = true;
    try {
      const parCarte = await dbSalesBulk(manquants);
      if (!parCarte) return;   // base illisible : on garde ce qu'on a
      for (const id of manquants) {
        const px = parCarte.get(id) || [];
        // Une carte sans vente est notée `null` : sans ça on la redemanderait
        // à chaque rendu, indéfiniment.
        tradePrix.set(id, px.length ? Math.round(px.reduce((a, b) => a + b, 0) / px.length) : null);
      }
      paintTradeListPrices();
      paintValueBadges();   // le détail d'une offre montre la carte en grand
    } catch (_) {
      /* base injoignable : la pastille se contentera des cartes possédées */
    } finally {
      tradeCoteEnCours = false;
    }
  }

  async function refreshTradeCards() {
    if (tradeEnCours || Date.now() - tradeCards.at < TRADES_TTL) return;
    tradeEnCours = true;
    try {
      const { status, data } = await api('/api/trades');
      const lots = (data && (data.trades || data.data)) || [];
      if (status !== 200 || !Array.isArray(lots)) return;
      const vues = new Map();
      for (const t of lots) {
        for (const it of (t && t.items) || []) {
          const titre = it.card && (it.card.wikipedia_title || it.card.title);
          if (!titre || !it.card_id) continue;
          vues.set(it.card_id, { t: titre, r: it.snapshot_rarity || (it.card && it.card.rarity) || '' });
        }
      }
      tradeCards = { at: Date.now(), lignes: [...vues.entries()].map(([id, v]) => ({ id, ...v })) };
      /*
       * Repeindre TOUT DE SUITE, sans quoi rien ne s'affiche jamais.
       *
       * Le peintre tourne sur les rendus de la page. Au premier passage l'index
       * est vide, il lance cette lecture et s'arrête ; la lecture aboutit deux
       * cents millisecondes plus tard, alors que la page ne bouge plus — donc
       * plus aucun rendu, donc plus aucun passage. Vu à l'écran : zéro prix sur
       * une liste dont toutes les cartes étaient cotées.
       *
       * C'est le même détour que la cote d'une enchère, et pour la même raison.
       * Ce second passage peint seulement : l'index est en mémoire, il ne relit
       * rien.
       */
      paintTradeListPrices();
      coterCartesEchangees();
    } catch (_) {
      /* réseau : on garde l'index précédent plutôt que de tout effacer */
    } finally {
      tradeEnCours = false;
    }
  }

  /** « R · Mobile Legends: Ba… » — rareté, séparateur, titre éventuellement coupé. */
  const TRADE_LABEL = /^\s*([A-Z]{1,2})\s*·\s*(.+?)\s*$/;

  function paintTradeListPrices() {
    if (!onTrades()) return;
    installCardsProxy();
    if (!sell.rows.length) return;
    refreshTradeCards();
    if (!tradeCards.lignes.length) return;

    const parId = new Map(sell.rows.map((r) => [r.id, r.moy]));

    for (const span of document.querySelectorAll('span.inline-flex')) {
      if (span.children.length || span.dataset.wmTradePrice) continue;
      const m = TRADE_LABEL.exec(span.textContent || '');
      if (!m) continue;
      const rarete = m[1];
      const prefixe = m[2].replace(/[…]|\.\.\.$/g, '').trim();
      if (!prefixe) continue;

      // Toutes les cartes d'échange dont le titre commence par ce préfixe, à
      // rareté égale. La rareté est portée par l'étiquette elle-même : elle
      // écarte déjà l'essentiel des homonymes.
      const prix = new Set();
      for (const l of tradeCards.lignes) {
        if (l.r && rarete && l.r !== rarete) continue;
        if (!l.t.startsWith(prefixe)) continue;
        // Ta cote d'abord — c'est la même mesure ; sinon celle relevée pour
        // les cartes d'échange que tu ne possèdes pas.
        const moy = parId.get(l.id) ?? tradePrix.get(l.id);
        if (moy != null) prix.add(moy);
      }
      // Zéro prix connu, ou plusieurs prix qui ne s'accordent pas : on se tait.
      if (prix.size !== 1) continue;

      const moy = [...prix][0];
      const etiquette = document.createElement('span');
      etiquette.dataset.wmTradePrice = '1';
      etiquette.textContent = `⌀ ${fmtWb(moy)}`;
      etiquette.title = 'Moyenne des ventes réelles de cette carte';
      etiquette.style.cssText =
        `margin-left:4px;color:${VALUE_COLOR};font-weight:700;font-variant-numeric:tabular-nums`;
      span.insertAdjacentElement('afterend', etiquette);
      // Le marqueur va sur l'étiquette de la CARTE, pas sur la nôtre : c'est
      // lui qui empêche de repeindre deux fois au rendu suivant.
      span.dataset.wmTradePrice = 'fait';
    }
  }

  // -------------------------------- prix moyen sous le formulaire de mise

  /*
   * Le prix moyen d'une carte existe déjà côté site, à deux endroits. Le
   * dialogue « Mettre aux enchères » l'affiche pour la rareté qu'on vend —
   * VENTES, DERNIÈRE, MOYENNE, sous un titre « Marché · Légendaire ». Et la
   * page d'une annonce a sa « Vue du marché », avec le graphique.
   *
   * Sauf que sur la page d'annonce, cette vue est rangée derrière une icône,
   * en haut à droite, à l'opposé du formulaire de mise. Décider d'un prix
   * demande donc d'ouvrir la modale, de lire, de la refermer, et de revenir au
   * champ avec le nombre en tête. Sur une enchère qui se termine dans dix
   * secondes, ça ne se fait pas.
   *
   * Le chiffre se pose donc sous le formulaire, là où la question se pose.
   *
   * La source est `?scope=summary`, celle du dialogue de vente, et non
   * l'historique complet : c'est l'historique détaillé que le site réserve aux
   * comptes PRO, pas la moyenne. Un compte sans abonnement voit donc ce
   * chiffre-là, exactement comme il le voit déjà en mettant une carte en vente.
   *
   * Le résumé rend `{average, count, latest}` PAR RARETÉ, et c'est ce qui
   * compte : un même titre se vend à des prix sans rapport selon la rareté de
   * l'exemplaire, et l'annonce dit la sienne (`snapshot_rarity`). La « Vue du
   * marché », elle, s'ouvre sur « Toutes » : quand le titre s'est vendu en
   * plusieurs raretés, sa moyenne les mêle. Relevé sur une carte partie une
   * fois en Rare à 15 et une fois en Super Rare à 5, elle annonce 10 — un prix
   * auquel aucun des deux exemplaires n'est jamais parti.
   */
  const RARITY_NAME = {
    L: 'Légendaire', UR: 'Ultra Rare', SR: 'Super Rare',
    R: 'Rare', PC: 'Peu Commune', C: 'Commune',
  };

  const AUCTION_PATH = /^\/marketplace\/([0-9a-f-]{36})\/?$/i;

  /*
   * Le wikibidou du site, recopié tel quel. Tous les prix de la page en
   * portent un — mise de départ, mise minimum, champ de saisie. Un nombre nu
   * posé au milieu d'eux se lirait comme une autre unité.
   *
   * C'est le seul dessin de ce script : partout ailleurs, un caractère suffit.
   *
   * Les attributs de pose sont passés par l'appelant — la moyenne s'écrit en
   * grand dans une boîte flex, la dernière vente au fil d'une phrase, et les
   * deux ne se calent pas de la même façon. `currentColor` fait le reste :
   * l'icône prend la couleur du texte qui la porte.
   */
  const wbIcon = (pose) =>
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"'
    + ' stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
    + ` aria-hidden="true" ${pose}><circle cx="12" cy="12" r="9"></circle>`
    + '<path d="M7.5 8.5 9.5 15.5 12 10 14.5 15.5 16.5 8.5"></path></svg>';

  /*
   * L'icône au fil du texte, et non dans une boîte à elle.
   *
   * Elle avait d'abord une boîte `inline-flex`, comme celle du site pour la
   * mise de départ. Sauf qu'une boîte flex se fabrique sa PROPRE ligne de
   * base : le « 364 » flottait trois pixels au-dessus de la phrase qui le
   * porte. Mesuré à l'écran, et visible à l'œil nu.
   *
   * Le chiffre reste donc du texte ordinaire, sur la ligne de base de la
   * phrase, et l'icône seule est calée. `display:inline-block` est
   * indispensable : le preflight de Tailwind pose `svg { display: block }`,
   * qui renverrait l'icône à la ligne. La taille est en `em` pour suivre le
   * corps du texte, et −0,2 em centre le rond sur la hauteur d'x — relevé
   * à un quart de pixel près.
   */
  const WB_AU_FIL = 'style="display:inline-block;width:1.15em;height:1.15em;'
    + 'vertical-align:-0.2em"';

  /*
   * Le guetteur repasse à chaque rendu de React — donc sans arrêt sur une page
   * dont le compte à rebours bouge toutes les secondes. Sans ce cache, ouvrir
   * une annonce lancerait deux requêtes par tour de guetteur. La cote d'une
   * carte ne bouge pas en cinq minutes ; une lecture ratée se retente plus
   * tôt, sans pour autant marteler un serveur qui vient de refuser.
   */
  const COTE_ENCHERE_TTL = 300000;
  const COTE_ENCHERE_RETRY = 30000;
  const COTE_ENCHERE_MAX = 200;  // annonces gardées en mémoire

  const coteVue = new Map();  // id d'annonce → { at, cote }
  let coteEnCours = null;     // une lecture à la fois

  /**
   * La cote d'une annonce : la moyenne des ventes de sa carte, DANS SA RARETÉ.
   *
   * @returns {Promise<?{moy: ?number, n: number, dernier: ?number, rarete: string}>}
   *   `n: 0` pour une carte jamais vendue dans cette rareté — ce n'est pas un
   *   échec, et ça se dit. `null` quand la lecture n'a pas abouti.
   */
  async function fetchAuctionCote(id) {
    // L'annonce d'abord : ni la carte ni sa rareté ne sont dans l'URL.
    let carte = null;
    let rarete = null;

    const a = await api(`/api/marketplace/${id}`);
    if (a.status === 200 && a.data && a.data.auction) {
      carte = a.data.auction.card_id;
      rarete = a.data.auction.snapshot_rarity;
    } else {
      // Repli par la base, comme partout ailleurs quand le site refuse.
      const lignes = await sbGet(`auctions?id=eq.${id}&select=card_id,snapshot_rarity`);
      if (!Array.isArray(lignes) || !lignes.length) return null;
      carte = lignes[0].card_id;
      rarete = lignes[0].snapshot_rarity;
    }
    if (!carte || !rarete) return null;

    const vide = { moy: null, n: 0, dernier: null, rarete };

    const s = await api(`/api/marketplace/cards/${carte}/sales?scope=summary`);
    if (s.status === 200 && s.data && s.data.summary) {
      const e = s.data.summary[rarete];
      if (!e || !Number.isFinite(e.average)) return vide;
      return {
        moy: Math.round(e.average),
        n: Number.isFinite(e.count) ? e.count : 0,
        dernier: Number.isFinite(e.latest) ? e.latest : null,
        rarete,
      };
    }

    /*
     * Le résumé refusé, il reste la base. Même critère de « vendue » que le
     * relevé de la Revente : un `final_price` non nul, et rien d'autre.
     */
    const lignes = await sbGet(
      `auctions?card_id=eq.${carte}&snapshot_rarity=eq.${rarete}&final_price=not.is.null`
      + `&select=final_price&order=settled_at.desc&limit=${DB_LIMIT}`,
    );
    if (!Array.isArray(lignes)) return null;
    const px = lignes.map((r) => r.final_price).filter(Number.isFinite);
    if (!px.length) return vide;
    return {
      moy: Math.round(px.reduce((x, y) => x + y, 0) / px.length),
      n: px.length,
      dernier: px[0],  // `order=settled_at.desc` : la plus récente est en tête
      rarete,
    };
  }

  /**
   * La boîte sous laquelle le prix moyen se pose : celle du formulaire de mise.
   *
   * Une enchère terminée n'a plus de bouton « Miser », mais la colonne garde
   * ses boîtes — la dernière annonce alors le statut. Le prix moyen s'y
   * accroche, au même endroit à l'œil, et reste utile : c'est là qu'on regarde
   * à combien la carte est partie.
   */
  function boiteDeMise() {
    const miser = [...document.querySelectorAll('main button')]
      .find((b) => b.textContent.trim() === 'Miser');
    const sienne = miser && miser.closest('.card-frame');
    if (sienne) return sienne;

    // La nôtre est une `.card-frame` elle aussi : elle ne doit pas s'ancrer
    // sous elle-même, sans quoi elle descendrait d'un cran à chaque tour.
    const boites = document.querySelectorAll('main .card-frame:not([data-wm-cote])');
    return boites.length ? boites[boites.length - 1] : null;
  }

  function injectAuctionCote() {
    const m = AUCTION_PATH.exec(location.pathname);
    if (!m) {
      document.querySelector('[data-wm-cote]')?.remove();
      return;
    }
    const id = m[1];
    const ancre = boiteDeMise();
    if (!ancre) return;

    const vu = coteVue.get(id);
    const ttl = vu && vu.cote ? COTE_ENCHERE_TTL : COTE_ENCHERE_RETRY;
    if ((!vu || Date.now() - vu.at > ttl) && !coteEnCours) {
      coteEnCours = id;
      fetchAuctionCote(id)
        .catch(() => null)
        .then((cote) => {
          if (coteVue.size >= COTE_ENCHERE_MAX) oublierVieillesCotes();
          coteVue.set(id, { at: Date.now(), cote });
          coteEnCours = null;
          /*
           * Le formulaire a pu être remplacé pendant la lecture, et l'onglet
           * changer d'annonce. On repart de la page telle qu'elle est, pas de
           * l'ancre relevée avant l'appel. La cote est en cache : ce second
           * passage peint, il ne relit pas.
           */
          injectAuctionCote();
        });
    }
    paintAuctionCote(ancre, id);
  }

  /** Le cache ne doit pas grossir indéfiniment au fil des annonces ouvertes. */
  function oublierVieillesCotes() {
    const limite = Date.now() - COTE_ENCHERE_TTL;
    for (const [id, v] of coteVue) if (v.at < limite) coteVue.delete(id);
    // Que des entrées fraîches : on repart de zéro plutôt que de garder la main
    // sur des centaines d'annonces qu'on ne rouvrira pas.
    if (coteVue.size >= COTE_ENCHERE_MAX) coteVue.clear();
  }

  function paintAuctionCote(ancre, id) {
    const vu = coteVue.get(id);
    let boite = document.querySelector('[data-wm-cote]');

    /*
     * Rien tant que la lecture n'a pas abouti. Une boîte vide qui apparaît puis
     * se remplit décalerait le formulaire de mise sous le curseur — le bouton
     * « Miser » n'a pas le droit de bouger sous le doigt.
     */
    if (!vu || !vu.cote) {
      if (boite) boite.remove();
      return;
    }
    const { moy, n, dernier, rarete } = vu.cote;
    const nom = RARITY_NAME[rarete] || rarete;
    const maigre = n > 0 && n < THIN_SALES;

    // Annonce suivante : la boîte de la précédente ne doit pas se recycler avec
    // ses chiffres le temps d'un rendu.
    if (!boite || boite.dataset.wmCote !== id) {
      if (boite) boite.remove();
      boite = document.createElement('div');
      boite.dataset.wmCote = id;
      // Classes du site : la boîte a la géométrie de celles qu'elle suit.
      boite.className = 'card-frame p-4 space-y-1';
    }
    if (boite.previousElementSibling !== ancre) ancre.after(boite);

    /*
     * Le nombre de ventes n'a pas d'unité à porter, le mot « ventes » la dit.
     * La dernière, elle, est un PRIX : elle prend le wikibidou, comme tous les
     * prix de la page au-dessus d'elle.
     */
    const detail = n
      ? `${esc(fmtWb(n))} vente${n > 1 ? 's' : ''} en ${esc(nom)}`
        + (dernier == null
          ? ''
          // `nowrap` : l'unité ne doit jamais se retrouver seule en fin de ligne.
          : ' · la dernière à <span style="white-space:nowrap">'
            + `${wbIcon(WB_AU_FIL)} ${esc(fmtWb(dernier))}</span>`)
      : `Jamais vendue en ${esc(nom)}`;

    boite.title = n
      ? `Moyenne des ventes conclues de cette carte en ${nom} — le chiffre que le site donne `
        + 'en mettant une carte en vente, et dans sa Vue du marché.'
        + (dernier == null
          ? ''
          : ` La dernière est partie à ${fmtWb(dernier)} : son écart avec la moyenne dit dans `
            + 'quel sens le prix bouge.')
        + (maigre
          ? ` Établie sur ${n} vente${n > 1 ? 's' : ''} seulement : une enchère emballée `
            + 'suffit à la tirer loin du prix courant.'
          : '')
      : `Aucune vente conclue pour cette carte en ${nom} : il n’y a pas de prix courant, `
        + 'et la mise de départ ne se compare à rien.';

    boite.innerHTML = `
      <div class="flex items-center justify-between">
        <span class="text-xs uppercase tracking-wide text-[var(--color-foreground)]/50"
          >Prix moyen${maigre ? ' ⚠' : ''}</span>
        <span class="inline-flex items-center gap-1.5 text-2xl font-bold tabular-nums"
          style="color:${VALUE_COLOR}"
          >${moy == null ? '' : wbIcon('class="size-6"')}${moy == null ? '—' : esc(fmtWb(moy))}</span>
      </div>
      <div class="text-sm text-[var(--color-foreground)]/50"
        ><span style="color:${RARITY_COLOR[rarete] || VALUE_COLOR}">◆</span> ${detail}</div>`;
  }

  function refreshCollection() {
    syncNavigation();
    injectNewFilter();
    applyNewFilter();
    injectValueSort();
    paintValueBadges();
    paintTradeListPrices();
    injectWishAll();
    injectAuctionCote();
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
   * sur des milliers de cartes est stable ; c'est la meilleure estimation
   * disponible.
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

  /*
   * La taille de la collection, relue pour DEUX lecteurs : le palier de
   * l'onglet Succès (`state.owned`, raretés et vitesse comprises) et la
   * couverture de la cote dans la Revente (`sell.owned`).
   *
   * La 2.16.0 avait donné à la Revente sa propre `refreshOwned`, déclarée sous
   * le même nom dans la même fonction. Rien ne le signale : la seconde remplace
   * la première pour TOUS les appelants, sans une erreur. `state.owned` n'était
   * donc plus écrit que par la restauration du stockage — l'onglet Succès
   * annonçait la collection du jour de la mise à jour, et ni les paquets, ni
   * les ventes, ni la défausse n'y changeaient plus rien. Une seule requête
   * sert désormais les deux, et `verifier.js` refuse un nom déclaré deux fois.
   *
   * Deux gardes, venues de la Revente qui l'appelle à CHAQUE rendu de la page
   * collection. `ownedEnCours` empêche la rafale : dix rendus dans la même
   * seconde lanceraient dix requêtes. `ownedTry` horodate la TENTATIVE, pas le
   * succès : sans lui, un serveur qui refuse laisse les relevés à leur vieille
   * date, la garde de fraîcheur ne retient plus rien, et l'échec se rejoue à
   * chaque rendu.
   *
   * La fraîcheur est celle du plus vieux des deux relevés : `sell.owned` n'est
   * pas mémorisé, et `state.owned` restauré du stockage paraîtrait frais au
   * rechargement alors que la Revente n'a encore rien.
   */
  let ownedEnCours = false;
  let ownedTry = 0;

  async function refreshOwned() {
    if (ownedEnCours) return;
    if (Date.now() - Math.min(state.owned.at, sell.owned.at) < OWNED_EVERY_MS) return;
    if (Date.now() - ownedTry < OWNED_EVERY_MS) return;
    ownedEnCours = true;
    ownedTry = Date.now();
    try {
      const d = await api('/api/my-collection/stats');
      const n = d.data && d.data.total;
      if (!Number.isFinite(n) || n <= 0) return;
      const at = Date.now();
      const rc = (d.data && d.data.rarityCounts) || {};
      state.owned = { count: n, rc, at };
      if (state.running) trackOwned(n, rc, at);
      saveStore({ owned: state.owned, ownedTrack: state.ownedTrack });
      sell.owned = { n, at };
      render();
      renderSell();
      paintValueSort();
    } catch (_) {
      /* réseau : on retentera au prochain cycle, et la couverture se tait */
    } finally {
      ownedEnCours = false;
    }
  }

  /*
   * Les succès, relevés en entier.
   *
   * On ne lisait que le nombre de débloqués — un ratio, donc rien d'actionnable.
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
   * Le classement se fait sur le temps, pas sur l'écart. Exemple inventé :
   * 600 cartes à 100 cartes/h arrivent en six heures, 10 Légendaires à 0,1/h
   * en quatre jours. Trier sur « 10 < 600 » mettrait le second en tête. Un
   * palier sans estimation passe derrière ceux qui en ont, départagé par sa
   * part restante.
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
      const res = await fetchBorne(`${sbUrl()}/${path}`, {
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
      const res = await fetchBorne(`${sbUrl()}/rpc/${nom}`, {
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
   * Écrire, et plus seulement lire
   * ------------------------------
   * Un seul geste passe par là, et il n'a pas d'autre chemin : la liste de
   * souhaits. Le site ne publie aucune route d'API pour elle — aucun
   * `/api/…wish…` dans ses seize bundles — parce que son propre client tape
   * la table `wishlist_items` en direct. Ce n'est donc pas un raccourci
   * derrière le dos du site : c'est exactement ce que la page fait quand tu
   * cliques « Ajouter à la liste de souhaits ».
   *
   * L'engagement de la lecture vaut ici mot pour mot : jeton relu à chaque
   * appel, jamais recopié dans le stockage du script, jamais journalisé. Et
   * une écriture ne part jamais seule — il faut un clic, sur un bouton qui
   * annonce son compte avant d'agir.
   *
   * On rend le statut plutôt que `null` : à la différence d'une lecture, une
   * écriture qui échoue doit pouvoir le dire, et dire de quoi elle est morte.
   */
  async function sbWrite(method, path, body) {
    if (!prefs.db) return { ok: false, status: 0, raison: 'option' };
    const token = sbToken();
    if (!token) return { ok: false, status: 0, raison: 'jeton' };
    try {
      const res = await fetchBorne(`${sbUrl()}/${path}`, {
        method,
        credentials: 'omit',
        headers: {
          apikey: SB_ANON,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          // `return=minimal` : on ne demande pas au serveur de nous relire les
          // lignes qu'on vient d'écrire — 345 cartes renvoyées pour rien.
          Prefer: 'return=minimal',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { ok: res.ok, status: res.status, raison: res.ok ? '' : 'serveur' };
    } catch (_) {
      return { ok: false, status: 0, raison: 'réseau' };
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
    if (!token) return 'Aucun jeton lisible — êtes-vous connecté au site ?';
    const res = await fetchBorne(`${sbUrl()}/`, {
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

  // ----------------------------------------------------------- registres « vu »

  /*
   * La guilde vivait ici — score, karma par rareté, dons possibles, alerte
   * sur les SR / UR demandées — et le lot à publier dans son tchat. Tout est
   * retiré en 3.8.0, à la demande de l'utilisateur : l'onglet est devenu
   * celui des amis. Le relevé de `/api/guilds/home` toutes les cinq minutes
   * n'avait plus de lecteur, il est parti avec.
   */

  /**
   * Un registre « déjà vu » ne doit pas gonfler indéfiniment : on garde les
   * `max` plus récents. Les valeurs sont des horodatages — une entrée écrite
   * par une version antérieure vaut 1, elle sort donc en premier, ce qui est
   * exactement l'effet voulu.
   */
  function bornerVus(registre, max) {
    const ids = Object.keys(registre);
    if (ids.length <= max) return registre;
    const gardes = ids.sort((a, b) => registre[b] - registre[a]).slice(0, max);
    const frais = {};
    for (const id of gardes) frais[id] = registre[id];
    return frais;
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
      /*
       * La réponse brute : un compte qui relance beaucoup n'a presque que des
       * avis d'invendu, et c'est justement ceux-là que le masquage retire. Ce
       * repli aurait cessé de trouver l'identifiant chez qui en a le plus.
       */
      const d = await api('/api/notifications', 'GET', null, fetchAvantFiltre);
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
   *
   * Le relevé est appelé de trois endroits — le tour du guetteur (15 s), le
   * bouton « rafraîchir », et le tick des relances — et il coûte jusqu'à
   * treize requêtes séquentielles sur le chemin de repli. Sans garde, deux
   * appelants se croisaient et doublaient le trafic PRÉCISÉMENT quand le
   * serveur ralentit, c'est-à-dire quand il faut lever le pied. Le tour manqué
   * n'est pas perdu : les échéances sont absolues, la ligne précédente reste
   * juste, et `reconcileWatch` refuse déjà d'agir sur un relevé périmé.
   */
  async function scanSales() {
    if (scanSales.busy) return;
    scanSales.busy = true;
    try {
      await scanSalesVraiment();
    } finally {
      scanSales.busy = false;
    }
  }

  async function scanSalesVraiment() {
    const list = await fetchMySales();
    if (!list) return;
    const before = new Map((state.sales.list || []).map((s) => [s.title, s]));

    for (const v of list) {
      const prev = before.get(v.title);
      if (v.offered && prev && !prev.offered) {
        notifyBid('Première mise sur votre vente', `${v.title} — ${v.bid} wb`);
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
    /*
     * Et la Revente, si elle est ouverte. `render()` ne dessine que le petit
     * panneau : la page gardait donc l'état d'avant la relecture — « vos ventes
     * ne sont pas encore relues » alors qu'elles venaient de l'être, et des
     * lignes « Vendre » sur des cartes déjà en vente. L'ouverture relance ce
     * relevé exprès pour ça ; encore fallait-il en montrer le résultat.
     */
    if (sell.open) renderSell();
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

  // Un tour de guetteur encore en vol : le suivant passe son chemin.
  let tickBusy = false;

  /*
   * Le guetteur ralentit quand il n'a rien à garder.
   *
   * Mesuré au banc, onglet laissé ouvert et boucle ARRÊTÉE : 749 appels par
   * heure, dont **720 d'ici** — trois relevés toutes les quinze secondes, que
   * vous ayez une vente en cours ou aucune. Un onglet oublié une nuit, c'est
   * neuf mille requêtes pour rien.
   *
   * Le remède n'est PAS de dormir quand l'onglet est caché, et c'est le piège
   * de ce réglage : cet outil travaille exprès en arrière-plan. Le guetteur ne
   * recharge le Marché que lorsque vous êtes ailleurs, et la boucle ouvre des
   * paquets dans un onglet de fond. Se taire quand on ne nous regarde pas
   * reviendrait à se taire pendant qu'on travaille.
   *
   * Ce qui décide, c'est donc s'il y a quelque chose à garder : une vente qui
   * court, une enchère menée, une carte en file de relance. Tant qu'il y en a
   * une, le rythme reste à quinze secondes — c'est là que la latence compte,
   * puisque c'est là qu'une surenchère peut tomber. Sinon on passe à la
   * minute, et le premier tour qui trouve quelque chose remet le rythme
   * aussitôt.
   *
   * Le coût à vide est divisé par quatre ; la latence, quand elle sert, ne
   * bouge pas d'une seconde.
   */
  const BIDS_REPOS_MS = 60000;
  let dernierTourMarche = 0;

  const rienAGarder = () =>
    !stillRunning(state.bids.list).length
    && !stillRunning(state.sales.list).length
    && !Object.keys(state.watch).length;

  function bidTick() {
    if (!prefs.watchBids) return;
    // Le tout premier tour passe toujours : sans lui, on ne saurait pas encore
    // s'il y a quelque chose à garder.
    if (rienAGarder() && Date.now() - dernierTourMarche < BIDS_REPOS_MS) return;
    dernierTourMarche = Date.now();

    /*
     * Tant que l'onglet est sous tes yeux, le guetteur ne touche à RIEN : il
     * se contente de lire ce que tu affiches. Changer d'onglet à ta place
     * pendant que tu consultes le Marché est insupportable, et c'est ce qu'il
     * faisait. Il ne reprend la main qu'en arrière-plan.
     */
    /*
     * Les ventes viennent de l'API : ni onglet ni page particulière. La chaîne
     * porte son propre drapeau — les trois relevés en ont chacun un, mais rien
     * n'empêchait le tour SUIVANT de démarrer sur un tour encore en vol, et
     * d'empiler des chaînes qui se marchent dessus.
     */
    /*
     * Le `finally` sans `catch` était un piège : une erreur non réseau dans
     * cette chaîne devenait un rejet de promesse non intercepté, répété toutes
     * les 15 s et SANS le préfixe « [WikiMasters Tools] » — donc noyé dans les
     * erreurs propres du site, exactement là où personne ne saura le
     * distinguer. Le filet le nomme, le compte, et finit par arrêter ce
     * tour-ci plutôt que de le laisser saigner en silence.
     */
    if (!tickBusy && !enPanne('marche')) {
      tickBusy = true;
      (async () => {
        try {
          await scanSales();
          await syncJournal();
          await reconcileWatch();
          // Le verdict porte sur ce que le tour RAPPORTE, pas sur son silence :
          // les trois appels ci-dessus rattrapent chacun leur échec réseau.
          if (!ventesSuresPourAgir()) throw new Error('le relevé des ventes ne se rafraîchit plus');
          noterSucces('marche');
        } catch (err) {
          noterEchec('marche', err);
        } finally {
          tickBusy = false;
        }
      })();
    }

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
     *
     * Jamais pendant un envoi de demandes d'ami : il dure une demi-heure au
     * rythme d'une personne, et un rechargement l'arrêterait au milieu.
     */
    const dernier = state.bids.at;
    if (
      !amisEnvoiEnCours() &&
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
      if (!prefs.watchWish || wishBusy || enPanne('souhaits')) return;
      wishBusy = true;
      try {
        const avant = state.wishHits.at;
        await scanWishMarket();
        /*
         * Rien à surveiller — aucune carte souhaitée — est un tour RÉUSSI, pas
         * un échec : il n'y avait rien à relever. On ne juge donc que les tours
         * qui avaient du travail, et on les juge sur leur relevé.
         */
        if (Object.keys(state.wish.cards || {}).length && state.wishHits.at === avant) {
          throw new Error('le balayage du marché n’a rien pu relever');
        }
        noterSucces('souhaits');
      } catch (err) {
        // « le tour suivant rattrapera » — vrai jusqu'au jour où il ne
        // rattrape plus. Le compteur tranche entre les deux.
        noterEchec('souhaits', err);
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

  // ------------------------------------------------ navigation dans le site

  /*
   * Ce qui suit n'a rien à voir avec le verrou : ce sont les gestes de
   * navigation dans les pages du jeu — poser une recherche en attente, ouvrir
   * une carte, suivre un lien sans recharger le SPA.
   *
   * Le titre est là pour une raison précise. `npm run couverture` découpe le
   * fichier sur ces titres, et cette section-ci en portait ONZE fonctions dont
   * trois seulement concernaient le verrou. Le tableau annonçait « verrou :
   * 54 % mort » et on en a tiré la conclusion qu'il fallait éprouver le
   * verrou — ce qui était vrai, mais pas pour cette raison : les 54 % étaient
   * ceux de la navigation, que le banc ne touche pas. Un tableau qui range
   * deux choses sous un seul nom fait chercher au mauvais endroit.
   */
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
      if (chipActive(btn) !== (label === target)) {
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
        marquerSelecteur(NOM_RECHERCHE, SEARCH_SELECTOR, input);
        setReactInput(input, q);
      } else if (++tries > 40) {
        clearInterval(id);
        /*
         * Dix secondes d'attente sans champ de recherche : ce n'est plus un
         * retard de rendu. C'est le seul des trois sélecteurs dont l'attente a
         * une fin franche, donc le seul qu'on marque à l'abandon plutôt qu'à
         * chaque coup d’œil.
         */
        marquerSelecteur(NOM_RECHERCHE, SEARCH_SELECTOR, null);
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

  /*
   * Les fins d'enchère sans preneur, retirées du panneau du site.
   *
   * Le serveur envoie `marketplace_auction_unsold` à CHAQUE clôture sans mise,
   * et `/api/notifications` ne garde que les cinquante dernières. Une carte
   * relancée toutes les dix minutes en produit six par heure : trois cartes en
   * boucle retournent la boîte en moins de trois heures, et tout ce qui compte
   * — une vente conclue, une offre d'échange, un message — en est chassé. Sur
   * un compte réel, neuf avis sur dix disaient la même chose.
   *
   * On filtre la RÉPONSE, pas l'affichage : le site dessine son panneau à
   * partir de ce tableau, donc la liste et le compteur suivent sans qu'on
   * touche à son DOM. Rien n'est effacé côté serveur — décocher la case rend
   * les avis à la seconde suivante.
   *
   * Ce que ça ne répare pas : la borne des cinquante est au serveur. Un avis
   * important déjà chassé de la boîte ne revient pas, et les invendus
   * continuent d'en pousser d'autres dehors. Pour tarir la source il faut
   * allonger la durée des ventes — « Tout repasser en », volet Relances.
   *
   * L'information n'est perdue pour personne : le Journal des ventes du
   * panneau dit la même chose, en mieux — « demandée 2 000, invendue ».
   */
  const NOTIF_INVENDU = 'marketplace_auction_unsold';
  let notifProxyOn = false;
  /* La réponse telle que le serveur l'envoie, pour nos propres lectures. */
  let fetchAvantFiltre = null;
  /* Ce que la dernière lecture a écarté : le rapport que la case affiche. */
  let notifFiltre = { masques: 0, total: 0 };
  /* Et ce que le direct a écarté depuis l'ouverture de la page. */
  let notifDirect = 0;
  /* Les dernières trames vues sur le canal — `__wmAuto.notifTrames`, mémoire seule. */
  const notifTrames = [];
  /*
   * Le nombre d'avis non lus QUI COMPTENT — invendus exclus. `null` tant
   * qu'aucune liste n'a été lue : on ne corrige pas une pastille sur une
   * supposition. Voir `corrigerPastille`.
   */
  let notifNonLues = null;

  /** Les non-lus d'une liste brute, les invendus mis de côté. */
  function compterNonLues(liste) {
    if (!Array.isArray(liste)) return null;
    return liste.filter((n) => n && n.read === false && n.type !== NOTIF_INVENDU).length;
  }

  function installNotifProxy() {
    if (notifProxyOn) return;
    notifProxyOn = true;
    const passe = window.fetch;
    fetchAvantFiltre = passe;
    window.fetch = async function (input) {
      const res = await passe.apply(this, arguments);
      try {
        if (!prefs.masquerInvendus) return res;
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (!url.includes('/api/notifications')) return res;

        const data = await res.clone().json();
        const liste = data && data.notifications;
        if (!Array.isArray(liste)) return res;

        const garde = liste.filter((n) => !n || n.type !== NOTIF_INVENDU);
        // La liste complète est sous la main : c'est le moment de compter juste.
        notifNonLues = compterNonLues(liste);
        const avant = notifFiltre;
        notifFiltre = { masques: liste.length - garde.length, total: liste.length };
        /*
         * Redessiner, mais seulement si quelqu'un regarde le chiffre et qu'il a
         * changé. Sans ça la note restait sur « rien de lu depuis l'ouverture
         * de la page » pendant que la cloche venait d'être lue : seul un
         * changement d'onglet la rattrapait, et le réglage passait pour mort.
         */
        if (prefs.tab === 'reglages'
            && (avant.masques !== notifFiltre.masques || avant.total !== notifFiltre.total)) {
          render();
        }
        if (!notifFiltre.masques) return res;   // rien à retirer : la réponse d'origine suffit
        data.notifications = garde;

        return new Response(JSON.stringify(data), {
          status: res.status,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (_) {
        return res;  // masquer ne doit jamais coûter le panneau de notifications
      }
    };
  }

  /*
   * L'autre porte : le direct. Et ce garde-là N'ATTRAPE RIEN aujourd'hui.
   *
   * Il faut le dire net, parce que le code seul laisserait croire l'inverse.
   * Le site tient un websocket avec Supabase, abonné à
   * `realtime:notifications:<votre id>`, et une enchère qui se clôt arrive par
   * là — la cloche s'incrémente sans qu'aucune requête ne parte. La 3.4.2 a
   * donc filtré les trames. Sans effet : mesuré sur un compte réel, quatre
   * invendus sont entrés pendant que le relevé ne montrait que
   * `[object ArrayBuffer] — non textuel`.
   *
   * **Ces trames sont binaires.** Chercher une chaîne de caractères dedans ne
   * peut rien donner, jamais. Seules les confirmations d'abonnement et les
   * accusés de réception voyagent en texte.
   *
   * Ce qui retire réellement ces avis est plus bas : `installNotifDomFiltre`,
   * qui regarde l'écran et non le transport. Celui-ci reste pour deux raisons,
   * et aucune n'est l'espoir qu'il serve : il tient si le canal repasse un jour
   * en texte, et il alimente `__wmAuto.notifTrames`, le relevé qui a fini par
   * répondre à la question après deux versions à côté.
   *
   * On n'altère pas la trame, on la retient : l'écouteur du site n'est pas
   * appelé pour celle-là. Rien à réécrire, donc rien à désynchroniser — la
   * connexion, les accusés et les battements de cœur passent intacts.
   *
   * Envelopper `WebSocket` doit se faire AVANT que le site ne construise le
   * sien : sa bibliothèque garde la référence trouvée au chargement. C'est la
   * leçon déjà payée deux fois — d'où l'installation à `document-start`.
   */
  const NOTIF_CANAL = /realtime:notifications:/;
  let wsProxyOn = false;

  function installNotifWsProxy() {
    if (wsProxyOn || typeof window.WebSocket !== 'function') return;
    wsProxyOn = true;
    const Natif = window.WebSocket;

    /**
     * La trame porte-t-elle un avis d'invendu ?
     *
     * Le canal ne sert plus de condition. Première version : on exigeait
     * `realtime:notifications:` dans la trame. Résultat mesuré sur un compte
     * réel — deux avis d'invendu sont apparus dans la cloche pendant que le
     * relevé ne montrait que la confirmation d'abonnement. Ils passent donc
     * ailleurs, et exiger le canal revenait à ne rien filtrer.
     *
     * Le type entre guillemets suffit à distinguer : `"marketplace_auction_unsold"`
     * ne peut pas apparaître par accident, et le guillemet fermant écarte les
     * dérivés comme `marketplace_auction_unsold_count`.
     */
    const estInvendu = (data) => {
      if (typeof data !== 'string') return false;
      return data.includes(`"${NOTIF_INVENDU}"`);
    };

    /*
     * Et le relevé, cette fois SANS condition : toutes les trames, leur type
     * compris. La version précédente ne notait que celles du canal des
     * notifications, et c'est exactement ce qui a caché le problème — une
     * trame binaire, ou postée sur un autre canal, ne laissait aucune trace.
     * `__wmAuto.notifTrames` les rend telles quelles.
     */
    const relever = (data) => {
      try {
        const ligne = typeof data === 'string'
          ? data.slice(0, 300)
          : `[${Object.prototype.toString.call(data)} — non textuel]`;
        // Le battement de cœur reviendrait toutes les trente secondes pour rien.
        if (/"heartbeat"/.test(ligne)) return;
        notifTrames.push(ligne);
        if (notifTrames.length > 12) notifTrames.shift();
      } catch (_) {
        /* relever ne doit jamais coûter la trame relevée */
      }
    };

    function Espion(...args) {
      const s = new Natif(...args);
      /*
       * On enveloppe les écouteurs plutôt que la socket : le site en pose par
       * `addEventListener` ou par `onmessage` selon la bibliothèque, et une
       * seule des deux voies laisserait l'autre ouverte.
       */
      const garde = (fn) => function (e) {
        try {
          if (e) relever(e.data);
          if (prefs.masquerInvendus && e && estInvendu(e.data)) {
            notifDirect += 1;
            if (prefs.tab === 'reglages') render();
            return undefined;   // le site n'apprend jamais que celle-ci existe
          }
        } catch (_) {
          /* trame illisible : elle passe, comme si nous n'étions pas là */
        }
        return fn.apply(this, arguments);
      };

      const ajoute = s.addEventListener.bind(s);
      const retire = s.removeEventListener.bind(s);
      const poses = new Map();
      s.addEventListener = function (type, fn, opts) {
        if (type !== 'message' || typeof fn !== 'function') return ajoute(type, fn, opts);
        const enveloppe = garde(fn);
        poses.set(fn, enveloppe);
        return ajoute(type, enveloppe, opts);
      };
      s.removeEventListener = function (type, fn, opts) {
        return retire(type, poses.get(fn) || fn, opts);
      };
      /*
       * `onmessage` est un accesseur du prototype dans tout navigateur. On le
       * relit plutôt que de le supposer : là où il manquerait, mieux vaut une
       * voie non filtrée qu'un `TypeError` qui emporte la connexion du site.
       */
      const accesseur = Object.getOwnPropertyDescriptor(Natif.prototype, 'onmessage');
      if (accesseur && typeof accesseur.set === 'function') {
        Object.defineProperty(s, 'onmessage', {
          configurable: true,
          get() { return this._wmOnMessage || null; },
          set(fn) {
            this._wmOnMessage = fn;
            accesseur.set.call(this, typeof fn === 'function' ? garde(fn) : fn);
          },
        });
      }
      return s;
    }

    Espion.prototype = Natif.prototype;
    // `CONNECTING`, `OPEN`, `CLOSING`, `CLOSED` : du code les lit sur le constructeur.
    for (const k of Object.keys(Natif)) Espion[k] = Natif[k];
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Espion[k] = Natif[k];
    window.WebSocket = Espion;
  }

  /*
   * Le dernier filet, et le seul qui ne dépende d'aucun transport.
   *
   * Deux versions ont visé le chemin par lequel ces avis arrivent — la réponse
   * HTTP, puis le websocket — et deux fois ils sont entrés quand même. Celui-ci
   * ne vise plus le chemin : il regarde ce qui est à l'écran. Une ligne de
   * notification est un `<button>` dans la liste de la cloche ; celle qui dit
   * qu'une enchère s'est terminée sans mise est repliée, pas supprimée.
   *
   * `hidden` plutôt qu'un retrait : le site tient sa propre liste et
   * redessinerait par-dessus une ligne arrachée. Décocher la case les rend
   * toutes, sans rechargement.
   *
   * Ce que ça ne corrige pas, et il faut le dire : la pastille compte ce que
   * le site croit avoir, pas ce qu'il montre. Elle peut donc annoncer plus de
   * lignes que la liste n'en présente.
   */
  const INVENDU_TEXTE = /sans aucune mise|without any bids|no bids were placed/i;
  /*
   * Ce qui compte un avis : sert à ne jamais replier un conteneur pour un seul.
   *
   * Le drapeau `g` n'est pas décoratif — sans lui `match` ne rend que la
   * PREMIÈRE occurrence, le compte valait toujours un, et la liste entière se
   * repliait. Et l'apostrophe est acceptée droite ou courbe : le site emploie
   * la courbe, un test écrit à la main emploie souvent l'autre.
   */
  const AVIS_TEXTE = /s['’]est termin|a été vendue|vous propose|a misé|was sold|has ended/gi;
  let domObs = null;

  function masquerLignesInvendues() {
    let caches = 0;
    try {
      for (const el of document.querySelectorAll('button')) {
        const t = el.textContent || '';
        if (!INVENDU_TEXTE.test(t)) continue;
        // Un bouton qui porte plusieurs avis n'est pas une ligne : c'est la liste.
        if ((t.match(AVIS_TEXTE) || []).length > 1) continue;
        if (el.hidden) { caches += 1; continue; }
        el.hidden = true;
        el.dataset.wmMasque = '1';
        caches += 1;
        /*
         * Le compte que les Réglages affichent. Il vit ici et non dans le
         * garde du websocket : c'est ce filet-ci qui fait le travail, et un
         * compteur branché sur la porte inactive serait resté à zéro en
         * laissant croire que rien n'arrive.
         */
        notifDirect += 1;
      }
    } catch (_) {
      /* le DOM du site n'est pas à nous : on ne casse rien s'il change */
    }
    return caches;
  }

  /** Rendre ce qu'on a replié — décocher la case doit suffire. */
  function rendreLignesInvendues() {
    try {
      for (const el of document.querySelectorAll('[data-wm-masque]')) {
        el.hidden = false;
        delete el.dataset.wmMasque;
      }
      const p = pastilleCloche();
      if (p && p.dataset.wmPastille != null) {
        p.textContent = p.dataset.wmPastille;
        p.hidden = false;
        delete p.dataset.wmPastille;
      }
    } catch (_) {
      /* rien à rendre */
    }
  }

  /*
   * Les deux gestes du masquage, ensemble. Ils ne se séparent pas : replier
   * les lignes en laissant la pastille les compter, c'est promettre des
   * nouvelles qui n'existent pas — et corriger la pastille sans replier les
   * lignes ne masquerait rien du tout.
   */
  function appliquerMasquage() {
    corrigerPastille();
    return masquerLignesInvendues();
  }

  /** Le compteur rouge posé sur la cloche, ou `null` s'il n'est pas affiché. */
  function pastilleCloche() {
    try {
      for (const b of document.querySelectorAll('button')) {
        if (!/notification/i.test(b.getAttribute('aria-label') || '')) continue;
        const s = b.querySelector('span');
        if (s) return s;
      }
    } catch (_) {
      /* page inattendue */
    }
    return null;
  }

  /*
   * La pastille disait le contraire de la liste.
   *
   * Elle compte ce que le SITE croit avoir reçu — invendus compris, puisqu'il
   * les reçoit et que nous ne faisons que les replier. Relevé sur un compte
   * réel : « 7 » sur la cloche, trois lignes utiles en dessous. Un compteur qui
   * annonce des nouvelles qui n'existent pas fait ouvrir pour rien, et c'est
   * exactement ce que cette option prétend supprimer.
   *
   * `/api/notifications` porte un booléen `read` par avis : le vrai nombre est
   * donc calculable — les non-lus, invendus exclus. Il est tenu à jour par les
   * deux lectures qui existent déjà, celle du site et notre relevé de quinze
   * secondes, pour rester juste même si l'une des deux est désactivée.
   *
   * On n'écrit que si la valeur diffère : réécrire le même texte crée une
   * mutation, qui rappelle l'observateur, qui réécrit — une boucle à chaque
   * image, pour rien.
   */
  function corrigerPastille() {
    if (notifNonLues == null) return;
    const p = pastilleCloche();
    if (!p) return;
    try {
      // La valeur du site, gardée une fois pour toutes : c'est elle qu'on rendra.
      if (p.dataset.wmPastille == null) p.dataset.wmPastille = p.textContent || '';
      const veut = notifNonLues > 0 ? String(notifNonLues) : '';
      if (!notifNonLues) {
        if (!p.hidden) p.hidden = true;
        return;
      }
      if (p.hidden) p.hidden = false;
      if (p.textContent !== veut) p.textContent = veut;
    } catch (_) {
      /* le DOM du site n'est pas à nous */
    }
  }

  function installNotifDomFiltre() {
    if (domObs || typeof MutationObserver !== 'function') return;
    /*
     * La liste se remplit à l'ouverture de la cloche et à chaque avis reçu :
     * un seul passage ne verrait rien, il faut donc suivre les mutations.
     *
     * Mais pas une par une. La première version relançait un
     * `querySelectorAll('button')` sur toute la page à CHAQUE mutation — or
     * cette page fait tourner des comptes à rebours à la seconde, et chaque
     * chiffre qui change est une mutation. Des centaines de balayages complets
     * par minute, pour une liste qui ne bouge que quand un avis tombe.
     *
     * Deux garde-fous, et ils se complètent :
     *
     * - **un seul passage par image.** Les mutations arrivent en rafales — un
     *   rendu React en produit des dizaines — et une rafale ne mérite qu'un
     *   balayage. `requestAnimationFrame` les regroupe naturellement, et
     *   s'endort tout seul quand l'onglet passe à l'arrière-plan.
     * - **rien à faire si le texte n'est pas là.** Un test sur le corps de la
     *   page coûte une comparaison de chaîne, contre un parcours de tous les
     *   boutons. Tant qu'aucune ligne ne dit « sans aucune mise », on ne
     *   cherche pas où elle serait.
     */
    let prevu = false;
    const planifier = () => {
      if (prevu || !prefs.masquerInvendus) return;
      prevu = true;
      const passer = () => {
        prevu = false;
        // La pastille d'abord : elle est là même quand la liste ne l'est pas.
        corrigerPastille();
        try {
          if (!INVENDU_TEXTE.test(document.body.textContent || '')) return;
        } catch (_) {
          return;
        }
        masquerLignesInvendues();
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(passer);
      else setTimeout(passer, 100);
    };

    domObs = new MutationObserver(planifier);
    quandLeDomEstPret(() => {
      try {
        domObs.observe(document.body, { childList: true, subtree: true });
        planifier();
      } catch (_) {
        /* pas de corps de page : rien à observer */
      }
    });
  }


  /**
   * @param {Function} [viaFetch] pour court-circuiter nos propres filtres de
   *   réponse. Le journal des ventes se nourrit des avis d'invendu que
   *   `installNotifProxy` retire au site : il lui faut la réponse brute, sans
   *   quoi le compte d'invendus — celui qui arme la suggestion de baisse —
   *   cesserait de monter le jour où l'on coche la case.
   */
  async function api(url, method = 'GET', body, viaFetch) {
    const res = await fetchBorne(url, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, viaFetch);
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
   * observe seulement que l'invite a quitté la page. La veille s'arrête au bout
   * d'une heure, pour qu'un onglet oublié ne redémarre pas tout seul beaucoup
   * plus tard, dans un contexte que tu n'as plus en tête.
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
        return setStatus('Vérification passée — cliquez Start pour reprendre.');
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

  /*
   * UN contexte audio, gardé.
   *
   * Il en naissait un par bip, jamais fermé. Le rappel de vérification humaine
   * sonne toutes les trente secondes pendant jusqu'à une heure : cent vingt
   * contextes, alors que le navigateur en plafonne le nombre par document.
   * Passé la limite, la construction lève, le `catch` avale, et l'alerte
   * s'éteignait EN SILENCE — exactement dans la situation qu'elle sert, quand
   * tu n'es pas devant l'écran et que la réserve se remplit.
   */
  let audio = null;

  function beep() {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      // Un contexte né hors d'un geste de l'utilisateur arrive suspendu.
      if (audio.state === 'suspended') audio.resume();
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.05;
      osc.connect(gain).connect(audio.destination);
      // Les nœuds ne se libèrent pas tout seuls tant qu'ils restent branchés.
      osc.onended = () => {
        try { gain.disconnect(); } catch (_) {}
      };
      osc.start();
      osc.stop(audio.currentTime + 0.25);
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

  // Dernier profil journalisé, pour ne pas répéter la même ligne chaque minute.
  let dernierProfil = '';
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
      state.dbNote = 'Session du jeu illisible — reconnectez-vous au site.';
      render();
      return null;
    }

    const rep = await sbRpc('get_my_profile', {});
    const p = Array.isArray(rep) ? rep[0] : rep;
    if (!p || typeof p !== 'object') {
      /*
       * Fonction absente, renommée, ou refusée : on le dit une fois plutôt que
       * de réessayer en silence toutes les minutes sans que rien n'apparaisse.
       *
       * Mais on le dit à qui de droit. Le panneau annonce la CONSÉQUENCE et le
       * geste qui la lève ; le nom de la fonction serveur et l'invite à taper
       * dans la console s'adressent à qui écrit le script, pas à qui l'utilise
       * — ils vont donc en console, où `diagCote()` les attend déjà.
       */
      state.dbNote = 'La base n’a pas répondu — la réserve reste estimée. '
        + 'Décochez puis recochez « Accès direct » pour réessayer.';
      console.info('[WikiMasters Tools] get_my_profile : aucune réponse exploitable.'
        + ' Voir wmSchema() pour les tables lisibles.');
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
     * Le compteur de pitié et le solde partent en console.
     *
     * `pity_counter` est une colonne que le site n'affiche nulle part et dont
     * on ne sait pas encore ce qu'elle commande : la montrer dans des réglages,
     * sous un mot que le jeu n'emploie pas, c'est du travail en cours exposé à
     * qui joue. Le solde, lui, est déjà écrit en haut de chaque page du site —
     * le répéter ici n'apprend rien et périme entre deux relevés.
     *
     * Une seule ligne par changement : ce relevé passe toutes les minutes tant
     * que la boucle tourne, et une console qui répète la même ligne soixante
     * fois par heure n'est pas plus lisible qu'un panneau qui l'affiche.
     */
    const empreinte = `${state.pity}/${state.pityMax}/${state.balance}`;
    if (empreinte !== dernierProfil) {
      dernierProfil = empreinte;
      console.info('[WikiMasters Tools] profil', {
        pitié: state.pity, pitié_max: state.pityMax, solde: state.balance,
      });
    }

    /*
     * Le repli n'énumérait plus les colonnes trouvées à l'écran. C'était une
     * trace de mise au point — le schéma d'une table du jeu — affichée dans un
     * onglet de réglages, où elle n'apprend rien à personne et ressemble à une
     * fuite. Elle part en console, à côté du reste du diagnostic.
     */
    if (!lu) {
      console.info('[WikiMasters Tools] get_my_profile ne porte pas les paquets — colonnes reçues :',
        Object.keys(p).slice(0, 12).join(', '));
    }
    /*
     * Ce qui reste à l'écran doit s'adresser à qui joue : combien de paquets
     * l'attendent, à quel rythme ils reviennent, et si son compte est PRO —
     * trois choses qu'il peut vérifier et qui changent ce qu'il fait. « Réserve
     * lue en base » décrivait par quel chemin l'outil l'avait appris, ce qui ne
     * regarde que l'outil.
     */
    const etat = lu
      ? `${state.reserve == null ? '?' : state.reserve} paquet${state.reserve === 1 ? '' : 's'}` +
        ` en réserve sur ${MAX_RESERVE} · un de plus toutes les ` +
        `${fmtClock(state.cadenceMs)}${p.is_pro ? ' (compte PRO)' : ''}`
      : 'Le compte de paquets n’est pas lisible : la réserve reste estimée.';
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

  /**
   * Un bonus rend les mêmes cartes qu'une ouverture normale — sinon on le
   * signale. Un code HTTP nu ne dit rien à qui utilise l'outil : l'écran
   * annonce que le paquet n'a pas pu être pris, le statut va en console.
   */
  function absorbBonus({ status, data }, label) {
    if (status === 200 && data && Array.isArray(data.cards)) {
      record(data.cards, label);
      state.bonusNote = `${label} réclamé`;
    } else {
      state.bonusNote = `${label} : indisponible pour l'instant`;
      console.info(`[WikiMasters Tools] ${label} — réponse ${status} non exploitée`);
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

  /*
   * LES CINQ ISSUES D'UNE OUVERTURE, une fonction chacune.
   *
   * `loop` faisait 314 lignes, dont l'essentiel était ces cinq branches —
   * autonomes depuis toujours : elles ne partagent que `state`, `mine()` et
   * la réponse. Leur densité, elle, est réelle : c'est l'apprentissage du
   * débit, et leurs commentaires documentent des régressions vues sur un
   * compte. Chaque commentaire est donc parti AVEC sa branche ; aucun n'est
   * resté orphelin en tête de fonction.
   *
   * La convention est la même pour les cinq : rendre `SUITE` quand le tour
   * suivant peut partir, `FIN` quand la boucle s'arrête ici. C'est ce que
   * disaient `continue` et `return` avant le découpage.
   */
  const SUITE = true;
  const FIN = false;

  /** Un paquet ouvert. */
  async function surPaquetOuvert(data, mine, tour) {
    state.throttles = 0;
    // Le dernier succès réseau de la boucle, daté. C'est la première ligne
    // que cherche quelqu'un qui demande « depuis quand ça ne marche plus ».
    noterSucces('boucle');
    if (state.reserve != null) state.reserve = Math.max(0, state.reserve - 1);
    /*
     * Succès : on grignote le délai pour retrouver le rythme réel, sans
     * repasser sous le plancher appris — inutile de retourner buter dans
     * un mur déjà rencontré.
     *
     * Ce mur bouge, lui : le jeu a déjà assoupli son débit une fois. Après
     * une longue série sans refus on rabote donc le plancher appris, ce qui
     * fait redescendre le délai d'un cran. Si c'était trop tôt, le 429
     * suivant le remonte — au pire un aller-retour tous les quarante paquets.
     *
     * Le pas est ADDITIF, et de la même famille que la marge qui pose le
     * plancher — un peu plus petit qu'elle. Deux règles proportionnelles se
     * sont succédé ici, et toutes deux ont fini par dériver : la détente
     * traversait ce que la marge défendait, et le plancher montait par
     * cliquet. Voir `probeMarginMs` pour le détail et les mesures.
     */
    state.delayMs = Math.max(floorMs(), state.delayMs - CFG.decayMs);
    if (state.probeFloorMs && ++state.cleanHits >= CFG.probeAfterHits) {
      state.cleanHits = 0;
      const relaxed = state.probeFloorMs - CFG.probeRelaxMs;
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
    if (!mine()) return FIN;
    refreshOwned();
    // Cote des nouvelles cartes, en tâche de fond : la liste de revente
    // reste à jour sans relevé complet.
    priceCards(data.cards.map((c) => ({ id: c.id, t: c.wikipedia_title, r: c.rarity, tags: [] })));
    setStatus('Paquet ouvert');
    tour.refusPerimes = 0;   // la série de refus périmés est close
    await sleep(jittered(state.delayMs));
    return SUITE;
  }

  /** Réserve vide : le serveur dit quand il en aura un autre — ou ne le dit pas. */
  async function surReserveVide(data, mine, tour) {
    state.reserve = 0;
    const target = data.next_regen_at ? Date.parse(data.next_regen_at) : NaN;
    if (Number.isFinite(target)) {
      learnCadence(target);
      state.nextRegenAt = target;
    }
    /*
     * Sans échéance annoncée, on attend une cadence mesurée plutôt qu'un
     * délai fixe : 90 s de repli feraient sept sondages inutiles par cycle
     * sur un compte sans PRO, où la régénération prend dix minutes.
     *
     * Une échéance DÉJÀ PASSÉE compte pour non annoncée, et c'est le point.
     *
     * `waitUntil` sort aussitôt d'une échéance dans le passé — sa boucle
     * ne s'exécute pas une fois — et la boucle repostait donc sur-le-champ,
     * sans le moindre délai. Plus rien ne la freinait que le refus du
     * serveur : 403, retente immédiate, 429, léger recul, 403 encore.
     * Relevé dans la console d'un vrai compte, en alternance serrée, là où
     * un refus doit produire un silence de plusieurs minutes.
     *
     * On ne peut pas savoir d'ici POURQUOI le serveur rend un horodatage
     * périmé — réserve épuisée qu'il n'a pas recréditée, compte bridé,
     * horloges décalées. Mais aucune de ces raisons ne justifie de le
     * marteler : on retombe sur la cadence mesurée, exactement comme
     * lorsqu'il n'annonce rien du tout.
     */
    const annoncee = Number.isFinite(target) && target > Date.now();
    const deadline = annoncee ? target : Date.now() + state.cadenceMs;

    /*
     * Échéance périmée : avant d'attendre une cadence en aveugle, on
     * DEMANDE. Le profil porte `packs_remaining` et se lit par une requête
     * ordinaire — pas par l'ouverture, qui est l'endpoint que le serveur
     * limite. Si le profil dit qu'il en reste, le refus était en retard sur
     * lui-même : on repart sans attendre trois minutes pour rien.
     *
     * Une seule relecture par série, et jamais plus vite que le délai
     * mesuré. Si l'ouverture et le profil se contredisent durablement,
     * insister ne ferait que remplacer un martèlement par un autre : au
     * second refus périmé d'affilée, on attend pour de bon.
     */
    if (!annoncee && tour.refusPerimes === 0) {
      tour.refusPerimes += 1;
      const prof = await refreshPacks(true);
      if (!mine()) return FIN;
      if (prof && state.reserve > 0) {
        await sleep(jittered(state.delayMs));
        return SUITE;
      }
    }
    await waitUntil(deadline, 'Prochain paquet dans', mine);
    return SUITE;
  }

  /** Session expirée. */
  function surSessionExpiree() {
    stop('Session expirée — reconnectez-vous puis relancez.', true);
    return FIN;
  }

  /*
   * Le serveur throttle les appels rapprochés. On ralentit durablement au
   * lieu d'insister — et surtout on RETIENT le délai qui vient d'être
   * refusé : c'est la seule mesure fiable du débit autorisé, et le jeu
   * l'a déjà changé une fois. Le plancher se pose une marge au-dessus de ce
   * délai, le délai courant recule plus largement puis redescend jusqu'à
   * ce plancher au fil des succès.
   *
   * La marge est ADDITIVE, et les deux gardes qui suivent tiennent à ça :
   * seul le premier refus d'une série compte, et seulement s'il a testé le
   * plancher. Voir `probeMarginMs` pour ce qu'a coûté chacune.
   */
  /** Débit limité. */
  async function surDebitLimite(retryMs, mine) {
    state.throttles += 1;
    state.cleanHits = 0;
    /*
     * Seul le PREMIER refus d'une série renseigne sur le débit soutenable.
     * Les suivants tombent alors qu'on recule déjà : ce n'est pas une
     * mesure nouvelle, c'est le même incident qui se prolonge. Les compter
     * faisait enfler le plancher en composé — sept refus d'affilée le
     * portaient à 40 s, soit près du plafond, d'où l'on ne redescendait
     * qu'en 1 520 paquets sans le moindre refus.
     *
     * Le délai courant, lui, continue de doubler : c'est le recul, et il
     * doit bien répondre à chaque refus.
     */
    /*
     * Et il ne renseigne que s'il a TESTÉ le plancher.
     *
     * Le délai courant peut être très au-dessus : il grandit de 60 % par
     * refus et ne redescend que de 250 ms par succès. Un refus qui tombe
     * pendant cette redescente ouvre bien une série neuve — les compteurs
     * ont été remis à zéro par le succès qui précède — mais il ne dit rien
     * de notre rythme : à ce délai-là, on ne testait plus rien.
     *
     * Le poser quand même sur ce délai gonflé était le dernier cliquet, et
     * il suffisait à lui seul. Reproduit sur le banc : trois succès, une
     * série de quatre refus, un succès, un refus — plancher de 1 550 à
     * 8 242 ms d'un coup. Deux cycles de plus et c'est le plafond. C'est
     * l'état trouvé sur un compte réel en 2.13.0, migration passée : les
     * deux à 60 000 ms moins d'une heure après une remise à zéro.
     *
     * La marge additive bornait le PAS, pas la BASE. On exige donc que le
     * délai refusé soit à portée du plancher — sinon le refus vient
     * d'ailleurs (une rafale, un autre appel, un hoquet du serveur) et
     * n'apprend rien sur l'espacement des ouvertures. Le premier refus,
     * lui, compte toujours : sans plancher, c'est notre seule mesure.
     */
    if (state.throttles === 1) {
      const aTeste = !state.probeFloorMs
        || state.delayMs <= floorMs() + CFG.probeMarginMs;
      if (aTeste) {
        state.probeFloorMs = Math.min(CFG.ceilDelayMs, state.delayMs + CFG.probeMarginMs);
      }
    }
    state.delayMs = Math.min(CFG.ceilDelayMs, Math.round(state.delayMs * CFG.growth));
    saveStore({ delayMs: state.delayMs, probeFloorMs: state.probeFloorMs });
    if (state.throttles > CFG.maxThrottleRetries) {
      stop(`Toujours limité après ${CFG.maxThrottleRetries} tentatives.`, true);
      return FIN;
    }
    // Le recul deviné double à chaque refus consécutif ; une consigne
    // explicite du serveur, elle, se suit telle quelle.
    const wait = retryMs || CFG.throttleBackoffMs * 2 ** (state.throttles - 1);
    await waitUntil(Date.now() + wait, 'Débit limité — reprise dans', mine);
    return SUITE;
  }

  /*
   * La limite QUOTIDIENNE, qui n'est pas un débit.
   *
   * Relevé sur un compte réel le 12 septembre 2026, appel par appel : à
   * chaque régénération, le premier essai reçoit un 429 « Limite quotidienne
   * de paquets atteinte », avec `rate_limit_daily: true`, un paquet pourtant
   * disponible, et un `retry_after` une quinzaine de secondes plus loin — que
   * le serveur tient : l'essai fait à l'heure dite passe. Le compte est au
   * plafond de sa journée, et chaque paquet attend son tour.
   *
   * Ce refus ne dit RIEN de l'espacement des ouvertures : il tombe après une
   * attente de régénération, deux minutes après l'appel précédent. La branche
   * du débit le prenait pourtant pour un mur touché — plancher relevé de
   * 300 ms, délai multiplié de 60 % — à chaque cycle de trois minutes, et le
   * cliquet avait porté les deux au plafond de 60 s.
   *
   * On attend donc l'heure annoncée, sans rien apprendre ni rien compter :
   * ni plancher, ni délai, ni refus d'affilée — une journée pleine ne doit
   * pas finir en « Toujours limité ». Sans heure annoncée, la cadence mesurée
   * sert de repli, comme pour une réserve vide.
   */
  async function surLimiteQuotidienne(retryMs, mine) {
    await waitUntil(Date.now() + (retryMs || state.cadenceMs), 'Limite quotidienne — reprise dans', mine);
    return SUITE;
  }

  /** Tout le reste : on ne devine pas, on s'arrête. */
  function surReponseInattendue(status, data) {
  /*
   * La charge utile allait à l'écran — 120 caractères de réponse serveur
   * bruts, dans la ligne d'état, celle qu'on voit depuis tous les onglets.
   * On ne sait pas ce que le serveur y met, et l'utilisateur n'en fait
   * rien : le panneau dit que la boucle s'arrête et sur quel statut, la
   * réponse va en console pour qui saura la lire.
   */
  console.info(`[WikiMasters Tools] réponse inattendue (${status}) :`, data);
  stop('Le site a répondu autre chose que prévu — arrêt par précaution.', true);
  return FIN;
  }

  async function loop(epoch) {
    // Vrai tant que cette boucle-ci est la boucle courante.
    const mine = () => state.running && epoch === loopEpoch;

    /*
     * Refus consécutifs dont l'échéance était déjà passée. Il autorise UNE
     * relecture du profil par série : si le profil et l'ouverture se
     * contredisent durablement, insister remplacerait un martèlement par un
     * autre. Remis à zéro dès qu'un paquet s'ouvre.
     */
    /*
     * Le seul état que deux branches se partagent : les refus dont
     * l'échéance était déjà passée. Il vit ICI, le temps d'une boucle, et
     * voyage explicitement — le hisser au niveau du fichier le ferait
     * survivre à un `stop()` puis à un `start()`, et une série close
     * repartirait avec le compte de la précédente.
     */
    const tour = { refusPerimes: 0 };

    while (mine()) {
      /*
       * Le verrou, repris à CHAQUE tour — pas seulement au démarrage.
       * ---------------------------------------------------------------
       * `start()` vérifiait le verrou une fois et plus jamais ; le battement le
       * rafraîchissait sans jamais lire sa réponse (voir plus bas). Une boucle
       * qui perdait la main continuait donc d'ouvrir, en aveugle, à côté de
       * celle qui l'avait prise.
       *
       * Ce n'est pas une hypothèse. Chrome gèle les minuteries d'un onglet en
       * arrière-plan à environ un tour par minute : le rafraîchissement, qui
       * n'a lieu qu'un tour sur huit, demande alors huit minutes là où le
       * verrou expire en douze secondes. Relevé sur un vrai navigateur : un
       * onglet tenait le verrou avec un battement vieux de 159 secondes. Il
       * suffit qu'un second onglet lise ce verrou — libre, puisque périmé —
       * pour que deux boucles ouvrent ensemble.
       *
       * Deux appels collés, c'est exactement ce que le serveur refuse. Le 429
       * qui suit n'apprend donc RIEN sur le débit autorisé : il est fabriqué
       * par l'outil. Et il coûte cher, parce qu'il est retenu — `delayMs` est
       * multiplié puis persisté, le plancher appris se recalcule dessus. Vu sur
       * un compte réel : les deux collés au plafond de 60 s, pour des paquets
       * ouverts à une minute d'intervalle que le serveur n'a jamais refusés à
       * ce rythme-là.
       *
       * `takeLock()` REPREND le verrou s'il est libre ou déjà nôtre, et ne rend
       * faux que si un autre onglet le tient vraiment. Un onglet réveillé après
       * un gel se réapproprie donc sa place tant que personne ne l'a prise ;
       * s'il l'a perdue, il s'arrête ici, avant d'ouvrir quoi que ce soit.
       */
      if (!takeLock()) {
        return stop('Un autre onglet a pris la main — boucle arrêtée ici.', true);
      }

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
        /*
         * Le message d'exception du navigateur — « Failed to fetch », et pire
         * selon le cas — partait tel quel dans la ligne d'état. Il ne dit rien
         * de plus que « ça n'est pas passé », et pas dans la même langue que le
         * reste du panneau. Il va en console, où il sert.
         */
        console.warn('[WikiMasters Tools] appel réseau échoué :', err);
        /*
         * Un serveur qui pend et un réseau coupé ne se cherchent pas au même
         * endroit : le premier n'a rien à voir avec la connexion de qui lit,
         * et l'envoyer vérifier sa box, c'est l'envoyer au mauvais endroit.
         */
        return stop(
          err && err.expiration
            ? 'Le site a accepté la connexion sans jamais répondre — arrêt au bout de '
              + `${Math.round(RESEAU_TIMEOUT_MS / 1000)} s. Réessayez plus tard.`
            : 'Le site est injoignable — vérifiez votre connexion, puis relancez.',
          true
        );
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

      /*
       * L'aiguillage. Les conditions sont celles d'avant, dans le même ordre :
       * un 200 sans tableau de cartes, ou un 403 avec des paquets restants,
       * tombent volontairement dans « réponse inattendue ».
       */
      const suite = status === 200 && data && Array.isArray(data.cards)
        ? await surPaquetOuvert(data, mine, tour)
        : status === 403 && data && data.packs_remaining === 0
          ? await surReserveVide(data, mine, tour)
          : status === 401
            ? surSessionExpiree()
            : status === 429 && data && data.rate_limit_daily === true
              ? await surLimiteQuotidienne(retryMs, mine)
              : status === 429
                ? await surDebitLimite(retryMs, mine)
                : surReponseInattendue(status, data);
      /*
       * `!== SUITE`, et non `=== FIN`. Une branche qui oublierait de rendre
       * son verdict rendrait `undefined` : comparé à FIN, ça vaut « continue »,
       * et la boucle repartirait sur une réponse qu'elle n'a pas su traiter.
       * Comparé à SUITE, elle s'arrête. Des deux erreurs possibles, s'arrêter
       * est celle qui n'ouvre pas de paquets.
       */
      if (suite !== SUITE) return;
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
        // Le détail de l'exception en console, le fait à l'écran.
        console.error('[WikiMasters Tools] la boucle s’est arrêtée sur une erreur :', err);
        stop('Quelque chose s’est mal passé — boucle arrêtée. Relancez avec Start.', true);
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
  /*
   * Plancher typographique : 10 px.
   *
   * Le panneau est dense à dessein — 300 px de large, il tient de l'outil, pas
   * de la page — et 10 à 12 px y sont la bonne échelle. Mais cinq règles
   * descendaient à 9 px : les pastilles de compte des volets, les étiquettes du
   * Marché, la numérotation de l'ancien lot de guilde et sa ligne de méta. C'est en
   * dessous de ce qui se lit, et ces mêmes règles portaient le ton le plus
   * faible de la palette — les deux difficultés cumulées au même endroit.
   *
   * Le palier de 9 px est donc supprimé, pas la densité : 10 et 11 px restent
   * l'échelle du panneau, et c'est un choix, pas un oubli. Si un jour une règle
   * redescend sous 10 px, c'est ce commentaire qu'il faut contredire.
   */
  /*
   * La palette, une seule fois pour les deux surfaces.
   *
   * Le panneau déclarait douze variables ; la Revente, écrite après, en
   * déclarait UNE et écrivait ses couleurs en dur — 105 littéraux pour 34
   * tons distincts. Rien ne reliait les deux : une retouche de la palette du
   * panneau laissait la Revente dériver, en silence, et le contrôle de
   * contraste du vérificateur ne regardait que « --text » et « --muted ».
   *
   * Relevé avant de toucher à quoi que ce soit : sur ces 34 tons, 25 étaient
   * DÉJÀ identiques au caractère près à une variable du panneau. Il n'y avait
   * donc rien à harmoniser — seulement à cesser de les recopier. Les trois
   * fonds plus sombres de la Revente, eux, sont un choix documenté et gardent
   * leurs propres noms ; le reste est du voile noir et une couleur de rareté.
   *
   * Les deux feuilles interpolent ce bloc : il n'y a plus qu'un endroit où
   * changer un ton, et les deux surfaces suivent.
   */
  const PALETTE = `
      --bg: rgba(13,15,19,.94);
      --raise: rgba(255,255,255,.045);
      --line: rgba(255,255,255,.07);
      --text: #F1F4F8;
      --muted: #949DAD;
      /*
       * #626B7A tombait à 3,59:1 sur le fond du panneau — mesuré au pixel sur
       * un rendu réel, translucidité comprise — soit sous le plancher WCAG AA
       * de 4,5:1. Or c'est le ton des textes de 9 à 11 px : le plus petit
       * portait le plus faible contraste, les deux difficultés au même endroit.
       *
       * #717C8D atteint 4,57:1 à teinte et saturation identiques (218°, 11 %),
       * et 4,54:1 sur le fond légèrement plus clair de la Revente — une seule
       * valeur pour les deux palettes. Il reste une fois et demie moins
       * contrasté que « --muted » : la hiérarchie des trois niveaux de gris
       * tient, elle se lit simplement jusqu'au bout.
       */
      --dim: #717C8D;
      --live: #35D68F;
      --warn: #F0A94B;
      --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI Variable", "Segoe UI", sans-serif;

      /*
       * Trois rayons, et pas huit.
       *
       * Le panneau en portait 4, 5, 6, 7, 8, 9, 10 et 16 px, au gré des blocs
       * écrits les uns après les autres. Aucun n'était faux ; c'est leur
       * nombre qui l'était — deux boutons voisins de rôle identique n'avaient
       * pas le même coin, et rien ne rimait.
       *
       * L'échelle suit l'imbrication, pas la taille : ce qui vit DANS quelque
       * chose prend le petit, les objets autonomes le moyen, les cadres qui
       * en contiennent d'autres le grand. Le panneau lui-même garde 16 px, et
       * les pastilles leur 999.
       *
       * L'écart entre --r-md et --r-sm vaut trois pixels, soit le rembourrage
       * du contrôle segmenté à un pixel près : un bouton posé dans son rail
       * suit donc sa courbe au lieu de la couper.
       */
      --r-sm: 7px;
      --r-md: 10px;
      --r-lg: 14px;
  `;
  const PANEL_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; }

    /*
     * « hidden » cache pour de bon.
     *
     * L'attribut ne doit son effet qu'à une règle de la feuille par défaut du
     * navigateur, et TOUTE règle d'auteur qui pose un « display » la bat —
     * « .opt { display: flex } » suffit. Un élément marqué caché restait donc
     * à l'écran, et c'est silencieux : le code croit l'avoir retiré.
     *
     * Le fichier le rattrapait jusqu'ici classe par classe — « .maj[hidden] »,
     * « .openrar[hidden] », « .revente[hidden] », « .relist[hidden] »… Autant
     * de correctifs identiques, et un de plus à écrire à chaque fois qu'on
     * cache quelque chose. La règle est posée une fois, elle vaut pour tout ce
     * qui viendra.
     */
    [hidden] { display: none !important; }

    .panel {
      ${PALETTE}

      background: var(--bg);
      backdrop-filter: blur(18px) saturate(1.3);
      border: 1px solid var(--line);
      border-radius: 16px;
      color: var(--text);
      font: 13px/1.5 var(--sans);
      /*
       * Le filet clair de la tranche haute, comme sur la boîte de la Revente :
       * c'est ce qui donne au panneau son épaisseur sans éclaircir son fond —
       * lequel est tenu par le plancher de contraste de « --dim ». Les deux
       * surfaces de l'outil se détachent donc de la même façon.
       */
      box-shadow: 0 24px 64px rgba(0,0,0,.6), 0 2px 8px rgba(0,0,0,.4),
                  inset 0 1px 0 rgba(255,255,255,.06);
      overflow: hidden;
      /* Le panneau ne dépasse jamais de l'écran : au-delà, le corps défile. */
      max-height: calc(100vh - 24px);
      display: flex;
      flex-direction: column;
    }
    /* Chasse tabulaire partout où un chiffre change en place : sans elle,
       le décompte fait danser tout ce qui l'entoure à chaque seconde. */
    .status b, .fig b, .goal .cnt { font-variant-numeric: tabular-nums; }

    /* « touch-action: none » : sans lui, le navigateur préempte le geste pour
       faire défiler la page et le panneau ne suit jamais le doigt. */
    .head { display: flex; align-items: center; gap: 9px; padding: 13px 14px; cursor: grab;
            touch-action: none; }
    .head:active { cursor: grabbing; }
    .panel:not(.folded) .head { border-bottom: 1px solid var(--line); }

    .mark { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--dim); transition: .25s; }
    .panel.live .mark { background: var(--live); box-shadow: 0 0 0 3px rgba(53,214,143,.18); }
    .panel.warn .mark { background: var(--warn); box-shadow: 0 0 0 3px rgba(240,169,75,.18); }

    /*
     * Le titre se COUPE plutôt que de passer à la ligne. Mesuré au pixel dans
     * le panneau réel : la pastille de mise à jour, ajoutée dans un en-tête
     * déjà plein, faisait passer « WikiMasters Tools » sur deux étages — et à
     * 260 px, la borne basse de la poignée, même la flèche seule suffisait à
     * le faire. Un titre tronqué en « WikiMaste… » se lit encore ; un en-tête
     * qui double de hauteur déplace tout ce qui est en dessous.
     */
    .title { font-size: 13px; font-weight: 600; letter-spacing: -.01em;
             min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /*
     * La version ne vivait que dans la console : « console.info » au démarrage et
     * « __wmAuto.version ». Or c'est LE numéro qu'on cite pour demander de l'aide,
     * et la mise à jour se fait toute seule, en silence, sous 24 h — rien
     * n'indiquait donc sur quoi on tournait.
     *
     * « user-select: text » à dessein : l'hôte porte « user-select: none »
     * pour que le glissé ne surligne pas la page. Affiché sans cette exception,
     * le numéro n'aurait pas été copiable, ce qui lui retire l'essentiel de son
     * intérêt.
     */
    .ver {
      flex: none; color: var(--dim); font-size: 10px; font-weight: 500;
      font-variant-numeric: tabular-nums; letter-spacing: 0;
      -webkit-user-select: text; user-select: text; cursor: text;
    }
    /*
     * La pastille de mise à jour. Elle est verte — la seule chose de l'en-tête
     * qui appelle un geste — et ne paraît que lorsqu'une version plus récente
     * est en ligne. Contrairement au numéro de version, elle survit à la borne
     * basse : à 260 px, c'est encore ce qu'il y a de plus utile à montrer.
     */
    .maj {
      flex: none; padding: 1px 6px; border-radius: 999px;
      background: rgba(53,214,143,.16); color: var(--live);
      font-size: 10px; font-weight: 600; letter-spacing: 0;
      font-variant-numeric: tabular-nums; text-decoration: none; cursor: pointer;
    }
    .maj:hover { background: rgba(53,214,143,.28); }
    .maj[hidden] { display: none; }

    /* Replié, l'en-tête doit suffire : il affiche le compte à rebours. */
    /* Le décompte vit dans l'onglet Paquets ; ailleurs il remonte dans l'en-tête
       pour rester sous les yeux sans dupliquer l'affichage. */
    .mini { display: none; margin-left: auto; font-size: 12px; font-weight: 600;
            font-variant-numeric: tabular-nums; color: var(--muted); }
    .panel.folded .mini, .panel:not(.tab-paquets) .mini { display: inline; }

    .icon {
      width: 26px; height: 26px; flex: none; border: 0; border-radius: var(--r-md);
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
    /* « display: none » et non « opacity: 0 » : effacée, la barre gardait ses
       3 px et son « gap ». Avec le ruban vide juste en dessous, ça faisait une
       vingtaine de pixels de rien entre le statut et les compteurs. */
    .bar.idle { display: none; }

    /* La réserve n'apparaît que si elle contient quelque chose : le script la
       vide en continu, une jauge permanente n'afficherait jamais rien. */
    .stock {
      padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, var(--live) 15%, transparent);
      color: var(--live); font-size: 11px; font-weight: 600;
    }

    /* Ruban des derniers tirages : une encoche par carte, teintée par rareté.
       Les communes restent sourdes, donc une trouvaille saute aux yeux. */
    .ribbon { display: flex; gap: 2px; align-items: flex-end; height: 18px; }
    /* Sa hauteur est fixe pour que les encoches ne fassent pas sauter la mise
       en page ; sans tirage, elle n'a rien à réserver. */
    .ribbon:empty { display: none; }
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
      margin-left: auto; padding: 3px 9px; border: 1px solid var(--line); border-radius: var(--r-sm);
      background: none; color: var(--muted); cursor: pointer; font: 11px var(--sans);
      transition: .14s;
    }
    .reset:hover { color: var(--text); border-color: var(--dim); background: var(--raise); }
    .reset.arme {
      color: var(--warn); border-color: var(--warn);
      background: color-mix(in srgb, var(--warn) 12%, transparent);
    }
    .rate { margin-top: -10px; color: var(--dim); font-size: 11px; }

    /*
     * Les six raretés doivent tenir sur une ligne. Elles débordaient de 4,5 px
     * sur les 260 disponibles — donc dès qu'un joueur avait tiré une
     * Légendaire, la sixième pastille passait seule à la ligne et le panneau
     * gagnait 22 px de haut pour rien. Mesuré à 300 px, la largeur par défaut.
     *
     * La gouttière passe à 4 px et le rembourrage des pastilles à 8 px : 17 px
     * regagnés. Mesuré à 300 px, sur les six pastilles :
     *
     *     L 1 UR 3 SR 8 R 22 PC 44 C 97     une ligne, 12,5 px de marge
     *     L 2 UR 3 SR 8 R 21 PC 44 C 102    une ligne,  7,9 px
     *     L 4 UR 12 SR 30 R 105 PC 210 C 480   deux lignes, -14,8 px
     *
     * Donc : la session ordinaire tient, y compris quand les communes passent
     * les 100. Une longue session, elle, repasse à deux lignes, et on s'y
     * arrête : gagner ces 15 px demanderait 7 px de rembourrage et 3 px de
     * gouttière, ce qui souderait les pastilles entre elles pour un cas qui
     * n'est pas le plus fréquent. flex-wrap est là pour ça.
     *
     * (Pas d'accent grave dans ce commentaire : il vit dans un littéral de
     * gabarit, et le premier fermerait la chaîne.)
     */
    .chips { display: flex; flex-wrap: wrap; gap: 4px; }
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
      padding: 3px 8px; border-radius: 999px; color: var(--c);
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
    /*
     * La rareté reste une LETTRE ici, alors qu'elle est une pastille teintée
     * dans la Revente et juste au-dessus, dans les filtres. Ce n'est pas un
     * oubli : essayé, regardé, retiré.
     *
     * Les pastilles du dessus se cliquent — ce sont les filtres de rareté.
     * Celles-ci ne se cliqueraient pas. Leur donner la même forme efface la
     * seule chose qui distingue à l'œil ce qui agit de ce qui informe, et une
     * colonne de quinze pastilles alourdit un journal qui doit se parcourir.
     * La teinte suffit : c'est la même, elle relie déjà les deux.
     */
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
      flex: none; width: 18px; height: 18px; border-radius: var(--r-sm); display: grid; place-items: center;
      color: var(--dim); font-size: 10px; font-weight: 600; text-decoration: none;
      cursor: pointer; opacity: 0; transition: .14s;
    }
    /* Au survol, mais aussi au focus : un contour dessiné autour d'un élément
       transparent ne dit rien à qui navigue au clavier. */
    .row:hover .go, .row .go:focus-visible { opacity: 1; }
    .row .go:hover { background: var(--raise); color: var(--text); }
    /* Un écran tactile n'a pas de survol : les deux raccourcis y étaient
       simplement inatteignables. On les y montre en retrait. */
    @media (hover: none) {
      .row .go { opacity: .55; }
    }

    .note { margin-top: 4px; color: var(--warn); font-size: 11px; }

    /* ------------------------------------------------------------ Marché
       Enchères, ventes, relances et journal empilés faisaient un panneau haut
       comme l'écran, avec un ascenseur par liste. Trois volets : on n'en montre
       qu'un, et le corps du panneau redevient le seul à défiler. */
    .subs { display: flex; gap: 3px; padding: 2px; border-radius: var(--r-md); background: rgba(255,255,255,.03); }
    .subs button {
      flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 4px;
      padding: 5px 4px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--dim);
      font: 600 10.5px/1 var(--sans); letter-spacing: -.005em; cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      transition: background .15s, color .15s;
    }
    .subs button:hover { color: var(--text); }
    .subs button.on { color: var(--text); background: var(--raise); }
    .subs .cnt {
      flex: none; padding: 1px 4px; border-radius: 999px; background: rgba(255,255,255,.08);
      color: var(--muted); font: 600 10px/1.4 var(--sans); font-variant-numeric: tabular-nums;
      font-style: normal;
    }
    .subs .cnt.hot { background: color-mix(in srgb, var(--warn) 22%, transparent); color: var(--warn); }
    /* Un relevé qui ne se rafraîchit plus : présent, mais il ne s'annonce pas
       comme courant. Voir le compteur « pale » dans renderSubs. */
    .subs .cnt.pale { opacity: .45; }
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
              border-radius: var(--r-sm); cursor: pointer; }
    .mkt li:hover { background: var(--raise); }
    .mkt li:first-child { border-top: 0; }
    .mkt .dot { width: 5px; height: 5px; flex: none; border-radius: 50%; background: var(--live); }
    .mkt li.out .dot { background: var(--warn); }
    .mkt li.done .dot { background: var(--dim); }
    .mkt .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
              font-size: 11px; color: var(--text); }
    .mkt .tag { flex: none; font-size: 10px; color: var(--live); }
    .mkt li.out .tag { color: var(--warn); }
    .mkt .v { flex: none; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
    /* Un souhait sous la médiane de sa cote, ou au-dessus de son prix visé.
       La flèche double la couleur : le verdict se lit sans distinguer les tons. */
    .mkt .v.bon { color: var(--live); }
    .mkt .v.cher { color: var(--warn); }
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
      padding: 9px 10px; border: 1px dashed var(--line); border-radius: var(--r-lg);
      color: var(--dim); font-size: 11px; line-height: 1.5;
    }
    .mkoff b { color: var(--muted); font-weight: 600; }

    /*
     * Échanges et Amis du classement partagent la même boîte : c'est la même
     * famille — ce que les autres joueurs peuvent pour toi — et deux cadres
     * différents dans un même onglet se seraient disputé l'attention.
     */
    .troc { padding: 9px 10px; margin-bottom: 8px; border: 1px solid var(--line);
            border-radius: var(--r-lg); font-size: 10px; line-height: 1.55; color: var(--dim); }
    .troc .h { font-size: 11px; color: var(--text); font-weight: 600; margin-bottom: 5px; }
    .troc b { color: var(--muted); font-weight: 600; font-variant-numeric: tabular-nums; }
    .troc .l {
      display: flex; align-items: baseline; gap: 6px; width: calc(100% + 12px);
      margin: 0 -6px; padding: 4px 6px; border: 0; border-radius: var(--r-sm);
      background: none; color: var(--dim); font: inherit; text-align: left; cursor: pointer;
      transition: background .14s;
    }
    .troc .l:hover { background: var(--raise); }
    /* Le titre cède la place le premier : le nom de l'ami est ce qui fait agir. */
    .troc .l .t { flex: 1; min-width: 0; color: var(--text); font-weight: 600;
                  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .troc .l .r { flex: none; color: var(--muted); font-weight: 700; }
    .troc .l .q { flex: none; max-width: 45%; color: var(--muted);
                  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .troc .plus { margin-top: 6px; color: var(--muted); }

    /*
     * Le top 200 du classement. Même boîte que les Échanges, juste en
     * dessous : l'un fait venir des amis, l'autre montre ce qu'ils ont.
     */
    .amis { padding: 9px 10px; margin-bottom: 8px; border: 1px solid var(--line);
            border-radius: var(--r-lg); font-size: 10px; line-height: 1.55; color: var(--dim); }
    .amis .h { display: flex; align-items: baseline; gap: 6px;
               font-size: 11px; color: var(--text); font-weight: 600; margin-bottom: 6px; }
    .amis .h .age { margin-left: auto; color: var(--dim); font-size: 10px; font-weight: 500; }

    /*
     * La grille : une case par joueur du top, dans l'ordre du classement,
     * vingt par ligne. C'est ce qui dit où l'on en est d'un coup d'œil — le
     * vert qui gagne sur le vide à mesure que les demandes sont acceptées.
     * Chaque état a SA couleur, et la légende en dessous les compte.
     */
    .amis .grille:empty { display: none; }
    .amis .cases { display: grid; grid-template-columns: repeat(20, 1fr); gap: 2px; }
    .amis .cases i {
      aspect-ratio: 1; border-radius: 2px; background: rgba(255,255,255,.04);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.14);
    }
    .amis .cases i.ami { background: var(--live); box-shadow: none; }
    .amis .cases i.att { background: var(--warn); box-shadow: none; }
    /* Reçue : c'est à vous d'agir, sur la page Amis — un bleu, qui ne se confond avec rien. */
    .amis .cases i.rec { background: #6FA8FF; box-shadow: none; }
    /* Refusée : présente, mais éteinte. Un rouge franc crierait pour une affaire close. */
    .amis .cases i.ref { background: color-mix(in srgb, #E5646A 45%, transparent); box-shadow: none; }
    .amis .cases i.moi { background: none; box-shadow: inset 0 0 0 2px var(--text); }
    /* La prochaine demande de l'envoi en cours : elle bat, le temps du compte à rebours. */
    .amis .cases i.suiv { box-shadow: inset 0 0 0 2px var(--warn); animation: amis-pouls 1.2s ease-in-out infinite; }
    @keyframes amis-pouls { 50% { opacity: .3; } }
    @media (prefers-reduced-motion: reduce) { .amis .cases i.suiv { animation: none; } }

    .amis .legende { display: flex; flex-wrap: wrap; gap: 2px 9px; margin: 6px 0 7px; }
    .amis .legende:empty { display: none; }
    .amis .legende span { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
    .amis .legende span::before {
      content: ''; flex: none; width: 7px; height: 7px; border-radius: 2px;
      background: var(--k, transparent); box-shadow: var(--o, none);
    }
    .amis .legende b { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }

    /* La progression de l'envoi en cours, sous le bouton qui l'arrête. */
    .amis .prog { height: 4px; margin: 1px 0 5px; border-radius: 2px; background: var(--raise); overflow: hidden; }
    .amis .prog i { display: block; height: 100%; border-radius: 2px; background: var(--warn); transition: width .4s; }
    .amis .lance {
      display: block; width: 100%; padding: 6px 8px; border: 1px solid var(--line);
      border-radius: var(--r-md); background: color-mix(in srgb, var(--live) 10%, transparent);
      color: var(--live); font: inherit; font-size: 11px; font-weight: 600; cursor: pointer;
      transition: .14s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .amis .lance:hover { background: color-mix(in srgb, var(--live) 18%, transparent); }
    .amis .lance:disabled { opacity: .5; cursor: default; }
    /* Armé : la même couleur que « Tout souhaiter » armé — c'est le même geste. */
    .amis .lance.arme { background: var(--warn); border-color: var(--warn); color: #1A1206; }
    /* En cours d'envoi, le bouton ne fait plus qu'arrêter : il perd sa couleur d'action. */
    .amis .lance.stop { background: none; color: var(--muted); }
    .amis .lance.stop:hover { color: var(--text); background: var(--raise); }
    .amis .etat { margin-top: 6px; }
    .amis .etat:empty { display: none; }
    .amis .etat div + div { margin-top: 2px; }
    .amis .etat b { color: var(--muted); font-weight: 600; font-variant-numeric: tabular-nums; }
    .amis .etat .lien { color: var(--live); cursor: pointer; text-decoration: none; }


    .mkfoot { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px;
              padding-top: 8px; border-top: 1px solid var(--line); font-size: 11px; color: var(--dim); }
    .mkfoot:empty { display: none; }
    .mkfoot span { white-space: nowrap; }
    .mkfoot .g { color: var(--live); font-variant-numeric: tabular-nums; }
    /*
     * Même correction de cible que la poignée de la Guilde : sans rembourrage,
     * « rafraîchir » n'offrait au clic que la hauteur de ses lettres.
     *
     * Pas de marge négative pour compenser ce rembourrage : elle tirait le
     * bouton six pixels au-delà du pied, qui se mettait alors à déborder —
     * 266 px de contenu pour 260 de large, à toutes les largeurs du panneau.
     * Le texte s'arrête donc six pixels avant le bord, ce qui ne se remarque
     * pas, plutôt que de créer une barre de défilement qui, elle, se remarque.
     */
    .mkfoot .rf {
      margin-left: auto; flex: none; padding: 3px 6px;
      border: 0; border-radius: var(--r-sm); background: none;
      color: var(--dim); font: 11px var(--sans); cursor: pointer; transition: .14s;
    }
    .mkfoot .rf:hover { color: var(--text); background: var(--raise); }
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
      /*
       * Mesuré à 260 px : les quatre boutons tombent à 52 px, et la pastille
       * de comptage dépassait de 2 px sur trois d'entre eux. Le bouton porte
       * « overflow: hidden » — elle n'écartait donc rien, elle se faisait
       * raboter, et une pastille arrondie rabotée a un côté droit plat.
       *
       * Quatre pixels regagnés par bouton sur le rembourrage, deux sur celui
       * de la pastille : de quoi la laisser entière.
       */
      .subs button { font-size: 10px; gap: 2px; padding: 5px 2px; }
      .subs .cnt { padding: 1px 3px; }
      /*
       * Les cinq onglets, eux aussi, débordaient de deux pixels à 260 px —
       * et « Réglages », le plus long, est celui que le panneau rabotait.
       * « flex: 1 » ne les égalise pas : aucun ne descend sous la largeur de
       * son texte, et le rembourrage est la seule chose qui reste à rendre.
       */
      /*
       * « .panel .tabs » et non « .tabs » : la règle de base des onglets est
       * écrite PLUS BAS dans cette feuille, et une requête de conteneur
       * n'ajoute aucune spécificité — à égalité, c'est la dernière qui gagne,
       * donc la règle large l'emportait et ce bloc ne servait à rien. Le
       * sélecteur du conteneur devant, la spécificité passe devant elle.
       */
      .panel .tabs { padding: 10px 8px 0; gap: 2px; }
      .panel .tabs button { padding: 7px 2px 9px; }
      /* L'en-tête porte déjà le titre, le décompte, replier et Start : à la
         borne basse, la version le ferait passer à la ligne. Elle reste en
         toutes lettres au pied des Réglages. */
      .ver { display: none; }
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
    /* Une baisse de prix n'est ni un succès ni un échec : c'est un ajustement,
       et elle se lit donc au même niveau que le titre, sans couleur d'alerte. */
    .relist li.baisse .act { color: var(--muted); }
    .relist .dot { width: 5px; height: 5px; flex: none; border-radius: 50%; background: var(--dim); }
    .relist li.ok .dot { background: var(--live); }
    .relist li.refus .dot { background: var(--warn); }
    .relist li.baisse .dot { background: var(--muted); }
    .relist .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                 font-size: 11px; color: var(--text); }
    .relist .p { flex: none; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .relist .w { flex: none; font-size: 10px; color: var(--dim); font-variant-numeric: tabular-nums; }
    /* Le motif d'un refus tenait dans une infobulle : invisible, donc inutile.
       Il prend sa propre ligne, sous le titre auquel il se rapporte. */
    .relist .why { flex-basis: 100%; margin: -2px 0 1px 13px; font-size: 10px; line-height: 1.4; color: var(--warn); }
    /* Le motif d'une baisse explique, il n'alerte pas. */
    .relist li.baisse .why { color: var(--dim); }
    /*
     * La suggestion de prix : une ligne à elle, sous la carte concernée. Elle
     * propose, elle n'agit pas — d'où un bouton bien visible plutôt qu'un
     * message qu'on prendrait pour un compte rendu de ce qui a déjà eu lieu.
     */
    /*
     * « span.baisse », et non « .baisse ».
     *
     * La classe sert à deux choses sans rapport : ce span, qui propose un prix
     * plus bas sous une carte suivie, et le li d'une baisse au journal. Écrite
     * sans le nom d'élément, la règle attrapait aussi le li — qui héritait de
     * sa marge gauche de 13 px et se retrouvait décalé d'un cran par rapport
     * aux lignes voisines, vu à l'écran. Les autres règles du journal visent
     * déjà « li.baisse » explicitement.
     *
     * (Pas d'accent grave dans ce commentaire : il vit dans un littéral de
     * gabarit, et le premier fermerait la chaîne.)
     */
    .relist span.baisse { flex-basis: 100%; display: flex; align-items: center; gap: 7px;
                      margin: 1px 0 2px 13px; font-size: 10px; color: var(--dim); }
    .relist span.baisse button {
      padding: 2px 8px; border: 1px solid rgba(240,169,75,.4); border-radius: 999px;
      background: none; color: var(--warn); cursor: pointer;
      font: 600 10px var(--sans); font-variant-numeric: tabular-nums;
    }
    .relist span.baisse button:hover { background: rgba(240,169,75,.16); }
    .relist .empty { font-size: 11px; color: var(--dim); line-height: 1.45; }
    .relist li.wait .dot { background: var(--dim); }
    .relist li.pause .dot { background: var(--warn); opacity: .5; }
    .relist li.stop .dot { background: var(--dim); }
    .relist .st { flex: none; font-size: 10px; color: var(--dim);
                  font-variant-numeric: tabular-nums; }
    .relist li.ok .st { color: var(--live); }
    .relist li.pause .st { color: var(--warn); }
    /* 20 px, pas 16 : ✕ retire la carte du suivi, et c'était la plus petite
       cible du panneau — collée à ↻, qui lui ne fait rien de définitif. */
    .relist .x {
      flex: none; width: 20px; height: 20px; padding: 0; line-height: 1;
      font: 10px/1 var(--sans); color: var(--dim); background: transparent;
      border: 0; border-radius: var(--r-sm); cursor: pointer;
    }
    .relist .x:hover { color: var(--text); background: var(--raise); }
    .relist .ra { display: flex; gap: 6px; margin-bottom: 7px; }
    .relist .ra button {
      flex: 1; padding: 5px 6px; font: 500 10.5px/1.3 var(--sans); color: var(--muted);
      background: var(--raise); border: 1px solid var(--line); border-radius: var(--r-sm); cursor: pointer;
    }
    .relist .ra button:hover { color: var(--text); background: rgba(255,255,255,.09); }

    /*
     * Les sept durées. Elles s'enroulent : à 260 px il en tient trois par
     * ligne, à 640 les sept d'un coup — c'est une rangée de choix, pas un
     * tableau, rien ne dépend de leur alignement.
     *
     * La durée armée prend l'ambre, celle des gestes qui engagent, et double
     * la couleur d'une coche : le second clic annule des enchères, il ne doit
     * pas se distinguer du premier par la seule intensité d'un fond.
     */
    .relist .duree { display: flex; flex-wrap: wrap; align-items: center; gap: 4px;
                     margin-bottom: 7px; }
    .relist .duree > span { flex-basis: 100%; margin-bottom: 1px;
                            font-size: 10px; color: var(--dim); }
    .relist .duree button {
      padding: 4px 8px; border: 1px solid var(--line); border-radius: var(--r-sm);
      background: var(--raise); color: var(--muted);
      font: 500 10.5px/1 var(--sans); font-variant-numeric: tabular-nums;
      cursor: pointer; transition: .14s;
    }
    .relist .duree button:hover { color: var(--text); background: rgba(255,255,255,.09); }
    .relist .duree button.arme {
      color: var(--warn); border-color: var(--warn);
      background: color-mix(in srgb, var(--warn) 14%, transparent);
    }

    /*
     * L'intitulé du journal, devenu la poignée qui le déplie. Il garde
     * l'apparence d'un intertitre — il n'a pas à se déguiser en bouton dans un
     * volet qui en porte déjà cinq — et ne le trahit que par son chevron et le
     * compte, qui dit s'il s'est passé quelque chose sans qu'on l'ouvre.
     */
    /*
     * L'édition d'une carte, dépliée sous elle. Même forme que la suggestion
     * de baisse — pleine largeur, décalée de 13 px sous son titre — parce que
     * c'est la même chose : un propos qui porte sur la ligne du dessus.
     */
    .relist .fedit {
      flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 5px 8px;
      margin: 3px 0 4px 13px; font-size: 10px; color: var(--dim);
    }
    .relist .fedit label { display: flex; align-items: center; gap: 5px; }
    /* Dessiné, pas laissé au navigateur : les flèches du compteur natif
       n'ajoutent qu'un ornement gris, et le champ doit suivre la palette. */
    .relist .fedit input {
      width: 62px; -moz-appearance: textfield; appearance: textfield;
      padding: 3px 6px; border: 1px solid var(--line); border-radius: var(--r-sm);
      background: var(--raise); color: var(--text);
      font: 600 11px var(--sans); font-variant-numeric: tabular-nums;
      transition: border-color .14s;
    }
    .relist .fedit input::-webkit-outer-spin-button,
    .relist .fedit input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    .relist .fedit input:focus { outline: 0; border-color: var(--live); }
    .relist .fedit .durs { display: flex; flex-wrap: wrap; gap: 3px; }
    .relist .fedit .durs button {
      padding: 3px 6px; border: 1px solid var(--line); border-radius: var(--r-sm);
      background: none; color: var(--dim);
      font: 500 10px var(--sans); font-variant-numeric: tabular-nums; cursor: pointer;
      transition: .14s;
    }
    .relist .fedit .durs button:hover { color: var(--text); background: var(--raise); }
    /* La durée en vigueur : celle qui décrit la carte, pas une cible à viser —
       d'où le vert de l'état et non l'ambre des gestes qui engagent. */
    .relist .fedit .durs button.on {
      color: var(--live); border-color: var(--live);
      background: color-mix(in srgb, var(--live) 12%, transparent);
    }
    .relist .fedit .raz {
      padding: 3px 7px; border: 1px solid rgba(240,169,75,.4); border-radius: 999px;
      background: none; color: var(--warn); font: 500 10px var(--sans); cursor: pointer;
    }
    .relist .fedit .raz:hover { background: color-mix(in srgb, var(--warn) 16%, transparent); }
    .relist .fedit .none { color: var(--dim); }

    .relist .jtoggle {
      display: flex; align-items: center; gap: 6px; width: 100%;
      margin: 9px 0 4px; padding: 8px 0 0;
      border: 0; border-top: 1px solid var(--line); background: none;
      color: var(--muted); font: 600 11px var(--sans); text-align: left; cursor: pointer;
    }
    .relist .jtoggle:hover { color: var(--text); }
    .relist .jtoggle i { font-style: normal; font-size: 10px; color: var(--dim); }
    .relist .jtoggle span {
      margin-left: auto; padding: 1px 6px; border-radius: 999px;
      background: rgba(255,255,255,.07); color: var(--dim);
      font-size: 10px; font-weight: 600; font-variant-numeric: tabular-nums;
    }

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
      display: block; margin-top: 6px; padding: 5px 8px; border-radius: var(--r-md);
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
      flex: 1; position: relative; padding: 7px 4px 9px;
      font: 600 11.5px/1 var(--sans); letter-spacing: -.005em;
      color: var(--muted); background: transparent; border: 0; border-radius: var(--r-md);
      cursor: pointer; transition: background .15s, color .15s;
    }
    /*
     * Le survol et l'onglet ouvert portaient EXACTEMENT le même fond
     * (« var(--raise) ») : la souris posée sur un onglet voisin en affichait
     * deux identiques, et lequel des deux était ouvert ne se lisait plus.
     *
     * Deux registres distincts, donc : le survol reste un fond, plus faible
     * qu'avant ; l'ouvert se signale par un trait d'accent sous l'intitulé.
     * Une couleur et une forme, là où il n'y avait qu'une intensité.
     */
    .tabs button:hover { color: var(--text); background: rgba(255,255,255,.04); }
    .tabs button.on { color: var(--text); background: transparent; }
    .tabs button.on::after {
      content: ''; position: absolute; left: 50%; bottom: 2px; transform: translateX(-50%);
      width: 16px; height: 2px; border-radius: 2px; background: var(--live);
    }
    .tabs .badge {
      position: absolute; top: 5px; right: 7px; width: 5px; height: 5px;
      border-radius: 50%; background: var(--warn);
    }
    .tabs .badge[hidden] { display: none; }

    /*
     * La note de panne. Elle vit entre les onglets et le corps, donc visible
     * quel que soit l'onglet ouvert, et elle emprunte le registre de
     * l'avertissement — pas celui de l'erreur : l'outil, lui, tourne toujours.
     *
     * Elle disparaît quand le panneau est replié : replié, l'en-tête ne montre
     * que le décompte, et une bannière sous une barre d'onglets masquée
     * flotterait sans rien à quoi se rattacher.
     */
    .panne {
      flex: none; margin: 8px 14px -4px; padding: 8px 10px;
      border-radius: var(--r-md);
      border: 1px solid color-mix(in srgb, var(--warn) 34%, transparent);
      background: color-mix(in srgb, var(--warn) 12%, transparent);
      color: var(--warn); font-size: 11px; line-height: 1.5;
    }
    .panne b { font-weight: 600; }
    .panne .quoi { display: block; color: var(--text); }
    .panne .reprendre {
      margin-top: 5px; padding: 3px 9px; border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
      background: none; color: var(--warn); font: 600 10px var(--sans); cursor: pointer;
    }
    .panne .reprendre:hover { background: color-mix(in srgb, var(--warn) 18%, transparent); }
    .panel.folded .panne { display: none; }

    .tab { display: none; }
    .tab.on { display: flex; flex-direction: column; gap: 14px; }
    /* Le Marché empile plus de blocs que les autres onglets : ils se serrent. */
    .tab[data-tab="marche"].on { gap: 10px; }
    .panel.folded .tabs { display: none; }
    /*
     * Les Réglages étaient six cases à plat, dans un ordre qui mélangeait ce
     * que le panneau FAIT à ta place et ce qu'il se contente de LIRE — les
     * notifications tombaient entre deux réclamations automatiques. La
     * distinction existait dans les valeurs par défaut, et dans le commentaire
     * qui les justifie ; elle n'était nulle part à l'écran. Deux intertitres
     * suffisent, sans rien déplacer d'autre.
     */
    /*
     * Les intertitres étaient en capitales espacées. Le texte est déjà écrit
     * en minuscules dans le balisage — « Ce qu'il fait à votre place » — et la
     * capitalisation lui venait du CSS seul : la retirer rend la phrase telle
     * qu'elle a été écrite, avec ses accents, et lui laisse sa ponctuation
     * naturelle. Un cran de graisse et de taille reprend le rang qu'elle
     * perd, sans la faire crier.
     */
    .sect { color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: -.005em; }
    /* Le titre appartient au groupe qu'il ouvre : il s'en rapproche, et le
       second s'écarte du groupe précédent — sinon les six cases restent une
       liste unique avec deux lignes de texte dedans. */
    .sect + .opt, .sect + .tune { margin-top: -8px; }
    .sect.suite { margin-top: 2px; padding-top: 12px; border-top: 1px solid var(--line); }
    /* Trois relevés qui se lisent ensemble : espacés du gap de l'onglet plus
       leur propre marge, ils se dispersaient en pavé gris. */
    .tune + .tune { margin-top: -7px; }
    .diag {
      margin-top: 4px; padding: 5px 10px; border: 1px solid var(--line);
      border-radius: var(--r-md); background: none; color: var(--muted);
      font: 11px var(--sans); cursor: pointer; transition: .14s;
    }
    .diag:hover { color: var(--text); border-color: var(--dim); background: var(--raise); }
    .diag.ok { color: var(--live); border-color: var(--live); }
    /* Ce que le panneau ne fera jamais seul, dit là où on cherche ce qu'il fait. */
    .note-vente { margin-top: -2px; color: var(--dim); font-size: 10px; line-height: 1.5; }
    .note-vente b { color: var(--muted); font-weight: 600; }

    /* Le pied de l'onglet Réglages : la version, en toutes lettres et
       sélectionnable. L'en-tête la porte aussi, mais il l'escamote sur un
       panneau étroit — ici elle est toujours là. */
    .apropos {
      margin-top: 2px; padding-top: 10px; border-top: 1px solid var(--line);
      color: var(--dim); font-size: 10px; line-height: 1.5;
      -webkit-user-select: text; user-select: text;
    }
    .apropos b { color: var(--muted); font-weight: 600; font-variant-numeric: tabular-nums; }

    .opt { display: flex; gap: 9px; align-items: center; padding: 5px 0; cursor: pointer; color: var(--muted); font-size: 12px; }
    .opt:hover { color: var(--text); }
    /*
     * L'interrupteur, dessiné ici plutôt que laissé au navigateur.
     *
     * « accent-color » ne teinte qu'une case du système : elle gardait sa
     * forme carrée, sa coche et son épaisseur de bordure, celles de Windows.
     * Six l'une sous l'autre dans les Réglages, c'était ce qui datait le
     * panneau le plus sûrement — le reste est dessiné, elles ne l'étaient pas.
     *
     * Elle passe à DROITE (« order: 2 » et la marge automatique) : dans une
     * colonne d'options, l'œil descend la liste des intitulés, et les états
     * s'alignent alors en une seule colonne qu'on lit d'un coup. À gauche,
     * chaque état était à une distance différente du bord, derrière un texte
     * de longueur variable.
     *
     * Dans le Marché (« .mopt »), les options sont en ligne et non en colonne :
     * la marge automatique n'y trouve pas d'espace libre et ne fait rien.
     * L'interrupteur y suit simplement son intitulé — même ordre, donc même
     * lecture, sans règle particulière.
     */
    .opt input {
      order: 2; flex: none; margin: 0 0 0 auto;
      appearance: none; -webkit-appearance: none;
      width: 30px; height: 18px; border-radius: 999px;
      background: rgba(255,255,255,.09);
      box-shadow: inset 0 0 0 1px var(--line);
      cursor: pointer; transition: background .18s, box-shadow .18s;
    }
    .opt input::after {
      content: ''; display: block; width: 14px; height: 14px; margin: 2px;
      border-radius: 50%; background: var(--muted);
      transition: transform .18s cubic-bezier(.3,.8,.4,1), background .18s;
    }
    .opt:hover input { background: rgba(255,255,255,.14); }
    .opt input:checked { background: var(--live); box-shadow: none; }
    /* 12 px = 30 (piste) − 14 (bouton) − 2 × 2 (marge) : il s'arrête au bord. */
    .opt input:checked::after { transform: translateX(12px); background: #06130C; }
    .tune { margin-top: 9px; color: var(--dim); font-size: 11px; }
    .revente {
      width: 100%; padding: 8px 0; border: 1px solid var(--live);
      border-radius: var(--r-md); background: color-mix(in srgb, var(--live) 12%, transparent);
      color: var(--live); cursor: pointer; font: 600 11px var(--sans); transition: .16s;
    }
    .revente:hover { background: color-mix(in srgb, var(--live) 22%, transparent); }
    .revente[hidden] { display: none; }

    .panel { position: relative; }
    /* Poignée de redimensionnement : largeur du panneau et hauteur du journal. */
    .grip {
      /* 18 px plutôt que 14 : la poignée se vise au doigt depuis qu'elle
         répond au tactile, et 14 px ne s'attrapent pas. */
      position: absolute; right: 3px; bottom: 3px; width: 18px; height: 18px;
      cursor: nwse-resize; z-index: 5; touch-action: none;
      /*
       * Deux traits, pas deux dégradés. Les bandes obliques tirées de
       * « linear-gradient » sortaient crénelées — un dégradé n'est pas
       * anticrénelé sur ses bornes — et l'ensemble avait le grain d'une
       * poignée de fenêtre des années 2000. Deux filets arrondis, tracés en
       * SVG, tiennent le même rôle proprement et à n'importe quelle échelle.
       */
      background:
        url("data:image/svg+xml;charset=utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='18' height='18'%3E%3Cg stroke='%23717C8D' stroke-width='1.5' stroke-linecap='round'%3E%3Cpath d='M6.5 15.5L15.5 6.5'/%3E%3Cpath d='M11.5 15.5L15.5 11.5'/%3E%3C/g%3E%3C/svg%3E")
        no-repeat center;
      opacity: .55; transition: opacity .14s;
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
          <span class="ver" data-ver title="Version installée. Les mises à jour se font seules ; dès qu'une nouvelle version existe, une pastille verte paraît ici.">${VERSION}</span>
          <a class="maj" data-maj hidden target="_blank" rel="noopener" href="${MAJ_URL}"></a>
          <b class="mini" data-mini></b>
          <button class="icon" data-fold title="Replier">–</button>
          <button class="run" data-toggle>Start</button>
        </div>

        <nav class="tabs" data-tabs>
          <button data-tab-btn="paquets">Paquets</button>
          <button data-tab-btn="marche">Marché<i class="badge" data-badge hidden></i></button>
          <!--
            L'onglet s'appelle Amis, mais sa clé reste « guilde » : c'est elle
            qui est mémorisée comme onglet ouvert, et la changer aurait renvoyé
            chacun sur Paquets à la mise à jour.
          -->
          <button data-tab-btn="guilde">Amis</button>
          <button data-tab-btn="succes">Succès</button>
          <button data-tab-btn="reglages">Réglages</button>
        </nav>

        <!--
          La note de panne, hors des onglets et au-dessus d'eux.

          Un tour secondaire qui abandonne concerne la personne quel que soit
          l'onglet qu'elle regarde : le mettre dans « Marché » l'aurait caché à
          qui consulte ses paquets, c'est-à-dire à peu près tout le monde. Elle
          n'apparaît que quand il y a quelque chose à dire, et emporte son
          propre bouton, parce qu'une note qui annonce un arrêt sans offrir de
          reprise oblige à recharger la page.
        -->
        <div class="panne" data-panne hidden></div>

        <div class="body" data-body>
          <section class="tab" data-tab="paquets">
          <div class="status" data-status></div>
          <div class="bar idle" data-bar><i></i></div>
          <div class="ribbon" data-ribbon title="Derniers tirages, teintés par rareté"></div>

          <div class="figs">
            <span class="fig"><b data-packs>0</b><span data-packs-unit>paquets</span></span>
            <span class="fig"><b data-cards>0</b><span data-cards-unit>cartes</span></span>
            <button class="reset" data-reset title="Remet les compteurs à zéro et vide le journal des tirages. Deux clics : le premier demande confirmation.">Réinitialiser</button>
          </div>
          <div class="rate" data-rate></div>

          <div class="chips" data-rar></div>
          <button class="openrar" data-open-rar hidden></button>
          <div class="log" data-log></div>
          </section>

          <!--
            Les paliers et les succès ont leur onglet.

            Ils vivaient sous le journal des tirages, où ils pesaient 223 px
            sur 576 : 39 % de l'onglet Paquets ne parlait pas de paquets. Et ce
            sont les mêmes succès du jeu vus par deux sources : pendingGoals
            les lit dans GOALS, readAchievements sur la page du site, au point
            que renderAchievements doit écarter les noms que l'autre affiche
            déjà. Les séparer était l'anomalie ; les réunir ici les remet
            ensemble et rend l'onglet Paquets à ce qu'il annonce.

            Mesuré avant de le faire : à 260 px — la borne basse de la poignée —
            cinq onglets tiennent avec 12,1 px de marge. « Échanges » débordait
            de 1,7 px, d'où son refus quand le volet a été ajouté ; « Succès »
            est plus court de deux lettres, et c'est tout ce qui les sépare.

            (Pas d'accent grave ici : ce balisage vit dans un littéral de
            gabarit, et le premier fermerait la chaîne.)
          -->
          <section class="tab" data-tab="succes">
            <div class="goal" data-goal></div>
            <div class="achv" data-achv></div>
          </section>

          <section class="tab" data-tab="marche">
            <nav class="subs" data-subs></nav>
            <div class="mkt" data-market></div>
            <div class="relist" data-relist></div>
            <button class="revente" data-revente>Revente — cote de vos cartes</button>
            <div class="mkfoot" data-mkfoot></div>
            <!--
              Un seul interrupteur à la fois : celui du volet ouvert.

              Les trois s'affichaient ensemble et s'enroulaient sur deux lignes
              dès 300 px, sous un onglet qui empile déjà le plus de choses.
              Deux d'entre eux ne commandaient rien de ce qu'on avait sous les
              yeux.

              Ils restent ICI, et ne repartent pas dans les Réglages : le volet
              éteint dit « Cochez Surveillance en bas de cet onglet », et cette
              phrase n'a de sens que si la case y est. C'est le correctif qu'ils
              avaient valu la première fois — on garde le remède à portée de qui
              voit le problème, on ne montre simplement plus les deux autres.

              L'attribut « data-mopt » porte les volets que chaque option
              commande. (Pas d'accent grave ici : ce commentaire vit dans un
              littéral de gabarit, et le premier fermerait la chaîne.)
            -->
            <div class="mopt">
              <label class="opt" data-mopt="ench vent" title="Relève enchères et ventes. Ne touche à rien tant que vous regardez : il ne change d’onglet et ne recharge qu’en arrière-plan, après une minute d’absence.">
                <input type="checkbox" data-opt-bids> Surveillance</label>
              <label class="opt" data-mopt="rel" title="Une vente terminée sans acheteur est relancée au même prix et pour la même durée — le prix que vous avez choisi, jamais un autre. Après deux invendus d'affilée, le volet Relances propose un prix plus bas ; il ne s'applique que si vous cliquez.">
                <input type="checkbox" data-opt-relist> Relances auto</label>
              <label class="opt" data-mopt="souh" title="Signale les cartes de votre liste de souhaits mises aux enchères. Lit le marché récent, sans rien y publier.">
                <input type="checkbox" data-opt-wish> Souhaits</label>
            </div>
          </section>

          <!--
            Dans l'ordre où l'on s'en sert : ce que les amis détiennent, puis le
            moyen d'en avoir davantage. Le bloc du classement est posé ici une
            fois pour toutes ; seuls le texte du bouton, la grille et la ligne
            d'état changent ensuite. Réécrire le bouton à chaque seconde du
            compte à rebours avalerait le clic qui veut l'arrêter.
          -->
          <section class="tab" data-tab="guilde">
            <div class="troc" data-troc></div>
            <div class="amis" data-amis>
              <div class="h" title="Les 200 premiers du classement général, qui trie les joueurs sur le nombre de cartes possédées.">Top 200 du classement <span class="age" data-amis-age></span></div>
              <div class="grille" data-amis-grille></div>
              <button class="lance" data-amis-go>Ajouter en amis</button>
              <div class="etat" data-amis-etat></div>
            </div>
          </section>

          <section class="tab" data-tab="reglages">
            <div class="sect">Ce qu'il fait à votre place</div>
            <label class="opt"><input type="checkbox" data-opt-autostart> Démarrer automatiquement</label>
            <label class="opt" title="Après une vérification humaine, repart dès que vous avez coché la case — sans repasser par Start. Le script ne coche jamais la case lui-même."><input type="checkbox" data-opt-autoresume> Reprise après vérification</label>
            <label class="opt"><input type="checkbox" data-opt-bonus> Réclamer les paquets bonus</label>
            <label class="opt" title="Le panneau appuie sur le bouton Réclamer du site pour chaque succès débloqué, quand vous êtes sur la page Succès"><input type="checkbox" data-opt-autoclaim> Réclamer les récompenses de succès</label>
            <div class="sect suite">Ce qu'il lit et vous signale</div>
            <label class="opt" title="Lit vos propres données de jeu avec la session déjà ouverte dans cet onglet : nombre exact de paquets et liste complète de vos ventes, que le site ne donne plus autrement. Les prix restent lisibles sans compte PRO. Rien n'est écrit sans un geste de votre part, rien n'est envoyé ailleurs."><input type="checkbox" data-opt-db> Accès direct à la base</label>
            <label class="opt"><input type="checkbox" data-opt-notify> Notifications bureau</label>
            <div class="note-vente">Mettre en vente et donner restent à votre main. Les relances
              automatiques se cochent dans <b>Marché</b>, et le panneau ne donne jamais seul.</div>
            <div class="sect suite">Notifications du site</div>
            <label class="opt" title="Le jeu vous envoie une notification « aucune offre n'a été faite pendant l'enchère » à chaque vente qui ne trouve pas preneur. Elles noient les autres. Cette case les cache. Rien n'est effacé : décochez et elles reviennent."><input type="checkbox" data-opt-masqinv> Cacher les « aucune offre »</label>
            <div class="tune" data-notifnote></div>
            <div class="sect suite">Ce qu'il a constaté</div>
            <div class="tune" data-bonusnote></div>
            <div class="tune" data-dbnote></div>
            <!--
              Le salon d'aide demandait d'ouvrir la console avec F12 et d'y
              taper une commande. C'est l'étape qui fait renoncer : on demande à
              un joueur d'utiliser un outil de développeur pour signaler que
              rien ne s'affiche. Ce bouton met le même relevé dans le
              presse-papiers, et la personne colle.

              Ce qu'il ne met PAS : la taille de la collection, ni le nombre de
              Légendaires, ni les succès. Ce sont eux qui identifient un compte
              sur un jeu à classement public — c'est la raison pour laquelle la
              capture du README est fabriquée sur un compte inventé. Un
              diagnostic collé dans un salon public n'a pas le droit d'en dire
              plus qu'une image.
            -->
            <button class="diag" data-diag>Copier le diagnostic</button>
            <div class="apropos">WikiMasters Tools <b>${VERSION}</b> — mise à jour
              automatique. Dès qu'une version plus récente est en ligne, une
              pastille verte paraît à côté du titre : un clic dessus la propose.
              C'est ce numéro qu'on vous demandera sur le Discord.</div>
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
      panne: q('[data-panne]'),
      status: q('[data-status]'),
      bar: q('[data-bar]'),
      barFill: q('[data-bar] i'),
      ribbon: q('[data-ribbon]'),
      packs: q('[data-packs]'),
      cards: q('[data-cards]'),
      packsUnit: q('[data-packs-unit]'),
      cardsUnit: q('[data-cards-unit]'),
      rate: q('[data-rate]'),
      rar: q('[data-rar]'),
      openRar: q('[data-open-rar]'),
      log: q('[data-log]'),
      reset: q('[data-reset]'),
      bonusnote: q('[data-bonusnote]'),
      dbnote: q('[data-dbnote]'),
      notifnote: q('[data-notifnote]'),
      diag: q('[data-diag]'),
      troc: q('[data-troc]'),
      amisAge: q('[data-amis-age]'),
      amisGrille: q('[data-amis-grille]'),
      amisGo: q('[data-amis-go]'),
      amisEtat: q('[data-amis-etat]'),
      optDb: q('[data-opt-db]'),
      optAutostart: q('[data-opt-autostart]'),
      optNotify: q('[data-opt-notify]'),
      optBonus: q('[data-opt-bonus]'),
      optWish: q('[data-opt-wish]'),
      optAutoclaim: q('[data-opt-autoclaim]'),
      optAutoresume: q('[data-opt-autoresume]'),
      optBids: q('[data-opt-bids]'),
      optRelist: q('[data-opt-relist]'),
      optMasqInv: q('[data-opt-masqinv]'),
      relist: q('[data-relist]'),
      tabs: q('[data-tabs]'),
      badge: q('[data-badge]'),
      subs: q('[data-subs]'),
      market: q('[data-market]'),
      mkfoot: q('[data-mkfoot]'),
      goal: q('[data-goal]'),
      achv: q('[data-achv]'),
      ver: q('[data-ver]'),
      grip: q('[data-grip]'),
      mini: q('[data-mini]'),
      maj: q('[data-maj]'),
      revente: q('[data-revente]'),
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
    ui.optAutoresume.checked = prefs.autoResume;
    ui.optBids.checked = prefs.watchBids;
    ui.optRelist.checked = prefs.relistUnsold;
    ui.optMasqInv.checked = prefs.masquerInvendus;

    /*
     * Le câblage, une fonction par surface.
     *
     * Il tenait ici même : 480 lignes d'écouteurs couvrant quinze domaines
     * sans rapport — prix de relance, pause, baisse, édition, remise à zéro,
     * journal replié, navigation du Marché, diagnostic — dont onze
     * gestionnaires `change` quasi identiques, avec la génération du lot de
     * guilde coincée au milieu. Chaque préférence ajoutée depuis plusieurs
     * versions était un écouteur de plus dans le même corps.
     *
     * Le découpage suit une structure DÉJÀ PRÉSENTE dans le balisage
     * ci-dessus : `data-tab="paquets|marche|guilde|reglages"`. Rien n'a été
     * réécrit, tout a été déplacé — chaque bloc avec le commentaire qui le
     * justifie.
     */
    wireHeader();
    wirePaquetsTab();
    wireMarcheTab();
    wireGuildeTab();
    wireReglagesTab();

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
   * L'en-tête et le cadre : ce qui ne dépend d'aucun onglet.
   *
   * Start/Stop, le repli, la barre des onglets, la note de panne — qui vit
   * au-dessus d'eux — et les raccourcis de navigation posés sur le panneau
   * entier.
   */
  function wireHeader() {
    ui.toggle.addEventListener('click', () =>
      state.running ? stop('Arrêté manuellement.') : start()
    );

    ui.fold.addEventListener('click', () => setFolded(!ui.panel.classList.contains('folded')));

    /*
     * Le prix, sur « change » et non « input » : on écrit pendant la frappe,
     * et chaque touche déclencherait un rendu qui remplacerait le champ sous
     * les doigts. Le changement est pris quand le champ est quitté ou validé.
     *
     * Zéro ou négatif n'est pas un prix : on refuse et on rend la valeur
     * précédente, plutôt que d'inscrire une annonce que le site rejettera.
     */
    /*
     * Réessayer un tour arrêté. Le geste ne fait que remettre le compteur à
     * zéro : le tour suivant repart de lui-même, et s'il échoue encore la note
     * revient au bout de quatre. Rien n'est effacé du journal des faits — un
     * diagnostic collé ensuite doit encore porter la panne.
     */
    ui.panne.addEventListener('click', (e) => {
      const b = e.target.closest('[data-reprendre]');
      if (b) relancerSousSysteme(b.dataset.reprendre);
    });

    ui.tabs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab-btn]');
      if (b) setTab(b.dataset.tabBtn);
    });

    // Les raccourcis du panneau restent des navigations internes, sans onglet.
    ui.box.addEventListener('click', (e) => {
      const go = e.target.closest('[data-goto]');
      if (!go) return;
      e.preventDefault();
      goFilteredTo(go.dataset.goto, '');
    });
  }

  /*
   * L'onglet Paquets : le journal des tirages, les pastilles de rareté et la
   * remise à zéro des compteurs.
   */
  function wirePaquetsTab() {
    let resetArme = 0;

    ui.reset.addEventListener('click', () => {
      if (Date.now() < resetArme) {
        resetArme = 0;
        ui.reset.classList.remove('arme');
        ui.reset.textContent = 'Réinitialiser';
        resetStats();
        return;
      }
      resetArme = Date.now() + ARME_MS;
      ui.reset.classList.add('arme');
      ui.reset.textContent = state.history.length
        ? `Effacer ${state.history.length} tirages ?`
        : 'Confirmer ?';
      setTimeout(() => {
        if (!resetArme) return;
        resetArme = 0;
        ui.reset.classList.remove('arme');
        ui.reset.textContent = 'Réinitialiser';
      }, ARME_MS);
    });

    /*
     * Les deux boutons d'export ont quitté les réglages. Personne n'ouvre un
     * CSV de ses tirages, et ils occupaient une ligne entière au milieu des
     * options qui, elles, changent le comportement de l'outil. Ils restent
     * atteignables où ils ont leur place : `__wmAuto.exportCsv()` en console.
     */

    // Le titre d'un tirage ouvre la collection filtrée sur cette carte.
    // L'écriture est synchrone, donc faite avant que l'onglet ne s'ouvre.
    ui.log.addEventListener('click', (e) => {
      const link = e.target.closest('[data-card]');
      if (!link) return;
      e.preventDefault(); // on navigue via le routeur du site, pas via le href
      if (link.dataset.cote) openCardMarket(link.dataset.card);
      else goFilteredTo(link.dataset.target, link.dataset.card);
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
  }

  /*
   * L'onglet Marché, de loin le plus chargé : les quatre volets, le journal
   * des relances avec son édition carte par carte, la Revente, et les trois
   * interrupteurs qui commandent ces volets.
   */
  function wireMarcheTab() {
    ui.relist.addEventListener('change', (e) => {
      const p = e.target.closest('[data-fprix]');
      if (!p) return;
      const w = state.watch[p.dataset.fprix];
      if (!w) return;
      const prix = Math.round(Number(p.value));
      if (Number.isFinite(prix) && prix > 0 && prix !== w.price) {
        logRelist(w.title, 'baisse', prix, `prix changé à la main (était ${w.price} wb)`);
        w.price = prix;
        // Le compte d'invendus se rapportait à l'ANCIEN prix : il ne dit plus
        // rien du nouveau, et le garder armerait une suggestion de baisse sur
        // un prix qu'on vient de choisir.
        w.invendus = 0;
        saveStore({ watch: state.watch, relistLog: state.relistLog });
      }
      render();
    });

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
          // Le geste dit « réessaie » : les refus du serveur s'effacent avec
          // les absences, sinon le premier non de l'API remettrait aussitôt
          // en pause ce qu'on vient de relancer à la main.
          w.refus = 0;
          saveStore({ watch: state.watch });
        }
        return render();
      }
      /*
       * Le seul endroit où un prix de relance change — et il faut un clic pour
       * y arriver. Les annonces déjà en ligne ne bougent pas : une enchère
       * lancée ne se modifie pas, c'est la suivante qui partira au nouveau prix.
       */
      const bas = e.target.closest('[data-baisser]');
      if (bas) {
        const w = state.watch[bas.dataset.baisser];
        const prix = Number(bas.dataset.prix);
        if (w && prix > 0 && prix < w.price) {
          logRelist(w.title, 'baisse', prix, `à votre demande, après ${w.invendus} invendus à ${w.price} wb`);
          w.price = prix;
          w.invendus = 0;   // le compte repart : le nouveau prix n'a pas encore échoué
          saveStore({ watch: state.watch });
        }
        return render();
      }
      /*
       * Ouvrir ou refermer l'édition d'une carte. Une seule à la fois : le
       * clic sur une autre déplace le formulaire au lieu d'en ouvrir un second.
       */
      const ed = e.target.closest('[data-edit]');
      if (ed) {
        fileEdit = fileEdit === ed.dataset.edit ? null : ed.dataset.edit;
        return render();
      }
      // La durée de CETTE carte. Celle qui court garde la sienne : le
      // changement vaut pour les annonces suivantes.
      const fd = e.target.closest('[data-fdur]');
      if (fd) {
        const w = state.watch[fd.dataset.fdur];
        if (w) { w.minutes = Number(fd.dataset.min); saveStore({ watch: state.watch }); }
        return render();
      }
      /*
       * Remettre le compte d'invendus à zéro. C'est lui qui arme la suggestion
       * de baisse ; l'effacer dit « ce prix n'a pas encore échoué », et
       * n'engage rien d'autre — le prix ne bouge pas.
       */
      const fz = e.target.closest('[data-fraz]');
      if (fz) {
        const w = state.watch[fz.dataset.fraz];
        if (w) {
          logRelist(w.title, 'stop', w.price, 'compte d’invendus remis à zéro');
          w.invendus = 0;
          saveStore({ watch: state.watch, relistLog: state.relistLog });
        }
        return render();
      }
      if (e.target.closest('[data-journal-toggle]')) {
        prefs.relistLogOuvert = !prefs.relistLogOuvert;
        saveStore({ relistLogOuvert: prefs.relistLogOuvert });
        return render();
      }
      if (e.target.closest('[data-watch-all]')) return void watchCurrentSales();
      if (e.target.closest('[data-unwatch-all]')) {
        for (const c of Object.keys(state.watch)) dropWatch(c, null);
        return render();
      }
      /*
       * Repasser toutes les ventes à une autre durée, en deux temps.
       *
       * Le premier clic ARME la durée choisie et le libellé annonce combien de
       * ventes sont concernées ; le second, sur la même durée, agit. Choisir
       * une autre durée pendant l'armement déplace la cible au lieu de partir :
       * sept boutons collés se cliquent de travers, et une annulation ne se
       * reprend pas.
       */
      const dur = e.target.closest('[data-duree]');
      if (dur) {
        const minutes = Number(dur.dataset.duree);
        if (repasseArme !== minutes) {
          repasseArme = minutes;
          clearTimeout(repasseTimer);
          repasseTimer = setTimeout(() => { repasseArme = 0; render(); }, ARME_MS);
          return render();
        }
        repasseArme = 0;
        clearTimeout(repasseTimer);
        render();
        repasserToutEn(minutes).then((r) => {
          state.bidNote = r.refus
            ? r.refus
            : `${r.annulees} vente${r.annulees > 1 ? 's' : ''} repassée${r.annulees > 1 ? 's' : ''} en `
              + `${fmtDuree(r.minutes)}`
              + (r.misees ? ` · ${r.misees} gardée${r.misees > 1 ? 's' : ''}, une mise court dessus` : '')
              + (r.refusees ? ` · ${r.refusees} refusée${r.refusees > 1 ? 's' : ''} par le serveur` : '');
          state.bidNoteAt = Date.now();
          render();
        });
        return;
      }
    });

    /*
     * La Revente reste ouverte sous le panneau quand on vient par « en file » :
     * ce qu'on change ici doit s'y voir aussitôt. Une carte retirée de la file
     * y reprend ses boutons, sans fermer ni rouvrir la page. Posés APRÈS les
     * écouteurs des gestes, ils passent une fois l'état écrit.
     */
    const suivreRevente = () => { if (sell.open) renderSell(); };
    ui.relist.addEventListener('click', suivreRevente);
    ui.relist.addEventListener('change', suivreRevente);

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

    /*
     * Entrée et Espace sur une ligne valent le clic. On repasse par `click()`
     * plutôt que de rejouer la navigation : la décision de « où mène cette
     * ligne » reste écrite à un seul endroit, juste au-dessus.
     *
     * `preventDefault` sur Espace est indispensable — sans lui, la barre fait
     * défiler le corps du panneau en même temps qu'elle active la ligne.
     */
    ui.market.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const ligne = e.target.closest('[data-auction], [data-open]');
      if (!ligne) return;
      e.preventDefault();
      ligne.click();
    });

    ui.mkfoot.addEventListener('click', (e) => {
      if (e.target.closest('[data-mk-refresh]')) refreshMarket();
    });

    ui.revente.addEventListener('click', openSell);

    ui.optWish.addEventListener('change', (e) => {
      prefs.watchWish = e.target.checked;
      saveStore({ watchWish: prefs.watchWish });
      render();
      if (prefs.watchWish) scanWishMarket();
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
  }

  /*
   * L'onglet Amis (clé « guilde ») : les échanges, et le top 200 du classement
   * à demander en ami.
   */
  function wireGuildeTab() {
    ui.troc.addEventListener('click', (e) => {
      const b = e.target.closest('[data-troc-qui]');
      if (b) goTroc(b.dataset.trocQui);
    });

    /*
     * Le top 200. Le bouton est le SEUL chemin vers l'envoi : il lit, arme,
     * puis envoie au second clic — ou arrête, pendant l'envoi. Voir
     * `amisClick`.
     */
    ui.amisGo.addEventListener('click', amisClick);
    /*
     * Pas `data-goto` : son gestionnaire général retombe sur une navigation
     * classique quand la barre du site n'a pas le lien, et un rechargement
     * couperait un envoi en cours. `goPath` passe par le routeur du site.
     */
    ui.amisEtat.addEventListener('click', (e) => {
      const lien = e.target.closest('[data-amis-lien]');
      if (!lien) return;
      e.preventDefault();
      goPath(lien.dataset.amisLien);
    });
  }

  /*
   * L'onglet Réglages : les cases à cocher et le bouton de diagnostic.
   *
   * C'est ici qu'atterrit chaque préférence ajoutée — et c'est pour ça que
   * ce découpage existe. Elles arrivaient toutes dans le même corps de 725
   * lignes, à côté du câblage de la Revente et de la génération du lot de
   * guilde, sans rapport les unes avec les autres. Une de plus, c'est
   * maintenant une de plus ICI.
   */
  function wireReglagesTab() {
    /*
     * Confirmation en deux temps, sans boîte de dialogue : `confirm()` bloque
     * la page entière, et le panneau vit dans l'onglet du jeu. Le premier clic
     * arme le bouton en annonçant ce qui va disparaître ; le second, dans les
     * quatre secondes, exécute. Passé ce délai il se désarme tout seul — un
     * bouton laissé armé finirait par être cliqué sans qu'on sache pourquoi.
     */
    ui.diag.addEventListener('click', async () => {
      const texte = construireDiagnostic();
      let pose = false;
      try {
        await navigator.clipboard.writeText(texte);
        pose = true;
      } catch (_) {
        /*
         * Le presse-papiers demande un contexte sûr et parfois une permission.
         * Refusé, on ne laisse pas l'utilisateur sans rien : le relevé part en
         * console, où il reste sélectionnable.
         */
        console.info('[WikiMasters Tools] diagnostic\n' + texte);
      }
      ui.diag.classList.toggle('ok', pose);
      ui.diag.textContent = pose ? 'Copié — collez-le dans #aide' : 'Voir dans la console (F12)';
      setTimeout(() => {
        ui.diag.classList.remove('ok');
        ui.diag.textContent = 'Copier le diagnostic';
      }, 4000);
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

    ui.optAutoresume.addEventListener('change', (e) => {
      prefs.autoResume = e.target.checked;
      saveStore({ autoResume: prefs.autoResume });
    });

    ui.optAutoclaim.addEventListener('change', (e) => {
      prefs.autoclaim = e.target.checked;
      saveStore({ autoclaim: prefs.autoclaim });
      if (prefs.autoclaim) claimAll();
    });

    /*
     * Le masquage prend effet à la lecture suivante, pas au clic : c'est le
     * site qui redemande sa liste. Le compte affiché date donc de la dernière
     * lecture, et on le remet à zéro pour ne pas laisser croire qu'il est
     * frais — la prochaine ouverture de la cloche le rétablira.
     */
    ui.optMasqInv.addEventListener('change', (e) => {
      prefs.masquerInvendus = e.target.checked;
      saveStore({ masquerInvendus: prefs.masquerInvendus });
      notifFiltre = { masques: 0, total: 0 };
      // Les lignes déjà repliées, elles, sont à l'écran : elles répondent au clic.
      if (prefs.masquerInvendus) appliquerMasquage();
      else rendreLignesInvendues();
      render();
    });

    ui.optDb.addEventListener('change', (e) => {
      prefs.db = e.target.checked;
      saveStore({ db: prefs.db });
      // Relire tout de suite : cocher la case sans rien voir changer pendant
      // une minute donnerait l'impression que le réglage ne fait rien.
      state.packsReadAt = 0;
      state.dbNote = prefs.db ? '' : 'Accès direct désactivé.';
      // La cote refusée par l'API redevient possible par la base : on lève le
      // verrou posé par le 403, sans quoi le relevé refuserait de repartir.
      if (prefs.db) {
        sell.refusVentes = 0;
        sell.refusVentesN = 0;
        refreshPacks();
      }
      render();
    });
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

  /*
   * Glisser la poignée élargit le panneau et allonge le journal.
   *
   * En `pointer*` et non en `mouse*` : les seconds ne parlent qu'à la souris,
   * si bien que sur un écran tactile le panneau ne se déplaçait ni ne se
   * redimensionnait. Le défaut se payait justement là où il coûte le plus —
   * sous 640 px le panneau démarre REPLIÉ, donc le premier geste attendu
   * était celui qui ne répondait pas.
   *
   * `setPointerCapture` remplace les écouteurs posés sur la fenêtre : les
   * événements suivants reviennent à la poignée même si le doigt en sort, et
   * ils se libèrent tout seuls au relâchement. Un contact interrompu — appel
   * entrant, geste système — émet `pointercancel`, qu'il faut traiter comme
   * une fin : sans lui le panneau resterait collé au doigt.
   */
  function makeResizable() {
    let x0 = 0, y0 = 0, w0 = 0, h0 = 0, actif = false;
    const hauteurJournal = () =>
      parseInt(getComputedStyle(ui.panel).getPropertyValue('--logh')) || 128;

    ui.grip.addEventListener('pointerdown', (e) => {
      actif = true;
      x0 = e.clientX;
      y0 = e.clientY;
      w0 = ui.box.offsetWidth;
      h0 = hauteurJournal();
      ui.grip.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation(); // sinon l'en-tête croirait qu'on déplace le panneau
    });

    ui.grip.addEventListener('pointermove', (e) => {
      if (!actif) return;
      applySize({ w: w0 + (e.clientX - x0), h: h0 + (e.clientY - y0) });
    });

    const fini = () => {
      if (!actif) return;
      actif = false;
      saveStore({ size: { w: ui.box.offsetWidth, h: hauteurJournal() } });
    };
    ui.grip.addEventListener('pointerup', fini);
    ui.grip.addEventListener('pointercancel', fini);
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
    for (const n of ['paquets', 'succes', 'marche', 'guilde', 'reglages']) {
      ui.panel.classList.toggle(`tab-${n}`, n === nom);
    }
    ui.body.scrollTop = 0;
    requestAnimationFrame(clampPanel);
    render();
    // Ouvrir le Marché suffit à le rendre juste : une liste vieille d'une heure
    // affichée telle quelle est ce qui lui donnait son air d'inachevé.
    if (nom === 'marche') freshenMarket();
    // Même principe pour l'onglet Amis : la liste d'amis se relit — c'est elle
    // qui dit qui a accepté ou refusé —, et le classement s'il a vieilli.
    if (nom === 'guilde') {
      refreshAmis(false).then(renderAmis, () => {});
      amisLireAuto();
    }
  }

  /** Le panneau se déplace au doigt comme à la souris ; sa position est mémorisée. */
  function makeDraggable() {
    let dx = 0, dy = 0, dragging = false;

    ui.head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return; // les boutons gardent leur rôle
      dragging = true;
      dx = e.clientX - ui.box.offsetLeft;
      dy = e.clientY - ui.box.offsetTop;
      ui.head.setPointerCapture(e.pointerId);
      ui.head.style.cursor = 'grabbing';
      e.preventDefault();
    });

    ui.head.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const left = e.clientX - dx;
      const top = e.clientY - dy;
      placePanel({
        r: innerWidth - left - ui.box.offsetWidth,
        b: innerHeight - top - ui.box.offsetHeight,
      });
    });

    // `pointercancel` autant que `pointerup` : un geste système interrompu
    // laisserait sinon le panneau accroché au doigt.
    const fini = () => {
      if (!dragging) return;
      dragging = false;
      ui.head.style.cursor = 'grab';
      saveStore({ pos: panelPos() });
    };
    ui.head.addEventListener('pointerup', fini);
    ui.head.addEventListener('pointercancel', fini);
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

  /**
   * La note des tours arrêtés. Rien à l'écran tant que tout va bien, ce qui
   * est le cas quasiment tout le temps — d'où le retrait complet du bloc
   * plutôt qu'une ligne « tout va bien » qui ne serait jamais lue.
   *
   * Appelée depuis `render()` comme le reste, mais aussi directement par
   * `noterEchec` : un tour secondaire peut abandonner sans qu'aucun message
   * d'état ne passe derrière, et la note attendrait alors le prochain
   * rafraîchissement pour paraître.
   */
  function renderPannes() {
    if (!ui.panne) return;
    const morts = Object.keys(state.sains).filter((n) => state.sains[n].arret);
    ui.panne.hidden = morts.length === 0;
    if (!morts.length) {
      paint(ui.panne, '');
      return;
    }
    paint(ui.panne, morts
      .map((nom) => {
        const s = state.sains[nom];
        const depuis = s.depuis ? ` Depuis ${fmtSpan(Date.now() - s.depuis)}.` : '';
        const echecs = s.echecs > 1 ? ` ${s.echecs} échecs d’affilée.` : '';
        return `<span class="quoi"><b>${esc(SOUS_SYSTEMES[nom] || nom)}</b> `
          + `${esc(PLAINTES[nom] || 'ne répond plus')}.</span>`
          + `<span title="${esc(s.dernier)}">${depuis}${echecs} Le reste du panneau continue.</span>`
          + `<button class="reprendre" data-reprendre="${esc(nom)}">Réessayer</button>`;
      })
      .join(''));
  }

  function render() {
    if (!ui.box) return;

    ui.panel.classList.toggle('live', state.running);
    ui.panel.classList.toggle('warn', !state.running && state.warn);
    ui.toggle.textContent = state.running ? 'Stop' : 'Start';

    renderPannes();
    renderStatus();
    renderRibbon();

    /*
     * La pastille de mise à jour, quand il y en a une. Le lien EST le geste :
     * l'ouvrir fait afficher à Tampermonkey sa page d'installation, qui propose
     * la mise à jour. C'est le même lien que le README et le Discord donnent.
     */
    ui.maj.hidden = !state.majDispo;
    /*
     * Les deux ne cohabitent pas : la pastille prend la place du numéro plutôt
     * que de s'ajouter à lui. L'en-tête porte déjà titre, version, décompte,
     * repli et Start — mesuré, un élément de plus le faisait passer sur deux
     * lignes dès 320 px. Et « ↑ 2.10.0 » dit déjà tout ce que « 2.9.0 » disait,
     * puisque son infobulle porte la version installée. Le numéro en toutes
     * lettres reste au pied des Réglages, où on va le chercher pour le citer.
     */
    ui.ver.hidden = !!state.majDispo;
    if (state.majDispo) {
      ui.maj.textContent = `↑ ${state.majDispo}`;
      ui.maj.title = `Version ${state.majDispo} disponible — vous êtes en ${VERSION}. `
        + 'Ouvrir ce lien fait proposer la mise à jour par Tampermonkey, '
        + 'puis actualisez la page.';
    }

    ui.packs.textContent = state.packs.toLocaleString('fr-FR');
    ui.cards.textContent = state.cards.toLocaleString('fr-FR');
    /*
     * « 1 paquets » : le compteur le plus gros du panneau était le seul texte
     * à ne pas s'accorder, alors que `renderGoal` a une fonction écrite pour
     * ça — et pour la même raison, vue à l'écran.
     */
    ui.packsUnit.textContent = state.packs === 1 ? 'paquet' : 'paquets';
    ui.cardsUnit.textContent = state.cards === 1 ? 'carte' : 'cartes';

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
                 : `Trier le journal sur vos ${byRarity[r]} carte(s) ${r}`
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
       * Le réglage du limiteur — délai courant, plancher appris, cadence de
       * régénération — vivait ici, sous un titre « Ce qu'il mesure ». C'est le
       * réglage interne de l'outil : il ne dit rien à qui joue, et il n'appelle
       * aucun geste. Il part en console, avec le reste du diagnostic.
       */
      ui.bonusnote.textContent = state.bonusNote;
      ui.dbnote.textContent = state.dbNote;
      ui.notifnote.textContent = noteInvendus();
    }
  }

  /*
   * Ce que le masquage a retiré, dit en proportion plutôt qu'en nombre sec :
   * « 44 sur 50 » est exactement la plainte de départ, et c'est le chiffre qui
   * dit s'il faut allonger la durée des ventes plutôt que continuer à masquer.
   */
  function noteInvendus() {
    if (!prefs.masquerInvendus) return 'Vous les voyez toutes.';
    /*
     * Le direct compte à part, et il le mérite : c'est par là qu'elles
     * revenaient après la 3.4.1, une par enchère terminée, pendant que la
     * liste chargée au départ était propre.
     */
    const s = (n) => (n > 1 ? 's' : '');
    const direct = notifDirect
      ? ` ${notifDirect} arrivée${s(notifDirect)} en direct depuis, cachée${s(notifDirect)} aussi.`
      : '';
    if (!notifFiltre.total) {
      return direct
        ? direct.trim()
        : 'Ouvrez vos notifications pour voir le compte.';
    }
    if (!notifFiltre.masques) return `Aucune à cacher sur vos ${notifFiltre.total} dernières.${direct}`;
    return `${notifFiltre.masques} cachée${s(notifFiltre.masques)}`
      + ` sur vos ${notifFiltre.total} dernières notifications.${direct}`;
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
               title="Voir cette carte dans votre collection">${esc(e.title)}</a>
            ${prix}
            <a class="go" href="/collection" data-card="${esc(e.title)}" data-cote="1"
               title="Voir sa cote : ventes, moyenne, min/max">M</a>
            ${wiki}
          </div>`;
      })
      .join(''));
  }

  /*
   * L'onglet Amis (clé « guilde », d'où le nom) : ce que les amis détiennent,
   * puis le top 200 du classement à demander en ami. La partie guilde — les
   * dons possibles et leur alerte — est retirée en 3.8.0.
   */
  function renderGuild() {
    renderTroc();
    renderAmis();
  }

  /**
   * Le palier le plus proche en détail, puis les suivants en une ligne chacun.
   *
   * N'afficher que le premier revenait à cacher les récompenses : « 10 000
   * cartes » paie 500 et arrive vite, « 40 Légendaires » paie 1 500.
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
    /*
     * Accord au singulier. Les unités sont écrites au pluriel — « cartes »,
     * « Légendaires », « Peu Communes » — et le dernier palier avant l'arrivée
     * en affichait forcément un : « 1 Légendaires restantes », vu à l'écran.
     * Toutes se réduisent en retirant le « s » final.
     */
    const accord = (n, mot) => (n === 1 ? mot.replace(/s$/, '') : mot);
    const unit = accord(top.left, GOAL_UNIT[top.g.of] || 'cartes');

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
    /*
     * « à », et pas une espace. Les deux nombres se touchaient — « ~4,2 j
     * 0,1/h », par exemple — et se lisaient comme une seule valeur, alors
     * que le second est justement là pour qu'on puisse contester le premier.
     */
    const eta = top.eta != null
      ? ` · ~${fmtSpan(top.eta)} <span class="rate">à ${fmtRate(top.rate)}/h</span>`
      : '';

    const suite = rest.length ? `<div class="more">${rest.map((r) => `
      <span class="g" title="${esc(r.g.name)} — ${r.have.toLocaleString('fr-FR')} / ${r.g.at.toLocaleString('fr-FR')} ${GOAL_UNIT[r.g.of] || ''}">
        <b>+${r.g.reward}</b> ${esc(r.g.name)}
        <i>${r.left.toLocaleString('fr-FR')} ${accord(r.left, GOAL_UNIT[r.g.of] || '')}${r.eta != null ? ` · ~${fmtSpan(r.eta)}` : ''}</i>
      </span>`).join('')}</div>` : '';

    paint(ui.goal, `
      <div class="top">
        <span class="name">${esc(top.g.name)}</span>
        <span class="fee">+${top.g.reward}</span>
        <span class="cnt">${top.have.toLocaleString('fr-FR')} / ${top.g.at.toLocaleString('fr-FR')}</span>
      </div>
      <div class="track"><i style="width:${Math.min(100, top.part * 100).toFixed(1)}%"></i></div>
      <div class="left">${top.left.toLocaleString('fr-FR')} ${unit} restante${top.left === 1 ? '' : 's'}${eta}</div>
      ${suite}`);
  }

  /**
   * Les succès : la progression, et surtout ce qui attend d'être réclamé.
   *
   * Le relevé date de ton dernier passage sur la page — on affiche donc son
   * âge. Un ratio de succès sans fraîcheur ne dit pas s'il vaut encore.
   */
  function renderAchievements() {
    const a = state.achievements;
    if (!a.at) {
      paint(ui.achv, `<div class="none">Succès : <a class="go" href="/achievements"
        data-goto="/achievements" title="Relever la liste des succès">ouvrir la page</a></div>`);
      return;
    }
    const du = claimable();
    /*
     * Le succès le mieux payé qui reste — mais pas un de ceux que le bloc des
     * paliers, juste au-dessus, énumère déjà.
     *
     * Les deux blocs tiraient de la même liste par deux chemins : `GOALS`,
     * écrit en dur, et le relevé de la page Succès. On lisait donc, à trois
     * lignes d'intervalle, « +3 000 Va donc jouer dehors — <votre compte> »
     * puis « Mieux payé encore verrouillé : +3 000 Va donc jouer dehors ». Le
     * bloc des paliers gagne : il a l'échéance, que le relevé n'a pas. Celui-ci
     * ne garde que ce que l'autre ne montre pas — un succès de bataille, par
     * exemple, qui n'a rien à voir avec la collection.
     */
    const dejaDits = new Set(pendingGoals().map((r) => r.g.name));
    const reste = (a.list || []).filter((x) => !x.done && !dejaDits.has(x.name));
    const gros = reste.slice().sort((x, y) => y.reward - x.reward)[0];

    paint(ui.achv, `
      <div class="top">
        <span class="name">Succès</span>
        <span class="cnt">${a.done} / ${a.total}</span>
        <span class="age">${fmtAge(a.at)}</span>
      </div>
      ${du.n ? `<a class="claim" href="/achievements" data-goto="/achievements"
          title="${esc(du.list.map((x) => `${x.name} +${fmtWb(x.reward)}`).join(' · '))}">
          ${du.n} récompense${du.n > 1 ? 's' : ''} à réclamer <b>+${fmtWb(du.total)}</b></a>` : ''}
      ${gros ? `<div class="none">Mieux payé encore verrouillé :
          <b>+${fmtWb(gros.reward)}</b> ${esc(gros.name)} — ${esc(chiffresFr(gros.desc))}</div>` : ''}`);
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
   * Les textes qui viennent du site n'ont pas nos séparateurs : il écrit
   * « Posséder 100000 cartes ». Posé trois lignes sous un palier que le
   * panneau écrit avec ses séparateurs, c'est la même quantité écrite de deux
   * façons dans le même bloc — et c'est ce qu'on voyait dans l'onglet Paquets.
   */
  const chiffresFr = (s) =>
    String(s == null ? '' : s).replace(/\d{4,}/g, (n) => Number(n).toLocaleString('fr-FR'));

  /*
   * La fraîcheur d'un relevé, en trois caractères : l'en-tête n'a pas la place
   * d'une phrase, et « il y a 15 min » y poussait le titre sur deux lignes.
   * La phrase entière reste en infobulle.
   *
   * Mais `fmtSpan` rend « 24 h 25 » — la forme exacte d'une heure de la
   * journée. Posé en coin, à droite du ratio des succès, ça se lisait comme
   * une horloge et non comme une ancienneté ; l'infobulle disait juste, encore
   * fallait-il survoler un chiffre qu'on croyait avoir compris.
   *
   * Un âge n'a pas besoin des minutes passé la première heure : les retirer
   * lève l'ambiguïté ET raccourcit, ce que la contrainte de place demandait.
   */
  const fmtAge = (at) => {
    if (!at) return '—';
    const ms = Date.now() - at;
    if (ms < 60000) return 'à jour';
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m} min`;
    if (m < 2880) return `${Math.floor(m / 60)} h`;
    return fmtSpan(ms);   // au-delà de deux jours, fmtSpan compte déjà en jours
  };
  const ageTitle = (at) =>
    at ? `Dernier relevé ${Date.now() - at < 60000 ? "à l'instant" : `il y a ${fmtSpan(Date.now() - at)}`}`
       : 'Jamais relevé';

  const MKT_SOON_MS = 300000;   // même seuil que l'alerte « bientôt terminée »

  /*
   * Une ligne du Marché mène à sa page d'enchère : c'est la navigation
   * principale de l'onglet. C'étaient pourtant des `<li>` nus, cliqués par
   * délégation — ni bouton, ni lien, ni `tabindex` : rien à atteindre au
   * clavier, et rien qui s'annonce comme actionnable.
   *
   * `role="button"` + `tabindex="0"` suffisent, à condition que la touche
   * agisse aussi — c'est le rôle du gestionnaire `keydown` posé sur `ui.market`,
   * qui repasse par le clic pour n'avoir qu'une seule décision à maintenir.
   */
  const LIGNE_ACTIVE = 'role="button" tabindex="0"';

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
        return `<li class="${cls}" ${cible} ${LIGNE_ACTIVE}>
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
  /*
   * 12 pages suffisaient tant que la liste se remplissait à la main. « Tout
   * souhaiter » la fait passer à quelques centaines d'un clic : au plafond
   * d'avant, le volet aurait cessé de surveiller le reste sans le dire —
   * exactement au moment où tu viens de le lui confier. La boucle s'arrête de
   * toute façon sur `total`, donc ces pages ne sont lues que si elles existent.
   */
  const WISH_MAX_PAGES = 40;       // 2 000 cartes ; garde-fou si `total` mentait
  const WISH_SCAN_PAGES = 8;       // ~400 annonces, la fenêtre récente du marché
  const WISH_SCAN_MS = 100000;     // sous les deux minutes que couvrent ces pages
  const WISH_SEEN_MAX = 800;       // annonces retenues : deux balayages de recul

  async function refreshWishlist(force) {
    if (!force && Date.now() - state.wish.at < WISH_TTL_MS) return state.wish;
    const cartes = {};
    /*
     * Chaque page porte aussi `friendOwners` — quel ami détient quelle carte —
     * et `friendPendingOfferKeys`, les couples joueur:carte déjà engagés dans
     * une offre. Les récolter ici ne coûte rien : ce sont les mêmes réponses.
     */
    const chezAmis = {};
    const amis = new Set();
    const engages = new Set();
    try {
      for (let page = 0; page < WISH_MAX_PAGES; page++) {
        const d = await api(`/api/cards?page=${page}&wishlist=1`);
        const lot = (d.data && d.data.cards) || [];
        if (!lot.length) break;
        for (const c of lot) {
          cartes[c.id] = { t: c.wikipedia_title || c.title || c.id, r: c.rarity || '?' };
        }
        for (const k of (d.data && d.data.friendPendingOfferKeys) || []) engages.add(k);
        const proprios = (d.data && d.data.friendOwners) || {};
        for (const [id, liste] of Object.entries(proprios)) {
          for (const a of liste || []) {
            if (!a || !a.username) continue;
            (chezAmis[id] = chezAmis[id] || []).push(a);
          }
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

    /*
     * Le filtrage des offres en cours se fait ICI, une fois tout lu : les
     * couples engagés arrivent page par page, et une clé de la page 2 peut
     * porter sur une carte de la page 1. Filtrer au fil de l'eau aurait laissé
     * passer celles qui arrivent après leur carte.
     *
     * Ordre des lignes : par rareté décroissante, puis par nombre d'amis. Une
     * Légendaire détenue par un ami est la ligne qui vaut le déplacement ; une
     * Commune que quatre amis possèdent ne vaut presque rien, et se retrouve
     * en bas d'elle-même.
     */
    const lignes = [];
    for (const [id, proprios] of Object.entries(chezAmis)) {
      const carte = cartes[id];
      if (!carte) continue;
      const libres = proprios.filter((a) => !engages.has(`${a.id}:${id}`));
      const qui = libres.map((a) => a.username);
      if (!qui.length) continue;
      /*
       * Les identifiants voyagent avec les pseudos : ce sont eux que retient
       * la mémoire des demandes d'ami, et c'est par eux que le bloc du
       * classement compte les souhaits trouvés chez les amis qu'il a ajoutés.
       * Un pseudo change ; l'identifiant, non.
       */
      lignes.push({ id, t: carte.t, r: carte.r, qui: [...new Set(qui)],
                    ids: [...new Set(libres.map((a) => a.id).filter(Boolean))] });
      for (const u of qui) amis.add(u);
    }
    const rang = (r) => {
      const i = RARETES.indexOf(r);
      return i === -1 ? RARETES.length : i;
    };
    lignes.sort((a, b) => rang(a.r) - rang(b.r) || b.qui.length - a.qui.length
      || a.t.localeCompare(b.t));

    state.troc = {
      at: Date.now(),
      lignes,
      amis: amis.size,
      enAttente: engages.size,
    };
    saveStore({ wish: state.wish, troc: state.troc });
    renderTroc();
    return state.wish;
  }

  /*
   * Le volet Échanges
   * -----------------
   * `friendOwners` répond à la question que le marché ne sait pas traiter :
   * non pas « qui vend cette carte », mais « qui l'a ». Sur une liste de
   * souhaits ordinaire, une bonne part de ce qu'on cherche est à portée de
   * conversation, et rien ne le disait.
   *
   * Il vit dans l'onglet Amis (clé « guilde »), pas dans un onglet à lui : la
   * barre en porte déjà cinq à 11,5 px, et un de plus déborderait à 260 px de
   * large — la borne basse de la poignée de redimensionnement. C'est l'onglet
   * des autres joueurs : ce qu'ils détiennent, comment en faire des amis, et
   * ce que la guilde demande.
   *
   * Ce que le volet NE fait pas : proposer. Une proposition engage une de tes
   * cartes et un autre joueur ; c'est de la même famille que vendre ou donner,
   * et le panneau ne le fait pas à ta place. Il montre, il ouvre le composeur
   * au bon nom, et il s'arrête là.
   */
  const TROC_LIGNES = 8;   // au-delà, le volet cesse d'être lisible d'un coup d'œil

  function renderTroc() {
    if (!ui || !ui.troc) return;
    const t = state.troc || { lignes: [], amis: 0, enAttente: 0 };
    const lignes = t.lignes || [];

    if (!lignes.length) {
      ui.troc.innerHTML = '<div class="h">Échanges</div>'
        + '<div>Aucun de vos souhaits n’est détenu par un ami pour l’instant. '
        + 'La liste est relue avec vos souhaits, toutes les quinze minutes. Plus vous '
        + 'avez d’amis, plus elle trouve : le bloc suivant ajoute les premiers du classement.</div>';
      return;
    }

    /*
     * Un nom, puis le compte des autres — jamais trois noms tronqués.
     *
     * La colonne rendait « CielGreg, guacamolec, J… » sur sept lignes de huit :
     * le début, identique partout, tenait toute la place, et ce que la
     * troncature emportait était justement le nom qui distinguait une ligne de
     * la suivante. Un seul nom suivi de « +2 » tient dans moins de signes et
     * dit ce que la ligne apporte ; la liste entière reste en infobulle, où
     * elle a la place de s'écrire.
     */
    const rangs = lignes.slice(0, TROC_LIGNES).map((l) => {
      const qui = l.qui.join(', ');
      const autres = l.qui.length - 1;
      const court = autres > 0 ? `${l.qui[0]} +${autres}` : l.qui[0];
      return `<button class="l" data-troc-qui="${esc(l.qui[0])}"`
        + ` title="${esc(l.t)} — détenue par ${esc(qui)}. Ouvre les échanges,`
        + ` le composeur cherchera ${esc(l.qui[0])}.">`
        + `<span class="t">${esc(l.t)}</span>`
        + `<span class="r">${esc(l.r)}</span>`
        + `<span class="q">${esc(court)}</span>`
        + '</button>';
    }).join('');

    const reste = lignes.length - TROC_LIGNES;
    const pied = [];
    if (reste > 0) pied.push(`${reste} autre${reste > 1 ? 's' : ''} plus bas dans la liste`);
    if (t.enAttente) {
      pied.push(`${t.enAttente} offre${t.enAttente > 1 ? 's' : ''} déjà en cours, écartée${t.enAttente > 1 ? 's' : ''}`);
    }

    ui.troc.innerHTML =
      `<div class="h">Échanges · <b>${lignes.length}</b> souhait${lignes.length > 1 ? 's' : ''}`
      + ` chez <b>${t.amis}</b> ami${t.amis > 1 ? 's' : ''}</div>`
      + rangs
      + (pied.length ? `<div class="plus">${esc(pied.join(' · '))}</div>` : '');
  }

  /*
   * Le site n'a pas de lien profond vers le composeur : « Proposer un
   * échange » ouvre une fenêtre sans toucher à l'URL. On refait donc le geste
   * — aller sur la page, ouvrir le composeur, y écrire le nom — exactement le
   * détour déjà fait pour atteindre une carte en collection.
   *
   * Chaque étape abandonne en silence si elle ne trouve pas sa cible : on est
   * alors sur la page des échanges, ce qui reste le bon endroit. Une erreur
   * affichée pour un raccourci raté vaudrait moins que le raccourci.
   */
  function goTroc(qui) {
    if (!location.pathname.startsWith('/trades')) goPath('/trades');
    attendre(
      () => [...document.querySelectorAll('button')]
        .find((b) => /proposer un échange/i.test(b.textContent)),
      (bouton) => {
        bouton.click();
        attendre(
          () => document.querySelector(SEARCH_SELECTOR),
          (champ) => setReactInput(champ, qui),
        );
      },
    );
  }

  /** Attendre qu'un nœud paraisse, puis agir. Abandon au bout de dix secondes. */
  function attendre(trouver, agir) {
    let essais = 0;
    const id = setInterval(() => {
      let cible = null;
      try {
        cible = trouver();
      } catch (_) {
        /* la page se redessine : on retentera au tour suivant */
      }
      if (cible) {
        clearInterval(id);
        agir(cible);
      } else if (++essais > 40) {
        clearInterval(id);
      }
    }, 250);
  }

  /*
   * Amis du classement
   * ------------------
   * Le volet Échanges ne voit que les cartes de vos AMIS : `friendOwners` ne
   * dit rien des autres joueurs, et aucune route ne dit qui possède une carte.
   * Plus le cercle est large, plus il trouve. Et ceux qui ont le plus de
   * chances d'avoir une carte donnée sont ceux qui en ont le plus : le haut du
   * classement général, trié sur le nombre de cartes possédées.
   *
   * Relevé en lecture seule le 12 septembre 2026 :
   *   - `GET /api/leaderboard?period=all&page=N` : 25 joueurs par page, fixe
   *     (`limit` est ignoré), pages comptées à partir de 1, une seconde et
   *     demie chacune côté serveur. `weekly` répond 500, `daily` s'arrête à
   *     25 joueurs : aucun moyen de ne garder que les joueurs actifs ;
   *   - `GET /api/friends` rend amis et demandes en un appel, statuts
   *     `accepted` et `pending` ;
   *   - `POST /api/friends {addressee_id}` : l'identifiant du classement suffit.
   *
   * Trois règles, qui valent plus que le bouton :
   *
   * 1. Au rythme d'une personne. Une demande toutes les 8 à 45 secondes,
   *    tirées au hasard, et une pause d'une à trois minutes toutes les six à
   *    douze demandes. Jamais de rafale : chaque demande arrive chez un vrai
   *    joueur, et le jeu permet de signaler un envoi pour « Spam ».
   *
   * 2. On ne redemande JAMAIS. Une demande refusée disparaît de la liste
   *    d'amis sans laisser de trace : pour le site, un joueur qui a dit non
   *    ressemble à un joueur jamais demandé. Le panneau tient donc sa propre
   *    mémoire (`lireVus`), où entre tout joueur croisé dans la liste d'amis —
   *    ami, demande envoyée, demande reçue — et tout joueur à qui le bouton a
   *    écrit. Rien n'en sort, sauf un envoi que le serveur a explicitement
   *    refusé : là, on sait qu'aucune demande n'a été créée.
   *
   * 3. Rien ne part sans deux clics : le premier lit et annonce le compte, le
   *    second envoie. Le panneau ne retire, n'accepte ni ne refuse aucune
   *    demande : ces gestes restent sur la page Amis du site.
   */
  /*
   * Deux cents, fixe. Il y avait un choix Top 50 / 100 / 200 : à l'usage, le
   * 200 faisait le travail et les deux autres ne servaient à rien.
   */
  const AMIS_PROF = 200;
  const CLASSEMENT_PAGE = 25;              // fixé par le serveur
  const CLASSEMENT_TTL_MS = 86400000;      // un jour : le haut du classement bouge lentement
  const CLASSEMENT_GAP_MS = 600;           // souffle entre deux pages lues
  const AMIS_TTL_MS = 600000;              // la liste d'amis, relue au plus toutes les dix minutes
  const AMIS_KEY = 'wm-auto-amis';         // la mémoire des demandes, à part du stockage principal
  const AMIS_ENVOI_KEY = 'wm-auto-amis-envoi';   // un seul onglet envoie à la fois
  const AMIS_ENVOI_TTL = 150000;           // un onglet d'arrière-plan ne bat qu'une fois par minute
  const AMIS_NOTE_MS = 20000;              // même tenue que les comptes rendus de « Tout souhaiter »
  /*
   * Le rythme. Un intervalle = un minimum + une part exponentielle : beaucoup
   * d'écarts courts, quelques longs — la façon dont on enchaîne vraiment des
   * gestes à la main. Plafonné pour qu'un tirage malchanceux ne fige pas
   * l'envoi. Moyenne autour de 17 secondes.
   */
  const AMIS_PAS_MIN_MS = 8000;
  const AMIS_PAS_TYPE_MS = 9000;
  const AMIS_PAS_MAX_MS = 45000;
  const AMIS_PAUSE_APRES = [6, 12];        // demandes entre deux pauses
  const AMIS_PAUSE_MS = [60000, 180000];
  const AMIS_REPRISES = 2;                 // nouveaux essais après un « ralentissez »
  // Même raison que `WISH_ARME_MIN_MS` : un double-clic n'a rien lu.
  const AMIS_ARME_MIN_MS = 500;

  let amisBusy = '';        // '' | 'lecture' | 'lecture i/n' | 'envoi'
  let amisArme = 0;         // fin d'armement
  let amisArmeA = 0;        // début d'armement
  let amisLot = null;       // ce que le second clic enverra
  let amisStop = false;     // demandé par le bouton, pendant l'envoi
  let amisEnvoi = null;     // { fait, total, prochaine, pause } pendant l'envoi
  let amisMinuteur = 0;     // compte à rebours et battement du verrou, pendant l'envoi
  let amisNote = '';
  let amisNoteTitre = '';
  let amisNoteAt = 0;
  let amisTenteA = 0;       // dernière lecture de la liste d'amis TENTÉE, réussie ou non

  function amisEnvoiEnCours() {
    return amisBusy === 'envoi';
  }

  function amisDire(note, titre) {
    amisNote = note;
    amisNoteTitre = titre || '';
    amisNoteAt = Date.now();
  }

  function amisDesarmer() {
    amisArme = 0;
    amisLot = null;
  }

  const amisTirage = ([a, b]) => Math.round(a + Math.random() * (b - a));

  function amisPas() {
    const x = AMIS_PAS_MIN_MS - Math.log(1 - Math.random()) * AMIS_PAS_TYPE_MS;
    return Math.round(Math.min(AMIS_PAS_MAX_MS, x));
  }

  /** Durée attendue pour n demandes, pauses comprises — pour l'annoncer, pas pour la tenir. */
  function amisEstime(n) {
    const serie = (AMIS_PAUSE_APRES[0] + AMIS_PAUSE_APRES[1]) / 2;
    const pause = (AMIS_PAUSE_MS[0] + AMIS_PAUSE_MS[1]) / 2;
    return n * (AMIS_PAS_MIN_MS + AMIS_PAS_TYPE_MS) + Math.floor(n / serie) * pause;
  }

  const amisDuree = (ms) => (ms < 60000 ? 'moins d’une minute' : fmtSpan(ms));
  const rangFr = (r) => (r === 1 ? '1er' : `${r}e`);

  /*
   * La mémoire des demandes. Une clé à part, hors de `saveStore` : le
   * stockage principal se réécrit en entier à chaque réglage, et on le sait
   * proche du plafond sur les grosses collections. Celle-ci doit tenir — c'est
   * elle qui empêche de redemander quelqu'un qui a dit non.
   *
   * `null` veut dire illisible, et alors on n'envoie RIEN. Rendre `{}` sur
   * une mémoire corrompue ferait redemander tout le monde.
   *
   * Une entrée par joueur, sous son identifiant — un pseudo change, pas lui :
   * { n: pseudo, e: état, at: première rencontre, m: dernier changement,
   *   o: 1 si c'est le panneau qui a demandé, r: son rang à ce moment-là }.
   * États : envoyee, attente, recue, ami, refusee, retire, close.
   */
  function lireVus() {
    let brut;
    try {
      brut = localStorage.getItem(AMIS_KEY);
    } catch (_) {
      return null;
    }
    if (brut == null) return {};
    try {
      const v = JSON.parse(brut);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch (_) {
      return null;
    }
  }

  /** Écrit, puis relit : une écriture qu'on ne peut pas relire n'a pas eu lieu. */
  function ecrireVus(vus, id) {
    try {
      localStorage.setItem(AMIS_KEY, JSON.stringify(vus));
    } catch (_) {
      return false;
    }
    const relu = lireVus();
    return !!relu && (!id || !!relu[id]);
  }

  /*
   * Relit la liste d'amis et met la mémoire à jour. Un joueur qui sort de la
   * liste dit ce qu'il était la dernière fois qu'on l'a vu : une demande en
   * attente qui s'en va a été refusée, un ami qui s'en va vous a retiré.
   *
   * Une entrée écrite PENDANT la lecture n'est pas jugée : la demande est
   * peut-être partie après que le serveur a préparé sa réponse. La croire
   * refusée ne changerait rien à l'envoi — elle reste en mémoire — mais
   * l'écran mentirait.
   *
   * @returns {Promise<object|null>} la mémoire à jour, ou `null` si la liste
   *   n'a pas pu être lue : l'appelant n'envoie alors rien.
   */
  async function refreshAmis(force) {
    /*
     * La fraîcheur se compte sur la dernière TENTATIVE, comme pour la guilde :
     * appelée par un tour d'une seconde, une lecture qui échoue repartirait
     * sinon à chaque seconde.
     */
    if (!force && Date.now() - Math.max(state.amis.at, amisTenteA) < AMIS_TTL_MS) return lireVus();
    amisTenteA = Date.now();
    const moi = await fetchMyId();
    if (!moi) return null;
    const debut = Date.now();
    let d;
    try {
      d = await api('/api/friends');
    } catch (_) {
      return null;
    }
    const liste = d.status === 200 && d.data && Array.isArray(d.data.friendships)
      ? d.data.friendships
      : null;
    if (!liste) return null;
    const vus = lireVus();
    if (!vus) return null;

    const presents = new Set();
    let recues = 0;
    for (const f of liste) {
      if (!f) continue;
      const sortant = f.requester_id === moi;
      const id = sortant ? f.addressee_id : f.requester_id;
      if (!id || id === moi) continue;
      const autre = (sortant ? f.addressee : f.requester) || {};
      /*
       * Un statut inconnu n'est pas une porte ouverte : le joueur entre en
       * mémoire comme les autres, et ne sera donc jamais demandé.
       */
      const e = f.status === 'accepted' ? 'ami'
        : f.status === 'pending' ? (sortant ? 'attente' : 'recue')
          : (sortant ? 'refusee' : 'close');
      if (e === 'recue') recues += 1;
      presents.add(id);
      const v = vus[id];
      const n = autre.username || (v && v.n) || '';
      if (!v) vus[id] = { n, e, at: Date.now(), m: Date.now() };
      else if (v.e !== e || v.n !== n) vus[id] = { ...v, n, e, m: v.e !== e ? Date.now() : v.m };
    }
    const suite = { envoyee: 'refusee', attente: 'refusee', ami: 'retire', recue: 'close' };
    for (const [id, v] of Object.entries(vus)) {
      if (!v || presents.has(id) || !suite[v.e] || v.m > debut) continue;
      vus[id] = { ...v, e: suite[v.e], m: Date.now() };
    }
    if (!ecrireVus(vus)) return null;
    state.amis = { at: Date.now(), recues };
    return vus;
  }

  /**
   * Les N premiers du classement général. Gardés un jour ; un classement lu
   * plus profond sert aussi pour moins profond.
   *
   * @returns {Promise<Array|null>} `null` si une page a manqué : armer sur un
   *   classement troué annoncerait un compte faux.
   */
  async function lireClassement(prof) {
    const c = state.classement;
    if (c && c.prof >= prof && Date.now() - c.at < CLASSEMENT_TTL_MS) return c.lignes.slice(0, prof);
    const pages = Math.ceil(prof / CLASSEMENT_PAGE);
    const lignes = new Map();
    for (let p = 1; p <= pages; p++) {
      if (p > 1) await new Promise((r) => setTimeout(r, CLASSEMENT_GAP_MS));
      amisBusy = `lecture ${p}/${pages}`;
      renderAmis();
      let d;
      try {
        d = await api(`/api/leaderboard?period=all&page=${p}`);
      } catch (_) {
        return null;
      }
      const lot = d.status === 200 && d.data && Array.isArray(d.data.entries) ? d.data.entries : null;
      if (!lot) return null;
      for (const e of lot) {
        // Un joueur qui change de page pendant la lecture passerait deux fois.
        if (e && e.user_id && !lignes.has(e.user_id)) {
          lignes.set(e.user_id, { u: e.user_id, n: String(e.username || ''), r: Number(e.rank) || 0 });
        }
      }
      if (lot.length < CLASSEMENT_PAGE) break;
    }
    const tout = [...lignes.values()].sort((a, b) => a.r - b.r);
    state.classement = { at: Date.now(), prof, lignes: tout };
    saveStore({ classement: state.classement });
    return tout.slice(0, prof);
  }

  // ---- un seul onglet envoie à la fois : même principe que le verrou de la boucle

  function amisVerrouTenu() {
    try {
      const l = JSON.parse(localStorage.getItem(AMIS_ENVOI_KEY) || 'null');
      if (l && Date.now() - l.at < AMIS_ENVOI_TTL) return l.id;
    } catch (_) {
      /* stockage illisible : verrou libre */
    }
    return null;
  }

  function amisPrendreVerrou() {
    const t = amisVerrouTenu();
    if (t && t !== instanceId) return false;
    try {
      localStorage.setItem(AMIS_ENVOI_KEY, JSON.stringify({ id: instanceId, at: Date.now() }));
    } catch (_) {
      /* sans stockage, la mémoire des demandes ne s'écrira pas non plus : l'envoi s'arrêtera */
    }
    return true;
  }

  function amisRendreVerrou() {
    if (amisVerrouTenu() !== instanceId) return;
    try {
      localStorage.removeItem(AMIS_ENVOI_KEY);
    } catch (_) {}
  }

  /*
   * Premier clic : lire le classement et la liste d'amis, écarter, armer.
   * Second clic dans les six secondes : envoyer. Pendant l'envoi : arrêter.
   */
  async function amisClick() {
    if (amisBusy === 'envoi') {
      amisStop = true;
      renderAmis();
      return;
    }
    if (amisBusy) return;

    if (Date.now() < amisArme && amisLot) {
      if (Date.now() - amisArmeA < AMIS_ARME_MIN_MS) return;
      const lot = amisLot;
      amisDesarmer();
      await amisEnvoyer(lot);
      return;
    }

    const tenu = amisVerrouTenu();
    if (tenu && tenu !== instanceId) {
      amisDire('Déjà en cours dans un autre onglet',
        'Un autre onglet envoie des demandes en ce moment. Attendez qu’il ait fini.');
      renderAmis();
      return;
    }

    amisBusy = 'lecture';
    amisNote = '';
    renderAmis();
    try {
      if (!lireVus()) {
        amisDire('Mémoire illisible', 'La liste des joueurs déjà demandés n’a pas pu être lue. '
          + 'Sans elle, le bouton risquerait de redemander quelqu’un qui a refusé : il n’envoie rien.');
        return;
      }
      const moi = await fetchMyId();
      if (!moi) {
        amisDire('Session illisible', 'Votre session n’a pas pu être lue dans cet onglet. '
          + 'Rechargez la page ; si ça persiste, reconnectez-vous au site.');
        return;
      }
      const lignes = await lireClassement(AMIS_PROF);
      if (!lignes) {
        amisDire('Classement illisible', 'Le serveur n’a pas rendu le classement en entier. '
          + 'Rien n’a été envoyé. Réessayez dans une minute.');
        return;
      }
      // Toujours relue : c'est elle qui écarte vos amis et les demandes en cours.
      const vus = await refreshAmis(true);
      if (!vus) {
        amisDire('Liste d’amis illisible', 'Sans elle, le bouton ne peut écarter ni vos amis ni '
          + 'vos demandes en attente. Rien n’a été envoyé. Réessayez dans une minute.');
        return;
      }
      const lot = lignes.filter((l) => l.u !== moi && !vus[l.u]);
      if (!lot.length) {
        amisDire(`Tout le top ${AMIS_PROF} est déjà ami ou demandé`,
          'Vos amis, vos demandes en attente et les joueurs déjà demandés sont écartés. '
            + 'Le classement bouge : de nouveaux joueurs y entreront.');
        return;
      }
      amisLot = lot;
      amisArmeA = Date.now();
      amisArme = Date.now() + ARME_MS;
      setTimeout(() => {
        if (Date.now() < amisArme) return;
        amisDesarmer();
        renderAmis();
      }, ARME_MS + 100);
    } finally {
      amisBusy = '';
      renderAmis();
    }
  }

  /** Attendre, en rendant la main dès qu'on demande l'arrêt. */
  function amisAttendre(ms) {
    if (amisEnvoi) amisEnvoi.prochaine = Date.now() + ms;
    return new Promise((ok) => {
      const fin = Date.now() + ms;
      const id = setInterval(() => {
        if (amisStop || Date.now() >= fin) {
          clearInterval(id);
          ok();
        }
      }, 500);
    });
  }

  /** Retire un joueur de la mémoire, si et seulement si c'est le panneau qui venait de l'y mettre. */
  function amisOublier(id) {
    const vus = lireVus();
    if (!vus || !vus[id] || vus[id].e !== 'envoyee') return;
    delete vus[id];
    ecrireVus(vus);
  }

  /*
   * Une demande, et ce que la réponse dit de la mémoire.
   *
   * Le joueur est noté AVANT l'envoi : si l'onglet se ferme pendant la
   * requête, on ne sait pas si elle est partie, et dans le doute on ne la
   * refera pas. Il n'en ressort que sur un refus explicite du serveur — un
   * « ralentissez », une vérification demandée, une autre erreur 4xx : là, on
   * sait qu'aucune demande n'a été créée, et le garder l'écarterait pour rien.
   * Une erreur 5xx ne dit pas si la demande est passée : il reste noté.
   *
   * @returns {Promise<{echec?: {note, titre}, stop?: boolean}>}
   */
  async function amisDemander(j) {
    for (let essai = 0; ; essai++) {
      const vus = lireVus();
      if (!vus) {
        return { echec: { note: 'Mémoire illisible', titre: 'La liste des joueurs déjà demandés '
          + 'n’a pas pu être relue. Sans elle, le bouton risquerait de redemander quelqu’un qui a '
          + 'refusé : il s’arrête.' } };
      }
      vus[j.u] = { n: j.n, e: 'envoyee', at: Date.now(), m: Date.now(), o: 1, r: j.r };
      if (!ecrireVus(vus, j.u)) {
        return { echec: { note: 'Stockage plein', titre: 'Le navigateur n’a pas pu noter le '
          + 'joueur avant l’envoi. Sa demande n’est pas partie, et l’envoi s’arrête là.' } };
      }

      let d;
      try {
        d = await api('/api/friends', 'POST', { addressee_id: j.u });
      } catch (_) {
        return { echec: { note: 'Réseau coupé', titre: 'La dernière demande est peut-être '
          + 'partie, peut-être pas. Son joueur reste noté : il ne sera pas redemandé.' } };
      }
      if (d.status >= 200 && d.status < 300) return {};

      const message = errorText(d.data);
      // Déjà amis, ou demande déjà faite : il n'y a rien à refaire.
      if (d.status === 409 || /déjà|already|exist/i.test(message)) return {};
      if (d.status >= 500) {
        // Le code va en console, comme partout : à l'écran, il ne dit pas quoi faire.
        console.warn('[WikiMasters Tools] demande d’ami : erreur du serveur', { statut: d.status, message });
        return { echec: { note: 'Erreur du serveur', titre: 'On ne sait pas si la '
          + 'dernière demande est partie : son joueur reste noté. Réessayez plus tard.' } };
      }

      amisOublier(j.u);
      if (needsHuman(d.status, d.data)) {
        return { echec: { note: 'Vérification humaine demandée', titre: 'Le site demande de '
          + 'prouver que vous êtes humain. Faites-la dans l’onglet, puis recliquez : les joueurs '
          + 'déjà demandés sont écartés d’office.' } };
      }
      if (d.status === 429 && essai < AMIS_REPRISES) {
        await amisAttendre(Math.max(d.retryMs || 0, 60000) + amisTirage([2000, 15000]));
        if (amisStop) return { stop: true };
        continue;
      }
      console.warn('[WikiMasters Tools] demande d’ami refusée', { statut: d.status, message });
      return { echec: { note: 'Refusé par le serveur',
        titre: (message ? `Le serveur dit : « ${message} ». ` : 'Le serveur n’a pas dit pourquoi. ')
          + 'L’envoi s’arrête là ; les demandes déjà parties restent parties.' } };
    }
  }

  /*
   * L'envoi. Seul endroit du panneau qui écrit une demande d'ami, et le
   * second clic est seul à l'appeler — `verifier.js` le garde.
   */
  async function amisEnvoyer(lot) {
    if (!amisPrendreVerrou()) {
      amisDire('Déjà en cours dans un autre onglet',
        'Un autre onglet envoie des demandes en ce moment. Attendez qu’il ait fini.');
      renderAmis();
      return;
    }
    amisBusy = 'envoi';
    amisStop = false;
    amisNote = '';
    amisEnvoi = { fait: 0, total: lot.length, prochaine: 0, pause: false, suivant: lot[0] || null };
    amisMinuteur = setInterval(() => {
      amisPrendreVerrou();   // le battement : un onglet mort libère la place en deux minutes et demie
      renderAmis();
    }, 1000);
    renderAmis();

    let envoyees = 0;
    let echec = null;
    let avantPause = amisTirage(AMIS_PAUSE_APRES);
    try {
      for (let i = 0; i < lot.length && !amisStop; i++) {
        const j = lot[i];
        const vus = lireVus();
        if (!vus) {
          echec = { note: 'Mémoire illisible', titre: 'La liste des joueurs déjà demandés n’a pas '
            + 'pu être relue : l’envoi s’arrête plutôt que de risquer un doublon.' };
          break;
        }
        // Demandé entre-temps — par un autre onglet, ou par la relecture de la liste.
        if (vus[j.u]) {
          amisEnvoi.fait = i + 1;
          continue;
        }
        const r = await amisDemander(j);
        if (r.echec) {
          echec = r.echec;
          break;
        }
        if (r.stop) break;
        envoyees += 1;
        amisEnvoi.fait = i + 1;
        // Le prochain à qui l'on écrira : celui que la grille fait battre pendant l'attente.
        const reste = lireVus() || {};
        amisEnvoi.suivant = lot.slice(i + 1).find((l) => !reste[l.u]) || null;
        renderAmis();
        if (i === lot.length - 1 || amisStop || !amisEnvoi.suivant) break;

        let attente = amisPas();
        amisEnvoi.pause = false;
        if (--avantPause <= 0) {
          attente = amisTirage(AMIS_PAUSE_MS);
          amisEnvoi.pause = true;
          avantPause = amisTirage(AMIS_PAUSE_APRES);
        }
        await amisAttendre(attente);
      }
    } finally {
      clearInterval(amisMinuteur);
      amisMinuteur = 0;
      const interrompu = amisStop || echec;
      const fait = amisEnvoi ? amisEnvoi.fait : 0;
      amisEnvoi = null;
      amisBusy = '';
      amisStop = false;
      amisRendreVerrou();
      const s = envoyees > 1 ? 's' : '';
      if (echec) {
        amisDire(`${envoyees} demande${s} envoyée${s} · ${echec.note}`, echec.titre);
      } else if (interrompu) {
        amisDire(`${envoyees} demande${s} envoyée${s} · arrêté à ${fait} / ${lot.length}`,
          'Recliquer reprend avec les joueurs restants : ceux déjà demandés sont écartés.');
      } else {
        amisDire(`${envoyees} demande${s} envoyée${s}`,
          'Ceux qui acceptent apparaissent dans Échanges au prochain relevé de vos souhaits.');
      }
      refreshAmis(true).then(renderAmis, () => {});
      renderAmis();
    }
  }

  /*
   * Le classement se lit tout seul quand l'onglet s'ouvre — c'est ce qui
   * donne la grille et le compte « à demander » AVANT le premier clic. Lecture seule, gardée un jour ; après un échec, pas de
   * nouvel essai avant une minute, sinon le tour d'une seconde relancerait
   * la lecture en boucle.
   */
  let amisLuA = 0;

  function amisLireAuto() {
    if (amisBusy) return;
    const c = state.classement;
    if (c && c.prof >= AMIS_PROF && Date.now() - c.at < CLASSEMENT_TTL_MS) return;
    if (Date.now() - amisLuA < 60000) return;
    amisLuA = Date.now();
    lireClassement(AMIS_PROF)
      .catch(() => null)
      .then(() => {
        amisBusy = '';
        renderAmis();
      });
  }

  /**
   * L'état de chacun des joueurs du top choisi : la matière de la grille, de
   * sa légende et du compte du bouton. Rien ne se lit ici — le classement
   * vient du cache, les états de la mémoire des demandes.
   */
  function amisTop(vus) {
    const c = state.classement;
    const top = c && c.lignes ? c.lignes.slice(0, AMIS_PROF) : [];
    const par = { ami: [], att: [], rec: [], ref: [], vide: [] };
    const cases = top.map((l) => {
      const v = vus[l.u];
      const k = l.u === myId ? 'moi'
        : !v ? 'vide'
          : ({ ami: 'ami', attente: 'att', envoyee: 'att', recue: 'rec' })[v.e] || 'ref';
      if (par[k]) par[k].push(`${rangFr(l.r)} ${l.n}`);
      const mot = {
        moi: 'vous', vide: 'à demander', ami: 'ami', att: 'demande en attente',
        rec: 'vous a demandé en ami', ref: v && v.e === 'retire' ? 'vous a retiré' : 'a refusé',
      }[k];
      return { l, k, mot };
    });
    return { top, par, cases };
  }

  function amisGrilleHtml(t) {
    if (!t.top.length) return '';
    const suivant = amisEnvoi && amisEnvoi.suivant ? amisEnvoi.suivant.u : '';
    const cases = t.cases.map(({ l, k, mot }) => {
      const cls = [k === 'vide' ? '' : k, l.u === suivant ? 'suiv' : ''].filter(Boolean).join(' ');
      const dit = l.u === suivant ? 'prochaine demande' : mot;
      return `<i${cls ? ` class="${cls}"` : ''} title="${esc(`${rangFr(l.r)} · ${l.n} — ${dit}`)}"></i>`;
    }).join('');
    const puce = (liste, un, plusieurs, style) => (liste.length
      ? `<span style="${style}" title="${esc(liste.join(', '))}"><b>${liste.length}</b> `
        + `${liste.length > 1 ? plusieurs : un}</span>`
      : '');
    const p = t.par;
    const legende = [
      puce(p.ami, 'ami', 'amis', '--k:var(--live)'),
      puce(p.att, 'en attente', 'en attente', '--k:var(--warn)'),
      puce(p.rec, 'vous a demandé', 'vous ont demandé', '--k:#6FA8FF'),
      puce(p.ref, 'a refusé', 'ont refusé', '--k:color-mix(in srgb, #E5646A 45%, transparent)'),
      puce(p.vide, 'à demander', 'à demander', '--o:inset 0 0 0 1px rgba(255,255,255,.3)'),
    ].join('');
    return `<div class="cases">${cases}</div><div class="legende">${legende}</div>`;
  }

  /** Sous le bouton : l'envoi en cours, le dernier compte rendu, ce que les demandes ont rapporté. */
  function amisEtatHtml(vus) {
    const lignes = [];
    if (amisBusy === 'envoi' && amisEnvoi) {
      const e = amisEnvoi;
      const reste = Math.max(0, (e.prochaine || 0) - Date.now());
      const restantes = e.total - e.fait;
      const pct = e.total ? Math.round((e.fait / e.total) * 100) : 0;
      lignes.push(`<div class="prog"><i style="width:${pct}%"></i></div>`);
      lignes.push(`<div>Envoi <b>${e.fait}</b> / ${e.total}`
        + (restantes > 0 && !amisStop ? ` · reste environ ${amisDuree(amisEstime(restantes))}` : '')
        + '</div>');
      const qui = e.suivant ? `${esc(e.suivant.n)} (${rangFr(e.suivant.r)})` : '';
      if (amisStop) lignes.push('<div>Arrêt demandé : plus rien ne part.</div>');
      else if (qui && e.pause && reste) lignes.push(`<div>Pause · ${qui} dans ${fmtClock(reste)}</div>`);
      else if (qui && reste) lignes.push(`<div>Prochaine : ${qui} dans ${Math.ceil(reste / 1000)} s</div>`);
      else lignes.push('<div>Envoi…</div>');
    } else if (amisNote && Date.now() - amisNoteAt < AMIS_NOTE_MS) {
      lignes.push(`<div><span title="${esc(amisNoteTitre)}">${esc(amisNote)}</span></div>`);
    }

    /*
     * Ce que ça rapporte : les souhaits du volet Échanges détenus par un ami
     * que le panneau a fait venir. Aucune requête : les deux listes sont là.
     */
    const venus = new Set(Object.keys(vus).filter((id) => vus[id] && vus[id].o && vus[id].e === 'ami'));
    if (venus.size && amisBusy !== 'envoi') {
      const n = ((state.troc && state.troc.lignes) || [])
        .filter((l) => (l.ids || []).some((id) => venus.has(id))).length;
      lignes.push(n
        ? `<div><b>${n}</b> de vos souhaits chez les amis ajoutés ici</div>`
        : '<div>Aucun de vos souhaits chez les amis ajoutés ici, pour l’instant</div>');
    }

    if (state.amis.recues) {
      const n = state.amis.recues;
      lignes.push(`<div><a class="lien" href="/friends" data-amis-lien="/friends">${n} demande${n > 1 ? 's' : ''} `
        + `reçue${n > 1 ? 's' : ''}</a> : à accepter sur la page Amis</div>`);
    }
    if (!lignes.length && !(state.classement && state.classement.lignes.length)) {
      lignes.push('<div>Les gros collectionneurs ont le plus de chances d’avoir vos souhaits. '
        + 'Ceux qui acceptent apparaissent dans Échanges.</div>');
    }
    return lignes.join('');
  }

  /*
   * Le bouton vit dans le gabarit : on ne change
   * ici que leurs propriétés, jamais les nœuds. Réécrire le bouton à chaque
   * seconde du compte à rebours avalerait le clic qui veut l'arrêter. La
   * grille, elle, ne se réécrit que lorsqu'un état change : son HTML ne porte
   * pas le compte à rebours, et une infobulle ouverte reste ouverte.
   */
  function renderAmis() {
    if (!ui || !ui.amisGo) return;

    const vus = lireVus();
    if (!vus) {
      // La raison tient en une ligne, et elle vaut mieux qu'une grille fausse.
      paint(ui.amisGrille, '');
      paint(ui.amisEtat, '<div>Mémoire des demandes illisible : rien ne partira tant qu’elle le restera.</div>');
    }
    const t = amisTop(vus || {});
    if (vus) {
      paint(ui.amisGrille, amisGrilleHtml(t));
      paint(ui.amisEtat, amisEtatHtml(vus));
    }

    const c = state.classement;
    const age = c && c.at && c.lignes.length ? fmtAge(c.at) : '';
    if (ui.amisAge.textContent !== age) ui.amisAge.textContent = age;
    ui.amisAge.title = age ? `${ageTitle(c.at)}. Le classement se relit chaque jour.` : '';

    let texte;
    let titre;
    let etat = '';
    let actif = true;
    if (amisBusy === 'envoi' && amisEnvoi) {
      texte = amisStop ? 'Arrêt…' : `Arrêter · ${amisEnvoi.fait} / ${amisEnvoi.total}`;
      titre = 'Arrête après la demande en cours. Celles déjà parties restent parties : '
        + 'elles se retirent sur la page Amis du site.';
      etat = 'stop';
      actif = !amisStop;
    } else if (amisBusy) {
      const p = amisBusy.split(' ')[1];
      texte = p ? `Lecture du classement · ${p}` : 'Lecture…';
      titre = 'Le classement se lit par pages de 25 joueurs.';
      actif = false;
    } else if (amisArme && amisLot) {
      const n = amisLot.length;
      const premier = amisLot[0];
      const dernier = amisLot[n - 1];
      texte = `Envoyer ${n} demande${n > 1 ? 's' : ''} ?`;
      titre = (n > 1
        ? `De ${premier.n} (${rangFr(premier.r)}) à ${dernier.n} (${rangFr(dernier.r)}). `
        : `${premier.n} (${rangFr(premier.r)}). `)
        + 'Vous-même, vos amis, les demandes en attente et les joueurs déjà demandés sont '
        + `écartés. Au rythme d’une personne : environ ${amisDuree(amisEstime(n))}. `
        + 'Recliquez pour confirmer. Le bouton se désarme tout seul en six secondes.';
      etat = 'arme';
    } else if (!vus) {
      texte = 'Ajouter en amis';
      titre = 'La liste des joueurs déjà demandés est illisible. Sans elle, le bouton risquerait '
        + 'de redemander quelqu’un qui a refusé : il reste éteint.';
      actif = false;
    } else {
      /*
       * Le compte vient de la grille, donc du dernier relevé : le premier clic
       * relit tout et annonce le compte exact avant que rien ne parte.
       */
      const n = t.par.vide.length;
      texte = t.top.length && n ? `Ajouter ${n} joueur${n > 1 ? 's' : ''} en amis` : 'Ajouter en amis';
      titre = `Relit le top ${AMIS_PROF} du classement et votre liste d’amis, écarte vos amis et `
        + 'les joueurs déjà demandés, puis annonce le compte. Rien ne part avant votre second clic. '
        + 'Un joueur qui refuse n’est jamais redemandé.';
    }
    const go = ui.amisGo;
    if (go.textContent !== texte) go.textContent = texte;
    go.title = titre;
    go.disabled = !actif;
    go.classList.toggle('arme', etat === 'arme');
    go.classList.toggle('stop', etat === 'stop');
  }

  /*
   * Souhaiter toute une recherche
   * -----------------------------
   * Le site fait de la liste de souhaits un geste à l'unité : ouvrir la fiche
   * d'une carte, cliquer, refermer. Sur « BMW » — 345 cartes — c'est mille
   * gestes, et personne ne les fait. La liste reste donc maigre, et le volet
   * Souhaits, qui croise le marché avec elle, n'a presque rien à croiser.
   *
   * Rien n'oblige pourtant à en faire mille : la recherche s'énumère en sept
   * requêtes, et la table accepte un tableau. Les 345 cartes partent en une
   * écriture, réversible par le même chemin.
   *
   * Ce que le bouton refuse de faire : plus que ce qui est affiché. Il lit la
   * recherche du champ ET les raretés actives dans la barre, parce qu'un
   * bouton qui souhaite 345 cartes alors que l'écran en montre 4 est un piège.
   */
  const WISH_Q_PAGES = 60;      // 3 000 cartes lues au plus — au-delà ce n'est plus une recherche
  const WISH_LOT_ADD = 200;     // lignes par écriture : un corps qui reste petit
  const WISH_LOT_DEL = 100;     // identifiants par suppression : l'URL a une longueur
  const WISH_ARME_MS = ARME_MS;   // même fenêtre que les deux autres boutons à double clic
  const WISH_PAGE_GAP = 120;    // souffle entre deux pages : 60 pages ne partent pas en rafale

  /*
   * Le seul plafond qui veuille dire quelque chose : ce que le volet Souhaits
   * sait surveiller, soit `WISH_MAX_PAGES × 50`. Au-delà, le bouton
   * remplirait une liste dont la fin ne serait plus regardée — et une alerte
   * qu'on croit armée sans qu'elle le soit est pire que pas d'alerte du tout.
   *
   * Le chiffre n'est donc pas rond par goût : il suit le volet. Bouger l'un
   * bouge l'autre, et c'est voulu.
   */
  const WISH_SUIVI_MAX = WISH_MAX_PAGES * 50;

  /*
   * Une lecture courte — deux cartes trouvées en 300 ms — rendrait l'armement
   * illusoire : un double-clic armerait puis exécuterait dans le même geste.
   * Le second clic n'est donc accepté qu'après ce délai, le temps qu'un œil
   * lise le compte annoncé.
   */
  const WISH_ARME_MIN_MS = 500;

  /*
   * Un compte rendu qui explique un refus doit tenir le temps qu'on aille lire
   * son infobulle. Douze secondes s'éteignaient au milieu de la phrase.
   */
  const WISH_NOTE_MS = 20000;

  const RARETES = ['L', 'UR', 'SR', 'R', 'PC', 'C'];

  let wishAllBusy = '';         // '' | 'lecture' | 'ecriture'
  let wishAllArme = 0;          // horodatage de fin d'armement
  let wishAllArmeA = 0;         // horodatage de début : le double-clic ne passe pas
  let wishAllLot = null;        // ce que le second clic exécutera
  let wishAllSens = '';         // sens de l'écriture en cours, pour son libellé
  let wishAllNote = '';         // compte rendu de la dernière opération
  let wishAllNoteTitre = '';    // ce que ce compte rendu mérite comme explication
  let wishAllNoteAt = 0;

  /** Un compte rendu n'a de valeur que s'il dit aussi quoi faire ensuite. */
  function wishDire(note, titre) {
    wishAllNote = note;
    wishAllNoteTitre = titre;
    wishAllNoteAt = Date.now();
  }

  const onGlobal = () => location.pathname.startsWith('/global-collection');

  /*
   * Ce qui est tapé n'est pas ce qui est affiché
   * --------------------------------------------
   * Le champ de la page ne cherche pas en frappant : il faut valider par
   * « Rechercher ». Mesuré — taper n'émet aucune requête, la validation en
   * émet une seule. Un bouton qui se fierait au champ agirait donc sur un mot
   * que l'écran ne montre pas encore : on croit souhaiter ce qu'on voit, on
   * souhaite ce qu'on vient de taper. C'est le piège que tout le reste du
   * bouton cherche à éviter.
   *
   * La seule source qui ne mente pas est la requête elle-même. On l'observe au
   * passage, sans rien changer d'elle — nos propres lectures portent un
   * drapeau pour ne pas s'observer soi-même et se croire affichées.
   */
  let wishVue = { q: '', at: 0 };
  let wishLitPourNous = false;
  let wishProxyOn = false;

  function installWishProxy() {
    if (wishProxyOn) return;
    wishProxyOn = true;
    const passe = window.fetch;
    window.fetch = function (input) {
      try {
        if (!wishLitPourNous) {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (url.includes('/api/cards?')) {
            const p = new URL(url, location.origin).searchParams;
            // La liste de souhaits passe par le même point d'entrée : ce n'est
            // pas une recherche, elle ne dit rien de ce qui est affiché ici.
            if (!p.get('wishlist')) wishVue = { q: (p.get('q') || '').trim(), at: Date.now() };
          }
        }
      } catch (_) {
        /* observer ne doit jamais coûter la requête observée */
      }
      return passe.apply(this, arguments);
    };
  }

  /*
   * L'état de la barre du site, lu dans le DOM parce qu'il ne vit nulle part
   * ailleurs : la recherche ne passe pas par l'URL, et les raretés sont un
   * filtre React. `ring-2` est la marque que le site pose sur un filtre actif,
   * `opacity-50` sur un filtre éteint.
   */
  function wishBarre() {
    const champ = document.querySelector(SEARCH_SELECTOR);
    const row = document.querySelector(FILTER_ROW);
    const actifs = new Set();
    let surSouhaits = false;
    if (row) {
      for (const b of row.children) {
        const t = (b.textContent || '').trim();
        const actif = chipActive(b);
        if (RARETES.includes(t)) { if (actif) actifs.add(t); continue; }
        if (/liste de souhaits/i.test(t) && actif) surSouhaits = true;
      }
    }
    /*
     * `q` est ce que le serveur a renvoyé, donc ce que l'écran montre ; `tape`
     * est ce qui attend dans le champ. Le bouton agit sur le premier et
     * s'éteint quand les deux divergent.
     */
    return {
      q: wishVue.q,
      tape: champ ? champ.value.trim() : '',
      raretes: actifs,
      surSouhaits,
    };
  }

  /*
   * Énumérer une recherche. `total` vaut `null` en recherche — c'est
   * `searchHasMore` qui borne, page après page. Les raretés se filtrent ici
   * plutôt que côté serveur : le filtre du site est multi-sélection, et un
   * seul chemin de lecture vaut mieux que deux qui doivent s'accorder.
   *
   * `ownedCardIds` n'est rendu que pour les cartes de la page : on l'accumule
   * au fil des pages, ce qui le rend exact sur exactement ce qu'on a lu.
   */
  async function lireRecherche(q, raretes, deja, place, dansLaListe) {
    const cartes = [];
    const possedees = new Set();
    let tronque = false;
    let freine = 0;
    let deborde = false;
    let net = 0;   // ce qui serait réellement écrit, compté au fil de la lecture
    wishLitPourNous = true;   // nos pages ne sont pas ce que la page affiche
    try {
      for (let page = 0; page < WISH_Q_PAGES; page++) {
        if (page) await sleep(WISH_PAGE_GAP);
        /*
         * `wishlist=1` se combine avec `q` côté serveur — vérifié. Un retrait
         * lit donc ta liste, pas le catalogue : « Beckham » y rend une carte
         * au lieu de vingt-deux, et deux pages suffisent là où soixante
         * auraient été lues pour n'en garder presque rien.
         */
        const d = await api(
          `/api/cards?page=${page}&q=${encodeURIComponent(q)}${dansLaListe ? '&wishlist=1' : ''}`,
        );
        /*
         * Un serveur qui freine ne dit pas « fin de liste ». Confondre les
         * deux ferait armer sur un lot amputé, en annonçant un compte qui
         * aurait l'air d'être le bon — le pire des deux mondes. On sort en le
         * disant.
         */
        if (d.status === 429 || d.status === 403 || d.retryMs) {
          freine = d.status;
          break;
        }
        const lot = (d.data && d.data.cards) || [];
        if (!lot.length) {
          // Une page vide sur une réponse en erreur n'est pas une fin de liste.
          tronque = d.status !== 200;
          break;
        }
        for (const id of (d.data && d.data.ownedCardIds) || []) possedees.add(id);
        for (const c of lot) {
          if (raretes.size && !raretes.has(c.rarity)) continue;
          cartes.push({ id: c.id, t: c.wikipedia_title || c.title || c.id, r: c.rarity || '?' });
          if (deja && !deja.has(c.id) && !possedees.has(c.id)) net++;
        }
        /*
         * Refuser au bout de soixante pages, c'est faire attendre trente
         * secondes pour dire non. Dès que le net dépasse la place disponible,
         * la suite de la lecture ne peut plus changer la réponse : on sort.
         */
        if (place != null && net > place) {
          deborde = true;
          break;
        }
        if (!d.data.searchHasMore) break;
        if (page === WISH_Q_PAGES - 1) tronque = true;
        wishAllBusy = `lecture ${page + 1}`;
        paintWishAll();
      }
    } finally {
      wishLitPourNous = false;
    }
    return { cartes, possedees, tronque, freine, deborde };
  }

  /** Les `card_id` déjà souhaités, lus dans la table plutôt que dans le cache. */
  async function wishlistIds() {
    const lignes = await sbGet('wishlist_items?select=card_id&limit=5000');
    return Array.isArray(lignes) ? new Set(lignes.map((l) => l.card_id)) : null;
  }

  /*
   * Sans recherche, la cible d'un retrait est la liste entière — mais la barre
   * peut porter des raretés actives, et le bouton ne doit jamais retirer plus
   * que ce qui est affiché. La rareté de chaque souhait vit déjà dans le volet
   * Souhaits ; on s'y adosse plutôt que de relire le catalogue.
   *
   * Une carte que ce volet ne connaît pas est écartée, pas incluse : se
   * tromper en retirant moins se rattrape d'un clic, l'inverse non.
   */
  async function souhaitsParRarete(ids, raretes) {
    if (!raretes.size) return [...ids];
    const wish = await refreshWishlist(false);
    const connues = (wish && wish.cards) || {};
    return [...ids].filter((id) => connues[id] && raretes.has(connues[id].r));
  }

  /*
   * Premier clic : lire et armer. Second clic, dans les six secondes : écrire.
   * Le compte annoncé est le compte NET — ni ce que tu possèdes déjà, ni ce
   * que tu souhaites déjà. Armer sur le brut ferait promettre 345 pour en
   * écrire 30.
   */
  async function wishAllClick() {
    if (wishAllBusy) return;

    if (Date.now() < wishAllArme && wishAllLot) {
      // Un double-clic n'est pas une confirmation : il n'a rien lu.
      if (Date.now() - wishAllArmeA < WISH_ARME_MIN_MS) return;
      const lot = wishAllLot;
      wishAllArme = 0;
      wishAllLot = null;
      await wishAllEcrire(lot);
      return;
    }

    const barre = wishBarre();
    /*
     * Ces deux refus doublent l'extinction du bouton. Un compte rendu encore
     * affiché le laisse cliquable quelques secondes, et c'est précisément
     * l'instant où l'on retape une recherche sans la valider.
     */
    if (barre.tape !== barre.q) return;           // recherche tapée, pas encore cherchée
    if (!barre.q && !barre.surSouhaits) return;   // rien d'affiché à souhaiter

    wishAllBusy = 'lecture';
    wishAllNote = '';
    paintWishAll();
    try {
      const deja = await wishlistIds();
      if (!deja) {
        wishDire(
          prefs.db ? 'base illisible' : 'option décochée',
          prefs.db
            ? 'Ta liste de souhaits n’a pas pu être lue, et sans elle le bouton écrirait en '
              + 'double. Réessayez ; si ça dure, décochez puis recochez « Accès direct à la base ».'
            : 'Cochez « Accès direct à la base » dans les réglages du panneau.',
        );
        return;
      }
      /*
       * La place restante n'est un critère d'arrêt que pour un ajout : un
       * retrait ne remplit rien, il vide.
       */
      const place = WISH_SUIVI_MAX - deja.size;
      const { cartes, possedees, tronque, freine, deborde } = barre.q
        ? await lireRecherche(
          barre.q, barre.raretes, deja, barre.surSouhaits ? null : place, barre.surSouhaits,
        )
        : { cartes: [], possedees: new Set(), tronque: false, freine: 0, deborde: false };

      if (freine) {
        wishDire(
          `serveur freiné · ${freine || 'attente'}`,
          'Le serveur a demandé de lever le pied pendant la lecture. Rien n’a été écrit, et le '
            + 'compte aurait été faux. Laisse passer une minute et reclique.',
        );
        return;
      }

      if (barre.surSouhaits) {
        /*
         * Vue « Liste de souhaits » : le bouton retire au lieu d'ajouter, sur
         * exactement le même critère. Sans recherche, c'est la liste entière —
         * le compte armé le dit, et c'est le seul moyen de la vider.
         */
        const cible = barre.q
          ? cartes.filter((c) => deja.has(c.id)).map((c) => c.id)
          : await souhaitsParRarete(deja, barre.raretes);
        wishAllLot = { sens: 'retirer', ids: cible, tronque };
      } else {
        const neuves = cartes.filter((c) => !deja.has(c.id) && !possedees.has(c.id));
        /*
         * Le plafond ne se rattrape pas en tronquant : garder « les 1 200
         * premières par ordre alphabétique » n'est le choix de personne. On
         * refuse, et on dit combien il reste de place — à toi de resserrer,
         * par une recherche plus étroite ou par une rareté.
         */
        if (deborde || neuves.length > place) {
          const reste = Math.max(0, place);
          wishDire(
            place <= 0 ? 'liste pleine'
              : deborde ? 'recherche trop large'
                : `${neuves.length - place} de trop`,
            `Le volet Souhaits ne surveille que ${WISH_SUIVI_MAX} cartes : au-delà, vous rempliriez `
              + 'une liste dont la fin ne serait plus regardée, ce qui est pire que de ne rien '
              + `ajouter. Tu en souhaites déjà ${deja.size}, il reste donc ${reste} places, et `
              + (deborde
                ? 'cette recherche en demande davantage — la lecture s’est arrêtée dès qu’elle '
                  + 'a débordé, rien n’a été écrit. '
                : `celle-ci en demande ${neuves.length}. `)
              + 'Resserre la recherche, ou coche une rareté.',
          );
          wishAllLot = null;
          return;
        }
        wishAllLot = { sens: 'ajouter', ids: neuves.map((c) => c.id), tronque };
      }

      if (!wishAllLot.ids.length) {
        wishDire(
          barre.surSouhaits ? 'rien à retirer' : 'rien de neuf',
          barre.surSouhaits
            ? 'Aucune carte de cette vue n’est dans votre liste de souhaits.'
            : 'Tout ce que cette recherche renvoie est déjà souhaité, ou déjà dans votre collection.',
        );
        wishAllLot = null;
        return;
      }
      wishAllArmeA = Date.now();
      wishAllArme = Date.now() + WISH_ARME_MS;
      setTimeout(() => {
        if (Date.now() < wishAllArme) return;
        wishAllArme = 0;
        wishAllLot = null;
        paintWishAll();
      }, WISH_ARME_MS + 100);
    } finally {
      wishAllBusy = '';
      paintWishAll();
    }
  }

  async function wishAllEcrire(lot) {
    const uid = sbUserId();
    if (!uid) {
      wishDire(
        'session illisible',
        'Votre session n’a pas pu être lue dans cet onglet. Rechargez la page ; si ça persiste, '
          + 'reconnectez-vous au site.',
      );
      paintWishAll();
      return;
    }
    wishAllBusy = 'ecriture';
    wishAllSens = lot.sens;
    paintWishAll();

    let faits = 0;
    let echec = null;
    try {
      if (lot.sens === 'ajouter') {
        for (let i = 0; i < lot.ids.length; i += WISH_LOT_ADD) {
          const tranche = lot.ids.slice(i, i + WISH_LOT_ADD)
            .map((card_id) => ({ user_id: uid, card_id }));
          const r = await sbWrite('POST', 'wishlist_items', tranche);
          if (!r.ok) { echec = r; break; }
          faits += tranche.length;
        }
      } else {
        for (let i = 0; i < lot.ids.length; i += WISH_LOT_DEL) {
          const tranche = lot.ids.slice(i, i + WISH_LOT_DEL);
          const filtre = `user_id=eq.${uid}&card_id=in.(${tranche.join(',')})`;
          const r = await sbWrite('DELETE', `wishlist_items?${filtre}`);
          if (!r.ok) { echec = r; break; }
          faits += tranche.length;
        }
      }
    } finally {
      wishAllBusy = '';
      /*
       * Le volet Souhaits lit une liste mise en cache un quart d'heure : sans
       * cette péremption, il surveillerait l'ancienne pendant tout ce temps,
       * c'est-à-dire précisément quand la nouvelle vient d'être posée.
       */
      state.wish.at = 0;
      refreshWishlist(true).catch(() => {});
      // Le code de retour du serveur ne dit rien à qui joue : il va en console,
      // avec de quoi retrouver l'écriture qui a échoué.
      if (echec) {
        console.warn('[WikiMasters Tools] écriture des souhaits interrompue',
          { faits, total: lot.ids.length, statut: echec.status || null, raison: echec.raison || null });
      }
      wishDire(
        echec
          ? `${faits} sur ${lot.ids.length} — interrompu`
          : `${faits} ${lot.sens === 'ajouter' ? 'ajoutées' : 'retirées'}`,
        echec
          ? `L’écriture s’est arrêtée en chemin : ${faits} cartes sont bien passées, le reste non. `
            + 'Recliquer reprend là où ça s’est arrêté — ce qui est déjà écrit est écarté du '
            + 'compte suivant.'
          : 'Le site ne redessine pas ses cœurs tout seul — actualisez la page pour les voir. '
            + 'Le volet Souhaits, lui, est déjà à jour.',
      );
      paintWishAll();
    }
  }

  function injectWishAll() {
    if (!onGlobal()) return;
    installWishProxy();
    const row = vu(NOM_FILTRES, FILTER_ROW);
    if (!row) return;

    let btn = row.querySelector('[data-wm-wish-all]');
    if (!btn) {
      btn = document.createElement('button');
      btn.dataset.wmWishAll = '1';
      // Mêmes classes que les filtres du site : la géométrie reste la sienne.
      btn.className = 'px-3 py-1 rounded-full text-xs font-semibold transition-all cursor-pointer';
      btn.addEventListener('click', wishAllClick);
      row.appendChild(btn);
    }
    paintWishAll(btn);
  }

  function paintWishAll(btn) {
    const b = btn || document.querySelector('[data-wm-wish-all]');
    if (!b) return;

    const barre = wishBarre();
    const retire = barre.surSouhaits;
    let texte;
    let titre;
    let actif = true;

    /*
     * Un lot armé porte son sens avec lui. Si la vue change entre les deux
     * clics — la bascule « Liste de souhaits » est à deux pastilles de là —
     * le lot ne correspond plus à ce que l'écran montre : on désarme plutôt
     * que d'exécuter sur un critère que l'utilisateur ne voit plus.
     */
    if (wishAllArme && wishAllLot && wishAllLot.sens !== (retire ? 'retirer' : 'ajouter')) {
      wishAllArme = 0;
      wishAllLot = null;
    }

    if (wishAllBusy.startsWith('lecture')) {
      const p = wishAllBusy.split(' ')[1];
      texte = `Lecture${p ? ` · ${p} pages` : '…'}`;
      titre = 'Énumération de la recherche — 50 cartes par page';
      actif = false;
    } else if (wishAllBusy === 'ecriture') {
      texte = wishAllSens === 'retirer' ? 'Retrait…' : 'Écriture…';
      titre = 'Envoi à la liste de souhaits';
      actif = false;
    } else if (wishAllArme && wishAllLot) {
      const n = wishAllLot.ids.length;
      texte = wishAllLot.sens === 'retirer' ? `Retirer ${n} ?` : `Souhaiter ${n} ?`;
      titre = wishAllLot.tronque
        ? `Recherche trop large : lecture arrêtée à ${WISH_Q_PAGES} pages, ces ${n} cartes n’en `
          + 'sont qu’une partie. Recliquez pour confirmer.'
        : 'Recliquez pour confirmer. Le bouton se désarme tout seul en six secondes.';
    } else if (wishAllNote && Date.now() - wishAllNoteAt < WISH_NOTE_MS) {
      texte = wishAllNote;
      titre = wishAllNoteTitre;
    } else if (!prefs.db) {
      texte = retire ? 'Tout retirer' : 'Tout souhaiter';
      titre = 'Le site ne publie aucune route d’API pour la liste de souhaits : son propre client '
        + 'écrit dans la base. Cochez « Accès direct à la base » dans les réglages du panneau '
        + 'pour que ce bouton puisse en faire autant.';
      actif = false;
    } else if (barre.tape !== barre.q) {
      /*
       * Divergence entre le champ et l'écran : le site n'a pas encore cherché
       * ce qui est tapé. Agir maintenant porterait sur autre chose que ce qui
       * est montré — précisément l'erreur que le bouton doit rendre
       * impossible.
       */
      texte = 'Valide la recherche';
      titre = `Le champ dit « ${barre.tape || '(vide)'} », l’écran montre `
        + `${barre.q ? `« ${barre.q} »` : 'le catalogue'}. Cliquez « Rechercher » — le bouton `
        + 'agit sur ce qui est affiché, jamais sur ce qui est seulement tapé.';
      actif = false;
    } else if (retire) {
      texte = 'Tout retirer';
      titre = barre.q
        ? `Retirer de vos souhaits les cartes de la recherche « ${barre.q} »`
          + (barre.raretes.size ? `, raretés ${[...barre.raretes].join(' ')}` : '')
        : 'Vider la liste de souhaits entière. Le compte s’affiche avant, et il faut recliquer.';
    } else if (!barre.q) {
      texte = 'Tout souhaiter';
      titre = 'Cherche quelque chose d’abord — « BMW », « Peugeot », un réalisateur. Le bouton '
        + 'souhaite ce que la recherche affiche, jamais le catalogue.';
      actif = false;
    } else {
      texte = 'Tout souhaiter';
      titre = `Mettre en souhait les cartes de « ${barre.q} »`
        + (barre.raretes.size ? `, raretés ${[...barre.raretes].join(' ')}` : '')
        + '. Les cartes que vous possédez ou souhaitez déjà sont écartées, et le compte exact '
        + 's’affiche avant toute écriture.';
    }

    b.textContent = texte;
    b.title = titre;
    b.disabled = !actif;
    b.style.cssText = !actif
      ? 'color:#626B7A;background:transparent;opacity:.35;cursor:default'
      : wishAllArme
        ? 'background:#F5A524;color:#1A1206'
        : `background:${NEW_TAG_COLOR}30;color:${NEW_TAG_COLOR}`;
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
          // L'identifiant de la carte, pour retrouver sa cote : sans lui, le
          // volet affichait un prix sans jamais dire s'il était bon.
          id: x.card_id,
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
    /*
     * Horodaté et borné, comme le registre des souhaits de guilde. Il ne
     * portait qu'un `1`, donc rien ne permettait de le purger : une entrée par
     * annonce croisée, ~400 par balayage, toutes les 100 s, mémorisées à vie.
     * Un stockage saturé fait échouer TOUS les `saveStore` — donc aussi les
     * stats, le journal des ventes et le suivi des relances, sans un mot.
     */
    for (const h of trouvees) state.wishSeen[h.auction] = Date.now();
    state.wishSeen = bornerVus(state.wishSeen, WISH_SEEN_MAX);

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
  /*
   * Le verdict sur un prix demandé, quand la cote le permet.
   *
   * Le volet listait des prix allant de 12 à 22 000 wb sans jamais dire s'ils
   * étaient bons — alors que la Revente tient la cote de plusieurs milliers de
   * cartes dans le même navigateur. C'est pourtant la seule question qu'on se
   * pose devant une carte qu'on veut : est-ce que je mise ?
   *
   * On ne tranche que sur une cote solide, au même seuil que le reste : sous
   * cinq ventes, il n'y a rien à comparer et la ligne reste neutre.
   */
  function coteSouhait(x) {
    const r = (sell.rows || []).find((l) => (x.id && l.id === x.id) || l.t === x.title);
    if (!r || r.seule || r.n < THIN_SALES) return null;
    const cls = x.bid <= r.med ? 'bon' : x.bid >= (r.q3 || r.med) ? 'cher' : '';
    const verdict = cls === 'bon' ? 'sous la médiane'
      : cls === 'cher' ? 'au-dessus du prix visé' : 'dans la fourchette';
    return {
      cls,
      fleche: cls === 'bon' ? '↓' : cls === 'cher' ? '↑' : '·',
      titre: `Cote sur ${r.n} ventes — médiane ${fmtWb(r.med)} wb, prix visé `
        + `${fmtWb(r.q3 || r.med)} wb. La demande actuelle est ${verdict}.`,
    };
  }

  function wishRows(list) {
    return list
      .map((x) => ({ x, ms: leftNow(x) }))
      .sort((a, b) => (a.ms == null ? Infinity : a.ms) - (b.ms == null ? Infinity : b.ms))
      .map(({ x, ms }) => {
        const fini = ms != null && ms <= 0;
        const cls = [fini ? 'done' : ms != null && ms <= MKT_SOON_MS ? 'soon' : ''].filter(Boolean).join(' ');
        const c = coteSouhait(x);
        return `<li class="${cls}" data-auction="${esc(x.auction)}" ${LIGNE_ACTIVE}
            title="${esc(x.title)} — ouvrir la page de l'enchère${c ? `\n${esc(c.titre)}` : ''}"
            style="--c:${RARITY_COLOR[x.rarity] || '#8C8275'}">
          <span class="dot"></span>
          <span class="t">${esc(x.title)}</span>
          ${x.bids ? '<span class="tag">offre</span>' : ''}
          <span class="v${c ? ` ${c.cls}` : ''}">${c ? `${c.fleche} ` : ''}${fmtWb(x.bid)} wb</span>
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
        (c.n ? `<i class="cnt${c.hot ? ' hot' : ''}${c.pale ? ' pale' : ''}">${c.n}</i>` : '') +
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
    // Seul l'interrupteur du volet ouvert reste à l'écran — voir `data-mopt`.
    for (const l of ui.panel.querySelectorAll('[data-mopt]')) {
      l.hidden = !l.dataset.mopt.split(' ').includes(sub);
    }
    const bids = stillRunning(state.bids.list);
    /*
     * Les ventes ne disparaissent PAS à la seconde où leur compte atteint zéro.
     *
     * La pastille du volet répète `sellingCount`, l'instantané du serveur, qui
     * ne vieillit pas entre deux relevés. La liste, elle, était passée à
     * `stillRunning`, qui retire une ligne dès que son échéance est franchie —
     * seconde par seconde, dans le navigateur. Deux vues du MÊME relevé, dont
     * une seule vieillissait : l'écart se creusait en continu, et on lisait
     * « Ventes 5 » au-dessus de trois lignes.
     *
     * Une enchère close n'a d'ailleurs pas disparu : elle attend que le serveur
     * la tranche, et elle occupe encore son emplacement — c'est bien pourquoi
     * le serveur la compte. On la garde donc à l'écran le temps qu'il s'est
     * donné pour trancher, `SETTLE_MS`, et le rendu la grise : la classe
     * « done » et son point éteint existaient déjà pour ce cas, sans que rien
     * ne puisse jamais les atteindre.
     */
    const sales = (state.sales.list || []).filter(
      (x) => x.end == null || x.end > Date.now() - SETTLE_MS);
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
    /*
     * Surveillance décochée : les deux premiers compteurs ne comptent plus
     * rien. Ils étaient peints ici, AVANT le retour anticipé qui remplace le
     * volet par « Surveillance désactivée » — on lisait donc « Enchères 3 »
     * au-dessus d'un panneau qui annonce ne rien suivre, et « 1 surenchérie »
     * en ambre pour une enchère que plus personne ne relève. Un badge
     * d'alerte sur un guetteur à l'arrêt est pire qu'un badge absent : il
     * promet une veille qui n'a pas lieu.
     *
     * Le dernier relevé reste affiché — c'est une information, et l'effacer
     * ferait croire à zéro enchère — mais en sourdine, et sans jamais passer
     * en ambre. L'infobulle dit pourquoi.
     */
    const veille = prefs.watchBids;
    const perime = veille ? '' : '\nSurveillance décochée : dernier relevé connu, il ne se met plus à jour.';
    renderSubs({
      ench: { n: bids.length, hot: veille && perdues > 0, pale: !veille,
              title: (perdues ? `${perdues} enchère(s) surenchérie(s)` : 'Tes mises en cours') + perime },
      vent: { n: occupes, hot: veille && !libres, pale: !veille,
              title: `${occupes} vente(s) sur ${max} emplacements` + perime },
      rel: { n: suivies, hot: pausees > 0,
             title: pausees ? `${pausees} carte(s) en pause` : 'Cartes remises en vente automatiquement' },
      souh: { n: souhaits.length, hot: souhaits.length > 0,
              title: (souhaits.length
                ? `${souhaits.length} carte(s) de votre liste de souhaits en vente`
                : 'Cartes de votre liste de souhaits actuellement aux enchères')
                + '\n↓ le prix demandé est sous la médiane de sa cote · ↑ il dépasse son prix visé' },
    });

    /*
     * La Revente ne dépend d'aucun volet, ni de la surveillance : elle lit ta
     * collection et le marché des cartes, rien d'autre. Elle n'apparaissait
     * pourtant que dans « Ventes », et disparaissait donc des trois quarts de
     * l'onglet — ainsi que de tout l'onglet quand la surveillance est décochée,
     * alors qu'elle n'a rien à voir avec elle. C'est une des trois grandes
     * fonctions de l'outil : elle reste sous les yeux tant qu'on est au Marché.
     */
    ui.revente.hidden = false;

    // Les deux volets de relevé n'ont de sens que si le guetteur tourne.
    if (!prefs.watchBids && sub !== 'rel' && sub !== 'souh') {
      ui.relist.hidden = true;
      paint(ui.market,
        `<div class="mkoff"><b>Surveillance désactivée.</b> Cochez ` +
        `« Surveillance » en bas de cet onglet pour suivre ici vos mises, ` +
        `vos ventes en cours et leurs échéances.</div>`);
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
        `pour vous si vous y êtes.</div>`);

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
          `cote de vos cartes et pré-remplit le prix de vente.</div>`);

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
      ? `<div class="mkoff"><b>Souhaits non surveillés.</b> Cochez « Souhaits » en ` +
        `bas de cet onglet : le panneau signalera les cartes de votre liste de ` +
        `souhaits mises aux enchères.</div>`
      : mktHead(souhaits.length
          ? `<span class="n">${souhaits.length}</span> en vente sur ${nbSouh} souhaitée${nbSouh > 1 ? 's' : ''}`
          : `aucun souhait en vente · ${nbSouh} carte${nbSouh > 1 ? 's' : ''} suivie${nbSouh > 1 ? 's' : ''}`,
          state.wishHits.at) +
        (souhaits.length
          ? `<ul>${wishRows(souhaits)}</ul>`
          : `<div class="none">Rien de votre liste de souhaits aux enchères en ce ` +
            `moment. Le marché récent est relu toutes les 100 s ; ajoute des ` +
            `cartes depuis <em>Toutes les cartes</em> sur le site.</div>`);

    ui.relist.hidden = sub !== 'rel';
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

    /*
     * La ligne qui propose un prix plus bas — et ne l'applique pas.
     *
     * Elle dit ce qu'on constate (n invendus au même prix), ce sur quoi repose
     * le conseil (la médiane, et sur combien de ventes), et le prix proposé.
     * Le bouton est le seul chemin : sans clic, la carte repart à SON prix.
     */
    const suggestion = (card, w) => {
      const propose = prixSuggere(card, w.title, w.price, w.invendus || 0);
      if (propose == null || propose >= w.price) return '';
      const cote = (sell.rows || []).find((r) => r.id === card || r.t === w.title);
      return `<span class="baisse">
        invendue ${w.invendus} fois à ${w.price} wb
        <button data-baisser="${esc(card)}" data-prix="${propose}"
          title="Les prochaines annonces partiront à ${propose} wb au lieu de ${w.price} wb. Calculé sur ${cote.n} ventes réelles, dont la médiane est ${cote.med} wb — la suggestion ne descend jamais en dessous. Rien ne change tant que vous ne cliquez pas.">passer à ${propose} wb</button>
      </span>`;
    };

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
        (w.invendus ? ` · invendue ${w.invendus} fois` : '') +
        (w.paused ? ` · en pause après ${w.fails} tentatives` : '');
      /*
       * Pour une carte en vente, le compte à rebours REMPLACE les mots.
       *
       * La ligne portait « en vente » ET l'échéance dans deux colonnes
       * voisines — deux façons de dire la même chose. Et la seconde était
       * masquée sous 310 px, c'est-à-dire à la largeur par défaut du panneau :
       * le compteur existait et ne se voyait jamais. Il avait été retiré parce
       * que les colonnes de précision mangeaient le titre, à l'époque où la
       * ligne portait aussi le nombre d'échecs.
       *
       * Le point vert dit déjà « en vente ». Les mots partent, le compteur
       * prend leur place, et la ligne ne s'élargit pas d'un pixel.
       */
      const enCompte = enLigne && info;
      return `<li class="${cls}" title="${esc(infobulle)}">
        <span class="dot"></span>
        <span class="t">${esc(w.title)}</span>
        <span class="p">${w.price} wb</span>
        <span class="st">${enCompte ? info : etat}</span>
        <span class="w">${enCompte ? '' : info}</span>
        ${w.paused
          ? `<button class="x" data-retry="${esc(card)}" title="Reprendre le suivi : remet le compteur d'échecs à zéro">↻</button>`
          : ''}
        <button class="x" data-edit="${esc(card)}" aria-expanded="${fileEdit === card}"
          title="Modifier le prix, la durée et le compte d'invendus de cette carte">✎</button>
        <button class="x" data-unwatch="${esc(card)}" title="Ne plus suivre cette carte">✕</button>
        ${suggestion(card, w)}
        ${fileEdit === card ? editFile(card, w) : ''}
      </li>`;
    });

    const actions =
      (aInscrire ? `<button data-watch-all>+ Suivre mes ${aInscrire} vente${aInscrire > 1 ? 's' : ''}</button>` : '') +
      (suivies.length ? `<button data-unwatch-all>Tout arrêter</button>` : '');

    /*
     * Combien de ventes le geste toucherait vraiment. Celles qui portent une
     * mise n'en sont pas : le serveur refuse de les annuler, et c'est juste —
     * on ne retire pas sa carte à quelqu'un qui s'est engagé. Les annoncer
     * dans le compte promettrait ce qui n'arrivera pas.
     */
    const ventesAnnulables = frais
      ? ventes.filter((v) => v.card && v.auction && !v.offered).length
      : 0;

    /*
     * Une ligne de journal montrait un titre, un prix et un âge — jamais ce qui
     * était arrivé à la carte, et le motif d'un refus restait dans l'infobulle,
     * là où personne ne va le chercher. Les deux sont maintenant écrits.
     */
    const VERBES = { ok: 'remise en vente', refus: 'refusée', stop: 'retirée', baisse: 'prix baissé' };
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
        ${(e.issue === 'refus' || e.issue === 'baisse') && e.motif
          ? `<span class="why">${esc(e.motif)}</span>` : ''}
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
      /*
       * Repasser toutes les ventes à une autre durée.
       *
       * Sept boutons plutôt qu'une liste déroulante : ce sont les sept mêmes
       * que le formulaire du site, dans le même ordre — on choisit ici ce
       * qu'on choisirait là-bas, sans avoir à traduire.
       *
       * Deux temps, comme « Réinitialiser » : une annulation est définitive
       * pour l'enchère en cours, et sept cibles serrées côte à côte se cliquent
       * de travers. Le premier clic arme et annonce ce qui va arriver, le
       * second agit — et l'armement retombe seul.
       */
      (ventesAnnulables
        ? `<div class="duree"><span>${repasseArme
            ? `Repasser ${ventesAnnulables} vente${ventesAnnulables > 1 ? 's' : ''} en`
            : 'Tout repasser en'}</span>` +
          DUREES.map((d) => `<button data-duree="${d.minutes}"${
            repasseArme === d.minutes ? ' class="arme"' : ''}>${
            repasseArme === d.minutes ? '✓ ' : ''}${d.label}</button>`).join('') +
          '</div>'
        : '') +
      (lignes.length
        ? `<ul class="suivi">${lignes.join('')}</ul>`
        : `<div class="empty">Aucune carte suivie. ${prefs.relistUnsold
            ? `Une vente qui se termine sans acheteur s'inscrit toute seule.`
            : `Cochez « Relances auto » en bas pour que les ventes sans acheteur s'inscrivent seules.`}</div>`) +
      (journal.length
        ? `<button class="jtoggle" data-journal-toggle aria-expanded="${!!prefs.relistLogOuvert}">`
          + `<i>${prefs.relistLogOuvert ? '▾' : '▸'}</i>Journal<span>${log.length}</span></button>`
          + (prefs.relistLogOuvert ? `<ul>${journal.join('')}</ul>` : '')
        : ''));
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
  const owned = { map: new Map(), tagged: new Set(), copies: new Map(), at: 0, tried: 0,
                  tronque: false, repetitions: 0 };

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
    /*
     * COMBIEN d'exemplaires, et pas seulement lesquels.
     *
     * C'est la seule chose qui autorise à mettre en vente une carte gardée :
     * si vous en avez plusieurs, en vendre une ne vous en prive pas. Sur un
     * exemplaire unique, l'étiquette garde son dernier mot — et l'index doit
     * donc savoir compter, pas seulement reconnaître.
     */
    const combien = new Map();
    /*
     * ON COMPTE DES EXEMPLAIRES, PAS DES LIGNES REÇUES.
     *
     * La pagination du site n'est pas stable : mesuré en lecture seule sur un
     * balayage de cent vingt pages, une ligne est revenue deux fois — donc une
     * autre a été sautée. C'est rare et ça ne se reproduit pas à volonté, mais
     * compter les lignes reviendrait à croire qu'on possède deux exemplaires
     * d'une carte qu'on n'a qu'une fois.
     *
     * Ce n'est pas une inexactitude d'affichage : c'est exactement la
     * condition qui autorise « Vendre un double » à publier. Un double
     * imaginaire ferait vendre le dernier exemplaire d'une carte gardée.
     * L'identifiant d'exemplaire tranche, lui, et le serveur le donne.
     */
    const exemplairesVus = new Set();
    let repetitions = 0;
    // Les cartes dont on a vu au moins un exemplaire LIBRE : voir la boucle.
    const libres = new Set();
    let complet = true;
    let fini = false;
    for (let base = 0; base < 80 && !fini; base += 8) {
      const lot = await Promise.all(
        Array.from({ length: 8 }, (_, k) =>
          fetchBorne(`/api/my-collection?page=${base + k}`, { credentials: 'same-origin' })
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
          if (c.id) {
            if (exemplairesVus.has(c.id)) { repetitions += 1; continue; }
            exemplairesVus.add(c.id);
          }
          combien.set(c.card_id, (combien.get(c.card_id) || 0) + 1);
          /*
           * UN EXEMPLAIRE VENDABLE, pas le dernier venu.
           *
           * L'étiquette et le favori vivent sur l'EXEMPLAIRE — c'est le jeu qui
           * les y range, `user_cards` porte `starred` et ses tags ligne par
           * ligne. Ici on écrasait la distinction : le dernier exemplaire
           * rencontré gagnait la place dans l'index, et une seule ligne
           * étiquetée suffisait à marquer toute la carte comme protégée.
           *
           * Signalé à l'usage, et le cas est exactement celui-là : une
           * Légendaire en double, l'originale gardée sous étiquette, le double
           * qu'on veut vendre. Le double héritait de la protection de sa
           * jumelle et ne repartait jamais — sans un mot, puisque « protégée »
           * est un état normal.
           *
           * On retient donc en priorité un exemplaire LIBRE, et la carte n'est
           * déclarée protégée que si TOUS le sont. C'est ce que « protégée »
           * a toujours voulu dire : je garde cette carte — pas « je garde
           * l'une de ces deux, devinez laquelle ».
           */
          const protege = !!(c.tags || []).length || !!c.starred;
          if (!protege) {
            // Un exemplaire LIBRE : c'est celui-là qu'on retient pour vendre,
            // et la carte cesse d'être protégée, quel que soit l'ordre des
            // pages — un exemplaire protégé croisé plus tard ne la reprotège
            // pas.
            if (c.id) m.set(c.card_id, c.id);
            libres.add(c.card_id);
            etiquetees.delete(c.card_id);
          } else if (!libres.has(c.card_id)) {
            // Protégé, et rien de libre vu jusqu'ici : il sert de repli pour
            // l'index, et la carte reste protégée tant qu'aucun libre ne
            // paraît.
            if (c.id) m.set(c.card_id, c.id);
            etiquetees.add(c.card_id);
          }
        }
        if (col.length < 50) fini = true;
      }
    }
    /*
     * La TRONCATURE, dite pour ce qu'elle est.
     *
     * `complet` ne comptait que les requêtes en échec. Un balayage qui s'arrête
     * parce qu'il a atteint la borne des quatre-vingts pages — toutes pleines,
     * aucune en erreur — se déclarait donc complet, et l'index tronqué
     * s'installait comme faisant autorité. C'est ce qui faisait passer une
     * carte au-delà de la 4 000ᵉ pour une carte disparue.
     *
     * On ne relève pas la borne — cinq cents requêtes toutes les cinq minutes
     * ne se justifient pas quand le serveur sait filtrer par titre. On retient
     * le fait, et `reconcileWatch` demande la carte au serveur plutôt que de
     * conclure de son absence ici.
     */
    owned.tronque = !fini;
    /*
     * Une ligne revue, c'est une ligne sautée ailleurs : le balayage n'a pas vu
     * toute la collection, même s'il est allé au bout. On le retient pour le
     * diagnostic — et `reconcileWatch` ne conclut de toute façon jamais d'une
     * absence sans avoir demandé la carte par son titre.
     */
    owned.repetitions = repetitions;
    if (repetitions) {
      noterFait('relances', 'note',
        `la collection a rendu ${repetitions} ligne(s) en double : autant de sautées`);
    }

    if (complet && m.size) {
      owned.map = m;
      owned.tagged = etiquetees;
      owned.copies = combien;
      owned.at = Date.now();
      return m;
    }
    /*
     * Balayage incomplet : on ne le mémorise pas, et on complète avec l'ancien.
     * Les étiquettes, elles, s'ajoutent sans jamais se retirer sur un relevé
     * partiel — une page manquante ne doit pas déprotéger une carte.
     */
    for (const c of etiquetees) owned.tagged.add(c);
    /*
     * Le compte des exemplaires ne se fusionne PAS : sur un relevé partiel il
     * serait trop bas, et un compte trop bas se lit « exemplaire unique »,
     * c'est-à-dire le cas où l'on refuse de vendre. On garde l'ancien, qui
     * vient d'un balayage complet.
     */
    return new Map([...owned.map, ...m]);
  }

  /**
   * Tout repasser à une autre durée.
   *
   * Le geste du soir : la journée on vend en dix minutes, le soir on veut la
   * même chose en une heure. À la main, c'est ouvrir chaque enchère, cliquer
   * « Annuler et récupérer ma carte », rouvrir la fiche, relancer, choisir la
   * durée — pour chacune.
   *
   * Ce qu'on NE fait pas ici : republier. Annuler suffit, parce que la boucle
   * de relance sait déjà tout le reste — retrouver l'exemplaire possédé,
   * compter les emplacements, écarter les cartes étiquetées, réessayer quand le
   * serveur tarde à rendre la carte, journaliser l'issue. Écrire un second
   * chemin de publication à côté du premier, c'était deux fois les mêmes
   * garde-fous et une occasion de les désaccorder. On pose la durée sur le
   * suivi, on annule, et la machine existante fait le travail à la durée neuve.
   *
   * D'où la condition d'entrée : sans « Relances auto », rien ne republierait
   * et les cartes resteraient en collection. On refuse plutôt que de laisser
   * quelqu'un vider ses ventes sans retour.
   */
  async function repasserToutEn(minutes) {
    if (!prefs.relistUnsold) {
      return { refus: 'Cochez « Relances auto » d’abord : sans elle, rien ne remettrait vos cartes en vente.' };
    }
    const frais = Date.now() - state.sales.at < 120000;
    const ventes = (state.sales.list || []).filter((v) => v.card && v.auction);
    if (!frais || !ventes.length) {
      return { refus: 'Aucune vente en cours connue — attendez le prochain relevé du Marché.' };
    }

    let annulees = 0;
    let misees = 0;
    let refusees = 0;

    for (const v of ventes) {
      // La durée est posée AVANT l'annulation : si le tour de relance passe
      // entre les deux, il republie déjà à la bonne durée.
      const w = state.watch[v.card];
      if (w) w.minutes = minutes;
      else enrolWatch(v.card, v.title, v.price, minutes, 0);

      /*
       * Une mise déjà posée interdit l'annulation, côté serveur. On ne tente
       * même pas : la requête serait refusée, et surtout la carte appartient
       * moralement à l'enchère en cours. Elle repartira à la durée neuve quand
       * celle-ci se terminera sans acheteur.
       */
      if (v.offered) { misees += 1; continue; }

      const r = await annulerVente(v.auction);
      if (r.ok) {
        annulees += 1;
        state.slots.used = Math.max(0, state.slots.used - 1);
        delete state.lastListing[v.card];
        if (state.watch[v.card]) state.watch[v.card].auction = null;
        logRelist(v.title, 'stop', v.price, `annulée pour repasser en ${fmtDuree(minutes)}`);
      } else {
        refusees += 1;
        logRelist(v.title, 'refus', v.price,
          r.status === 0 ? 'réseau' : `le serveur a refusé l’annulation (${r.status})`);
      }
      /*
       * Les annulations suivent le rythme du MARCHÉ, pas celui des paquets.
       * `state.delayMs` est calé sur `/api/packs/open` et n'a rien à dire ici :
       * une annulation frappe la même API que les mises en vente, donc le même
       * intervalle — 7 à 12 s, tiré au hasard comme elles.
       */
      const [bas, haut] = CFG.relistGapMs;
      await sleep(bas + Math.random() * (haut - bas));
    }

    saveStore({ watch: state.watch, relistLog: state.relistLog, lastListing: state.lastListing });
    // Le prochain tour republie : on ne le fait pas attendre son repos.
    state.nextRelistAt = 0;
    reconcileWatch();
    return { annulees, misees, refusees, minutes };
  }

  /** « 90 » → « 1 h 30 ». Pour dire une durée d'annonce à l'écran. */
  function fmtDuree(min) {
    const t = DUREES.find((d) => d.minutes === min);
    if (t) return t.label;
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60}` : ''}`;
  }

  /*
   * La durée actuellement ARMÉE, et sa minuterie de désarmement. Elles vivent
   * ici et non dans `state` : un armement ne survit pas à un rechargement de
   * page, et l'écrire dans le stockage ferait repartir la Revente avec un
   * geste destructeur à moitié engagé.
   */
  let repasseArme = 0;
  let repasseTimer = 0;

  /*
   * La carte dont on modifie les conditions, une seule à la fois.
   *
   * Le volet montrait une file qu'on ne pouvait que créer et vider : le prix
   * ne se changeait qu'en suivant une suggestion de baisse — laquelle
   * n'apparaît qu'après deux invendus au même prix, et jamais à la hausse — et
   * la durée qu'en masse, pour toutes les cartes d'un coup.
   *
   * L'édition est repliée par défaut : la ligne porte déjà titre, prix,
   * compteur et deux boutons dans 260 px. Elle s'ouvre sous sa carte, comme la
   * suggestion de baisse juste au-dessus, et une seule à la fois — deux
   * formulaires ouverts dans une liste, on ne sait plus lequel on remplit.
   */
  let fileEdit = null;

  /**
   * Réveiller les cartes en pause parce que plus rien n'attend.
   *
   * Appelé seulement quand il n'y a rien à replacer ET des emplacements
   * libres — voir `IDLE_WAKE_MS` pour le pourquoi et les deux freins.
   *
   * @returns {number} cartes réveillées, 0 si le frein a joué.
   */
  function reveillerAuRepos(ids) {
    if (Date.now() - (state.idleWokeAt || 0) < IDLE_WAKE_MS) return 0;
    let n = 0;
    for (const c of ids) {
      const w = state.watch[c];
      if (!w || !w.paused) continue;
      if ((w.reveils || 0) >= IDLE_WAKE_MAX) continue;
      w.paused = false;
      w.fails = 0;
      w.refus = 0;
      w.reveils = (w.reveils || 0) + 1;
      n += 1;
    }
    if (n) {
      state.idleWokeAt = Date.now();
      saveStore({ watch: state.watch });
    }
    return n;
  }

  /** Les conditions d'une carte de la file : prix, durée, invendus. */
  function editFile(card, w) {
    const dur = DUREES.map((d) => `<button data-fdur="${esc(card)}" data-min="${d.minutes}"`
      + `${(w.minutes || 10) === d.minutes ? ' class="on"' : ''}>${d.label}</button>`).join('');
    return `<span class="fedit">
      <label>Prix <input type="number" min="1" step="1" value="${w.price}"
        data-fprix="${esc(card)}" title="Le prix des prochaines annonces de cette carte. Celle qui court, s’il y en a une, garde le sien."></label>
      <span class="durs">${dur}</span>
      ${w.invendus
        ? `<button class="raz" data-fraz="${esc(card)}"
             title="Le compte d’invendus déclenche la suggestion de baisse. Le remettre à zéro efface cet historique, sans toucher au prix.">${
             w.invendus} invendu${w.invendus > 1 ? 's' : ''} · remettre à zéro</button>`
        : '<span class="none">aucun invendu</span>'}
    </span>`;
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
  const WATCH_FAILS = 20;   // absences de la collection avant mise en pause d'une carte
  /*
   * Refus du serveur avant mise en pause. Quatre, et pas vingt comme les
   * absences : une absence est une lenteur — le serveur rend la carte quelques
   * secondes après avoir clos l'enchère — alors qu'un refus est une RÉPONSE. Un
   * serveur qui dit non quatre fois d'affilée à la même demande ne dira pas oui
   * à la cinquième, et vingt tentatives espacées de dix secondes, c'est trois
   * minutes et demie à marteler une API qui a déjà tranché.
   *
   * Les refus passagers — 429, 5xx — ne comptent pas ici : ils disent que le
   * serveur ne peut pas, pas que la demande est mauvaise.
   */
  const WATCH_REFUS = 4;
  const SLOTS_FRESH_MS = 20000;  // durée de validité du compte d'emplacements
  const SETTLE_MS = 60000;       // délai laissé au serveur pour trancher une enchère close
  const IDLE_RELIST_MS = 15000;  // repos quand un tour n'a rien à replacer
  /*
   * Une carte en pause ne repart jamais d'elle-même : sans oubli, le volet
   * Relances devenait un cimetière que seul « Tout arrêter » vidait. Une
   * semaine d'immobilité veut dire que l'inscription a perdu son objet — carte
   * vendue ailleurs, retirée à la main, ou disparue de la collection.
   */
  const WATCH_PAUSE_TTL = 604800000;   // 7 jours
  const WATCH_PAUSE_RETRY = 1800000;   // 30 min : la pause se desserre seule, voir reconcileWatch

  /*
   * Et la pause se lève PLUS TÔT quand il n'y a rien d'autre à faire.
   *
   * Signalé après usage : « quand la liste d'attente est vide, les ventes avec
   * le compteur à 20 doivent être remises à 0 pour ne pas laisser le système à
   * rien faire ». C'est juste : la cause la plus fréquente des vingt échecs est
   * une lenteur du serveur à rendre la carte après une clôture — quelques
   * dizaines de secondes — et attendre trente minutes pour la retenter alors
   * que des emplacements sont libres et que plus rien n'attend, c'est laisser
   * la place vide pour rien.
   *
   * Deux freins, parce que réveiller sans fin une carte réellement partie
   * reviendrait à marteler l'API :
   *
   * - une minute entre deux réveils au repos, tous suivis confondus ;
   * - trois réveils par carte, après quoi elle retombe sur les trente minutes.
   *
   * Le compte de réveils repart à zéro dès que la carte est revue en vente :
   * elle a prouvé qu'elle existait, l'ardoise est effacée.
   */
  const IDLE_WAKE_MS = 60000;   // entre deux réveils au repos
  const IDLE_WAKE_MAX = 3;      // réveils au repos par carte avant de laisser faire le temps

  /*
   * Les sept durées que le site propose, relevées sur son propre formulaire de
   * mise aux enchères — sept boutons, pas une liste déroulante, et « 1 h »
   * présélectionnée. Le champ envoyé est un entier libre ; ce sont ces
   * valeurs-là qu'un joueur peut choisir à la main, donc les seules qu'on
   * propose ici.
   */
  /*
   * La durée d'une carte mise en file : la plus courte que le site propose.
   *
   * C'est le choix qui engage le moins. Une carte qu'on vient de mettre en
   * file part sans qu'on la revoie ; dix minutes, c'est dix minutes avant de
   * pouvoir changer d'avis, contre vingt-quatre heures. Et « Tout repasser
   * en » sait faire passer tout le lot à une autre durée en un geste — la
   * corriger après coup coûte un clic, l'avoir devinée trop longue coûte une
   * journée.
   */
  const FILE_MINUTES = 10;

  const DUREES = [
    { label: '10 min', minutes: 10 },
    { label: '30 min', minutes: 30 },
    { label: '1 h', minutes: 60 },
    { label: '3 h', minutes: 180 },
    { label: '6 h', minutes: 360 },
    { label: '12 h', minutes: 720 },
    { label: '24 h', minutes: 1440 },
  ];

  /**
   * Annule une enchère et récupère la carte.
   *
   * Le site ne l'offre PAS depuis la liste « Mes ventes » : le bouton
   * « Annuler et récupérer ma carte » vit sur la page de l'enchère elle-même,
   * un clic plus loin. C'est sa route.
   *
   * Une enchère qui porte déjà une mise ne s'annule pas — le serveur le refuse
   * aux joueurs, et c'est très bien : on ne retire pas sa carte à quelqu'un qui
   * s'est engagé. On n'essaie donc même pas quand on sait qu'il y a une mise,
   * et on encaisse le refus sans le traiter comme une panne quand on l'ignore.
   */
  async function annulerVente(auctionId) {
    if (!auctionId) return { ok: false, status: 0 };
    try {
      const r = await api(`/api/marketplace/${auctionId}`, 'DELETE');
      return { ok: r.status >= 200 && r.status < 300, status: r.status, data: r.data };
    } catch (_) {
      return { ok: false, status: 0 };
    }
  }
  /*
   * Un prix demandé attend l'issue que la notification apporte — et
   * `/api/notifications` n'en garde que cinquante. Une notification manquée
   * laissait l'entrée à vie, sans rien à quoi la confronter.
   */
  const ASK_TTL = 604800000;           // 7 jours

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

  /*
   * Une annonce qui ne trouve pas preneur deux fois de suite au même prix a
   * répondu à la question : le prix est trop haut. Le journal d'un compte réel
   * montrait la même carte échouer deux fois au même montant — quatre cartes
   * sur douze lignes, pour 14 ventes conclues sur 100.
   *
   * Le panneau le DIT. Il ne baisse pas.
   *
   * La 2.9.0 baissait le prix toute seule, d'un quart par tour invendu. C'était
   * une faute, sur deux plans.
   *
   * D'abord le principe : mettre en vente est irréversible dès la première
   * mise, et c'est pour ça que le panneau ne vend ni ne donne à la place de qui
   * l'utilise. Cocher « Relances auto », c'est consentir à REPUBLIER SON prix —
   * celui qu'on a choisi, qu'on connaît. Ce n'est pas consentir à ce qu'un
   * autre prix soit choisi pour soi.
   *
   * Ensuite l'arithmétique, et c'est pire. Le plancher n'existait que pour une
   * carte à cote solide. Sous cinq ventes — le cas le plus fréquent sur les
   * cartes chères, justement — il tombait au plancher absolu : 100, 75, 56, 42,
   * et ainsi de suite jusqu'à 5 wikibidous. Une Légendaire mal cotée finissait
   * bradée pendant qu'on regardait ailleurs.
   *
   * Ce qui reste : le calcul, offert comme SUGGESTION dans le volet Relances,
   * avec un bouton. Rien ne bouge sans un clic.
   */
  const RELIST_TOURS_AVANT_SUGGESTION = 2;
  const RELIST_BAISSE = 0.75;
  const RELIST_PLANCHER = 5;

  /**
   * Le prix qu'on PROPOSERAIT après des invendus — jamais celui qu'on applique.
   * @param {string} card     identifiant de la carte
   * @param {string} titre    son titre, pour retrouver la cote d'un cache ancien
   * @param {number} prix     le prix qui vient d'échouer
   * @param {number} tours    nombre d'invendus consécutifs, celui-ci compris
   * @returns {number|null}   le prix suggéré, ou `null` s'il n'y a rien à dire
   */
  function prixSuggere(card, titre, prix, tours) {
    if (tours < RELIST_TOURS_AVANT_SUGGESTION) return null;
    const ligne = (sell.rows || []).find((r) => r.id === card || r.t === titre);
    /*
     * Sans cote solide, on ne suggère RIEN. Un quart de moins sur un prix dont
     * on ignore s'il est juste n'est pas un conseil, c'est une devinette — et
     * répétée, elle mène à zéro. La médiane d'une cote établie, elle, est un
     * prix auquel la carte s'est réellement vendue.
     */
    if (!ligne || ligne.seule || ligne.n < THIN_SALES) return null;
    const plancher = Math.max(RELIST_PLANCHER, ligne.med);
    if (prix <= plancher) return null;
    return Math.max(plancher, Math.round(prix * RELIST_BAISSE));
  }

  /**
   * @param {boolean} [observe] Les conditions viennent d'une enchère LUE, et
   *   non d'un choix. Elles ne remplacent alors jamais celles déjà inscrites.
   *
   *   Signalé après usage : « j'ai cliqué et validé 30 minutes et pourtant les
   *   relances se font en 10 minutes ». `enrolWatch` prenait la durée qu'on lui
   *   passait pour parole d'évangile, et deux appelants sur quatre lui passaient
   *   celle de l'annonce en cours — le relevé du Marché à chaque tour, et la
   *   clôture d'un invendu. Une carte qui portait déjà une mise n'était pas
   *   annulée par « Tout repasser en » : son annonce de dix minutes continuait,
   *   le relevé suivant la relisait, et réécrivait dix par-dessus les trente
   *   choisies. Le réglage tenait quelques secondes.
   *
   *   Le prix suit la même règle, et pour la même raison : le crayon change le
   *   prix pendant qu'une annonce court encore à l'ancien, et la clôture de
   *   celle-ci le remettait.
   */
  function enrolWatch(card, title, price, minutes, invendus, observe, voulu) {
    if (!card || !price) return false;
    /*
     * Une carte étiquetée ne s'inscrit pas. C'est la première des deux barrières
     * — la seconde est au moment de publier — parce qu'une carte peut être
     * étiquetée après son inscription, et qu'on ne veut pas non plus la voir
     * traîner dans la liste de surveillance en donnant à croire qu'elle partira.
     *
     * UNE SEULE EXCEPTION, ET ELLE SE DEMANDE.
     *
     * `voulu` ne s'obtient qu'en confirmant, carte par carte, le bouton
     * « Vendre un double » — jamais par un geste en masse, jamais par la
     * réinscription automatique d'un invendu. Il dit une chose que l'étiquette
     * ne sait pas dire : vous en avez PLUSIEURS, et vous voulez en vendre une.
     *
     * L'étiquette veut dire « je garde cette carte ». Elle ne veut pas dire
     * « je garde les trois exemplaires que j'en ai » — et c'est pourtant ce
     * qu'elle imposait. Le nombre d'exemplaires est vérifié une seconde fois
     * au moment de publier : d'ici là vous pouvez en avoir vendu un à la main.
     */
    const dejaVoulu = !!(state.watch[card] && state.watch[card].voulu);
    if (isTagged(card) && !voulu && !dejaVoulu) {
      if (state.watch[card]) dropWatch(card, 'étiquetée');
      return false;
    }
    const dejaLa = state.watch[card];
    /*
     * Ce que VOUS avez choisi l'emporte sur ce qui est lu. Une inscription
     * neuve prend les conditions qu'on lui donne — il n'y a rien d'autre.
     */
    const garde = observe && dejaLa;
    state.watch[card] = {
      title: title || (dejaLa && dejaLa.title) || '',
      price: (garde && dejaLa.price) || price,
      minutes: (garde && dejaLa.minutes) || minutes || (dejaLa && dejaLa.minutes) || FILE_MINUTES,
      since: dejaLa ? dejaLa.since : Date.now(),
      fails: 0,
      paused: false,
      // Les tours perdus survivent à la réinscription : c'est eux qui font
      // baisser le prix, et les remettre à zéro à chaque cycle les annulerait.
      invendus: invendus != null ? invendus : (dejaLa && dejaLa.invendus) || 0,
      /*
       * On garde la trace de la dernière annonce publiée. La réinscription
       * l'effaçait, et avec elle la garantie « une annonce à la fois » : une
       * carte réinscrite pendant que son annonce courait repartait en vente.
       * Les deux repères expirent d'eux-mêmes quand l'enchère se termine.
       */
      /*
       * Ce que vous avez demandé pour CETTE carte survit à la réinscription :
       * un invendu qui revient ne doit pas redemander la confirmation qu'on
       * vient de donner.
       */
      voulu: !!(voulu || dejaVoulu),
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
      if (!ventesSuresPourAgir()) return;
      const enVente = new Set((state.sales.list || []).map((v) => v.card).filter(Boolean));

      for (const c of ids) {
        if (!enVente.has(c)) continue;
        // Une carte de retour en vente repart d'un compteur d'échecs vierge.
        if (state.watch[c].fails) state.watch[c].fails = 0;
        // Et d'une ardoise de réveils vierge : elle vient de prouver qu'elle existe.
        if (state.watch[c].reveils) state.watch[c].reveils = 0;
        // Les refus du serveur aussi : elle vient d'être acceptée en vente,
        // c'est la meilleure preuve possible que la demande était bonne.
        if (state.watch[c].refus) state.watch[c].refus = 0;
        /*
         * On note qu'on vient de la voir en ligne. C'est ce repère qui empêche
         * de la replacer dans la minute qui suit la clôture : à cet instant elle
         * a quitté les ventes sans qu'on sache encore si elle a trouvé preneur.
         * Il vaut pour les annonces posées à la main comme pour les nôtres.
         */
        state.watch[c].seenListedAt = Date.now();
      }

      /*
       * La pause se lève d'elle-même.
       *
       * Elle était TERMINALE : vingt échecs d'affilée — le plus souvent « carte
       * introuvable en collection », qui arrive quand le serveur tarde à la
       * rendre après une clôture — et la carte s'arrêtait là. Il fallait aller
       * cliquer ↻ sur chacune, une par une, ou attendre sept jours qu'elle soit
       * simplement oubliée. C'est la corvée, et elle punissait une lenteur du
       * serveur comme une erreur définitive.
       *
       * La supprimer tout court ferait réessayer sans fin une carte réellement
       * partie. On garde donc le frein, mais on le desserre seul : après
       * `WATCH_PAUSE_RETRY`, les compteurs repartent à zéro et la carte
       * retente. Une carte vraiment absente coûte alors deux tentatives par
       * heure au lieu d'une toutes les quinze secondes — et plus personne n'a
       * à cliquer.
       */
      let reveillees = 0;
      for (const c of ids) {
        const w = state.watch[c];
        if (w.paused && Date.now() - (w.pausedAt || 0) > WATCH_PAUSE_RETRY) {
          w.paused = false;
          w.fails = 0;
          w.refus = 0;
          /*
           * Le temps a fait son office : l'ardoise des réveils au repos est
           * effacée aussi. Sans ça, une carte ayant épuisé ses trois réveils
           * n'en aurait plus jamais, même des heures plus tard.
           */
          w.reveils = 0;
          reveillees += 1;
        }
      }
      // Écrit ici, et non par le drapeau du bas : ce tour peut rendre la main
      // avant lui — quand il n'y a rien à replacer — et le réveil serait perdu.
      if (reveillees) saveStore({ watch: state.watch });

      const aReplacer = () => ids.filter(
        (c) => !dejaEnLigne(c, enVente) && !state.watch[c].paused
      );
      let manquantes = aReplacer();

      /*
       * Plus rien à replacer, et des emplacements libres : c'est le moment de
       * réveiller ce qui dort, plutôt que de laisser la place vide en attendant
       * les trente minutes. Voir `IDLE_WAKE_MS` pour les deux freins.
       *
       * La condition sur `libres` compte autant que le reste : réveiller des
       * cartes alors que les dix emplacements sont pris ne ferait qu'aligner
       * des candidates qui ne peuvent pas partir, et remettre à zéro des
       * compteurs qui disent quelque chose.
       */
      if (!manquantes.length && libres > 0) {
        if (reveillerAuRepos(ids)) manquantes = aReplacer();
      }

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
        /*
         * Le geste explicite passe — à une condition qui se revérifie ICI.
         *
         * `voulu` a été donné devant un tableau qui annonçait plusieurs
         * exemplaires. Entre-temps vous avez pu en vendre un à la main : il
         * n'en reste qu'un, et publier reviendrait à vendre la carte que vous
         * gardez. L'index vient d'être relu, il sait compter — on lui demande.
         *
         * Un index tronqué compte trop bas ; « trop bas » se lit « exemplaire
         * unique », donc on s'abstient. C'est le bon sens de l'erreur.
         */
        const exemplaires = owned.copies.get(card) || 0;
        if (isTagged(card) && !(w.voulu && exemplaires > 1)) {
          dropWatch(card, w.voulu ? 'gardée, et plus qu’un exemplaire' : 'étiquetée');
          bouge = true;
          continue;
        }
        let copie = index.get(card);
        if (!copie && !rebati) {
          rebati = true;                      // une seule reconstruction par passage
          index = await ownedIndex(true);
          copie = index.get(card);
        }
        /*
         * TOUJOURS PAS TROUVÉE : ON DEMANDE AU SERVEUR, AU LIEU DE CONCLURE.
         *
         * `ownedIndex` s'arrête à quatre-vingts pages, soit 4 000 cartes.
         * Au-delà, la collection existe mais le balayage ne la voit pas — et
         * l'index ne le SAIT pas : son drapeau `complet` ne compte que les
         * requêtes en échec, pas la troncature. Une carte suivie au-delà de
         * cette borne récoltait donc une absence par créneau, atteignait les
         * vingt absences, et se mettait en pause définitivement. Vu à l'usage :
         * des cartes en pause définitive, vingt absences chacune, zéro refus du
         * serveur, jamais publiées — et une collection dont le balayage n'avait
         * jamais atteint la fin.
         *
         * Le même défaut avait été corrigé côté cote : `fetchCollectionRaw`
         * lit jusqu'à la première page incomplète et signale sa troncature.
         * Il ne l'avait jamais été ici, dans la fonction qui décide si une
         * carte existe encore.
         *
         * Relever la borne coûterait cinq cents requêtes toutes les cinq
         * minutes. Le serveur sait filtrer par titre — vérifié sur le vrai
         * site : `?q=` rend UNE ligne. On lui demande donc la carte, une
         * requête, plutôt que de relire la collection entière pour la trouver.
         *
         * Ce qu'on ne fait toujours pas : conclure. Une carte qu'on n'a pas su
         * chercher n'est pas une carte absente.
         */
        if (!copie) {
          try {
            const d = await api(`/api/my-collection?page=0&q=${encodeURIComponent(w.title)}`);
            const miennes = ((d.data && d.data.collection) || []).filter((c) => c.card_id === card);
            /*
             * Un exemplaire LIBRE d'abord, comme l'index.
             *
             * Le serveur rend toutes vos copies, et prendre la première venue
             * referait ici l'erreur qu'on vient de corriger là-bas : sur une
             * carte en double dont une seule est gardée, on mettrait en vente
             * celle qu'on garde. Le repli suit donc la même règle que l'index —
             * et s'il n'y a que des exemplaires protégés, on n'en prend aucun.
             */
            const ligne = miennes.find((c) => !(c.tags || []).length && !c.starred)
              /*
               * Toutes gardées, mais vous avez demandé d'en vendre une et le
               * serveur vient de confirmer qu'il y en a plusieurs : on prend la
               * première. C'est le seul endroit où une copie étiquetée part en
               * vente, et il a fallu un clic de confirmation pour y arriver.
               */
              || (w.voulu && miennes.length > 1 ? miennes[0] : null);
            if (ligne && ligne.id) {
              copie = ligne.id;
              // Elle existe : l'index était court, pas la collection.
              index.set(card, ligne.id);
            }
          } catch (_) {
            /* réseau : le créneau suivant retentera, comme pour le reste */
          }
        }
        if (!copie) {
          /*
           * Le serveur rend la carte quelques secondes après avoir clos
           * l'enchère : absente ne veut pas dire perdue. On la garde inscrite
           * et on retentera — c'est tout l'intérêt de réconcilier.
           *
           * Mais un échec ne compte qu'UNE FOIS PAR CRÉNEAU.
           *
           * Ce tour repasse chaque seconde, et une carte introuvable ne
           * reprogrammait rien : elle se voyait donc infliger vingt échecs en
           * vingt secondes, puis la pause. Vingt tentatives étaient pensées
           * comme un filet de sécurité au long cours ; elles se consommaient
           * pendant l'absence de quelques secondes que ce commentaire décrit
           * lui-même. Relevé sur un compte réel : trois cartes en pause après
           * un seul invendu, revenues en collection depuis longtemps, la pause
           * ayant survécu à sa cause.
           *
           * Espacé au rythme du marché, le budget devient trois minutes au
           * lieu de vingt secondes — le temps qu'il faut à un serveur lent,
           * sans rien perdre du filet.
           */
          if (Date.now() >= (w.failAt || 0) + CFG.relistGapMs[0]) {
            w.fails = (w.fails || 0) + 1;
            w.failAt = Date.now();
            if (w.fails >= WATCH_FAILS) {
              w.paused = true;
              w.pausedAt = Date.now();   // au-delà de WATCH_PAUSE_TTL, on oublie
              logRelist(w.title, 'refus', w.price, 'introuvable en collection — suivi en pause');
            }
            bouge = true;
          }
          continue;
        }
        /*
         * Retrouvée : le compte d'échecs repart de zéro.
         *
         * Il ne se remettait à zéro qu'après une publication RÉUSSIE. Une
         * carte revenue en collection mais qu'aucun emplacement n'attendait
         * gardait donc ses échecs, et la prochaine absence les reprenait là où
         * ils s'étaient arrêtés. Le compteur dit « combien de fois d'affilée
         * on ne l'a pas trouvée » : la trouver le remet à zéro.
         */
        if (w.fails) { w.fails = 0; w.failAt = 0; bouge = true; }
        const res = await api('/api/marketplace', 'POST', {
          card_id: copie,
          base_amount: w.price,
          duration_minutes: w.minutes,
        });
        if (res.status === 200 || res.status === 201) {
          libres -= 1;
          state.slots.used += 1;
          w.fails = 0;
          w.refus = 0;
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
          /*
           * UN REFUS DU SERVEUR N'EST PAS UN « INTROUVABLE EN COLLECTION ».
           *
           * Les deux se comptaient sur le même `w.fails`. Or la ligne
           * « Retrouvée : le compte d'échecs repart de zéro », vingt lignes
           * plus haut, le remet à zéro à CHAQUE passage — puisque la carte est
           * bien dans l'index, c'est le serveur qui refuse. Le compteur
           * montait donc à 1, retombait à 0, remontait à 1 : il ne pouvait
           * jamais atteindre `WATCH_FAILS`, et tout ce bloc — la pause, la
           * ligne de journal — était du code MORT.
           *
           * Ce que ça donnait : le site change la forme de sa mise en vente,
           * chaque POST est refusé, et le script réessaie toutes les dix
           * secondes indéfiniment, sans une ligne au journal. Éprouvé au banc :
           * 91 refus en quinze minutes de temps virtuel, `fails` à 1, aucune
           * pause, volet Relances vide. C'est le scénario 20 de `preuves.js`,
           * et il n'existait pas quand ce code a été écrit.
           *
           * Deux compteurs, donc, parce que ce sont deux faits différents :
           * `fails` compte les absences de la collection, `refus` compte les
           * non du serveur. Seule une publication réussie remet le second à
           * zéro — ou le retour de la carte en vente, qui prouve la même chose.
           */
          const passager = res.status === 429 || res.status >= 500;
          const pourquoi = String((res.data && res.data.error) || res.status);
          if (passager) {
            /*
             * Le serveur freine ou hoquette : la demande, elle, était bonne.
             * On réessaie au créneau suivant sans rien compter contre la carte
             * — la punir pour un 429 reviendrait à mettre en pause ce qui n'a
             * pas eu tort, exactement le défaut que la 3.2.0 a corrigé
             * ailleurs.
             */
            logRelist(w.title, 'refus', w.price, `${pourquoi} — nouvel essai au prochain créneau`);
          } else {
            w.refus = (w.refus || 0) + 1;
            if (w.refus >= WATCH_REFUS) {
              w.paused = true;
              w.pausedAt = Date.now();
              logRelist(w.title, 'refus', w.price,
                `${pourquoi} — suivi en pause après ${w.refus} refus`);
            } else {
              /*
               * Et on le dit dès le PREMIER refus. Le seuil décide quand on
               * arrête d'essayer, pas quand on en parle : entre les deux, le
               * volet Relances affichait une carte « en attente » qui n'avait
               * aucune chance de partir.
               */
              logRelist(w.title, 'refus', w.price, `${pourquoi} — nouvel essai`);
            }
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
      if (v.card && v.price && enrolWatch(v.card, v.title, v.price, v.minutes, null, true)) n += 1;
    }
    render();
    return n;
  }

  /*
   * Même garde que `scanSales`, et pour la même raison : appelé par le tour du
   * guetteur, par « rafraîchir » et à l'ouverture de la Revente. Deux passages
   * concurrents inscriraient en plus deux fois la même carte invendue.
   */
  async function syncJournal() {
    if (syncJournal.busy) return;
    syncJournal.busy = true;
    try {
      await syncJournalVraiment();
    } finally {
      syncJournal.busy = false;
    }
  }

  async function syncJournalVraiment() {
    let notifs;
    try {
      // La réponse brute : c'est ici qu'on lit les invendus que le site ne voit plus.
      const d = await api('/api/notifications', 'GET', null, fetchAvantFiltre);
      notifs = (d.data && d.data.notifications) || [];
      /*
       * Et le compte de la pastille, tenu à jour ici aussi. Le filtre HTTP le
       * calcule déjà, mais il ne le fait que si le SITE relit sa liste — ce
       * qu'il ne fait pas à chaque avis reçu. Ce relevé-ci passe toutes les
       * quinze secondes et voit tout, y compris ce qui est arrivé en direct.
       */
      notifNonLues = compterNonLues(notifs);
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
        /*
         * Une vente change ce qu'on possède, et la Revente n'en savait rien.
         *
         * Elle ne retire une ligne que dans `pruneSold`, qui relit la
         * collection — mais seulement à l'ouverture, et pas plus d'une fois
         * par `PRUNE_TTL`. Une carte vendue restait donc au tableau, bouton
         * « Vendre » compris, jusqu'à dix minutes après son départ, et
         * indéfiniment si la Revente restait ouverte.
         *
         * On n'efface PAS la ligne ici : `card_id` désigne le type de carte,
         * pas l'exemplaire, et les doublons le partagent. Vendre un exemplaire
         * sur deux en laisse un, dont la cote reste juste. Seule la relecture
         * de la collection sait trancher — on la rend simplement possible tout
         * de suite, au lieu de la faire attendre son tour.
         */
        sell.prunedAt = 0;
      } else if (prefs.relistUnsold) {
        // Invendue : on l'inscrit, la réconciliation se charge du reste.
        const t = await listingTerms(id, n.data?.auction_id || null);
        if (t) {
          /*
           * On réinscrit au prix que l'utilisateur a choisi, inchangé. Le
           * compte des invendus le suit, et la suggestion se calcule à
           * l'affichage — elle n'entre nulle part dans ce qui est publié.
           */
          const tours = ((state.watch[id] && state.watch[id].invendus) || 0) + 1;
          enrolWatch(id, titre, t.price, t.minutes, tours, true);
        }
      }
    }
    if (!ajout) return;
    state.journal.sort((a, b) => b.at - a.at);
    state.journal = state.journal.slice(0, JOURNAL_MAX);
    saveStore({ journal: state.journal, asks: state.asks });
    /*
     * La Revente ouverte pendant qu'une vente se conclut : elle affichait
     * encore la carte partie, sans rien pour l'en déloger — `pruneSold` ne
     * s'exécute qu'à l'ouverture. On relit donc maintenant, puisque le verrou
     * de fraîcheur vient d'être levé juste au-dessus.
     */
    if (sell.open) { pruneSold(); renderSell(); }
  }

  const THIN_SALES = 5;  // en dessous, la cote repose sur trop peu de transactions
  const SELL_POOL = 6;   // requêtes simultanées pour la cotation
  const SELL_MAX_PAGES = 1000;  // garde-fou : la lecture s'arrête d'elle-même à la fin

  /*
   * Concurrence : combien d'exemplaires d'une carte sont mis en vente en ce
   * moment par d'autres joueurs. Le marché est dispersé — 14 500 enchères pour
   * 13 600 cartes distinctes — donc une carte sans concurrence peut être
   * proposée haut et attendre son acheteur, ce qui est tout l'intérêt.
   *
   * « par d'autres joueurs » est MESURÉ, pas supposé.
   *
   * Rien ici ne filtre le vendeur : on additionne toutes les annonces que
   * `/api/marketplace` rend. La question s'est posée de savoir si nos propres
   * annonces s'y trouvaient — auquel cas une carte que l'on est seul à vendre
   * afficherait « En vente 1 » en ambre, et paraîtrait disputée par soi-même.
   *
   * Éprouvé sur le compte réel le 9 septembre 2026 : une carte mise en vente,
   * que personne d'autre ne proposait, garde « — » après un relevé neuf
   * (`sell.compAt = 0` puis réouverture, pour passer outre les dix minutes de
   * cache ci-dessous — sans quoi l'observation ne prouve rien). L'API exclut
   * donc le vendeur qui l'interroge.
   *
   * Conséquence pratique : NE PAS soustraire ses propres annonces de ce
   * compte. Ce serait corriger une erreur qui n'existe pas, et en créer une —
   * un sous-comptage, cette fois.
   */
  const MARKET_TTL = 600000;

  /**
   * Une page REFUSÉE n'est pas une fin de marché — la même confusion que celle
   * qui vidait la cote, et elle n'avait pas été corrigée ici.
   *
   * `r.json()` sans contrôle de statut : un 429 — fréquent, la boucle
   * d'ouverture tourne en parallèle — rend un JSON d'erreur, `auctions` y est
   * absent, la page passait pour vide et le balayage s'arrêtait là. La carte de
   * concurrence était alors tronquée EN SILENCE, et le filtre « Sans
   * concurrence », coché par défaut, présentait comme seul vendeur des cartes
   * qui avaient des concurrents — l'inverse exact de ce qu'on lui demande.
   *
   * @returns {Promise<Map|null>} null si une page n'a pas été reçue :
   *   l'appelant garde alors le relevé précédent plutôt qu'un compte faux.
   */
  async function fetchCompetition() {
    const counts = new Map();
    for (let base = 0; base < 400; base += 8) {
      const lot = await Promise.all(
        Array.from({ length: 8 }, (_, k) =>
          fetchBorne(`/api/marketplace?page=${base + k}&limit=50`, { credentials: 'same-origin' })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
        )
      );
      let fini = false;
      let manque = false;
      for (const d of lot) {
        if (!d || !Array.isArray(d.auctions)) { manque = true; continue; }
        if (!d.auctions.length) { fini = true; continue; }
        for (const x of d.auctions) counts.set(x.card_id, (counts.get(x.card_id) || 0) + 1);
        if (d.auctions.length < 50) fini = true;
      }
      if (manque) return null;
      if (fini) break;
    }
    return counts;
  }

  /*
   * La ligne dont on choisit le prix avant de la mettre en file :
   * `{ id, titre, prix }`, le prix tel que tapé — plus `double` (le nombre
   * d'exemplaires) et `ouvertA` quand c'est « Vendre un double ». Une seule à
   * la fois : deux saisies ouvertes, c'est un prix validé sur la mauvaise
   * carte.
   *
   * « Mettre en file » et « Vendre un double » inscrivaient la carte au prix
   * visé, sans demander : pour en changer, il fallait aller la retrouver dans
   * le volet Relances. Signalé à l'usage — le prix se choisit maintenant dans
   * la ligne, avant l'inscription.
   */
  let saisieFile = null;

  const sell = { open: false, scanning: false, done: 0, total: 0, read: 0, rows: [], at: 0, tags: [],
                 checked: new Set(), themes: {}, comp: new Map(), compAt: 0, compTronque: false,
                 prunedAt: 0,   // dernière vérification de ce qui est encore possédé
                 /*
                  * Ce que la dernière lecture COMPLÈTE de la collection a vu :
                  * les cartes possédées, et l'instant où la lecture a commencé.
                  * En mémoire seulement — un rechargement relit la collection à
                  * la première ouverture. Voir `tiragesACoter`.
                  */
                 possedees: null,
                 /*
                  * De quoi dire si la cote est DISTANCÉE.
                  *
                  * `sell.at` répond « de quand date la dernière cote », jamais
                  * « sur quelle part de la collection ». Or la cote se remplit
                  * cinq cartes par paquet ouvert : entre deux relevés complets
                  * elle décroche à mesure que la collection grossit, et rien ne
                  * le disait. Mesuré sur un compte réel : 17 % des lignes,
                  * soit quatre cartes sur cinq sans prix — un tri « par prix »
                  * qui range l'essentiel de la collection en fin de liste, sans
                  * que personne puisse le savoir.
                  *
                  * `scanTotal` est la taille de la collection au dernier relevé
                  * COMPLET, `owned` sa taille aujourd'hui. L'écart des deux est
                  * ce que « Rafraîchir la cote » comblerait vraiment — à la
                  * différence des cartes lues mais jamais vendues, que ce bouton
                  * ne peut pas coter et qu'on se garde de compter ici.
                  */
                 scanAt: 0, scanTotal: 0,
                 owned: { n: 0, at: 0 },
                 // Pourquoi le tableau est vide — ou incomplet — quand il l'est.
                 // Lignes relues à cause du glissement de pagination, écartées.
                 note: '', refus: 0, tronque: false, freinages: 0, doublons: 0,
                 // Refus rencontrés sur l'historique des ventes, carte par carte.
                 refusVentes: 0, refusVentesN: 0,
                 /*
                  * La défausse en lot, demandée sur #suggestions : les cartes
                  * cochées (par identifiant de carte), les exemplaires engagés
                  * dans un échange en attente — le site les donne avec chaque
                  * page de collection —, et le bilan de la dernière défausse.
                  */
                 aDefausser: new Set(), echanges: new Set(), defausse: null };

  function loadCote() {
    try {
      const d = JSON.parse(localStorage.getItem(SELL_KEY) || 'null');
      if (d && Array.isArray(d.rows)) {
        sell.rows = d.rows;
        sell.at = d.at || 0;
        sell.tags = d.tags || [];
        sell.themes = d.themes || {};
        /*
         * Une cote relue du cache n'a plus de relevé complet derrière elle tant
         * qu'on n'a pas retenu lequel. Sans ces deux valeurs, la couverture se
         * tairait exactement là où elle sert le plus : au rechargement suivant,
         * sur une cote vieille de trois jours.
         */
        sell.scanAt = d.scanAt || 0;
        sell.scanTotal = d.scanTotal || 0;
        /*
         * Le cache porte des cotes calculées par l'ancienne règle, où le
         * « 3e quartile » d'un échantillon mince valait le maximum. On les
         * répare ici plutôt que d'attendre un rescan de la collection entière
         * — qui dure plusieurs minutes et que personne ne relance pour un
         * correctif qu'il ignore. La réparation est exacte : sous le seuil,
         * la valeur juste est la médiane, et elle est déjà dans la ligne.
         */
        /*
         * Le cache porte aussi des LIGNES EN DOUBLE : le relevé posait une
         * ligne par exemplaire possédé, et un exemplaire en double donnait deux
         * lignes identiques, indiscernables, chacune avec son bouton « Vendre ».
         * Vu sur un compte réel : quelques dizaines de lignes de plus que de
         * cartes. Le compte de tête annonçait donc des lignes en disant
         * « cartes ».
         *
         * Réparé ici plutôt qu'au prochain relevé complet, qui dure deux
         * minutes et que personne ne relance pour un correctif qu'il ignore —
         * même raison que la réparation du prix visé juste en dessous.
         */
        const vus = new Set();
        sell.rows = sell.rows.filter((r) => {
          if (!r.id) return true;
          if (vus.has(r.id)) return false;
          vus.add(r.id);
          return true;
        });

        for (const r of sell.rows) {
          if (r.id) sell.checked.add(r.id);
          /*
           * Le plafond s'applique aussi aux cotes déjà en cache : sans ça, un
           * prix visé à vingt fois la médiane resterait affiché jusqu'au
           * prochain relevé complet.
           */
          if (!r.seule && r.n >= THIN_SALES && Number.isFinite(r.med) && Number.isFinite(r.q3)) {
            r.q3 = Math.min(r.q3, Math.round(r.med * Q3_PLAFOND));
          }
          if (r.seule || r.n >= THIN_SALES) continue;
          /*
           * Deux ventes : la médiane rangée est celle du haut, donc le maximum
           * — s'y replier ne corrigerait rien. Les deux valeurs centrales sont
           * ici le minimum et le maximum, tous deux dans la ligne : la vraie
           * médiane se recalcule exactement, sans relire quoi que ce soit.
           */
          if (r.n === 2 && Number.isFinite(r.min) && Number.isFinite(r.max)) {
            r.med = Math.round((r.min + r.max) / 2);
          }
          r.q3 = r.med;
        }
      }
    } catch (_) {
      /* cache illisible : on rescannera */
    }
  }

  function saveCote() {
    try {
      localStorage.setItem(
        SELL_KEY,
        JSON.stringify({ rows: sell.rows, at: sell.at, tags: sell.tags, themes: sell.themes,
                         scanAt: sell.scanAt, scanTotal: sell.scanTotal })
      );
      noterSucces('stockage');
    } catch (err) {
      /*
       * Trop volumineux ou stockage plein : le scan reste en mémoire, et
       * disparaît au rechargement. C'est ici que ça se voit en premier sur une
       * grosse collection — la cote est de loin la plus lourde des quatre clés.
       */
      noterEchec('stockage', err, 1);
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
      const r = await fetchBorne(`/api/marketplace/cards/${cardId}/sales`, { credentials: 'same-origin' });
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
        const r = await fetchBorne(`/api/my-collection?page=${page}`, { credentials: 'same-origin' });
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

  /*
   * La pagination glisse pendant la lecture, et c'est la boucle qui la fait
   * glisser.
   *
   * Des centaines de pages, de longues secondes, et pendant ce temps des
   * paquets s'ouvrent : cinq cartes de plus à chaque fois, insérées dans un
   * ordre trié par rareté, donc n'importe où. Une insertion pousse tout ce qui
   * suit d'un cran — une carte qui était en fin de page passe en tête de la
   * suivante, et on la lit DEUX FOIS.
   *
   * Rien n'est sauté pour autant : sauter demanderait un déplacement vers
   * l'arrière, donc une suppression. Le défaut est unilatéral, et dédoublonner
   * ne peut donc pas amputer la liste — c'est ce qui avait fait hésiter, à
   * tort. La suppression existe (une carte vendue, une carte donnée), elle est
   * simplement rare devant le flux des ouvertures ; `buildValueOrder` compare
   * de son côté le compte obtenu à celui du serveur avant d'allumer le tri.
   *
   * `id` est l'identifiant de la LIGNE de collection, pas de la carte : deux
   * exemplaires d'une même carte sont deux lignes, et tous deux doivent rester.
   * Sans `id`, on garde l'entrée plutôt que de la perdre.
   */
  async function fetchCollectionRaw(onProgress) {
    const out = [];
    const vues = new Set();
    // Les exemplaires engagés dans un échange : jamais à défausser.
    const echanges = new Set();
    sell.refus = 0;
    sell.tronque = false;
    sell.doublons = 0;
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
        if (Array.isArray(d.pendingTradeCardIds)) for (const x of d.pendingTradeCardIds) echanges.add(x);
        for (const e of d.collection) {
          if (e && e.id != null) {
            if (vues.has(e.id)) { sell.doublons += 1; continue; }
            vues.add(e.id);
          }
          out.push(e);
        }
        if (d.collection.length < COLLECTION_PAGE) fini = true;
      }
      if (onProgress) onProgress(out.length);
      if (manque) {
        sell.tronque = true;
        break;
      }
      if (fini) break;
    }
    sell.echanges = echanges;
    return out;
  }

  /**
   * Une ligne par EXEMPLAIRE en entrée, une carte par ligne de tableau en
   * sortie.
   *
   * Ça, c'était déjà juste. Ce qui ne l'était pas : la carte gardait les
   * étiquettes du PREMIER exemplaire rencontré et les présentait comme les
   * siennes. Sur un double dont une seule copie est gardée, l'affichage
   * dépendait donc de l'ordre des pages rendues par le serveur — « protégée »
   * ou « à vendre » selon le sens du vent.
   *
   * On agrège : les étiquettes de toutes les copies, pour que le filtre les
   * retrouve toutes, et surtout COMBIEN il reste d'exemplaires LIBRES. C'est
   * ce nombre-là qui décide si la carte est vendable, et c'est lui qui
   * manquait.
   */
  const copieLibre = (c) => !(c.tags || []).length && !c.starred;

  function cartesDistinctes(cards) {
    const out = [];
    const vus = new Map();
    /*
     * Ici on ne se garde PAS de la pagination qui rend deux fois la même
     * ligne : `fetchCollectionRaw` l'écarte déjà à la lecture, sur
     * l'identifiant d'exemplaire, et compte ce qu'elle a écarté dans
     * `sell.doublons`. Un second filtre serait un code que rien ne peut faire
     * échouer — et une seconde vérité sur le même fait.
     *
     * L'index de la revente, lui, lit la collection par un autre chemin et se
     * garde tout seul : voir `exemplairesVus` dans `ownedIndex`.
     */
    for (const c of cards) {
      if (!c.id) continue;
      const vu = vus.get(c.id);
      if (!vu) {
        const neuf = { ...c, tags: (c.tags || []).slice(),
                       exemplaires: 1, libres: copieLibre(c) ? 1 : 0 };
        vus.set(c.id, neuf);
        out.push(neuf);
        continue;
      }
      vu.exemplaires += 1;
      if (copieLibre(c)) vu.libres += 1;
      for (const t of c.tags || []) if (!vu.tags.includes(t)) vu.tags.push(t);
    }
    return out;
  }

  /** Un exemplaire de la collection, réduit à ce dont la cote a besoin. */
  const ligneCollection = (e) => ({
    id: e.card_id,
    t: e.card?.wikipedia_title || '',
    r: e.card?.rarity || '?',
    cat: e.card?.category || '',
    vues: e.card?.pageviews || 0,
    tags: (e.tags || []).map((x) => (typeof x === 'string' ? x : x.name)).filter(Boolean),
    /*
     * L'étoile appartient à l'EXEMPLAIRE, comme les étiquettes. Le tableau ne
     * la lisait pas : une carte mise en favori s'y affichait « libre », avec
     * son bouton « Vendre », et la file la refusait ensuite en silence. Deux
     * avis contraires sur le même fait, et le faux était celui qu'on voyait.
     */
    starred: !!e.starred,
  });

  /** La même collection, réduite à ce dont la cote a besoin. */
  async function fetchCollection(onProgress) {
    return (await fetchCollectionRaw(onProgress)).map(ligneCollection);
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
    /*
     * `total` aussi — il ne l'était pas, et c'est lui que `renderSell` teste
     * pour distinguer « lecture de la collection » de « cotation ». Au second
     * relevé il valait encore celui du premier : la Revente annonçait
     * « cotation 0 / N » figé pendant les deux minutes de lecture, soit
     * exactement le compteur bloqué sur zéro qu'on avait voulu supprimer.
     */
    sell.total = 0;
    renderSell();

    /*
     * La cotation ne peut commencer qu'une fois la collection lue — des
     * centaines de pages, plus longtemps encore quand le serveur freine. Sans compteur pendant ce
     * temps-là, le panneau affichait « cotation 0 / … » figé : impossible de
     * distinguer une lecture en cours d'un relevé en panne. On montre donc les
     * cartes lues au fil de l'eau.
     */
    sell.note = '';
    sell.refusVentes = 0;
    sell.refusVentesN = 0;
    const debut = Date.now();
    let cards = [];
    try {
      cards = await fetchCollection((n) => {
        sell.read = n;
        renderSell();
      });
    } catch (err) {
      cards = [];
      console.warn('[WikiMasters Tools] lecture de la collection interrompue :', err);
      sell.note = 'La lecture de votre collection s’est interrompue — réessayez.';
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
        if (sell.refus) console.warn('[WikiMasters Tools] collection refusée', sell.refus);
        sell.note = sell.refus
          ? 'Le serveur a refusé de lire votre collection. '
            + 'Rechargez la page ; si ça persiste, reconnectez-vous au site.'
          : 'Votre collection est revenue vide : rien à coter.';
      }
      renderSell();
      return;
    }

    // Ce que vous possédez, pour `tiragesACoter`. Une lecture tronquée n'en
    // dit rien de sûr : elle ne remplace pas la précédente.
    if (!sell.tronque) sell.possedees = { ids: new Set(cards.map((c) => c.id)), at: debut };

    /*
     * Un exemplaire par ligne, c'est la collection. Une carte par ligne, c'est
     * la cote.
     *
     * `fetchCollection` rend un exemplaire possédé par entrée — c'est sa
     * vérité, et le relevé de couverture s'en sert telle quelle. Mais la cote
     * porte sur une CARTE : son historique de ventes ne dépend pas du nombre
     * d'exemplaires qu'on en détient. Poser une ligne par exemplaire donnait
     * deux lignes identiques pour une carte détenue en double, avec le même
     * prix, la même amplitude et deux boutons « Vendre » qui ouvrent la même
     * fiche. Relevé sur un compte réel : 21 lignes pour rien, et un compte de
     * tête qui annonçait « N cartes » en comptant des lignes.
     *
     * Au passage, l'historique n'est plus demandé deux fois pour la même carte.
     */
    const distinctes = cartesDistinctes(cards);

    // La cotation avance carte par carte, pas exemplaire par exemplaire : c'est
    // ce que le compteur doit annoncer.
    sell.total = distinctes.length;

    /*
     * La BASE d'abord. La table `auctions` porte les mêmes ventes closes que
     * l'API du marché, mais elle se lit avec la session du joueur : ni
     * abonnement, ni une requête par carte. C'est le seul chemin qui coter un
     * compte sans PRO, et sur un compte PRO il remplace des minutes de scan par
     * quelques secondes.
     */
    if (prefs.db) {
      const parCarte = await dbSalesBulk(distinctes.map((c) => c.id), (n) => {
        sell.done = n;
        renderSell();
      });
      if (parCarte) {
        const enBase = [];
        for (const c of distinctes) {
          const px = parCarte.get(c.id) || [];
          if (px.length) enBase.push(coteRow(c, px));
        }
        sell.done = distinctes.length;
        finirScan(distinctes, enBase, cards.length);
        return;
      }
      // Base illisible (session, RLS, colonne renommée) : on retombe sur l'API.
    }

    /*
     * UNE requête avant les milliers. Le marché d'une carte n'a pas la même
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
      console.warn('[WikiMasters Tools] marché des cartes refusé', sonde.status || 'réseau');
      sell.note = sonde.status === 403
        ? 'les prix sont réservés aux comptes PRO — cochez « Accès direct à '
          + 'la base » dans les réglages : ils redeviennent lisibles sans l’abonnement'
        : 'le serveur a refusé de donner les prix du marché';
      renderSell();
      return;
    }
    if (!Array.isArray(sonde.data && sonde.data.sales) && avgOf(sonde.data) == null) {
      sell.scanning = false;
      // Même partage qu'ailleurs : l'écran dit qu'il n'y a rien à coter, la
      // liste des champs reçus — une trace de mise au point — va en console.
      sell.note = 'le serveur ne donne ni historique de ventes ni moyenne : rien à coter';
      console.info('[WikiMasters Tools] marché d’une carte — champs reçus :',
        Object.keys(sonde.data || {}).join(', ') || 'aucun');
      renderSell();
      return;
    }

    const queue = distinctes.slice();
    const rows = [];

    const worker = async () => {
      while (queue.length) {
        const c = queue.pop();
        try {
          const r = await fetchBorne(`/api/marketplace/cards/${c.id}/sales`, { credentials: 'same-origin' });
          if (r.status === 429) {
            queue.push(c);
            await delay(3000);
            continue;
          }
          /*
           * Un refus ne ressemblait à rien : la réponse d'erreur se parse en
           * JSON, `sales` y est absent, et la carte sortait « sans historique »
           * exactement comme une carte jamais vendue. Des milliers de refus de
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
             * des milliers de requêtes refusées — sans rien apprendre de plus, et
             * en s'enfonçant si c'est une garde anti-automatisation qui répond.
             * On s'arrête au bout de vingt-cinq, tant qu'aucune n'a abouti.
             */
            if (!rows.length && sell.refusVentesN >= REFUS_MAX) queue.length = 0;
            continue;
          }
          const d = await r.json();
          const px = (d.sales || []).map((s) => s.final_price).filter(Number.isFinite);
          if (px.length) {
            rows.push(coteRow(c, px));
          } else {
            // Pas d'historique, mais une moyenne : ce que le site donne sans
            // l'abonnement. Une seule valeur, et `coteSeule` le dit.
            const seule = avgOf(d);
            if (seule != null) rows.push(coteSeule(c, seule));
          }
        } catch (_) {
          /* carte ignorée */
        }
        sell.done += 1;
        if (sell.done % 50 === 0) renderSell();
      }
    };

    await Promise.all(Array.from({ length: SELL_POOL }, worker));
    finirScan(distinctes, rows, cards.length);
  }

  /**
   * Clôture d'un relevé, quelle que soit la source — base ou API du site.
   *
   * @param {object[]} cards Les cartes DISTINCTES de la collection. La
   *   liquidité par thème compte ainsi une carte une fois : détenue en double,
   *   elle pesait deux fois au dénominateur et une seule fois au numérateur —
   *   un thème paraissait donc moins liquide qu'il ne l'est.
   * @param {object[]} rows  Les cartes effectivement cotées.
   * @param {number} exemplaires Le nombre d'EXEMPLAIRES lus. C'est l'unité de
   *   `/api/my-collection/stats`, donc celle que la couverture doit comparer :
   *   mélanger les deux ferait apparaître un manque permanent égal au nombre
   *   de doublons.
   */
  function finirScan(cards, rows, exemplaires) {
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
      if (sell.refus) console.warn('[WikiMasters Tools] lecture interrompue', sell.refus);
      sell.note = `relevé partiel : lecture interrompue à ${cards.length.toLocaleString('fr-FR')} `
        + 'cartes, les cotes déjà connues sont gardées';
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
      if (sell.refusVentes) {
        console.warn('[WikiMasters Tools] historique des ventes refusé', sell.refusVentes);
      }
      sell.note = sell.refusVentes === 403
        ? 'les prix sont réservés aux comptes PRO — cochez « Accès direct à '
          + 'la base » dans les réglages : ils redeviennent lisibles sans l’abonnement'
        : sell.refusVentesN
          ? 'le serveur a refusé l’historique des ventes — relevé arrêté après '
            + `${sell.refusVentesN.toLocaleString('fr-FR')} cartes sur ${cards.length.toLocaleString('fr-FR')}`
          : `aucune de vos ${cards.length.toLocaleString('fr-FR')} cartes n’a d’historique de vente`;
      if (!sell.rows.length) sell.rows = rows;
    } else {
      sell.rows = rows;
      sell.note = '';
    }
    sell.checked = new Set(cards.map((c) => c.id));
    sell.at = Date.now();
    sell.tags = [...new Set(cards.flatMap((c) => c.tags))];
    // Le relevé vient de lire la collection entière : inutile que la prochaine
    // ouverture de la Revente la relise pour savoir ce qui est encore possédé.
    if (!sell.tronque) sell.prunedAt = Date.now();
    /*
     * L'ancre de la couverture. Une lecture tronquée n'en pose pas : elle n'a
     * pas vu la collection entière, et l'écrire ferait passer pour couvert ce
     * qu'elle n'a jamais lu — la faute même que `sell.tronque` évite deux blocs
     * plus haut en fusionnant au lieu d'écraser.
     */
    if (!sell.tronque) {
      sell.scanAt = Date.now();
      sell.scanTotal = exemplaires;
      sell.owned = { n: exemplaires, at: Date.now() };
    }
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
  /*
   * `minSales` par défaut au seuil du ⚠, et pas en dessous. À 2, le tableau
   * laissait passer — et classait en tête — exactement les lignes qu'il
   * signalait lui-même comme non fiables : sur les sept premières d'un compte
   * réel, les trois solides étaient toutes étiquetées donc invendables, et les
   * quatre seules à porter un bouton « Vendre » étaient les quatre marquées ⚠.
   * Deux seuils qui se contredisent ne valent pas mieux qu'aucun seuil.
   */
  const sellPrefs = { minSales: THIN_SALES, hideTags: [], hideTagged: false, rarity: '', onlyFree: true,
                      // « Tes ventes » déplié, et l'aide ouverte : repliés tant qu'on ne les demande pas.
                      journalOuvert: false, aide: false,
                      // Le tri choisi en cliquant une colonne (vide : l'ordre par défaut), son sens,
                      // le nom cherché, et combien de lignes on affiche.
                      tri: '', sens: -1, cherche: '', affiche: 200 };

  /*
   * Deux cents lignes à la fois. Un compte cote des milliers de cartes : tout
   * dessiner, c'était ~2 Mo de HTML reconstruits à chaque rafraîchissement de
   * la page — mesuré au banc à 190 ms de calcul pour 4 000 lignes, et `paint()`
   * compare les deux chaînes avant d'écrire. Personne ne lit la millième.
   */
  const PAGE_REVENTE = 200;

  /*
   * Ce qu'on trie quand on clique une colonne. Le nom se compare en français,
   * le reste en nombre ; une cote sans historique compte zéro vente.
   */
  const VALEUR_TRI = {
    r: (x) => RARITIES.length - RARITIES.indexOf(x.r),
    t: null,
    n: (x) => (x.seule ? 0 : x.n),
    comp: (x) => sell.comp.get(x.id) || 0,
    q3: (x) => x.q3 || x.med,
    med: (x) => x.med,
  };

  /** Les lignes dans l'ordre que vous avez choisi, ou telles quelles. */
  function trierVue(rows) {
    const k = sellPrefs.tri;
    if (!k || !(k in VALEUR_TRI)) return rows;
    const s = sellPrefs.sens;
    if (k === 't') return rows.slice().sort((a, b) => s * a.t.localeCompare(b.t, 'fr', { sensitivity: 'base' }));
    return rows.slice().sort((a, b) => s * (VALEUR_TRI[k](a) - VALEUR_TRI[k](b)));
  }

  /** Pour chercher un nom sans se soucier des accents ni des majuscules. */
  const sansAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  /** Une cote assise sur assez de ventes pour qu'on la classe devant. */
  const fiable = (x) => (!x.seule && x.n >= THIN_SALES ? 1 : 0);

  /*
   * Le relevé de la concurrence a-t-il eu lieu ? `sell.comp` vide se lisait
   * comme « personne ne vend rien », et le filtre « sans concurrence » laissait
   * alors passer TOUT le catalogue en le présentant comme exclusif. Mesuré au
   * chronomètre sur un compte réel : une carte sur dix annoncées « sans
   * concurrence » pendant le relevé ne l'était plus une fois celui-ci terminé.
   * L'absence de donnée n'est pas une donnée.
   */
  const concurrenceConnue = () => !!sell.compAt;

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
      // Le nom cherché dans la barre, accents et majuscules confondus.
      .filter((x) => !sellPrefs.cherche || sansAccents(x.t).includes(sansAccents(sellPrefs.cherche)))
      // Sans concurrence d'abord, puis par prix visé.
      .filter((x) => !sellPrefs.onlyFree || !concurrenceConnue() || !sell.comp.get(x.id))
      /*
       * Les cotes minces passent derrière, quel que soit leur prix. Trier sur
       * le seul prix revenait à classer par incertitude : moins une carte a de
       * ventes, plus son estimation est haute, plus elle remontait. Le haut du
       * tableau — celui qu'on lit — était donc systématiquement le moins sûr.
       */
      .sort((a, b) => fiable(b) - fiable(a) || (b.q3 || b.med) - (a.q3 || a.med));
  }

  /**
   * Ouvre la fiche de la carte au formulaire d'enchère, prix pré-rempli.
   *
   * Sur une COPIE LIBRE. La fiche se choisit par le titre, et la page
   * collection montre une tuile par exemplaire : ouvrir la première venue,
   * c'était ouvrir peut-être la copie que vous gardez, et la mettre en vente.
   * Faute de copie libre reconnue à l'écran, on n'ouvre rien, et on le dit.
   */
  async function prepareSale(title, price, tags = []) {
    closeSell();
    const ok = await openCardDetail(title, { libre: true, tags });
    if (ok === 'aucune libre') {
      setStatus(`« ${title} » : aucune copie libre à l'écran, rien n'a été ouvert.`, true);
      return;
    }
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

  /*
   * La tuile d'une copie LIBRE, reconnue à l'écran.
   *
   * Relevé sur le vrai site : la page collection montre une tuile par
   * exemplaire, l'étiquette y est écrite en clair, et le bouton étoile dit
   * « Ajouter aux favoris » tant que la copie n'est pas en favori. Une tuile
   * est tenue pour libre si elle ne porte aucune des étiquettes connues de la
   * carte, n'affiche rien que ses jumelles n'affichent aussi — une étiquette
   * écrite autrement que dans nos relevés se trahit ainsi — et n'est pas en
   * favori. Dans le doute, elle ne l'est pas.
   */
  function tuileLibre(tuile, jumelles, tags) {
    const textes = (t) => new Set([...t.querySelectorAll('*')]
      .filter((n) => !n.children.length && n.textContent.trim())
      .map((n) => n.textContent.trim()));
    const siens = textes(tuile);
    if (tags.some((t) => siens.has(t))) return false;
    if (jumelles.length > 1) {
      const communs = jumelles.map(textes).reduce((a, b) => new Set([...a].filter((x) => b.has(x))));
      if ([...siens].some((x) => !communs.has(x))) return false;
    }
    const etoile = [...tuile.querySelectorAll('button')]
      .find((b) => /favori/i.test(b.getAttribute('aria-label') || ''));
    return !etoile || /^ajouter/i.test(etoile.getAttribute('aria-label'));
  }

  /**
   * Recherche la carte dans la collection et ouvre sa fiche.
   *
   * @param {{libre?: boolean, tags?: string[]}} [opts] `libre` : n'ouvrir
   *   qu'une copie libre (voir `tuileLibre`). Rend alors « aucune libre » quand
   *   les tuiles sont là mais toutes gardées.
   */
  async function openCardDetail(title, { libre = false, tags = [] } = {}) {
    goFilteredTo('/collection', title);
    for (let i = 0; i < 40; i++) {
      await delay(250);
      const tuiles = [...document.querySelectorAll('h3')]
        .filter((x) => x.textContent.trim() === title)
        .map((h) => h.closest(CARD_ITEM))
        .filter(Boolean);
      if (!tuiles.length) continue;
      // Laisser la grille finir de se remplir : une tuile de plus peut être la libre.
      if (libre) await delay(400);
      const toutes = libre
        ? [...document.querySelectorAll('h3')].filter((x) => x.textContent.trim() === title)
          .map((h) => h.closest(CARD_ITEM)).filter(Boolean)
        : tuiles;
      const card = libre ? toutes.find((t) => tuileLibre(t, toutes, tags)) : toutes[0];
      if (!card) return 'aucune libre';
      (card.firstElementChild || card).click();
      await delay(900);
      return true;
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
  /**
   * Statistiques d'une série de prix — identiques quelle que soit la source.
   * Le relevé complet en avait sa propre copie, avec une clé `q3` écrite deux
   * fois : une ligne de cote ne se calcule qu'ici.
   */
  function coteRow(c, px) {
    const sorted = px.slice().sort((a, b) => a - b);
    const med = medianeDe(sorted);
    return {
      id: c.id, t: c.t || c.title, r: c.r || c.rarity, tags: c.tags || [], n: px.length,
      exemplaires: c.exemplaires || 1,
      libres: c.libres != null ? c.libres : ((c.tags || []).length || c.starred ? 0 : 1),
      theme: themeOf(c.cat || ''), vues: c.vues || 0,
      moy: Math.round(px.reduce((a, b) => a + b, 0) / px.length),
      med,
      q3: q3De(sorted, med),
      min: sorted[0], max: sorted[sorted.length - 1],
    };
  }

  /*
   * La médiane résiste aux ventes aberrantes, fréquentes ici — encore
   * faut-il que ce soit une médiane.
   *
   * `sorted[floor(n / 2)]` rend l'élément du HAUT sur un échantillon pair. Sur
   * deux ventes, une à 2 wikibidous et une à 10 000, il rendait donc 10 000 :
   * la « valeur du milieu » était le maximum, et le repli du prix visé sur la
   * médiane ne repliait sur rien. C'est le contrôle du vérificateur qui l'a
   * montré, en réclamant que le prix visé diffère du maximum.
   *
   * Sur un nombre pair, la médiane est la moyenne des deux valeurs centrales.
   */
  const medianeDe = (trie) => {
    const m = trie.length >> 1;
    return trie.length % 2 ? trie[m] : Math.round((trie[m - 1] + trie[m]) / 2);
  };

  /*
   * 3e quartile : on vend à la patience, pas au prix courant.
   *
   * Sauf qu'en dessous de cinq ventes, `floor(n × 0,75)` tombe sur le DERNIER
   * indice — 1 sur 2, 2 sur 3, 3 sur 4. Ce n'était donc pas une approximation
   * du quartile, c'était le MAXIMUM jamais atteint, et c'est lui qui partait
   * dans le formulaire de vente.
   *
   * Relevé à l'écran, sur un compte réel : une Rare cotée 1 565 sur trois
   * ventes dont la médiane est 28 — cinquante-six fois la médiane. Une Commune
   * à 10 000 sur deux ventes, l'une à 2 et l'autre à 10 000. Ces lignes-là
   * arrivaient en TÊTE du tableau, le tri se faisant sur ce prix.
   *
   * Le compteur de ventes conclues disait le reste : 14 sur 100.
   *
   * Le seuil est celui du ⚠ que le tableau affiche déjà — au-dessus,
   * `floor(n × 0,75)` désigne un vrai quartile haut ; en dessous, on s'en
   * tient à la médiane, qui ne peut pas être une valeur aberrante à elle
   * seule.
   */
  /*
   * Le prix visé ne peut pas s'éloigner indéfiniment de la médiane.
   *
   * Le 3e quartile est un prix réellement payé — un quart des ventes closes
   * l'ont dépassé. Sur un échantillon mince, c'est pourtant une valeur aberrante
   * déguisée en statistique : *Neptunium*, 8 ventes, médiane 233, prix visé
   * **5 000**. Personne ne l'achète, et le taux de ventes conclues est passé de
   * 16 à 11 sur 100 pendant que ces prix-là dormaient en tête de tableau.
   *
   * Mesuré sur un millier de cartes cotées, rapport q3/médiane par taille
   * d'échantillon :
   *
   *   ventes   cartes   médian   p90    max
   *    5–7      326      1,47    3,70   30,0
   *    8–11     222      1,91    4,67   21,5
   *    12–19    187      2,17    4,50   19,4
   *    20–34    136      2,14    3,73    8,3
   *    35+      133      1,54    2,33    5,5
   *
   * Le rapport MÉDIAN ne bouge pas — il reste entre 1,5 et 2,2 partout. C'est
   * le maximum qui s'effondre quand l'échantillon grandit : 30× à six ventes,
   * 5,5× à trente-cinq. Une carte bien échantillonnée ne justifie jamais un
   * écart pareil ; les 20× et 30× ne vivent que là où trois ventes suffisent à
   * faire un quartile. C'est du bruit, et on ne met pas un prix dessus.
   *
   * Le plafond est donc posé à 3× : au-dessus du rapport médian de TOUTES les
   * tranches (2,17 au pire) et au-dessus du p90 de la seule tranche à laquelle
   * on puisse se fier (2,33 à 35 ventes et plus). Ce qui dépasse est coupé.
   *
   * Ce que ça ne fait pas : baisser les prix en général. Le rapport médian
   * étant de 1,8, l'immense majorité des lignes ne bouge pas — moins d'une
   * carte cotée sur cinq dépassait 3×.
   */
  const Q3_PLAFOND = 3;

  const q3De = (trie, med) =>
    trie.length < THIN_SALES
      ? med
      : Math.min(
          trie[Math.min(trie.length - 1, Math.floor(trie.length * 0.75))],
          Math.round(med * Q3_PLAFOND)
        );

  /**
   * La cote quand le site ne rend qu'une moyenne — ce que voit un compte sans
   * abonnement. Une seule valeur, donc médiane et 3e quartile la valent, et
   * `seule` le dit : le tableau ne doit pas faire passer une estimation pour
   * une statistique.
   */
  const coteSeule = (c, moy) => ({
    id: c.id, t: c.t || c.title, r: c.r || c.rarity, tags: c.tags || [], n: 0, seule: true,
    exemplaires: c.exemplaires || 1,
    libres: c.libres != null ? c.libres : ((c.tags || []).length || c.starred ? 0 : 1),
    theme: themeOf(c.cat || ''), vues: c.vues || 0,
    moy, med: moy, q3: moy, min: moy, max: moy,
  });

  /*
   * La cote d'un lot de cartes, lue en base.
   *
   * `/api/marketplace/cards/<id>/sales` demande une requête par carte : cinq
   * par paquet ouvert. Tant que la boucle attendait six secondes entre deux
   * paquets, ça passait inaperçu ; à une seconde, ce trafic est six fois plus
   * dense — et c'est le débit cumulé, tous endpoints confondus, qui déclenche
   * la garde anti-automatisation du site.
   *
   * Le critère de « vendue » est `final_price` non nul, et non une valeur de
   * `status` : vérifié en comparant les deux sources sur la même carte, elles
   * rendent la même liste de prix.
   *
   * C'est la découverte qui a débloqué les comptes sans abonnement : l'onglet
   * Marché d'une carte est vendu avec le PRO, et `/api/marketplace/cards/<id>/
   * sales` répond 403 à un compte gratuit — mais la table `auctions`, elle, se
   * lit avec la session du joueur, sans passer par cette API. Les prix sont les
   * mêmes : ce sont les ventes closes du jeu.
   *
   * Le gain est double. Sans abonnement, le relevé devient possible ; avec, il
   * passe d'une requête par carte à une par lot de cinquante.
   *
   * `limit` borne chaque réponse : un lot qui la touche est peut-être tronqué,
   * et une moyenne calculée sur une moitié de ventes serait fausse sans le
   * dire. On le recoupe alors en deux, jusqu'à passer sous la borne.
   *
   * Il y avait à côté une seconde fonction pour les petits lots, avec la même
   * requête mais SANS cette recoupe : un lot qui touchait la borne tronquait en
   * silence. Un seul chemin, celui qui sait se recouper.
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
    // Une carte tirée deux fois dans le même lot ne fait qu'une ligne : sans
    // ce tri, elle en faisait deux, identiques, jusqu'au rechargement suivant.
    const todo = [...new Map(cards.filter((c) => c.id && !sell.checked.has(c.id))
      .map((c) => [c.id, c])).values()];
    if (!todo.length) return;
    let ajout = 0;

    // Chemin direct : un aller-retour pour tout le lot.
    const lot = await dbSalesBulk(todo.map((c) => c.id));
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
          const r = await fetchBorne(`/api/marketplace/cards/${c.id}/sales`, { credentials: 'same-origin' });
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
          sell.rows.push(coteSeule(c, seule));
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
   * collection. On revérifie donc ce que tu possèdes encore, sans refaire le
   * relevé des prix — c'est lui qui prend des minutes.
   *
   * Mais la vérification n'était bornée par rien, et elle part à CHAQUE
   * ouverture de la Revente : deux cent quarante requêtes pour rouvrir un
   * panneau qu'on venait de fermer. La possession bouge vite à l'échelle de la
   * cote, pas à celle du clic — dix minutes suffisent, et un relevé complet
   * repousse l'échéance puisqu'il vient de lire la collection entière.
   */
  const PRUNE_TTL = 600000;

  /*
   * La recherche par titre du site, telle qu'elle se comporte vraiment —
   * relevé en lecture seule sur le vrai site :
   *
   * - sous trois caractères elle ne rend RIEN, carte possédée ou non : « M »
   *   ou « 90 » reviennent vides. Une absence n'y prouve donc rien ;
   * - elle rend cinquante lignes par page, sans total. Un titre court a des
   *   homonymes par dizaines, et une page pleine ne dit pas s'il y en a
   *   d'autres derrière ;
   * - la ponctuation, les accents et les parenthèses passent.
   *
   * `VERIF_MAX` borne le coût d'un nettoyage : on en a mesuré quelques
   * dizaines d'absentes par lecture, pas des centaines. Au-delà, les cartes
   * restent au tableau jusqu'au nettoyage suivant plutôt que d'être tranchées
   * sans avoir été cherchées.
   */
  const Q_MIN = 3;
  const Q_PAGES_MAX = 4;
  const VERIF_MAX = 60;
  const cherchable = (titre) => [...(titre || '')].length >= Q_MIN;

  /**
   * Les exemplaires d'une carte, demandés au serveur par son titre.
   *
   * Le filtre est une correspondance PARTIELLE : il rend aussi les homonymes
   * plus longs. On ne garde donc que les lignes de CETTE carte, par son
   * identifiant — la leçon du scénario 35.
   *
   * @returns {Promise<object[]|null>} ses exemplaires — vide : elle n'est plus
   *   dans la collection —, ou `null` quand la réponse ne permet pas de conclure
   *   (réseau, refus, homonymes au-delà des pages lues).
   */
  async function exemplairesParTitre(id, titre, brut = false) {
    const copies = new Map();
    // `brut` : les lignes telles que le site les rend, identifiant de COPIE compris.
    const rendre = () => (brut ? [...copies.values()] : [...copies.values()].map(ligneCollection));
    for (let page = 0; page < Q_PAGES_MAX; page++) {
      let d;
      try {
        d = await api(`/api/my-collection?page=${page}&q=${encodeURIComponent(titre)}`);
      } catch (_) {
        return null;
      }
      const lignes = d.status === 200 && d.data && Array.isArray(d.data.collection)
        ? d.data.collection : null;
      if (!lignes) return null;
      if (Array.isArray(d.data.pendingTradeCardIds)) for (const x of d.data.pendingTradeCardIds) sell.echanges.add(x);
      for (const e of lignes) if (e.card_id === id && e.id != null) copies.set(e.id, e);
      if (lignes.length < COLLECTION_PAGE) return rendre();
    }
    // Des homonymes à perte de vue : ce qu'on a trouvé est sûr, l'absence non.
    return copies.size ? rendre() : null;
  }

  async function pruneSold() {
    if (sell.scanning || !sell.rows.length) return;
    if (Date.now() - sell.prunedAt < PRUNE_TTL) return;
    const debut = Date.now();
    let cards;
    try {
      cards = await fetchCollection();
    } catch (_) {
      return; // réseau : on garde la liste telle quelle plutôt que de la vider
    }
    // Lecture vide ou tronquée : on ne conclut rien. Retirer une carte que le
    // serveur n'a pas rendue reviendrait à effacer sa cote pour une coupure.
    if (!cards.length || sell.tronque) return;
    sell.prunedAt = Date.now();

    /*
     * UNE CARTE QUE LA LECTURE N'A PAS VUE N'EST PAS UNE CARTE VENDUE.
     *
     * La pagination du site saute des lignes, et pas rarement : relevé en
     * lecture seule sur un vrai compte, boucle en marche dans un autre onglet,
     * trois lectures de suite ont chacune manqué plusieurs cartes possédées —
     * jamais les mêmes. Le nettoyage les retirait toutes, à chaque ouverture :
     * la Revente perdait des cartes que vous aviez, jusqu'au relevé complet.
     *
     * On demande donc au serveur, par le titre, chaque carte absente de la
     * lecture — la règle que `reconcileWatch` suit déjà. Retrouvée : elle reste,
     * recomptée sur ses vrais exemplaires. Introuvable sur une réponse qui
     * permet de conclure : elle part. Sinon on la laisse telle qu'elle était.
     */
    /*
     * ET UNE CARTE EN VENTE N'EST PAS PARTIE NON PLUS.
     *
     * Sur le site, l'exemplaire mis aux enchères quitte la collection le temps
     * de l'enchère : ni la lecture ni la recherche par titre ne le rendent. Le
     * nettoyage retirait donc la ligne — et si l'enchère finissait sans
     * acheteur, l'exemplaire revenait sans que rien ne remette la ligne avant le
     * relevé complet suivant. L'état « en vente » d'une ligne ne se voyait
     * presque jamais.
     *
     * Une carte de vos ventes en cours, relevé frais, garde donc sa ligne telle
     * quelle : elle s'affiche « en vente », et reste si personne n'achète. Une
     * vente conclue la fait sortir de vos ventes, et le nettoyage suivant — que
     * la notification de vente déclenche — la retire.
     */
    const ventesFraiches = state.sales.at && Date.now() - state.sales.at < VENTES_FRAICHES_MS;
    const enVente = new Set(ventesFraiches ? (state.sales.list || []).map((v) => v.card).filter(Boolean) : []);
    const lues = new Set(cards.map((c) => c.id));
    // Les lignes qu'on laisse telles qu'elles étaient : en vente, ou sans réponse
    // qui permette de conclure.
    const inchangees = new Set();
    let demandes = 0;
    for (const r of sell.rows) {
      if (lues.has(r.id)) continue;
      if (enVente.has(r.id)) { inchangees.add(r.id); continue; }
      let copies = null;
      if (cherchable(r.t) && demandes < VERIF_MAX) {
        demandes += 1;
        copies = await exemplairesParTitre(r.id, r.t);
      }
      if (copies) cards.push(...copies);
      else inchangees.add(r.id);
    }
    // Un relevé complet a fini pendant ces vérifications : ses lignes sont plus
    // fraîches que notre lecture, on ne les touche pas.
    if (sell.scanning || sell.scanAt >= debut) return;

    /*
     * Les EXEMPLAIRES se recomptent ici, pas seulement les étiquettes.
     *
     * Vendre un double laisse la carte au tableau — il vous en reste une, et sa
     * cote reste juste. Mais la ligne gardait le compte d'avant la vente : un
     * exemplaire libre, alors qu'il ne restait que la copie gardée. Elle
     * proposait donc « Vendre » sur une carte vendue pour de bon, jusqu'au
     * relevé complet suivant — signalé à l'usage.
     *
     * Et les étiquettes se lisaient sur UN exemplaire, le dernier rencontré :
     * la faute que `cartesDistinctes` a réparée pour le relevé complet. On
     * passe par elle — un seul décompte pour les deux chemins.
     */
    const parCarte = new Map(cartesDistinctes(cards).map((c) => [c.id, c]));
    sell.possedees = { ids: new Set(parCarte.keys()), at: debut };
    sell.rows = sell.rows.filter((r) => parCarte.has(r.id) || inchangees.has(r.id));
    for (const r of sell.rows) {
      const c = parCarte.get(r.id);
      if (!c) continue;   // en vente ou sans conclusion : laissée telle qu'elle était
      r.tags = c.tags;
      r.exemplaires = c.exemplaires;
      r.libres = c.libres;
    }
    sell.tags = [...new Set(cards.flatMap((c) => c.tags))];
    saveCote();
    renderSell();
  }

  /*
   * Les tirages de l'historique à coter à l'ouverture — ceux que vous avez
   * ENCORE.
   *
   * Ce rattrapage cote les cartes des paquets qui auraient échappé à la cote,
   * sans relire toute la collection. Il ne demandait pas si elles étaient
   * toujours là. `priceCards` écarte ce qu'elle a déjà vu, mais « déjà vu » se
   * reconstruit à chaque rechargement depuis les lignes du tableau — dont
   * `pruneSold` venait justement de retirer la carte vendue. Elle redevenait
   * inconnue, se faisait recoter, et revenait au tableau avec son bouton
   * « Vendre » jusqu'au nettoyage suivant, puis encore au rechargement d'après.
   * D'où une panne « pas tout le temps ».
   *
   * La dernière lecture complète de la collection tranche : une carte tirée
   * AVANT elle, et qu'elle n'a pas vue, n'est plus à vous. Une carte tirée
   * APRÈS n'a pas pu y figurer — c'est celle qu'on veut coter. Sans lecture du
   * tout, rien : les cartes neuves se cotent déjà à l'ouverture de leur paquet,
   * et on ne propose pas à la vente ce qu'on n'a pas su compter.
   */
  function tiragesACoter() {
    const p = sell.possedees;
    if (!p) return [];
    const vus = new Map();
    for (const c of state.history) {
      if (!c.id || vus.has(c.id)) continue;
      if (!p.ids.has(c.id) && !(Date.parse(c.at) >= p.at)) continue;
      vus.set(c.id, { id: c.id, t: c.title, r: c.rarity, tags: [] });
    }
    return [...vus.values()];
  }

  async function refreshCompetition() {
    if (Date.now() - sell.compAt < MARKET_TTL) return;
    try {
      const c = await fetchCompetition();
      /*
       * Relevé interrompu : on garde le précédent, et on le DIT. Écraser avec
       * un compte incomplet ferait passer pour « sans concurrence » des cartes
       * dont les annonces n'ont simplement pas été lues — or c'est le filtre
       * coché par défaut, celui sur lequel se décide quoi mettre en vente.
       */
      sell.compTronque = !c;
      if (!c) {
        renderSell();
        return;
      }
      sell.comp = c;
      sell.compAt = Date.now();
      renderSell();
    } catch (_) {
      /* réseau : on garde le relevé précédent */
    }
  }

  /*
   * La taille de la collection vient de `refreshOwned`, avec les objectifs :
   * `/api/my-collection/stats` porte `total`, et la même requête sert le palier
   * de l'onglet Succès. C'est le seul chiffre qui manquait pour dire de quelle
   * part de la collection la cote rend compte — un aller-retour, là où compter
   * les cartes en coûte un par page.
   *
   * Échec silencieux et assumé : sans ce nombre, la couverture ne s'affiche
   * pas. Une Revente qui refuserait de s'ouvrir parce qu'un compteur d'appoint
   * n'a pas répondu serait une régression pour une information de confort.
   */

  /**
   * Ce que la cote couvre, ou `null` quand on ne peut rien en dire.
   *
   * Deux manques bien distincts, et un seul serait mensonger :
   * `manquantes` sont les cartes arrivées depuis le dernier relevé complet —
   * celles que « Rafraîchir la cote » ira vraiment chercher. Les cartes lues
   * mais jamais vendues n'en font pas partie : elles n'ont pas de prix parce
   * qu'il n'en existe aucun, et aucun bouton n'y changera rien.
   */
  function couverture() {
    const total = sell.owned.n;
    if (!total) return null;

    /*
     * Deux régimes, et c'est le second qui a motivé tout ceci.
     *
     * Sans relevé complet, la cote n'a jamais été qu'un dépôt : cinq cartes par
     * paquet, cumulées. La part couverte est alors le nombre de lignes qu'elle
     * porte — et « Rafraîchir la cote » va chercher tout le reste. C'est le cas
     * mesuré à 17 %, celui où le silence coûtait le plus cher.
     *
     * Avec un relevé complet daté, la collection entière a été vue ce jour-là :
     * ne manque que ce qui est arrivé depuis.
     */
    const vues = sell.scanAt && sell.scanTotal
      ? Math.min(sell.scanTotal, total)
      : Math.min(sell.rows.length, total);
    return { total, vues, manquantes: Math.max(0, total - vues),
             complet: !!sell.scanAt,
             pct: Math.round((vues / total) * 100) };
  }

  /*
   * Le seuil à partir duquel on en parle.
   *
   * Cinq cartes par paquet : au lendemain d'un relevé complet il en manque
   * quelques dizaines, et l'annoncer ferait clignoter une alerte permanente
   * pour un écart qui ne change aucune décision. On se tait donc sous 2 % ET
   * sous 200 cartes — au-delà, le tri par prix range assez de cartes en fin de
   * liste pour que le silence devienne trompeur.
   */
  /*
   * Au-delà, le relevé des ventes ne sert plus à marquer une ligne « en
   * vente » : il dit ce qui ÉTAIT vrai.
   *
   * DEUX FOIS la fenêtre du volet Relances (`VENTES_POUR_AGIR_MS`, 60 s), et
   * c'est voulu — le commentaire annonçait « la même » alors que les deux
   * chiffres ont toujours différé. AFFICHER une ligne « en vente » sur un
   * relevé de deux minutes ne coûte qu'une pastille en retard ; AGIR dessus
   * remettrait une carte en vente alors qu'elle y est déjà.
   */
  const VENTES_FRAICHES_MS = 120000;

  const COUV_PCT = 2;
  const COUV_CARTES = 200;

  function couvertureDistancee() {
    const c = couverture();
    return c && c.manquantes >= COUV_CARTES && 100 - c.pct >= COUV_PCT ? c : null;
  }

  function openSell() {
    sell.open = true;
    sellPrefs.affiche = PAGE_REVENTE;
    syncJournal();
    refreshCompetition();
    refreshOwned();
    /*
     * Vos ventes, relues à l'ouverture.
     *
     * Elles ne l'étaient pas — la page relisait le journal, la concurrence et
     * la taille de la collection, mais pas ce qui est en vente. Or c'est ce
     * relevé qui décide du « en vente » d'une ligne et du surlignage « à
     * lister maintenant ». Ouverte cinq minutes après le dernier tour du
     * guetteur, la Revente affirmait donc l'état d'il y a cinq minutes : une
     * carte vendue entre-temps y était encore « en vente », une carte qu'on
     * venait de lister proposait toujours « Vendre ».
     *
     * `scanSales` porte son propre verrou de ré-entrée : l'appeler ici ne
     * double aucun tour en vol.
     */
    const ventesRelues = scanSales();
    /*
     * Un compte gratuit s'est déjà vu refuser le marché : relancer le relevé à
     * chaque ouverture, c'est vingt-cinq requêtes refusées de plus pour le même
     * message. Le bouton « Rafraîchir la cote » reste là si l'abonnement change.
     *
     * Le nettoyage attend la relecture des ventes : c'est elle qui lui dit
     * quelles cartes sont en vente, donc absentes de la collection sans être
     * parties.
     */
    if (!sell.rows.length && !sell.scanning && sell.refusVentes !== 403) scanCote();
    // Une relecture en échec ne prive pas du nettoyage : il se passera
    // simplement de savoir ce qui est en vente, comme avant.
    else ventesRelues.catch(() => {}).then(pruneSold).then(() => priceCards(tiragesACoter()));
    renderSell();
  }

  function closeSell() {
    sell.open = false;
    saisieFile = null;
    desarmerDefausse();
    renderSell();
  }

  /*
   * Échap ferme la Revente. C'est une modale plein écran — `inset: 0`, au
   * sommet de la pile — et elle ne se fermait qu'au ✕ ou au clic sur le fond :
   * le réflexe qu'a tout le monde devant une modale ne donnait rien.
   *
   * L'écouteur est posé sur la fenêtre du site, pas sur l'ombre : le focus
   * peut très bien être resté dans la page derrière. Il ne fait rien quand la
   * Revente est fermée, et laisse passer les combinaisons — Échap seul.
   */
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !sell.open) return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    // Un prix en cours de saisie : Échap l'abandonne, sans fermer la page.
    if (saisieFile) { saisieFile = null; renderSell(); return; }
    closeSell();
  });

  /*
   * LA DÉFAUSSE EN LOT, demandée sur #suggestions : « j'ai beaucoup trop de
   * cartes, et je défausse la plupart de celles que je trouve dans mes
   * paquets ». Plutôt qu'une défausse automatique à l'ouverture des paquets —
   * au hasard des tirages —, on coche dans la Revente les cartes dont on ne
   * veut pas, et on les défausse d'un coup.
   *
   * C'est le geste le plus destructeur de l'outil : une carte défaussée ne
   * revient pas. D'où trois barrières, toutes tenues AU MOMENT de défausser,
   * sur une lecture fraîche de la collection — jamais sur l'état du tableau :
   *
   * - seules partent les copies LIBRES : jamais une copie étiquetée ou en
   *   favori, la règle de toute la revente ;
   * - jamais une carte en vente ou en file, ni un exemplaire engagé dans un
   *   échange en attente (le site en donne la liste avec chaque page) ;
   * - deux clics, le second jamais dans la foulée du premier, et le premier
   *   dit combien d'exemplaires partiront.
   *
   * L'appel est celui du site, relevé dans son propre code :
   * `POST /api/user-cards/bulk-discard { card_ids: [...] }` — des identifiants
   * d'EXEMPLAIRE, sous `user_cards` — qui rend `discarded_count`. Il ne rend
   * pas la récompense : le bilan ne dit donc que le nombre défaussé. La
   * différence de solde a été écartée — une vente conclue pendant la défausse
   * l'aurait faussée.
   */
  const DEFAUSSE_LOT = 50;
  // Au-delà, une requête par carte coûterait plus que la lecture complète.
  const DEFAUSSE_PAR_TITRE_MAX = 100;
  let defausseArmeeA = 0;
  let defausseTimer = null;

  const desarmerDefausse = () => { defausseArmeeA = 0; clearTimeout(defausseTimer); };

  /** Les cartes cochées que la défausse peut toucher, parmi celles affichées. */
  function cocheesDefaussables(rows = sellRows(), mesVentes = resumeRevente(rows).mesVentes) {
    return rows.filter((r) => sell.aDefausser.has(r.id)).filter((r) => {
      const e = etatLigne(r, mesVentes, 0);
      return !e.protegee && !e.dejaEnVente && !e.enFile;
    });
  }

  async function defausserCochees() {
    if (sell.scanning || (sell.defausse && sell.defausse.enCours)) return;
    const cartes = cocheesDefaussables();
    desarmerDefausse();
    if (!cartes.length) return;
    sell.defausse = { enCours: true, lues: 0, total: cartes.length };
    renderSell();

    /*
     * Les exemplaires, lus MAINTENANT — ceux des cartes cochées seulement.
     *
     * Par le TITRE d'abord : une requête par carte, quatre à la fois. La
     * première version relisait toute la collection pour retrouver dix
     * cartes — des centaines de pages, et une défausse qui paraissait figée.
     * Signalé à l'usage : « très longue alors qu'il n'y avait que 10
     * exemplaires ». Ne passent par la lecture complète que les cartes que le
     * titre ne tranche pas (titre trop court, homonymes, panne) et les très
     * grosses sélections, où une requête par carte coûterait davantage.
     */
    const copies = new Map();
    const aLire = [];
    if (cartes.length <= DEFAUSSE_PAR_TITRE_MAX) {
      for (let i = 0; i < cartes.length; i += 4) {
        await Promise.all(cartes.slice(i, i + 4).map(async (r) => {
          const trouvees = cherchable(r.t) ? await exemplairesParTitre(r.id, r.t, true) : null;
          if (trouvees) copies.set(r.id, trouvees);
          else aLire.push(r);
        }));
        sell.defausse.lues = Math.min(cartes.length, i + 4);
        renderSelection();
      }
    } else aLire.push(...cartes);
    if (aLire.length) {
      const ids = new Set(aLire.map((r) => r.id));
      let brut = [];
      try {
        brut = await fetchCollectionRaw((n) => { sell.defausse.pages = n; renderSelection(); });
      } catch (_) { brut = []; }
      for (const e of brut) {
        if (!ids.has(e.card_id) || e.id == null) continue;
        if (!copies.has(e.card_id)) copies.set(e.card_id, []);
        copies.get(e.card_id).push(e);
      }
    }
    sell.defausse.envoi = true;
    renderSelection();

    const aEnvoyer = [];
    const laissees = [];
    const libresDe = new Map();
    for (const r of cartes) {
      const libres = (copies.get(r.id) || []).filter((e) => !(e.tags || []).length && !e.starred
        && !sell.echanges.has(e.id) && !sell.echanges.has(e.card_id));
      if (!libres.length) { laissees.push(r.t); continue; }
      libresDe.set(r.id, libres.map((e) => e.id));
      aEnvoyer.push(...libres.map((e) => e.id));
    }

    let defaussees = 0;
    let erreur = '';
    const parties = new Set();
    for (let i = 0; i < aEnvoyer.length; i += DEFAUSSE_LOT) {
      const lot = aEnvoyer.slice(i, i + DEFAUSSE_LOT);
      let d;
      try { d = await api('/api/user-cards/bulk-discard', 'POST', { card_ids: lot }); } catch (_) { d = { status: 0 }; }
      // Un refus arrête tout : on ne s'obstine pas sur un geste irréversible.
      if (d.status !== 200) { erreur = d.status ? `refus ${d.status}` : 'réseau'; break; }
      console.info('[WikiMasters Tools] défausse — réponse du serveur :', d.data);
      defaussees += Number.isFinite(d.data && d.data.discarded_count) ? d.data.discarded_count : lot.length;
      for (const x of lot) parties.add(x);
    }

    // Le tableau suit : chaque carte perd ses exemplaires partis, et sort s'il n'en reste aucun.
    const sorties = new Set();
    for (const r of cartes) {
      const partis = (libresDe.get(r.id) || []).filter((x) => parties.has(x)).length;
      if (!partis) continue;
      const lues = copies.get(r.id) || [];
      r.exemplaires = lues.length - partis;
      r.libres = Math.max(0, lues.filter((e) => !(e.tags || []).length && !e.starred).length - partis);
      if (r.exemplaires <= 0) sorties.add(r.id);
    }
    sell.rows = sell.rows.filter((r) => !sorties.has(r.id));
    if (sell.possedees) for (const id of sorties) sell.possedees.ids.delete(id);
    sell.aDefausser.clear();
    sell.owned = { ...sell.owned, at: 0 };   // la collection a rétréci : à recompter
    saveCote();
    sell.defausse = { fini: true, exemplaires: defaussees, laissees, erreur };
    renderSell();
    render();
  }

  /** La barre de la sélection : ce qui est coché, le geste, puis le bilan. */
  function renderSelection(rows, mesVentes) {
    const bar = sellUI.selbar;
    const d = sell.defausse;
    const pl = (n, mot) => `${n} ${mot}${n > 1 ? 's' : ''}`;
    if (d && d.enCours) {
      bar.hidden = false;
      // Où en est la défausse : une attente sans chiffre ressemble à un blocage.
      paint(bar, `<span>Défausse en cours : ${d.envoi ? 'envoi au site…'
        : d.pages ? `lecture de votre collection, ${d.pages.toLocaleString('fr-FR')} exemplaires lus…`
          : `vérification des exemplaires, ${d.lues || 0} / ${d.total} ${d.total > 1 ? 'cartes' : 'carte'}…`}</span>`);
      return;
    }
    const cartes = cocheesDefaussables(rows, mesVentes);
    if (cartes.length) {
      const ex = cartes.reduce((s, r) => s + (r.libres != null ? r.libres : 1), 0);
      const arme = !!defausseArmeeA;
      bar.hidden = false;
      paint(bar, `<span><b>${pl(cartes.length, 'carte')}</b> ${cartes.length > 1 ? 'cochées' : 'cochée'}`
        + ` · ${pl(ex, 'exemplaire')} ${ex > 1 ? 'libres' : 'libre'}</span>`
        + `<button class="defausse${arme ? ' arme' : ''}" data-defausser title="Détruit définitivement les copies libres`
        + ' des cartes cochées. Jamais une copie étiquetée ou en favori, ni une carte en vente, en file ou engagée'
        + ` dans un échange. Deux clics.">${arme ? `Confirmer : défausser ${pl(ex, 'exemplaire')} ?` : 'Défausser'}</button>`
        + '<button data-decocher>Tout décocher</button>');
      return;
    }
    if (d && d.fini) {
      bar.hidden = false;
      paint(bar, `<span><b>${pl(d.exemplaires, 'exemplaire')}</b> ${d.exemplaires > 1 ? 'défaussés' : 'défaussé'}`
        + (d.laissees.length ? ` · ${pl(d.laissees.length, 'carte')} ${d.laissees.length > 1 ? 'laissées' : 'laissée'} :`
          + ' plus de copie libre, ou engagée dans un échange' : '')
        + (d.erreur ? ` · le site a arrêté la défausse (${esc(d.erreur)})` : '')
        + '</span><button data-bilanok>OK</button>');
      return;
    }
    bar.hidden = true;
  }

  /**
   * Le champ de prix d'une ligne et ses deux boutons, pour « Mettre en file »
   * comme pour « Vendre un double » : `valider` est le libellé du bouton qui
   * inscrit.
   */
  const editeurPrix = (valider) => `<span class="fedit"><input type="number" data-fprix min="1" step="1"`
    + ` value="${esc(String(saisieFile.prix))}" aria-label="Prix de mise en file"`
    + ` title="Le prix visé est proposé : gardez-le ou changez-le. Entrée pour valider, Échap pour annuler.">`
    + `<span class="u">wb</span><button class="go" data-fok>${esc(valider)}</button>`
    + '<button class="go" data-fnon>Annuler</button></span>';

  /**
   * « en vente » ou « en file » : les deux états d'une ligne qui renvoient au
   * panneau, là où la vente et la file se suivent déjà — voir `ouvrirVolet`.
   * `protegee` n'arrive ici, pour la file, que sur UNE copie d'un double
   * gardé : voir `fileAffichee` dans `etatLigne`.
   */
  function renvoiAuPanneau(x, enVente, protegee, copies) {
    if (enVente) {
      return '<button class="encours" data-volet="vent" title="Votre enchère court déjà sur cette carte :'
        + ' elle occupe un de vos emplacements de vente. Cliquez pour ouvrir le volet Ventes du panneau,'
        + ' avec son échéance.">en vente</button>';
    }
    const prix = fmtWb(state.watch[x.id].price);
    const dit = protegee
      ? `Une de vos ${copies} copies gardées est dans la file, à ${prix} wb — les autres restent gardées.`
      : `Dans la file, à ${prix} wb : elle partira dès qu’un de vos dix emplacements se libère.`;
    return `<button class="encours file" data-volet="rel" data-carte="${esc(x.id)}" title="${dit}`
      + ' Cliquez pour l’ouvrir dans le volet Relances du panneau : prix, durée, ou la retirer de la file.">en file</button>';
  }

  /**
   * Inscrit en file la carte dont on vient de choisir le prix — une carte
   * libre, ou UNE copie d'un double gardé (`saisieFile.double`).
   */
  function confirmerFile() {
    if (!saisieFile) return;
    // Un double gardé : pas de validation dans le même geste que l'ouverture.
    if (saisieFile.double && Date.now() - saisieFile.ouvertA < WISH_ARME_MIN_MS) return;
    const prix = Math.round(Number(saisieFile.prix));
    if (!(prix >= 1)) {
      const champ = sellUI.scroll.querySelector('[data-fprix]');
      if (champ) { champ.classList.add('ko'); champ.focus(); }
      return;
    }
    if (saisieFile.double) enrolWatch(saisieFile.id, saisieFile.titre, prix, FILE_MINUTES, 0, false, true);
    else enrolWatch(saisieFile.id, saisieFile.titre, prix, FILE_MINUTES, 0);
    saisieFile = null;
    saveStore({ watch: state.watch });
    renderSell();
    render();
  }

  /*
   * La feuille de la Revente, sortie de la fonction qui la posait.
   *
   * `buildSellUI` faisait 498 lignes, dont 379 de CSS : la lire pour trouver
   * ce qu'elle CONSTRUIT demandait de traverser une feuille de style entière,
   * et le tableau des grosses fonctions du dépôt la comptait parmi les pires
   * alors qu'il n'y avait rien à découper — juste à sortir. Le panneau suivait
   * déjà cette convention avec `PANEL_CSS` ; la Revente ne la suivait pas, sans
   * raison. La fonction retombe à ~118 lignes, et ce qu'elle fait se lit.
   *
   * Rien d'autre n'a bougé : le CSS est celui d'avant, désindenté de quatre
   * espaces pour tenir au niveau d'une constante.
   */
  const SELL_CSS = `
    :host { all: initial; }

    /*
     * La même palette que le panneau, sur l'hôte de CETTE racine.
     *
     * Une variable CSS ne traverse pas un Shadow DOM : celles du panneau
     * sont déclarées sur son propre « .panel », dans sa propre
     * racine, et ne valent rien ici. Elles sont donc redéclarées — mais
     * depuis la MÊME source, pas recopiées.
     */
    :host {
      ${PALETTE}
    }
    * { box-sizing: border-box; margin: 0; }
    /*
     * Le fond de la page passe de 86 % à 94 % d'opacité, et le flou de 10 à
     * 20 px.
     *
     * L'élévation ne peut PAS venir d'une boîte plus claire : « --dim »
     * (#717C8D) est calé à 4,54:1 sur #0D0F13, soit quatre centièmes
     * au-dessus du plancher AA. Éclaircir le fond de la modale, ne
     * serait-ce que vers #101319, le fait retomber à 4,43:1 — et c'est le
     * ton de l'amplitude et des en-têtes de colonnes, les plus petits
     * textes du tableau. On gagne donc le relief en ENFONÇANT ce qu'il y a
     * derrière, jamais en remontant ce qu'il y a devant.
     */
    .wrap {
      position: absolute; inset: 0; background: rgba(6,8,11,.94);
      backdrop-filter: blur(20px) saturate(.9);
      display: flex; align-items: center; justify-content: center;
      padding: 28px; font: 13px/1.5 ui-sans-serif, system-ui, -apple-system,
        "Segoe UI Variable", "Segoe UI", sans-serif; color: var(--text);
    }
    /*
     * 1 180 px et non 980 : à neuf colonnes, la largeur d'avant laissait le
     * titre des cartes se faire couper sur un écran qui avait la place. La
     * boîte reste bornée — au-delà, l'œil ne fait plus le lien entre le nom
     * à gauche et le prix à droite.
     *
     * L'arête claire du haut, elle, est ce qui remplace le fond éclairci :
     * un filet blanc à 7 % là où la lumière frapperait la tranche. C'est
     * tout ce qui sépare visuellement la boîte du fond, et ça suffit.
     */
    .box {
      width: min(1180px, 100%); max-height: 100%; display: flex; flex-direction: column;
      background: #0D0F13; border: 1px solid rgba(255,255,255,.09); border-radius: 18px;
      box-shadow: 0 40px 100px rgba(0,0,0,.7), 0 2px 10px rgba(0,0,0,.5),
                  inset 0 1px 0 var(--line);
      overflow: hidden;
    }
    /*
     * L'en-tête portait le titre et, à sa suite, quatre faits distincts
     * cousus par des points médians : « 15 cartes · ~1 234 wb · cote il y a
     * 41 min · concurrence il y a 6 min ». C'est une phrase qu'on relit
     * deux fois pour y trouver un nombre.
     *
     * Ils deviennent des relevés étiquetés, valeur au-dessus, intitulé
     * en-dessous — la disposition que le panneau emploie déjà pour ses
     * compteurs (« .fig »). Les deux surfaces de l'outil disent donc leurs
     * chiffres de la même façon, et le point médian disparaît.
     */
    .top { display: flex; align-items: flex-start; gap: 28px; padding: 18px 20px 16px;
           border-bottom: 1px solid var(--line); }
    .top h2 { font-size: 17px; font-weight: 650; letter-spacing: -.015em; padding-top: 2px; }
    .sum { display: flex; align-items: flex-start; gap: 26px; flex-wrap: wrap; }
    /* Le relevé chiffré : valeur au-dessus, intitulé en-dessous. Défini une
       fois — l'en-tête et le journal s'en servent tous les deux, et les
       deux blocs de la page disent donc leurs chiffres à l'identique. */
    .f { display: flex; flex-direction: column; gap: 3px; }
    .f b { font-size: 15px; font-weight: 650; letter-spacing: -.01em; line-height: 1.1;
           font-variant-numeric: tabular-nums; }
    .f span { color: var(--dim); font-size: 11px; line-height: 1.1; }
    /* Un relevé qui alerte — cote distancée, concurrence incomplète —
       prend l'ambre, la même que ⚠ ailleurs dans l'outil. */
    .f.due b { color: var(--warn); }
    .x { margin-left: auto; flex: none; width: 30px; height: 30px; border: 0; border-radius: 9px;
         background: rgba(255,255,255,.05); color: var(--muted); cursor: pointer; font-size: 14px;
         transition: background .14s, color .14s; }
    .x:hover { color: var(--text); background: rgba(255,255,255,.1); }
    /*
     * La bande des mises en garde. Ambre, comme ⚠ et comme le tri par
     * prix : c'est la couleur du « ce chiffre est plus mince qu'il n'en a
     * l'air » dans tout l'outil. Elle n'existe que lorsqu'il y a quelque
     * chose à dire — « [hidden] » la retire du flux, elle ne réserve pas
     * de hauteur vide au-dessus des filtres.
     */
    .caveat {
      display: flex; flex-direction: column; gap: 3px;
      padding: 10px 20px; border-bottom: 1px solid var(--line);
      background: color-mix(in srgb, var(--warn) 7%, transparent); color: var(--warn);
      font-size: 11.5px; line-height: 1.5;
    }
    .caveat[hidden] { display: none; }

    /*
     * La barre de filtres. C'est ici que la page trahissait son âge : la
     * case à cocher, la liste déroulante et le compteur étaient les
     * widgets du système. Trois objets dessinés par Windows au milieu
     * d'une interface dessinée à la main — coche bleue, chevron gris,
     * flèches de compteur — chacun avec ses propres angles, sa propre
     * graisse et sa propre idée de la hauteur de ligne.
     *
     * Tout est redessiné ci-dessous. Aucune règle ne change ce que les
     * contrôles FONT : ce sont les mêmes éléments, avec les mêmes
     * écouteurs et le même clavier — une case reste cochable à la barre
     * d'espace, la liste garde le menu natif à l'ouverture.
     *
     * Les commandes se regroupent aussi : « ventes mini » et « rareté »
     * restreignent la liste, « sans concurrence » et « masquer » la
     * filtrent. Un séparateur les sépare, au lieu d'un rang unique où
     * huit contrôles se suivaient sans hiérarchie.
     */
    .bar { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center;
           padding: 11px 20px; border-bottom: 1px solid var(--line);
           color: var(--muted); font-size: 12px; }
    .bar label { display: flex; align-items: center; gap: 7px; white-space: nowrap; }
    /* Le temps du relevé : la barre entière se retire, en bloc. */
    .bar.inerte { opacity: .45; }
    .bar.inerte label { cursor: default; }
    .bar .sep { flex: none; width: 1px; height: 18px; background: rgba(255,255,255,.16); }

    /* Le compteur : les flèches natives sont retirées, la valeur se tape
       ou se corrige au clavier — elles n'ajoutaient qu'un ornement gris. */
    .bar input[type=number] {
      width: 52px; -moz-appearance: textfield; appearance: textfield;
      background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.09);
      border-radius: 8px; color: var(--text); padding: 5px 8px;
      font: 500 12px ui-sans-serif, system-ui, sans-serif; font-variant-numeric: tabular-nums;
      transition: border-color .14s, background .14s;
    }
    /* Chercher une carte : le même champ que « Ventes mini », plus large. */
    .bar input[type=search] {
      width: 170px; appearance: none; -webkit-appearance: none;
      background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.09);
      border-radius: 8px; color: var(--text); padding: 5px 9px;
      font: 500 12px ui-sans-serif, system-ui, sans-serif;
      transition: border-color .14s, background .14s;
    }
    .bar input[type=search]::placeholder { color: var(--dim); }
    .bar input[type=search]:hover { background: rgba(255,255,255,.08); }
    .bar input[type=search]:focus { outline: 0; border-color: var(--live); background: rgba(255,255,255,.08); }
    .bar input[type=number]::-webkit-outer-spin-button,
    .bar input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    .bar input[type=number]:hover { background: rgba(255,255,255,.08); }
    .bar input[type=number]:focus { outline: 0; border-color: var(--live); background: rgba(255,255,255,.08); }

    /*
     * La case à cocher. « appearance: none » la vide de son rendu système,
     * et la coche est tracée en propre : deux côtés d'un carré, tourné de
     * 45°. Pas de glyphe ✓ — il change de dessin selon la police
     * installée, et la case doit avoir le même trait partout.
     */
    .bar input[type=checkbox] {
      flex: none; appearance: none; -webkit-appearance: none;
      width: 16px; height: 16px; margin: 0; border-radius: 5px;
      background: rgba(255,255,255,.05); box-shadow: inset 0 0 0 1px rgba(255,255,255,.14);
      cursor: pointer; transition: background .14s, box-shadow .14s;
    }
    .bar input[type=checkbox]:hover { background: rgba(255,255,255,.1); }
    .bar input[type=checkbox]:checked { background: var(--live); box-shadow: none; }
    .bar input[type=checkbox]:checked::after {
      content: ''; display: block; width: 4px; height: 8px; margin: 2px auto 0;
      border: solid #06130C; border-width: 0 2px 2px 0; transform: rotate(45deg);
    }
    /* Le filtre neutralisé le temps du relevé : il ne doit pas avoir l'air
       d'agir. Le curseur le dit autant que l'opacité, portée par le label. */
    .bar input[type=checkbox]:disabled { cursor: default; }
    .tags { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .tags > [data-tag] { display: flex; gap: 6px; flex-wrap: wrap; }
    .tagchip {
      padding: 3px 9px; border-radius: 999px; border: 1px solid rgba(255,255,255,.12);
      background: none; color: var(--muted); cursor: pointer;
      font: 500 11px ui-sans-serif, system-ui, sans-serif; transition: .16s;
    }
    .tagchip:hover { color: var(--text); }
    .tagchip.on { background: color-mix(in srgb, var(--live) 18%, transparent); border-color: var(--live); color: var(--live); }
    /*
     * La liste déroulante. Le chevron du système est remplacé par un tracé
     * en SVG, posé en image de fond — il suit la couleur du texte et garde
     * la même épaisseur de trait que le reste de l'interface. Le menu qui
     * s'ouvre au clic reste celui du navigateur : c'est la seule partie
     * qu'une page ne peut pas dessiner sans réécrire le contrôle entier,
     * et le réécrire lui coûterait son clavier.
     */
    .bar select {
      appearance: none; -webkit-appearance: none;
      background: rgba(255,255,255,.05)
        url("data:image/svg+xml;charset=utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23949DAD' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")
        no-repeat right 9px center;
      border: 1px solid rgba(255,255,255,.09); border-radius: 8px;
      color: var(--text); padding: 5px 28px 5px 9px;
      font: 500 12px ui-sans-serif, system-ui, sans-serif; cursor: pointer;
      transition: border-color .14s, background-color .14s;
    }
    .bar select:hover { background-color: rgba(255,255,255,.09); }
    .bar select:focus { outline: 0; border-color: var(--live); }
    /* Le menu déroulant, lui, est peint par le navigateur : sans couleur
       explicite ses options tombaient en noir sur blanc. */
    .bar select option { background: #14171C; color: var(--text); }

    .bar button { margin-left: auto; flex: none; padding: 6px 13px; border: 0; border-radius: 8px;
          background: rgba(255,255,255,.06); color: var(--muted); cursor: pointer;
          font: 500 12px ui-sans-serif, system-ui, sans-serif; transition: background .14s, color .14s; }
    .bar button:hover { color: var(--text); background: rgba(255,255,255,.1); }
    /*
     * Cote distancée. La même ambre que ⚠ et que le tri par prix — c'est
     * la couleur du « ce chiffre est plus mince qu'il n'en a l'air » dans
     * tout le panneau. Pas de clignotement : l'écart se comble quand on
     * veut, il n'urge pas.
     */
    .bar button.due { background: color-mix(in srgb, var(--warn) 16%, transparent); color: var(--warn); }
    .bar button.due:hover { background: color-mix(in srgb, var(--warn) 24%, transparent); color: var(--warn); }
    /*
     * Le tableau prend la place, les autres blocs gardent la leur. C'était
     * l'inverse : seul le tableau savait rétrécir, et il payait pour tous —
     * cinq lignes visibles sur un portable, aucune à largeur de téléphone.
     * Mesuré au banc de rendu, contrôlé par banc.controlesRevente().
     */
    .scroll { overflow: auto; flex: 1 1 auto; min-height: 120px; }
    .top, .caveat, .bar, .journal, .note { flex: none; }
    /*
     * « min-width » : le conteneur était prêt à défiler, mais une table en
     * « width: 100% » sans plancher se comprime au lieu de le déclencher.
     * Neuf colonnes — rareté, carte, thème, ventes, en vente, prix visé,
     * médiane, amplitude, action — s'écrasaient donc en silence sur une
     * fenêtre étroite. Elles défilent maintenant.
     */
    table { width: 100%; min-width: 720px; border-collapse: collapse; }
    th { position: sticky; top: 0; z-index: 1; background: #0D0F13; text-align: left; color: var(--dim);
         font-size: 11px; font-weight: 500; padding: 10px 14px;
         border-bottom: 1px solid var(--line); }
    /* Les colonnes qu'on trie au clic ; celle qui trie porte le vert et sa flèche. */
    th.tri { cursor: pointer; transition: color .14s; user-select: none; }
    th.tri:hover { color: var(--text); }
    th.tri.on { color: var(--live); }
    td { padding: 6px 14px; border-bottom: 1px solid rgba(255,255,255,.04);
         font-variant-numeric: tabular-nums; }
    tr:hover td { background: rgba(255,255,255,.035); }
    /*
     * La rareté était deux lettres colorées, seules dans leur colonne.
     * C'était l'unique endroit du tableau où la palette du jeu servait à
     * quelque chose, et à cette taille les six teintes — dont quatre
     * pastels très proches — ne se distinguaient plus.
     *
     * Elles deviennent des pastilles teintées, exactement celles que le
     * panneau emploie pour ses raretés (« .chip »). Le fond porte la
     * couleur autant que le texte : la teinte se lit sur une surface, plus
     * sur deux glyphes de onze pixels. Les valeurs, elles, restent celles
     * relevées sur le site — elles ne s'inventent pas.
     */
    .r { width: 1%; white-space: nowrap; }
    .r i {
      display: inline-block; min-width: 28px; padding: 2px 7px; border-radius: 999px;
      background: color-mix(in srgb, var(--c) 22%, transparent); color: var(--c);
      font: 700 10px ui-sans-serif, system-ui, sans-serif; font-style: normal;
      text-align: center; letter-spacing: .01em;
    }
    /* L'action est en bout de ligne : elle s'aligne sur ce bord, comme les
       nombres s'alignent sur le leur. Sans quoi les boutons flottaient au
       milieu d'une colonne large, à distance variable de la ligne suivante. */
    th:last-child, td:last-child { text-align: right; }
    .t { max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
         font-weight: 500; }
    .num { text-align: right; }
    /* « ×2 » à côté du titre : combien d'exemplaires vous en avez. */
    .t .nb { margin-left: 4px; color: var(--muted); font-size: 11px; font-weight: 500; }
    /* Les cases de la défausse, dessinées comme celle de la barre. */
    .sel { width: 1%; padding-right: 0; }
    .sel input[type=checkbox] {
      display: block; appearance: none; -webkit-appearance: none;
      width: 16px; height: 16px; margin: 0; border-radius: 5px;
      background: rgba(255,255,255,.05); box-shadow: inset 0 0 0 1px rgba(255,255,255,.14);
      cursor: pointer; transition: background .14s, box-shadow .14s;
    }
    .sel input[type=checkbox]:hover { background: rgba(255,255,255,.1); }
    .sel input[type=checkbox]:checked { background: var(--warn); box-shadow: none; }
    .sel input[type=checkbox]:checked::after {
      content: ''; display: block; width: 4px; height: 8px; margin: 2px auto 0;
      border: solid #1A1206; border-width: 0 2px 2px 0; transform: rotate(45deg);
    }
    /* La barre de la sélection : ce qui est coché, la défausse, puis son bilan. */
    .selbar { flex: none; display: flex; align-items: center; gap: 10px 14px; flex-wrap: wrap;
              padding: 8px 20px; border-bottom: 1px solid var(--line); font-size: 12px; color: var(--text);
              background: color-mix(in srgb, var(--warn) 7%, transparent); }
    .selbar[hidden] { display: none; }
    .selbar b { font-weight: 650; font-variant-numeric: tabular-nums; }
    .selbar button { flex: none; padding: 5px 12px; border: 0; border-radius: 8px; cursor: pointer;
                     background: rgba(255,255,255,.06); color: var(--muted);
                     font: 500 12px ui-sans-serif, system-ui, sans-serif; transition: background .14s, color .14s; }
    .selbar button:hover { color: var(--text); background: rgba(255,255,255,.1); }
    .selbar .defausse { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
    .selbar .defausse:hover { background: color-mix(in srgb, var(--warn) 28%, transparent); color: var(--warn); }
    /* Armée : pleine, pour qu'on voie que le prochain clic détruit. */
    .selbar .defausse.arme { background: var(--warn); color: #1A1206; font-weight: 650; }
    /* Le prix choisi avant de mettre en file, dans la ligne même. */
    .fedit { display: inline-flex; align-items: center; gap: 6px; }
    .fedit input {
      width: 76px; appearance: textfield; -moz-appearance: textfield;
      background: rgba(255,255,255,.06); border: 1px solid var(--live); border-radius: 8px;
      color: var(--text); padding: 4px 8px; text-align: right;
      font: 600 12px ui-sans-serif, system-ui, sans-serif; font-variant-numeric: tabular-nums;
    }
    .fedit input::-webkit-outer-spin-button, .fedit input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    .fedit input:focus { outline: 0; background: rgba(255,255,255,.1); }
    .fedit input.ko { border-color: var(--warn); }
    .fedit .u { color: var(--dim); font-size: 11px; margin-right: 4px; }
    /* La fin de la tranche affichée, et de quoi voir la suite. */
    tr.plus td { text-align: center; padding: 12px 14px; color: var(--dim); font-size: 11px; }
    tr.plus:hover td { background: none; }
    tr.plus .go { margin-right: 12px; }
    /*
     * Le prix visé est la réponse à la question que pose la page. Il portait
     * la même taille que les six autres nombres de sa ligne, à une graisse
     * près. Il passe à 14 px : c'est le seul écart de taille du tableau, et
     * il désigne la colonne qu'on est venu lire.
     */
    .med { font-size: 14px; font-weight: 650; letter-spacing: -.01em; }
    .amp { color: var(--dim); font-size: 11px; white-space: nowrap; }
    .th { color: var(--muted); font-size: 11px; white-space: nowrap; }
    .free { color: var(--live); }
    .busy { color: var(--warn); }
    /* Peu de ventes : le prix visé n'est pas un prix de marché. */
    .thin { color: var(--warn); cursor: help; }
    .th .liq { color: var(--dim); margin-left: 6px; }
    .tag { padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--live) 15%, transparent); color: var(--live); font-size: 10px; }
    /*
     * « Vendre », répété sur chaque ligne, faisait une colonne d'une
     * quinzaine de cadres identiques — le motif le plus lourd de l'écran,
     * pour une action qui ne concerne qu'une ligne à la fois.
     *
     * Le bouton perd donc son contour au repos et ne le reprend qu'au
     * survol de SA ligne. Il reste lisible et cliquable en permanence — ce
     * n'est pas une action cachée, seulement une action qui cesse de
     * dessiner un cadre autour d'elle-même quinze fois de suite.
     */
    .go { padding: 4px 10px; border: 1px solid rgba(255,255,255,.12); border-radius: 8px;
          background: none; color: var(--text); cursor: pointer;
          font: 500 11px ui-sans-serif, system-ui, sans-serif;
          transition: background .14s, border-color .14s, color .14s; }
    /*
     * Le contour ne s'efface QUE dans le tableau — « td .go », pas « .go ».
     * La même classe habille « Relâcher les filtres », qui vit seul au
     * milieu d'un tableau vide : sans ligne à survoler, il n'aurait jamais
     * repris son cadre et se lisait comme du texte mort. C'est le seul
     * bouton de cet écran-là, il doit rester un bouton.
     */
    td .go { border-color: transparent; color: var(--muted); }
    tr:hover td .go { border-color: rgba(255,255,255,.12); color: var(--text); }
    .go:hover, .go:focus-visible { background: color-mix(in srgb, var(--live) 15%, transparent); border-color: var(--live); color: var(--live); }
    /* Un écran tactile n'a pas de survol : le contour y est permanent. */
    @media (hover: none) { td .go { border-color: rgba(255,255,255,.12); color: var(--text); } }
    /* Une carte étiquetée n'a pas de bouton : rien à cliquer par mégarde. */
    .protege { display: inline-block; padding: 4px 9px; border: 1px dashed rgba(255,255,255,.14);
               border-radius: 8px; color: var(--dim); font: 500 11px ui-sans-serif, system-ui, sans-serif; }
    /*
     * Déjà en vente. Verte, parce que ce n'est pas un empêchement mais un
     * fait accompli : la carte est au marché, l'emplacement est pris, il
     * n'y a rien à faire de plus. Le tiret de « protégée » dirait le
     * contraire — qu'on est bloqué.
     */
    /*
     * Un bouton, depuis qu'il mène au panneau — volet Ventes, ou Relances
     * pour « en file ». Il garde son air d'étiquette : la teinte dit l'état,
     * le survol seul dit qu'on peut cliquer.
     */
    .encours { display: inline-block; padding: 4px 9px; border: 0; border-radius: 8px;
               background: color-mix(in srgb, var(--live) 12%, transparent); color: var(--live);
               font: 500 11px ui-sans-serif, system-ui, sans-serif; cursor: pointer;
               transition: background .14s; }
    .encours:hover { background: color-mix(in srgb, var(--live) 22%, transparent); }
    /*
     * En file : la carte attend son tour, elle n'est pas encore au marché.
     * Le lavande la distingue du vert de « en vente » — c'est une promesse,
     * pas un fait. Même teinte que la rareté R du jeu, la seule de la
     * palette qui ne soit prise ni par l'action ni par l'alerte.
     */
    .encours.file { background: color-mix(in srgb, ${RARITY_COLOR.R} 14%, transparent); color: ${RARITY_COLOR.R}; }
    .encours.file:hover { background: color-mix(in srgb, ${RARITY_COLOR.R} 24%, transparent); }
    /* Le second geste de la ligne : il pèse moins que « Vendre », qui
       passe par le formulaire du site et vous laisse valider. */
    .go.file { color: var(--dim); }
    tr:hover td .go.file { color: ${RARITY_COLOR.R}; }
    .go.file:hover, .go.file:focus-visible {
      background: color-mix(in srgb, ${RARITY_COLOR.R} 15%, transparent); border-color: ${RARITY_COLOR.R}; color: ${RARITY_COLOR.R};
    }
    /* L'aide, repliée sur son titre tant qu'on ne l'ouvre pas. */
    .note { padding: 8px 20px; border-top: 1px solid var(--line); }
    .note summary { cursor: pointer; list-style: none; width: max-content;
                    color: var(--muted); font-size: 11.5px; transition: color .14s; }
    .note summary::-webkit-details-marker { display: none; }
    .note summary::before { content: '?'; display: inline-block; width: 15px; height: 15px; margin-right: 7px;
                            border-radius: 50%; background: rgba(255,255,255,.07); color: var(--dim);
                            font: 700 10px/15px ui-sans-serif, system-ui, sans-serif; text-align: center; }
    .note summary:hover { color: var(--text); }
    .note p { margin: 8px 0 4px; max-width: 90ch; color: var(--dim); font-size: 11px; line-height: 1.55; }
    .empty { padding: 48px 40px; text-align: center; color: var(--dim); line-height: 1.6; }
    /* La jauge du relevé : mêmes 3 px, même vert et même transition que
       celle de la régénération, dans le panneau. */
    .empty .prog {
      height: 3px; width: min(320px, 60%); margin: 0 auto 20px;
      border-radius: 2px; background: var(--line); overflow: hidden;
    }
    .empty .prog i {
      display: block; height: 100%; border-radius: 2px; background: var(--live);
      transition: width .4s linear;
    }
    .slots { color: var(--live); font-weight: 600; }
    /* Autant de lignes surlignées que d'emplacements libres : ce sont les
       cartes à lister maintenant, sans avoir à compter soi-même. */
    tr.next td { background: color-mix(in srgb, var(--live) 6%, transparent); }
    tr.next:hover td { background: color-mix(in srgb, var(--live) 10%, transparent); }
    tr.next td:first-child { box-shadow: inset 2px 0 0 var(--live); }
    /*
     * Le journal se lisait comme une suite de la page, sans rien qui le
     * distingue du tableau au-dessus : même fond, même graisse, collé
     * dessous. C'est pourtant l'autre sujet — ce que TU as demandé et ce
     * que tu as obtenu, quand le tableau dit ce que le marché vaut.
     *
     * Il s'enfonce donc au lieu de s'élever : un fond légèrement plus
     * sombre que la boîte, qui le range visiblement au second plan. Aucun
     * texte en « --dim » n'y vit — les tons employés ici sont le blanc, le
     * vert et l'ambre — le plancher de contraste ne s'y applique donc pas.
     */
    .journal { border-top: 1px solid var(--line); padding: 10px 20px;
               background: rgba(0,0,0,.28); }
    /*
     * Vide, il ne réserve rien. Tant qu'il n'avait ni fond ni filet, une
     * boîte vide de 28 px de rembourrage passait inaperçue ; le fond l'a
     * rendue visible — une bande sombre et muette entre le tableau et la
     * note, pendant tout le relevé, sur un compte qui n'a encore rien
     * vendu. C'est le fond qui l'a révélée, pas lui qui l'a créée.
     */
    .journal:empty { display: none; }
    /*
     * Le journal est la boucle de retour de la page : le tableau dit à quel
     * prix vendre, le journal dit si ce prix s'est vendu. Il était pourtant
     * la partie la plus pauvre de l'écran, et pour deux raisons.
     *
     * Il occupait douze rangs pleine largeur — 230 px pris au tableau, qui
     * est le sujet — pour un contenu large de 400. Il passe en colonnes :
     * autant qu'il en tient, et les douze entrées se rangent en trois
     * rangs. Le tableau récupère la différence.
     *
     * Et chaque ligne disait « demandé 240 vendu 240 », le même nombre
     * deux fois, sur toutes les ventes conclues au prix demandé —
     * c'est-à-dire presque toutes. Le seul cas intéressant est celui où les
     * deux DIFFÈRENT : une enchère qui monte. On n'écrit donc qu'un
     * nombre, et la flèche ne paraît que lorsqu'il y en a deux à comparer.
     */
    .jhead { display: flex; align-items: flex-start; gap: 26px; flex-wrap: wrap; }
    /* Le titre de « Tes ventes » est le bouton qui la déplie. */
    .jtoggle { align-self: center; display: flex; align-items: center; gap: 8px; margin-right: 2px;
               padding: 0; border: 0; background: none; cursor: pointer; color: var(--text);
               font: 600 12px ui-sans-serif, system-ui, sans-serif; letter-spacing: -.005em; }
    .jtoggle:hover { color: var(--live); }
    .chev { width: 6px; height: 6px; border: solid var(--dim); border-width: 0 1.5px 1.5px 0;
            transform: rotate(-45deg); transition: transform .14s; }
    .chev.on { transform: rotate(45deg) translate(-2px, -2px); }
    .journal .list {
      margin-top: 10px; max-height: 30vh; overflow: auto;
      display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 2px 28px;
    }
    .journal .j { display: flex; gap: 9px; align-items: baseline; font-size: 12px; }
    .journal .j i { flex: none; width: 5px; height: 5px; border-radius: 50%;
                    background: var(--live); transform: translateY(-1px); }
    .journal .j.ko i { background: var(--warn); }
    .journal .n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
                  white-space: nowrap; color: var(--text); }
    .journal .px { flex: none; color: var(--muted); font-variant-numeric: tabular-nums; }
    /* Le prix atteint, quand il dépasse celui demandé : c'est le seul
       chiffre du journal qui soit une bonne nouvelle, il la porte. */
    .journal .px em { font-style: normal; color: var(--live); font-weight: 600; }
    .journal .j.ko .px { color: var(--warn); }

    /* Le clavier doit voir où il est : la Revente est une modale, on peut
       la parcourir entièrement à la tabulation. */
    :focus-visible { outline: 2px solid var(--live); outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }

    /*
     * Largeur de téléphone. L'en-tête et la barre passaient chacun à ~180 px
     * de haut en s'enroulant, et le tableau tombait à zéro. Marges et écarts
     * resserrés : il reste de la place pour lui.
     */
    @media (max-width: 640px) {
      .wrap { padding: 8px; }
      .top { gap: 12px; padding: 12px 14px; }
      .sum { gap: 10px 16px; }
      .bar { gap: 6px 10px; padding: 8px 14px; }
      .journal, .note { padding-left: 14px; padding-right: 14px; }
      .jhead { gap: 10px 16px; }
    }
  `;

  function buildSellUI() {
    const host = document.createElement('div');
    host.id = 'wm-sell-page';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:none';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${SELL_CSS}</style>
      <div class="wrap" data-wrap>
        <div class="box">
          <div class="top">
            <h2>Revente</h2><div class="sum" data-sum></div>
            <button class="x" data-close>✕</button>
          </div>
          <div class="caveat" data-caveat hidden></div>
          <div class="bar">
            <input type="search" data-cherche placeholder="Chercher une carte" aria-label="Chercher une carte par son nom">
            <label>Ventes mini <input type="number" data-min min="1" max="50"></label>
            <label>Rareté <select data-rar></select></label>
            <span class="sep"></span>
            <label data-freelabel title="N'afficher que les cartes que personne d'autre ne propose en ce moment">
              <input type="checkbox" data-free> Sans concurrence</label>
            <span class="tags" data-taglabel hidden>Masquer <button class="tagchip" data-all>toutes les étiquetées</button><span data-tag></span></span>
            <button data-rescan>Rafraîchir la cote</button>
          </div>
          <div class="selbar" data-selbar hidden></div>
          <div class="scroll" data-scroll></div>
          <div class="journal" data-journal></div>
          <details class="note" data-aide>
            <summary>Comment ça marche</summary>
            <p>⚠ signale une cote établie sur moins de 5 ventes : le prix visé y
            retombe sur la médiane, et ces cartes passent en fin de tableau.
            « Vendre » ouvre la fiche de la carte sur le formulaire du site,
            prix pré-rempli — vous choisissez la durée et vous lancez l'enchère
            vous-même. « Mettre en file » vous demande un prix — le prix visé
            est proposé — puis inscrit la carte : elle partira seule, sans
            vous, dès qu'un de vos dix emplacements se libère. Rien ne part
            d'ici sans l'un de ces deux gestes. « en file » et « en vente »
            ouvrent la carte dans le panneau, volet Relances ou Ventes : c'est
            là que la file se modifie.</p>
            <p>Les cases à gauche servent à défausser d'un coup les cartes
            dont vous ne voulez pas. Seules leurs copies libres partent —
            jamais une copie étiquetée ou en favori, ni une carte en vente, en
            file ou engagée dans un échange —, et une défausse est
            définitive : deux clics, le premier dit combien d'exemplaires.</p>
          </details>
        </div>
      </div>`;
    document.body.appendChild(host);

    const q = (s) => root.querySelector(s);
    sellUI = { host, root, sum: q('[data-sum]'), caveat: q('[data-caveat]'), scroll: q('[data-scroll]'),
      cherche: q('[data-cherche]'), selbar: q('[data-selbar]'),
      journal: q('[data-journal]'), min: q('[data-min]'), rar: q('[data-rar]'), free: q('[data-free]'), tag: q('[data-tag]'),
      taglabel: q('[data-taglabel]'), all: q('[data-all]'), freeLabel: q('[data-freelabel]'),
      rescan: q('[data-rescan]'), bar: q('.bar') };

    q('[data-close]').addEventListener('click', closeSell);
    q('[data-wrap]').addEventListener('click', (e) => { if (e.target === q('[data-wrap]')) closeSell(); });
    q('[data-rescan]').addEventListener('click', scanCote);
    /*
     * L'aide et « Tes ventes » se replient, et l'état se retient. Tous deux
     * restaient ouverts sous le tableau, à hauteur fixe : sur un portable, ils
     * prenaient plus de place que lui.
     */
    const aide = q('[data-aide]');
    aide.open = sellPrefs.aide;
    aide.addEventListener('toggle', () => {
      sellPrefs.aide = aide.open;
      saveStore({ sellAide: aide.open });
    });
    /*
     * La défausse des cartes cochées : deux clics, le second jamais dans la
     * foulée du premier (`WISH_ARME_MIN_MS`), et l'armement retombe seul au
     * bout de `ARME_MS` — un compte annoncé ne s'exécute pas longtemps après.
     */
    sellUI.selbar.addEventListener('click', (e) => {
      if (e.target.closest('[data-decocher]')) { sell.aDefausser.clear(); desarmerDefausse(); renderSell(); return; }
      if (e.target.closest('[data-bilanok]')) { sell.defausse = null; renderSell(); return; }
      if (!e.target.closest('[data-defausser]')) return;
      if (!defausseArmeeA) {
        defausseArmeeA = Date.now();
        clearTimeout(defausseTimer);
        defausseTimer = setTimeout(() => { desarmerDefausse(); renderSell(); }, ARME_MS);
        renderSell();
        return;
      }
      if (Date.now() - defausseArmeeA < WISH_ARME_MIN_MS) return;
      defausserCochees();
    });
    // Le prix de mise en file, retenu à la frappe ; Entrée valide.
    sellUI.scroll.addEventListener('input', (e) => {
      if (saisieFile && e.target.matches('[data-fprix]')) saisieFile.prix = e.target.value;
    });
    sellUI.scroll.addEventListener('keydown', (e) => {
      if (saisieFile && e.key === 'Enter' && e.target.matches('[data-fprix]')) { e.preventDefault(); confirmerFile(); }
    });
    // Chercher une carte par son nom : le tableau suit la frappe.
    sellUI.cherche.addEventListener('input', () => {
      sellPrefs.cherche = sellUI.cherche.value.trim();
      sellPrefs.affiche = PAGE_REVENTE;
      renderSell();
    });
    sellUI.journal.addEventListener('click', (e) => {
      if (!e.target.closest('[data-jtoggle]')) return;
      sellPrefs.journalOuvert = !sellPrefs.journalOuvert;
      saveStore({ sellJournal: sellPrefs.journalOuvert });
      renderJournal();
    });
    /*
     * Les quatre filtres se retiennent. Seules les étiquettes masquées
     * l'étaient : « Ventes mini », « Rareté » et « Sans concurrence »
     * revenaient à leur valeur par défaut à chaque rechargement de la page.
     */
    sellUI.min.value = sellPrefs.minSales;
    sellUI.min.addEventListener('change', (e) => {
      sellPrefs.minSales = Math.max(1, +e.target.value || 1);
      saveStore({ sellMin: sellPrefs.minSales });
      renderSell();
    });
    sellUI.rar.innerHTML = '<option value="">toutes</option>' + RARITIES.map((r) => `<option>${r}</option>`).join('');
    sellUI.rar.value = sellPrefs.rarity;
    sellUI.rar.addEventListener('change', (e) => {
      sellPrefs.rarity = e.target.value;
      saveStore({ sellRar: sellPrefs.rarity });
      renderSell();
    });
    sellUI.free.checked = sellPrefs.onlyFree;
    sellUI.free.addEventListener('change', (e) => {
      sellPrefs.onlyFree = e.target.checked;
      saveStore({ sellFree: sellPrefs.onlyFree });
      renderSell();
    });
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
    sellUI.scroll.addEventListener('click', clicTableau);
  }

  /*
   * « en vente » et « en file » mènent au panneau. La file se voyait et se
   * modifiait déjà dans le volet Relances, les ventes dans le volet Ventes ;
   * la Revente ne faisait que le dire, dans une infobulle — « retirez-la
   * depuis Marché, volet Relances » —, et c'était à vous de fermer la page
   * pour aller l'y chercher.
   *
   * Le panneau passe au-dessus de la Revente : elle reste ouverte derrière,
   * et on y revient sans rien avoir perdu. Pour une carte en file, son
   * édition s'ouvre d'office — c'est pour elle qu'on a cliqué.
   */
  function ouvrirVolet(sub, carte) {
    prefs.mktSub = sub;
    saveStore({ mktSub: sub });
    if (carte) fileEdit = carte;
    // La classe et non `prefs.folded` : sur écran étroit, le panneau se replie sans le retenir.
    if (ui.panel.classList.contains('folded')) setFolded(false);
    if (prefs.tab !== 'marche') setTab('marche');
    else {
      ui.body.scrollTop = 0;
      render();
      requestAnimationFrame(clampPanel);
    }
    const crayon = carte && [...ui.relist.querySelectorAll('[data-edit]')].find((b) => b.dataset.edit === carte);
    const ligne = crayon && crayon.closest('li');
    if (ligne && ligne.scrollIntoView) ligne.scrollIntoView({ block: 'nearest' });
  }

  /**
   * Les clics dans le tableau de la Revente : le tri par colonne, la suite de
   * la liste, la sortie de secours du tableau vide, les trois gestes par
   * ligne, et les deux états qui renvoient au panneau. Sorti de
   * `buildSellUI`, qui ne garde que son gabarit et ses références — un
   * contrôle de `verifier.js` y veille.
   */
  function clicTableau(e) {
    const volet = e.target.closest('[data-volet]');
    if (volet) { ouvrirVolet(volet.dataset.volet, volet.dataset.carte || null); return; }
    // Cocher une carte à défausser, ou toutes celles affichées. Toute
    // modification désarme une défausse déjà armée : son compte a changé.
    const cb = e.target.closest('[data-sel]');
    if (cb) {
      if (sell.aDefausser.has(cb.dataset.sel)) sell.aDefausser.delete(cb.dataset.sel);
      else sell.aDefausser.add(cb.dataset.sel);
      desarmerDefausse();
      if (sell.defausse && sell.defausse.fini) sell.defausse = null;
      renderSell();
      return;
    }
    if (e.target.closest('[data-selall]')) {
      const vus = [...sellUI.scroll.querySelectorAll('[data-sel]')].map((x) => x.dataset.sel);
      const tous = vus.length > 0 && vus.every((id) => sell.aDefausser.has(id));
      for (const id of vus) { if (tous) sell.aDefausser.delete(id); else sell.aDefausser.add(id); }
      desarmerDefausse();
      if (sell.defausse && sell.defausse.fini) sell.defausse = null;
      renderSell();
      return;
    }
    // Trier par une colonne : une fois, l'autre sens, puis l'ordre par défaut.
    const th = e.target.closest('[data-tri]');
    if (th) {
      const k = th.dataset.tri;
      const premier = k === 't' ? 1 : -1;   // le nom de A à Z, les nombres du plus grand au plus petit
      if (sellPrefs.tri !== k) { sellPrefs.tri = k; sellPrefs.sens = premier; }
      else if (sellPrefs.sens === premier) sellPrefs.sens = -premier;
      else sellPrefs.tri = '';
      saveStore({ sellTri: sellPrefs.tri, sellSens: sellPrefs.sens });
      renderSell();
      return;
    }
    if (e.target.closest('[data-plus]')) {
      sellPrefs.affiche += PAGE_REVENTE;
      renderSell();
      return;
    }
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
      sellPrefs.cherche = '';
      sellUI.min.value = 1;
      sellUI.free.checked = false;
      sellUI.rar.value = '';
      sellUI.cherche.value = '';
      saveStore({ sellHideTagged: false, sellHideTags: [], sellMin: 1, sellFree: false, sellRar: '' });
      renderSell();
      return;
    }
    /*
     * Mettre en file. Le premier clic ouvre, dans la ligne, le choix du prix —
     * le prix visé proposé, à garder ou à changer. Le second inscrit la carte
     * dans `state.watch`, à ce prix et à la durée minimale ; la boucle de
     * relance la publiera dès qu'un des dix emplacements se libère.
     *
     * La Revente reste ouverte : on en met plusieurs d'affilée, c'est tout
     * l'intérêt. Seule la ligne change d'air, sur place.
     *
     * `enrolWatch` refuse d'elle-même une carte étiquetée — c'est sa
     * première barrière, et elle vaut aussi bien ici qu'ailleurs.
     */
    const f = e.target.closest('[data-file]');
    if (f) {
      saisieFile = { id: f.dataset.file, titre: f.dataset.titre, prix: f.dataset.prix };
      renderSell();
      const champ = sellUI.scroll.querySelector('[data-fprix]');
      if (champ) { champ.focus(); champ.select(); }
      return;
    }
    if (e.target.closest('[data-fok]')) { confirmerFile(); return; }
    if (e.target.closest('[data-fnon]')) { saisieFile = null; renderSell(); return; }
    /*
     * « Vendre un double » : le seul geste qui passe outre une étiquette.
     *
     * Deux temps, comme les autres boutons du panneau qui engagent quelque
     * chose : le premier clic ouvre le choix du prix — il était fixé au prix
     * visé, signalé à l'usage —, le second inscrit. La demi-seconde de
     * `WISH_ARME_MIN_MS` reste exigée entre les deux, dans `confirmerFile` :
     * un double-clic ne doit pas ouvrir et valider dans le même geste.
     *
     * Ce que le second temps fait exactement : il inscrit la carte en file,
     * marquée « voulue ». Il ne vend rien tout de suite, et `reconcileWatch`
     * revérifiera qu'il vous reste bien plusieurs exemplaires avant de publier
     * quoi que ce soit.
     */
    const dbl = e.target.closest('[data-double]');
    if (dbl) {
      saisieFile = { id: dbl.dataset.double, titre: dbl.dataset.titre, prix: dbl.dataset.prix,
                     double: Number(dbl.dataset.copies) || 2, ouvertA: Date.now() };
      renderSell();
      const champ = sellUI.scroll.querySelector('[data-fprix]');
      if (champ) { champ.focus(); champ.select(); }
      return;
    }
    const b = e.target.closest('[data-sell]');
    if (!b) return;
    /*
     * La ligne a pu changer depuis son dessin. Le garde regardait si la carte
     * portait UNE étiquette, sur n'importe laquelle de ses copies : un double
     * dont une copie est gardée affichait « Vendre », et le clic ne faisait
     * rien, sans un mot. Ce qui compte, c'est qu'il reste une copie LIBRE —
     * la même règle que celle qui a dessiné le bouton.
     */
    const ligne = sell.rows.find((x) => x.t === b.dataset.sell);
    if (ligne && etatLigne(ligne, new Set(), 0).protegee) return;
    prepareSale(b.dataset.sell, b.dataset.prix, (ligne && ligne.tags) || []);
  }

  /** Ce que tu as demandé, ce que tu as obtenu. La seule référence qui soit tienne. */
  function renderJournal() {
    const j = state.journal.slice(0, 12);
    if (!j.length) {
      paint(sellUI.journal, '');
      return;
    }
    const vendues = state.journal.filter((e) => e.vendue);
    const sans = state.journal.length - vendues.length;
    /*
     * Encaissé, et non « valeur » : ce sont des enchères closes, l'argent est
     * arrivé. Le chiffre existait déjà au pied de l'onglet Marché sans jamais
     * paraître ici — alors que c'est ICI qu'on fixe les prix qui le produisent.
     *
     * `final_price` arrive en chaîne de caractères : sans la conversion, la
     * somme concatène « 1050 » et « 2500 » au lieu de les additionner.
     */
    const gains = vendues.reduce((s, e) => s + (Number(e.final) || 0), 0);
    /*
     * Les nombres passent par `fmtWb`, comme partout ailleurs.
     *
     * Il y avait ici un `nb` local qui refaisait exactement la même chose —
     * `Number(v).toLocaleString('fr-FR')` — à cent cinquante lignes de
     * distance de l'original, et SANS son garde `n == null` : un compteur
     * absent écrivait « NaN » ici et « — » partout ailleurs. Deux
     * réinventions de la même idée qui divergent, ce qui est le mode de
     * duplication de ce fichier : pas du copier-coller, des redécouvertes.
     */
    const nb = fmtWb;
    /*
     * Le compte brut, pas seulement le taux. Un « 75 % » se lit bien et ne dit
     * pas s'il porte sur quatre ventes ou sur quatre cents, et les invendues
     * ont leur propre relevé plutôt que d'être le reste d'une soustraction
     * qu'on laisserait faire au lecteur.
     */
    /*
     * Repliée par défaut sur sa ligne de chiffres. La liste des douze dernières
     * ventes prenait 130 px sous le tableau — plus que le tableau lui-même sur
     * un portable, où il ne montrait plus que cinq lignes. Le titre l'ouvre et
     * la referme, et l'état se retient.
     */
    const ouvert = sellPrefs.journalOuvert;
    /*
     * Le taux de ventes conclues, en clair. C'est lui qui juge les réglages de
     * prix — le plafond du prix visé a été posé sur ce pari — et il fallait
     * faire la division de tête.
     */
    const taux = state.journal.length ? Math.round((vendues.length / state.journal.length) * 100) : 0;
    /*
     * Ce que vous encaissez, rapporté à ce que vous demandiez. Les deux prix
     * sont notés à chaque vente et rien ne les rapprochait. Une vente close,
     * pas une espérance : c'est de l'argent arrivé. Muet sous cinq ventes
     * comparables, où un seul écart ferait le chiffre.
     */
    const comparables = vendues.filter((e) => Number(e.ask) > 0 && Number.isFinite(Number(e.final)));
    const demande = comparables.reduce((s, e) => s + Number(e.ask), 0);
    const obtenu = comparables.reduce((s, e) => s + Number(e.final), 0);
    const rapport = comparables.length >= 5 && demande ? Math.round((obtenu / demande) * 100) : null;
    const tete = `<div class="jhead"><button class="jtoggle" data-jtoggle aria-expanded="${ouvert}"`
      + ` title="${ouvert ? 'Replier la liste de vos dernières ventes' : 'Voir vos dernières ventes, une par une'}">`
      + `<i class="chev${ouvert ? ' on' : ''}"></i>Tes ventes</button>`
      + `<div class="f" title="Sur vos ${nb(state.journal.length)} dernières fins d’enchère : ${taux} % ont trouvé un acheteur.">`
      + `<b>${nb(vendues.length)} / ${nb(state.journal.length)}</b><span>vendues · ${taux} %</span></div>`
      + `<div class="f"><b>${nb(gains)}</b><span>wb encaissés</span></div>`
      + (rapport != null
        ? `<div class="f" title="Sur ${nb(comparables.length)} ventes dont le prix demandé est connu : ${nb(obtenu)} wb encaissés pour ${nb(demande)} demandés.">`
          + `<b>${rapport} %</b><span>du prix demandé</span></div>`
        : '')
      + (sans ? `<div class="f due"><b>${nb(sans)}</b><span>sans acheteur</span></div>` : '')
      + '</div>';

    if (!ouvert) {
      paint(sellUI.journal, tete);
      return;
    }
    paint(sellUI.journal, tete + '<div class="list">' + j
      .map((e) => {
        // Trois cas, trois écritures. Le prix demandé ne se répète que
        // lorsqu'il diffère de celui atteint — sinon c'est le même nombre deux
        // fois sur presque toutes les lignes.
        const px = !e.vendue
          ? `${e.ask != null ? `${nb(e.ask)} · ` : ''}sans acheteur`
          : e.ask != null && e.final != null && Number(e.final) !== Number(e.ask)
            ? `${nb(e.ask)} → <em>${nb(e.final)}</em>`
            : nb(e.final ?? e.ask ?? 0);
        return `<div class="j${e.vendue ? '' : ' ko'}"><i></i>`
          + `<span class="n">${esc(e.title)}</span><span class="px">${px}</span></div>`;
      })
      .join('') + '</div>');
  }


  /**
   * Ce qu'une ligne de la Revente PROPOSE — et c'est une décision, pas un
   * affichage.
   *
   * Elle se prenait en plein milieu du gabarit HTML, entre deux cellules de
   * tableau : quatre `const` qui décidaient si la carte affiche « Vendre »,
   * « en file », « en vente » ou « protégée ». Une carte étiquetée n'a même
   * pas de bouton, une carte déjà en vente occupe un emplacement, une carte
   * en file partira seule — trois issues très différentes, décidées là où
   * personne ne va les lire.
   *
   * Les quatre faits sont donc nommés ici, une fois, et le gabarit se contente
   * de les rendre.
   *
   * @param {Set<string>} enVente  vos ventes en cours, si le relevé est frais
   * @param {number} restants      emplacements encore libres à cet instant
   */
  function etatLigne(x, enVente, restants) {
    /*
     * « Protégée » se décide sur les EXEMPLAIRES, pas sur la carte.
     *
     * `x.tags.length > 0` réunissait les étiquettes de toutes vos copies et
     * concluait sur la carte : deux exemplaires dont un seul est gardé
     * donnaient « protégée », et le second — libre, vendable, celui qu'on garde
     * justement pour le vendre — n'avait aucun bouton.
     *
     * Un relevé d'avant cette version ne porte pas le compte. On retombe alors
     * sur l'ancienne lecture, plutôt que de déclarer libre ce qu'on n'a pas su
     * compter.
     */
    const copies = x.exemplaires || 1;
    const libresDeLaCarte = x.libres != null ? x.libres : (x.tags.length ? 0 : 1);
    const protegee = libresDeLaCarte === 0;
    const dejaEnVente = enVente.has(x.id);
    /*
     * Déjà dans la file. C'est `state.watch`, la même que celle du volet
     * Relances — une seule machine, qui sait déjà attendre un emplacement,
     * retrouver l'exemplaire, écarter une carte étiquetée. Le bouton n'ouvre
     * qu'une porte de plus vers elle.
     */
    const enFile = !!(state.watch && state.watch[x.id]);
    const listable = !dejaEnVente && !protegee;
    /*
     * Le seul cas où une carte gardée peut quand même partir : vous en avez
     * PLUSIEURS et toutes sont gardées. En vendre une ne vous en prive pas —
     * c'est le geste qu'on est venu nous demander. Sur un exemplaire unique,
     * l'étiquette garde son dernier mot, et il n'y a pas de bouton.
     *
     * Le geste reste à VOUS : ce drapeau n'autorise qu'un bouton de plus, et
     * ce bouton demande une confirmation.
     */
    const doubleGarde = protegee && copies > 1 && !dejaEnVente && !enFile;
    /*
     * « en file » se montre aussi sur une carte gardée, quand c'est UNE copie
     * d'un double que vous avez demandé à vendre. La ligne affichait
     * « protégée » — hors de portée de la revente, disait l'infobulle — alors
     * que la copie partait bel et bien. Une carte étiquetée APRÈS sa mise en
     * file reste « protégée » : la barrière la retirera au lieu de la vendre.
     */
    const suivie = enFile ? state.watch[x.id] : null;
    const fileAffichee = enFile && (!protegee || (!!suivie.voulu && copies > 1));
    return { protegee, dejaEnVente, enFile, fileAffichee, listable, doubleGarde, copies,
             libresDeLaCarte, aLister: listable && restants > 0 };
  }

  /**
   * Le résumé de la Revente : les chiffres de son en-tête et ses mises en garde.
   *
   * Il se calculait au milieu de `renderSell`, entre deux `paint()` — cent
   * quarante lignes de décisions prises dans une fonction dont le métier est
   * de dessiner. Ce qu'il produit ne dépend que de l'état : c'est donc une
   * fonction pure, et elle se lit sans traverser un gabarit HTML.
   *
   * Sorti au passage : `concGene`, calculé et jamais lu par personne. Les
   * alertes de concurrence lisent `sell.compAt` et `sell.compTronque`
   * directement, et le faisaient déjà.
   */
  function resumeRevente(rows) {
    const valeur = rows.reduce((a, x) => a + (x.q3 || x.med), 0);
    const libres = state.slots.at ? state.slots.max - state.slots.used : null;
    /*
     * Ce que tu as DÉJÀ en vente.
     *
     * Le tableau l'ignorait complètement : une carte dont l'enchère court
     * gardait son bouton « Vendre », et pouvait même être surlignée comme
     * « à lister maintenant ». La colonne « En vente » ne dit rien de ce
     * cas-là — elle compte les annonces des AUTRES joueurs, pas les tiennes.
     *
     * Le relevé n'existe que si la surveillance tourne ; sans lui on ne
     * prétend rien, plutôt que de présenter comme libre ce qu'on n'a pas lu.
     * C'est la même prudence que le filtre « sans concurrence » applique déjà
     * en attendant son propre relevé.
     */
    /*
     * Et on ne s'en sert que si le relevé est FRAIS.
     *
     * Il ne testait que « a-t-on déjà lu une fois » : un relevé vieux de dix
     * minutes servait donc à marquer des lignes « en vente » avec l'aplomb
     * d'un relevé de la seconde. Se taire coûte un bouton « Vendre » proposé
     * sur une carte déjà en vente — le site refusera, et on le saura tout de
     * suite. Affirmer à tort coûte une carte qu'on croit vendue et qui ne
     * l'est pas, ou l'inverse, et ça ne se voit jamais.
     *
     * Deux minutes : c'est la durée au-delà de laquelle ce relevé cesse de
     * valoir pour AFFICHER. Pour agir, le volet Relances est deux fois plus
     * exigeant — voir `VENTES_POUR_AGIR_MS`.
     */
    const ventesFraiches = state.sales.at && Date.now() - state.sales.at < VENTES_FRAICHES_MS;
    const mesVentes = new Set(
      ventesFraiches ? (state.sales.list || []).map((v) => v.card).filter(Boolean) : []
    );
    /*
     * La couverture se dit ICI, à côté de l'âge de la cote, parce que c'est la
     * question suivante : « de quand » ne vaut rien sans « sur quoi ».
     * Formulée en cartes manquantes plutôt qu'en pourcentage seul — un « 17 % »
     * ne dit pas s'il en manque cent ou dix mille.
     */
    const c = couvertureDistancee();
    /*
     * Deux nombres, pas trois. « X de vos Y cartes (17 %) — Z sans prix »
     * disait trois fois la même chose : les deux premiers s'additionnent pour
     * faire le troisième.
     */
    /*
     * Les mises en garde quittent la ligne des chiffres.
     *
     * Elles y étaient cousues aux relevés par des points médians — « 15 cartes
     * · ~1 234 wb · cote il y a 41 min · relevé de la concurrence interrompu —
     * “sans concurrence” n'est pas fiable ». Une phrase entière, en gris, en
     * quatrième position d'une énumération de nombres : c'est l'endroit d'un
     * écran où l'on regarde le moins. Elles prennent leur propre bande, en
     * ambre, sous l'en-tête — et n'apparaissent que lorsqu'il y a lieu.
     */
    const alertes = [
      c && `La cote couvre ${c.pct} % de vos cartes : ${c.manquantes.toLocaleString('fr-FR')} `
        + 'sont sans prix et tombent en fin de tri.',
      !sell.compAt && sell.compTronque
        && 'Relevé de la concurrence interrompu — « sans concurrence » n’est pas fiable.',
      !sell.compAt && !sell.compTronque
        && 'Relevé de la concurrence en cours — « sans concurrence » ne filtre pas encore.',
      sell.compAt && sell.compTronque
        && 'Dernier relevé de la concurrence interrompu — le serveur a freiné.',
      /*
       * La note du serveur — « les prix sont réservés aux comptes PRO » — ne
       * monte dans la bande QUE si le tableau a des lignes. Sans lignes, c'est
       * elle que le corps affiche en grand, au centre : la mettre aussi dans
       * la bande écrivait deux fois la même phrase, l'une sous l'autre, à
       * trois lignes d'intervalle. Vu à l'écran sur le cas du compte gratuit,
       * qui est précisément celui où elle est la plus longue.
       */
      rows.length ? sell.note : '',
      /*
       * Le relevé des ventes est en retard. On le DIT, parce que sans lui la
       * colonne d'action ne sait plus distinguer une carte déjà en vente d'une
       * carte libre — et qu'un tableau qui a cessé de savoir ne doit pas avoir
       * l'air de savoir encore. Il se relit tout seul à l'ouverture ; cette
       * phrase ne dure donc que le temps de l'aller-retour, ou signale que le
       * serveur ne répond pas.
       */
      !ventesFraiches
        && 'Vos ventes en cours ne sont pas encore relues : les cartes déjà '
           + 'en vente ne sont pas signalées comme telles.',
    ].filter(Boolean);

    return { valeur, libres, ventesFraiches, mesVentes, couverture: c, alertes };
  }

  function renderSell() {
    if (!sellUI) return;
    sellUI.host.style.display = sell.open ? '' : 'none';
    if (!sell.open) return;

    /*
     * Pendant le relevé, les filtres ne filtrent rien : il n'y a pas de
     * tableau. Ils restaient pourtant pleinement offerts, « Rafraîchir la
     * cote » compris — lequel ne fait rien non plus, un garde de ré-entrée
     * l'arrête net dans « scanCote ». Quatre commandes vives qui n'agissent
     * pas, pendant les deux minutes où l'on attend justement quelque chose.
     *
     * C'est la règle déjà posée pour « Sans concurrence » un peu plus bas :
     * une commande ne doit pas avoir l'air d'agir tant qu'elle n'agit pas.
     * L'attribut « disabled » vaut mieux que « pointer-events », qui laisse
     * le clavier atteindre un bouton mort.
     */
    sellUI.bar.classList.toggle('inerte', sell.scanning);
    for (const el of sellUI.bar.querySelectorAll('input, select, button')) {
      el.disabled = sell.scanning;
    }

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
      // Le relevé emprunte la même disposition que la page finie : c'est le
      // même compteur qui monte, il n'a pas à changer de forme en cours de route.
      sellUI.caveat.hidden = true;
      sellUI.selbar.hidden = true;   // pas de tableau, pas de sélection
      if (!sell.total) {
        paint(sellUI.sum,
          `<div class="f"><b>${sell.read.toLocaleString('fr-FR')}</b><span>cartes lues</span></div>`);
        paint(sellUI.scroll,
          '<div class="empty">Lecture de votre collection, 50 cartes par page…</div>');
        return;
      }
      paint(sellUI.sum,
        `<div class="f"><b>${sell.done.toLocaleString('fr-FR')} / ${sell.total.toLocaleString('fr-FR')}</b>`
        + '<span>cartes cotées</span></div>');
      /*
       * Une jauge, parce que le relevé dure deux minutes.
       *
       * « lues / totales » est exact et ne se lit pas d'un coup d'œil : il
       * faut diviser pour savoir si l'on est au tiers ou aux trois quarts.
       * Trois pixels de haut le disent sans un chiffre, et c'est déjà
       * l'idiome du panneau pour la régénération des paquets — même hauteur,
       * même vert, même transition.
       *
       * Seulement à la cotation : la lecture de la collection, elle, ne
       * connaît pas son total tant que le serveur ne l'a pas dit, et une
       * jauge sans dénominateur mentirait sur ce qu'il reste.
       */
      const pct = Math.min(100, Math.round((sell.done / sell.total) * 100));
      paint(sellUI.scroll,
        `<div class="empty"><div class="prog"><i style="width:${pct}%"></i></div>`
        + 'Lecture de l’historique des ventes, carte par carte…</div>');
      return;
    }

    const rows = sellRows();
    const { valeur, libres, ventesFraiches, mesVentes, couverture: c, alertes }
      = resumeRevente(rows);

    /*
     * La case ne doit pas avoir l'air d'agir tant qu'elle n'agit pas : cochée
     * pendant le relevé, elle affirmait « exclusives » une carte sur dix qui
     * ne l'était pas. On la neutralise le temps que la concurrence soit
     * connue.
     */
    /*
     * Le bouton porte le remède : c'est lui qui doit changer d'air, pas
     * seulement la ligne du haut. Un compte à jour le laisse en gris — rien à
     * faire, rien à signaler.
     */
    if (sellUI.rescan) {
      sellUI.rescan.classList.toggle('due', !!c);
      sellUI.rescan.title = c
        ? `${c.manquantes.toLocaleString('fr-FR')} de vos cartes n’ont pas de prix`
          + `${c.complet ? `, arrivées depuis le dernier relevé complet il y a ${fmtSpan(Date.now() - sell.scanAt)}` : ''}`
          + '. Le relevé les cote toutes — deux minutes environ, sans rien mettre en vente.'
        : 'Relire l’historique des ventes de toute la collection. '
          + 'Deux minutes environ, sans rien mettre en vente.';
    }

    sellUI.free.disabled = !concurrenceConnue();
    sellUI.freeLabel.style.opacity = concurrenceConnue() ? '' : '.4';
    sellUI.freeLabel.title = concurrenceConnue()
      ? 'N’afficher que les cartes que personne d’autre ne propose en ce moment'
      : 'En attente du relevé de la concurrence : le filtre ne peut pas encore savoir qui vend quoi.';

    // Les deux nombres de la même ligne s'écrivaient dans deux formats : « 1234
    // cartes · ~56 789 wb » — l'un sans séparateur, l'autre avec.
    const fig = (v, l, due) =>
      `<div class="f${due ? ' due' : ''}"><b>${esc(v)}</b><span>${esc(l)}</span></div>`;
    paint(sellUI.sum,
      /*
       * `fmtAge` et non `fmtSpan` pour les trois âges.
       *
       * `fmtSpan` mesure une durée : sous la minute, il écrit « 0 min ». C'est
       * juste pour un décompte, absurde pour un relevé qui vient d'arriver —
       * et ça se voyait dès qu'on ouvrait la page, puisqu'elle relit désormais
       * vos ventes en s'ouvrant. `fmtAge` dit « à jour », et c'est déjà lui
       * qui date les relevés du Marché : les deux surfaces parlent pareil.
       */
      fig(rows.length.toLocaleString('fr-FR'), 'cartes')
      + fig(`~${valeur.toLocaleString('fr-FR')}`, 'wb estimés')
      + (sell.at ? fig(fmtAge(sell.at), c ? `cote · ${c.pct} % de vos cartes` : 'cote', !!c) : '')
      + fig(fmtAge(sell.compAt), 'concurrence', !sell.compAt || sell.compTronque)
      /*
       * L'âge de VOS ventes, à côté de celui de la cote et de la concurrence.
       * Il manquait, et c'est pourtant le seul des trois qui décide de ce
       * qu'une ligne propose : « Vendre », « en vente », ou rien.
       */
      + fig(fmtAge(state.sales.at), 'vos ventes', !ventesFraiches));
    sellUI.caveat.hidden = !alertes.length;
    paint(sellUI.caveat, alertes.map((a) => `<span>${esc(a)}</span>`).join(''));

    if (!rows.length) {
      /*
       * Trois vides très différents s'affichaient pareil : un refus du serveur,
       * une cote qui n'existe pas, et un filtre trop serré. Le dernier se
       * corrige en un clic — encore faut-il savoir que c'est lui.
       */
      const filtres = [`ventes mini ${sellPrefs.minSales}`]
        .concat(sellPrefs.onlyFree ? ['sans concurrence'] : [])
        .concat(sellPrefs.rarity ? [`rareté ${sellPrefs.rarity}`] : [])
        .concat(sellPrefs.hideTagged ? ['étiquetées masquées'] : [])
        .concat(sellPrefs.cherche ? [`nom « ${sellPrefs.cherche} »`] : []);
      const filtrees = !sell.note && sell.rows.length;
      paint(sellUI.scroll, `<div class="empty">${esc(
        sell.note
          || (filtrees
            ? `${sell.rows.length} cartes cotées, mais aucune ne passe les filtres (${filtres.join(' · ')}).`
            : 'Aucune carte cotée pour l’instant.')
      )}${filtrees ? '<div style="margin-top:14px"><button class="go" data-relache>Relâcher les filtres</button></div>' : ''}</div>`);
      renderSelection(rows, mesVentes);   // le bilan d'une défausse qui vient de vider le tableau
      renderJournal();
      return;
    }

    renderJournal();

    /*
     * Le surlignage « à lister maintenant » comptait les premières lignes du
     * tableau, sans regarder si elles étaient listables. Il désignait donc
     * des cartes étiquetées — qui n'ont même pas de bouton — et des cartes
     * dont l'enchère courait déjà. Autant de lignes vertes qui ne menaient à
     * rien, et autant d'emplacements libres promis à personne.
     *
     * On décompte maintenant sur ce qui est réellement à faire — et dans
     * l'ordre PAR DÉFAUT, quel que soit le tri choisi : trié par nom, le
     * tableau désignerait sinon les cartes qui commencent par A.
     */
    const aListerIds = new Set();
    let restants = libres || 0;
    for (const x of rows) {
      if (restants <= 0) break;
      if (etatLigne(x, mesVentes, restants).aLister) { aListerIds.add(x.id); restants -= 1; }
    }
    const vue = trierVue(rows).slice(0, sellPrefs.affiche);

    /*
     * Les colonnes se trient au clic : une fois, deux fois pour l'autre sens,
     * trois fois pour revenir à l'ordre par défaut — cotes solides d'abord,
     * puis prix visé.
     */
    const COLONNES = [['r', 'Rareté', ''], ['t', 'Carte', ''], ['', 'Thème', ''], ['n', 'Ventes', 'num'],
      ['comp', 'En vente', 'num'], ['q3', 'Prix visé', 'num'], ['med', 'Médiane', 'num'], ['', 'Amplitude', ''], ['', '', '']];
    const entete = COLONNES.map(([k, nom, cls]) => {
      if (!k) return `<th${cls ? ` class="${cls}"` : ''}>${nom}</th>`;
      const actif = sellPrefs.tri === k;
      return `<th class="${cls ? `${cls} ` : ''}tri${actif ? ' on' : ''}" data-tri="${k}"`
        + ` title="Trier par ${nom.toLowerCase()}${actif ? ' — cliquer encore inverse, puis revient à l’ordre par défaut' : ''}">`
        + `${nom}${actif ? (sellPrefs.sens > 0 ? ' ↑' : ' ↓') : ''}</th>`;
    }).join('');

    renderSelection(rows, mesVentes);
    /*
     * La case de l'en-tête coche toutes les lignes AFFICHÉES qu'on peut
     * défausser — jamais celles hors de la tranche ou écartées par un filtre.
     */
    const cochables = vue.filter((x) => {
      const e = etatLigne(x, mesVentes, 0);
      return !e.protegee && !e.dejaEnVente && !e.enFile;
    });
    const toutCoche = cochables.length > 0 && cochables.every((x) => sell.aDefausser.has(x.id));
    const caseTout = `<th class="sel">${cochables.length
      ? `<input type="checkbox" data-selall${toutCoche ? ' checked' : ''} aria-label="Cocher toutes les cartes affichées"`
        + ' title="Cocher toutes les cartes affichées, pour les défausser">'
      : ''}</th>`;
    // La page se redessine seule pendant qu'on tape un prix : le champ garde
    // la main, et sa valeur vit dans `saisieFile`, pas dans le DOM.
    const tapait = !!(sellUI.root.activeElement && sellUI.root.activeElement.matches('[data-fprix]'));
    paint(sellUI.scroll,
      `<table><thead><tr>${caseTout}${entete}</tr></thead><tbody>` +
      vue
        .map(
          (x) => {
            const { protegee, dejaEnVente, enFile, fileAffichee, doubleGarde, copies } = etatLigne(x, mesVentes, 0);
            const aLister = aListerIds.has(x.id);
            const cochable = !protegee && !dejaEnVente && !enFile;
            return `<tr class="${aLister ? 'next' : ''}">
            <td class="sel">${cochable
              ? `<input type="checkbox" data-sel="${esc(x.id)}"${sell.aDefausser.has(x.id) ? ' checked' : ''}`
                + ` aria-label="Cocher ${esc(x.t)} pour la défausser">`
              : ''}</td>
            <td class="r"><i style="--c:${RARITY_COLOR[x.r] || '#949DAD'}">${x.r}</i></td>
            <td class="t">${esc(x.t)}${copies > 1 ? ` <span class="nb" title="Vous en avez ${copies} exemplaires">×${copies}</span>` : ''} ${x.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</td>
            <td class="th">${
              x.theme
                /*
                 * Le pourcentage ne disait pas ce qu'il mesure. C'est la part
                 * de vos cartes de ce thème qui ont déjà trouvé acheteur au
                 * moins une fois sur le marché — un indice de liquidité,
                 * calculé au dernier relevé complet.
                 */
                ? `${esc(x.theme)}<span class="liq" title="${Math.round(((sell.themes[x.theme] || {}).rate || 0) * 100)} % de vos cartes « ${esc(x.theme)} » se sont déjà vendues au moins une fois sur le marché : plus c’est haut, plus le thème se vend facilement.">${Math.round(((sell.themes[x.theme] || {}).rate || 0) * 100)} %</span>`
                : ''
            }</td>
            <td class="num${x.seule || x.n < THIN_SALES ? ' thin' : ''}"${
              x.seule
                ? ' title="Le site n’a donné que la moyenne, sans le détail des ventes : impossible de savoir sur combien de transactions elle repose."'
                : x.n < THIN_SALES
                  ? ' title="Moins de 5 ventes : trop peu pour un quartile haut, le prix visé retombe donc sur la médiane. La carte passe aussi en fin de tableau."'
                  : ''
            }>${x.seule ? '⌀' : `${x.n}${x.n < THIN_SALES ? ' ⚠' : ''}`}</td>
            <td class="num ${sell.comp.get(x.id) ? 'busy' : 'free'}">${sell.comp.get(x.id) || '—'}</td>
            <td class="num med">${(x.q3 || x.med).toLocaleString('fr-FR')}</td>
            <td class="num">${x.med.toLocaleString('fr-FR')}</td>
            <td class="amp">${x.min.toLocaleString('fr-FR')} – ${x.max.toLocaleString('fr-FR')}</td>
            <td>${dejaEnVente || fileAffichee
              ? renvoiAuPanneau(x, dejaEnVente, protegee, copies)
              : protegee
              /*
               * Le seul chemin par lequel une carte gardée part en vente, et il
               * se fait en deux temps : le prix, puis la validation. Il
               * n'apparaît que si vous en avez plusieurs — jamais sur le dernier
               * exemplaire — et que si les relances sont cochées, sans quoi rien
               * ne publierait.
               */
              ? (doubleGarde && prefs.relistUnsold && saisieFile && saisieFile.id === x.id
                ? editeurPrix(`Vendre un double (${copies})`)
                : `<span class="protege" title="${doubleGarde
                  ? `Vos ${copies} exemplaires sont gardés. En vendre un ne vous prive de rien : le bouton à côté met UNE copie en file, et vous gardez les autres.`
                  : 'Carte étiquetée : hors de portée de la revente. Retire l’étiquette sur le site pour pouvoir la vendre.'}">protégée</span>`
                + (doubleGarde && prefs.relistUnsold
                  ? ` <button class="go" data-double="${esc(x.id)}" data-titre="${esc(x.t)}"`
                    + ` data-prix="${x.q3 || x.med}" data-copies="${copies}"`
                    + ` title="Met UNE de vos ${copies} copies en file, au prix que vous choisissez.`
                    + ' Les autres restent gardées.">'
                    + `Vendre un double (${copies})</button>`
                  : ''))
              /*
               * Deux gestes, et ils ne font pas la même chose.
               *
               * « Vendre » ouvre le formulaire du site, prix pré-rempli :
               * vous voyez et vous validez. Il échoue quand les dix
               * emplacements sont pris, et c'est le seul chemin quand les
               * relances automatiques sont décochées.
               *
               * « Mettre en file » inscrit la carte et la laisse partir
               * seule dès qu'une place se libère — donc sans vous, au
               * moment venu. Il n'apparaît que si les relances sont
               * cochées : sans elles, rien ne publierait jamais et le
               * bouton promettrait une file qui n'avance pas.
               */
              : saisieFile && saisieFile.id === x.id && prefs.relistUnsold
                // Le prix de mise en file, choisi dans la ligne : le prix visé est proposé.
                ? editeurPrix('Mettre en file')
                : `<button class="go" data-sell="${esc(x.t)}" data-prix="${x.q3 || x.med}">Vendre</button>`
                + (prefs.relistUnsold
                  ? ` <button class="go file" data-file="${esc(x.id)}" data-titre="${esc(x.t)}"`
                    + ` data-prix="${x.q3 || x.med}"`
                    + ' title="Choisissez le prix : elle partira ensuite toute seule dès qu’un emplacement se libère,'
                    + ' pour la durée minimale. Rien ne part tant qu’une place ne s’ouvre pas.">Mettre en file</button>'
                  : '')}</td>
          </tr>`;
          }
        )
        .join('')
      + (rows.length > vue.length
        ? `<tr class="plus"><td colspan="10"><button class="go" data-plus>`
          + `Afficher ${Math.min(PAGE_REVENTE, rows.length - vue.length).toLocaleString('fr-FR')} de plus</button>`
          + `<span>${vue.length.toLocaleString('fr-FR')} lignes sur ${rows.length.toLocaleString('fr-FR')}</span></td></tr>`
        : '')
      + '</tbody></table>');
    if (tapait) {
      const champ = sellUI.scroll.querySelector('[data-fprix]');
      if (champ && sellUI.root.activeElement !== champ) champ.focus();
    }
  }

  // ------------------------------------------------- quand le jeu ne répond plus

  /*
   * « Parfois le jeu plante, plus moyen de cliquer sur rien. » Rare mais
   * régulier, quelques minutes après l'ouverture de l'onglet, et seul un
   * rechargement en sort. Trois faits relevés le 11 septembre 2026 écartent
   * l'essentiel des causes :
   *
   * - le panneau répond encore : la page n'est pas gelée, le JavaScript tourne ;
   * - la page a l'air normale : ni voile sombre, ni fenêtre ouverte ;
   * - le survol ne s'allume plus sur les boutons du jeu.
   *
   * Le survol ne doit rien au JavaScript : c'est le navigateur qui le pose sur
   * l'élément qu'il trouve sous la souris. S'il s'éteint pendant que le
   * panneau vit, c'est qu'autre chose que le jeu est sous la souris — un
   * calque invisible, glissé sous le panneau qui trône en haut de la pile —
   * ou que la page du jeu a cessé de recevoir la souris.
   *
   * Lire le code n'a rien trouvé. Tous les voiles du site sont sombres
   * (`bg-black/70` et consorts) : un voile resté ouvert se VERRAIT. Son seul
   * calque transparent plein écran, le feu d'artifice des révélations, porte
   * `pointer-events-none`. Le site ne pose ni `inert` ni `pointer-events` sur
   * sa page. Et nos calques à nous se voient : le panneau est petit, la Revente
   * assombrit tout à 94 %. Reste ce que la lecture n'atteint pas — une
   * extension, un script tiers, un état du site qu'on ne sait pas reproduire.
   *
   * Il faut donc le voir quand ça arrive. Le panneau restant cliquable pendant
   * le blocage, c'est lui qui peut le relever : « Copier le diagnostic » y
   * ajoute ce qui est sous la souris au centre de l'écran et au dernier clic
   * donné au jeu, les calques plein écran posés à la racine de la page, et les
   * dernières erreurs. Tout ce que le F5 efface.
   *
   * Aucun texte de la page n'y entre, par la règle du diagnostic : un nom de
   * carte ou de joueur collé dans un salon public désignerait le compte. Des
   * balises, des classes, des tailles et des styles, rien d'autre.
   */
  const RELEVE_MAX = 6;
  const clicsJeu = [];      // les derniers `pointerdown` qui ne visaient pas l'outil
  const erreursPage = [];   // les dernières erreurs de la page, les nôtres comprises

  const NOS_HOTES = new Set(['wm-auto-panel', 'wm-sell-page', 'wm-doublon']);

  /** L'élément appartient-il à l'outil ? Un clic sur le panneau n'est pas un clic au jeu. */
  function estANous(el) {
    for (let n = el, i = 0; n && i < 8; n = n.parentElement, i++) {
      if (n.id && NOS_HOTES.has(n.id)) return true;
    }
    return false;
  }

  function garderAuPlus(liste, entree) {
    liste.push(entree);
    if (liste.length > RELEVE_MAX) liste.shift();
  }

  /*
   * Un message d'erreur peut citer l'adresse d'une enchère ou d'un profil :
   * les identifiants sautent, et les longues suites de chiffres avec eux.
   */
  const caviarder = (s) => String(s == null ? '' : s)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\d{4,}/g, '<n>')
    .slice(0, 160);

  const nomDeFichier = (url) => String(url || '').split(/[?#]/)[0].split('/').pop();

  function noterErreur(texte, ou = '') {
    garderAuPlus(erreursPage, { at: Date.now(), texte: caviarder(texte), ou });
  }

  /*
   * Posé au démarrage, avant le premier script du site : une erreur levée
   * pendant son chargement doit déjà trouver quelqu'un pour l'entendre.
   * Les trois écouteurs regardent et ne touchent à rien — ni `preventDefault`,
   * ni arrêt de propagation : le clic et l'erreur continuent leur chemin.
   */
  function installerReleveBlocage() {
    addEventListener('pointerdown', (e) => {
      try {
        if (estANous(e.target)) return;
        garderAuPlus(clicsJeu, { at: Date.now(), x: e.clientX, y: e.clientY, cible: e.target });
      } catch (_) {
        /* relever ne doit jamais coûter le clic relevé */
      }
    }, { capture: true, passive: true });

    addEventListener('error', (e) => {
      try {
        const el = e.target;
        // Une balise qui ne charge pas arrive ici aussi, en `Event` nu : seules
        // comptent celles qui portent du code — une image manquante, non.
        if (el && el.tagName) {
          if (/^(SCRIPT|LINK)$/.test(el.tagName)) {
            noterErreur(`${el.tagName.toLowerCase()} non chargé`, nomDeFichier(el.src || el.href));
          }
          return;
        }
        /*
         * Un script EN LIGNE a pour fichier l'adresse de la page, qui peut
         * porter l'identifiant d'une enchère : le nom passe au caviardage. La
         * ligne et la colonne, non — sur un fichier minifié d'une seule ligne,
         * la colonne est tout ce qui situe l'erreur.
         */
        noterErreur(e.message || (e.error && e.error.message) || 'erreur sans message',
          e.filename
            ? `${caviarder(nomDeFichier(e.filename) || 'page')}:${e.lineno || 0}:${e.colno || 0}`
            : '');
      } catch (_) {
        /* relever ne doit jamais coûter l'erreur relevée */
      }
    }, true);

    addEventListener('unhandledrejection', (e) => {
      try {
        const r = e.reason;
        // Une requête annulée n'est pas une panne : le site en annule à chaque navigation.
        if (r && r.name === 'AbortError') return;
        noterErreur(`promesse rejetée : ${(r && (r.message || r.name)) || String(r)}`);
      } catch (_) {
        /* idem */
      }
    });
  }

  /** Une ligne par élément : ce que le navigateur voit, jamais ce que la page écrit. */
  function decrireElement(el) {
    if (!el || !el.tagName) return 'rien';
    if (estANous(el)) return `[WikiMasters Tools] #${el.id || el.tagName.toLowerCase()}`;
    let nom = el.tagName.toLowerCase();
    if (el.id) nom += `#${String(el.id).slice(0, 30)}`;
    // `className` est un objet sur un SVG : l'attribut, lui, est toujours du texte.
    const classes = String((typeof el.className === 'string' ? el.className
      : el.getAttribute && el.getAttribute('class')) || '').trim().split(/\s+/).filter(Boolean);
    if (classes.length) nom += `.${classes.slice(0, 6).join('.')}${classes.length > 6 ? '…' : ''}`;

    const traits = [];
    try {
      const r = el.getBoundingClientRect();
      // L'écran sans sa barre de défilement : un calque plein écran doit lire 100 %, pas 99.
      const racine = document.documentElement;
      const larg = (racine && racine.clientWidth) || innerWidth;
      const haut = (racine && racine.clientHeight) || innerHeight;
      traits.push(`${Math.round((100 * r.width) / larg)} × ${Math.round((100 * r.height) / haut)} % de l’écran`);
      const cs = getComputedStyle(el);
      if (cs.position && cs.position !== 'static') traits.push(cs.position);
      if (cs.zIndex && cs.zIndex !== 'auto') traits.push(`z ${cs.zIndex}`);
      if (cs.opacity && cs.opacity !== '1') traits.push(`opacité ${cs.opacity}`);
      if (cs.visibility && cs.visibility !== 'visible') traits.push(cs.visibility);
      if (cs.pointerEvents && cs.pointerEvents !== 'auto') traits.push(`pointer-events ${cs.pointerEvents}`);
      if (/^(transparent|rgba\(0, 0, 0, 0\))$/.test(cs.backgroundColor || '')
          && (cs.backgroundImage || 'none') === 'none') traits.push('fond transparent');
      if (el.inert) traits.push('inert');
      if (el.tagName === 'IFRAME') traits.push(`cadre de ${new URL(el.src, location.href).hostname || '?'}`);
    } catch (_) {
      /* un élément sans boîte se décrit par son nom */
    }
    return traits.length ? `${nom} (${traits.join(', ')})` : nom;
  }

  /** Ce que la souris trouve à un point de l'écran, de haut en bas. */
  function sousLePoint(x, y) {
    if (typeof document.elementsFromPoint !== 'function') return null;
    try {
      return [...document.elementsFromPoint(x, y)].slice(0, 4).map(decrireElement);
    } catch (_) {
      return null;
    }
  }

  /*
   * Les calques posés à la racine — enfants de `<html>` hors tête et corps, où
   * les extensions s'installent volontiers, et enfants de `<body>`, où le site
   * ouvre ses fenêtres. Seuls ceux qui couvrent la moitié de l'écran au moins
   * et flottent au-dessus de la page ont le moyen de tout recouvrir.
   */
  function calquesRacine() {
    const racine = document.documentElement;
    const candidats = [
      ...(racine && racine.children ? [...racine.children] : [])
        .filter((n) => !/^(HEAD|BODY)$/.test(n.tagName)),
      ...(document.body && document.body.children ? [...document.body.children] : []),
    ];
    return candidats.filter((n) => {
      try {
        const r = n.getBoundingClientRect();
        const pos = getComputedStyle(n).position;
        return (pos === 'fixed' || pos === 'absolute')
          && r.width >= innerWidth / 2 && r.height >= innerHeight / 2;
      } catch (_) {
        return false;
      }
    }).slice(0, 8).map(decrireElement);
  }

  /** Ce qui coupe la souris à toute la page d'un coup, s'il y a quelque chose. */
  function sourisCoupee() {
    const faits = [];
    for (const [nom, el] of [['html', document.documentElement], ['body', document.body]]) {
      try {
        const pe = el && getComputedStyle(el).pointerEvents;
        if (pe && pe !== 'auto') faits.push(`${nom} en pointer-events ${pe}`);
      } catch (_) {
        /* pas de style lisible : rien à en dire */
      }
    }
    try {
      const n = document.querySelectorAll('[inert]').length;
      if (n) faits.push(`${n} élément(s) inert`);
    } catch (_) {
      /* idem */
    }
    try {
      // Une `<dialog>` modale rend inerte tout le reste — y compris nous.
      const m = document.querySelector(':modal');
      if (m) faits.push(`fenêtre modale native : ${decrireElement(m)}`);
    } catch (_) {
      /* `:modal` inconnu du navigateur */
    }
    return faits;
  }

  /**
   * La section que « Copier le diagnostic » ajoute à la fin du relevé. Sous
   * garde, comme tout le diagnostic : il ne doit rien pouvoir refuser.
   */
  function releveBlocage() {
    try {
      return lignesBlocage();
    } catch (err) {
      return [`Si le jeu ne répond plus aux clics : relevé impossible (${caviarder(raison(err))})`];
    }
  }

  function lignesBlocage() {
    const ilYA = (at) => {
      const ms = Math.max(0, Date.now() - at);
      return ms < 60000 ? `${Math.round(ms / 1000)} s` : fmtSpan(ms);
    };
    const pile = (quoi, liste) => [`  ${quoi} :`, ...liste.map((d) => `    ${d}`)];
    const lignes = ['Si le jeu ne répond plus aux clics, ce qui est sous la souris :'];

    const centre = sousLePoint(innerWidth / 2, innerHeight / 2);
    if (centre) lignes.push(...pile('au centre de l’écran, de haut en bas', centre));

    const dernier = clicsJeu[clicsJeu.length - 1];
    if (dernier) {
      lignes.push(`  le dernier clic donné au jeu, il y a ${ilYA(dernier.at)}, a touché `
        + decrireElement(dernier.cible)
        + (dernier.cible && dernier.cible.isConnected === false ? ' — retiré de la page depuis' : ''));
      const la = sousLePoint(dernier.x, dernier.y);
      if (la) lignes.push(...pile('au même endroit maintenant, de haut en bas', la));
    }

    const calques = calquesRacine();
    if (calques.length) lignes.push(...pile('calques plein écran à la racine', calques));

    const coupe = sourisCoupee();
    lignes.push(`  souris : ${coupe.length ? coupe.join(' · ') : 'rien ne la coupe à la racine'}`);

    if (erreursPage.length) {
      lignes.push('Dernières erreurs de la page (la plus récente en dernier) :',
        ...erreursPage.map((e) => `  il y a ${ilYA(e.at).padStart(7)} · ${e.texte}`
          + (e.ou ? ` — ${e.ou}` : '')));
    }
    return lignes;
  }

  // ------------------------------------------------------------------ montage

  /*
   * Le montage est bavard, volontairement. Un panneau qui n'apparaît pas est
   * indiagnosticable à distance : sans cette trace, impossible de distinguer
   * « Tampermonkey n'exécute pas le script » d'une erreur au démarrage.
   */
  console.info(`[WikiMasters Tools] ${VERSION} — démarrage`);

  /*
   * Les deux gestes qui ne peuvent pas attendre le DOM, dans cet ordre.
   *
   * Ils sont ici, et pas plus haut, parce que `restore()` lit des constantes
   * déclarées tout au long de ce fichier — appelé au milieu, il lève avant
   * même que la page existe. Ils sont ici, et pas dans le montage, parce que
   * le site demande ses notifications dès qu'il s'exécute et ne les redemande
   * plus : le filtre posé après lui ne voit jamais cette lecture.
   *
   * À `document-start`, tout ce fichier s'évalue avant le premier script de la
   * page. Une ligne à la fin du fichier reste donc en avance sur le site — la
   * position dans le fichier ne coûte rien, la position dans le TEMPS est tout.
   *
   * `restore()` passe devant : le filtre lit un réglage, et sans lui la
   * première lecture du site serait filtrée même pour qui a décoché la case.
   * Il porte aussi le plancher de débit appris — le banc l'a rappelé en
   * perdant deux contrôles le jour où il est passé derrière le montage.
   */
  /*
   * Et chacun dans son filet.
   *
   * Ces quatre appels tournaient hors de tout `try`. `restore()` est très
   * défensif, donc le risque était faible — mais si l'un d'eux lève un jour,
   * le script meurt AVANT que `window.__wmAuto` n'existe : la personne perd le
   * panneau ET la poignée de diagnostic, c'est-à-dire tout ce qui permettrait
   * de dire pourquoi. C'est strictement pire que l'échec du montage, qui, lui,
   * est instrumenté depuis longtemps.
   *
   * On journalise donc et on continue : des réglages par défaut valent mieux
   * qu'un écran muet, et un filtre de notifications qui ne se pose pas ne coûte
   * qu'un avis d'invendu affiché.
   */
  for (const [quoi, faire] of [
    ['la relecture des réglages', restore],
    ['le filtre des notifications', installNotifProxy],
    ['le filtre du canal temps réel', installNotifWsProxy],
    ['le filtre des avis à l’écran', installNotifDomFiltre],
    // Avant le site, lui aussi : ses erreurs de chargement doivent trouver preneur.
    ['le relevé des blocages', installerReleveBlocage],
  ]) {
    try {
      faire();
    } catch (err) {
      console.error(`[WikiMasters Tools] ${quoi} a échoué au démarrage :`, err);
      noterFait('démarrage', 'échec', `${quoi} : ${raison(err)}`);
    }
  }

  /*
   * Le montage, lui, attend le DOM : il n'existe pas encore à `document-start`.
   */
  quandLeDomEstPret(() => {
    try {
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

    // Le démarrage automatique suppose le panneau monté : il écrit son état.
    if (prefs.autostart) startWhenFree();
  });

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
   * La vérification du numéro en ligne. Elle se garde elle-même à une fois par
   * heure — le tour n'est là que pour couvrir un onglet resté ouvert toute la
   * journée, cas exactement le plus concerné : c'est celui-là qui rate la
   * fenêtre de Tampermonkey.
   *
   * Le premier passage attend que la page se pose : rien de ceci n'est urgent,
   * et une requête sortante pendant le montage retarderait ce qui l'est.
   */
  setTimeout(chercherMaj, MAJ_PREMIER_DELAI);
  setInterval(chercherMaj, MAJ_TOUTES_LES_MS);

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

  // Le compte à rebours doit rester juste même quand la boucle dort longtemps,
  // et le verrou doit rester frais tant que cet onglet travaille.
  let beat = 0;
  setInterval(() => {
    if (!state.running) return;
    if (state.waitUntil) renderStatus();
    /*
     * La réponse de `takeLock()` était jetée. C'est le silence qui coûtait :
     * un onglet dépossédé continuait sa boucle sans que rien ne le dise, et
     * les deux ouvraient de concert. On le lit, et on s'arrête.
     *
     * Le tour de boucle refait la même vérification avant chaque ouverture —
     * c'est elle qui garantit qu'aucun paquet ne part sans le verrou. Ici, on
     * gagne seulement de le dire tout de suite plutôt qu'à la fin d'une longue
     * attente : sans ça le panneau annoncerait « Prochain paquet dans 2:54 »
     * pendant trois minutes alors que la main est déjà passée à côté.
     */
    if (++beat % 8 === 0 && !takeLock()) { // ~4 s, bien sous le TTL de 12 s
      stop('Un autre onglet a pris la main — boucle arrêtée ici.', true);
    }
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
      // Chaque relevé est borné par sa propre fraîcheur : la liste d'amis à
      // dix minutes — c'est elle qui fait passer une demande de « en attente »
      // à « acceptée » —, le classement à un jour. Ce tour-ci ne fait que
      // garder l'onglet juste entre deux.
      refreshAmis(false).catch(() => {});
      amisLireAuto();
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
  /*
   * Un tour qui échoue ne réessaie pas la seconde suivante : quatre échecs en
   * quatre secondes prendraient un hoquet du serveur pour une panne installée.
   * Quinze secondes entre deux essais, soit une minute avant que la note
   * paraisse — le temps qu'un vrai hoquet passe, pas le temps d'un mardi.
   */
  const RELIST_RETRY_MS = 15000;
  let relistTickBusy = false;

  setInterval(async () => {
    if (relistTickBusy || !prefs.relistUnsold || enPanne('relances')) return;
    if (!Object.keys(state.watch).length) return;
    if (Date.now() < state.nextRelistAt) return;
    relistTickBusy = true;
    try {
      // reconcileWatch refuse d'agir sur un relevé de ventes périmé.
      if (!ventesSuresPourAgir()) {
        // Un autre tour le relève déjà : rien à juger, et surtout rien à
        // compter — `scanSales` rendrait la main sans rien faire.
        if (scanSales.busy) return;
        await scanSales();
      }
      if (!ventesSuresPourAgir()) throw new Error('le relevé des ventes ne se rafraîchit plus');
      await reconcileWatch();
      noterSucces('relances');
    } catch (err) {
      /*
       * Celle-ci d'abord, si un seul de ces filets devait exister : elle agit
       * sur le compte, elle a été cochée à la main, et elle est la seule dont
       * la panne se paie en cartes qui dorment hors du Marché.
       */
      state.nextRelistAt = Date.now() + RELIST_RETRY_MS;
      noterEchec('relances', err);
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
  /*
   * Ce que la lecture de la collection a réellement ramené — surtout combien de
   * lignes ont été relues à cause du glissement de pagination.
   *
   * Ce chiffre-là n'était visible nulle part : la liste était simplement plus
   * longue que la collection, et personne ne comptait. Il s'affiche maintenant
   * à la demande, et il dira tout seul si le glissement s'aggrave — par exemple
   * si la lecture ralentit ou si le rythme d'ouverture monte.
   */
  async function diagTri() {
    /*
     * Une lecture complète, c'est quatre cents requêtes. Deux en même temps,
     * c'est douze appels simultanés au lieu de six — de quoi provoquer le
     * freinage qu'on venait mesurer, et fausser les deux relevés d'un coup,
     * `fetchCollectionRaw` écrivant ses compteurs sur le `sell` partagé.
     */
    if (valueBusy || sell.scanning) {
      console.info('[WikiMasters Tools] diagnostic tri : une lecture est déjà en cours,'
        + ' réessayez quand elle sera finie.');
      return null;
    }

    /*
     * Et on rend les compteurs comme on les a trouvés. Ils ne servent pas qu'à
     * ce diagnostic : la Revente s'en sert pour dire POURQUOI son tableau est
     * vide, et l'infobulle du bouton « Prix ↓ » distingue un serveur qui a
     * ralenti d'un serveur qui a refusé. Les écraser, c'est effacer la trace de
     * la panne qu'on cherche — l'inverse de ce qu'un diagnostic doit faire.
     */
    const avant = { refus: sell.refus, tronque: sell.tronque,
                    freinages: sell.freinages, doublons: sell.doublons };
    const t0 = Date.now();
    try {
      const { data } = await api('/api/my-collection/stats');
      const annonce = (data && data.total) || 0;
      const cartes = await fetchCollectionRaw();
      const rapport = {
        version: VERSION,
        annoncé_par_le_serveur: annonce,
        lignes_gardées: cartes.length,
        doublons_écartés: sell.doublons,
        écart: annonce ? cartes.length - annonce : null,
        lecture_tronquée: sell.tronque,
        freinages_429: sell.freinages,
        secondes: Math.round((Date.now() - t0) / 100) / 10,
      };
      console.info('[WikiMasters Tools] diagnostic tri', rapport);
      return rapport;
    } finally {
      Object.assign(sell, avant);
    }
  }

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
      rapport.compte = 'coche « Accès direct à la base » dans les réglages pour lire '
        + 'is_pro et les sanctions du compte';
    }

    console.info('[WikiMasters Tools] diagnostic cote', rapport);
    return rapport;
  }

  /**
   * Le relevé que le bouton des Réglages met dans le presse-papiers.
   *
   * Ce qu'il ne dit PAS, et c'est délibéré : la taille de la collection, le
   * nombre de Légendaires, l'avancement des succès. Ce sont eux qui
   * identifient un compte sur un jeu à classement public — la même raison qui
   * fait fabriquer la capture du README sur un compte inventé. Un diagnostic
   * collé dans un salon public n'a pas le droit d'en dire plus qu'une image.
   *
   * Les compteurs de SESSION, eux, sont admis : ils repartent de zéro à chaque
   * remise à zéro et ne désignent personne. Ils disent en revanche tout de
   * suite si la boucle a ouvert quelque chose ou rien du tout.
   */
  function construireDiagnostic() {
    const oui = (v) => (v ? '✓' : '✗');
    const opts = [
      ['démarrage auto', prefs.autostart],
      ['paquets bonus', prefs.bonus],
      ['succès auto', prefs.autoclaim],
      ['base directe', prefs.db],
      ['reprise auto', prefs.autoResume],
      ['marché', prefs.watchBids],
      ['notifications', prefs.notify],
      ['souhaits', prefs.watchWish],
      ['relances auto', prefs.relistUnsold],
      ['invendus masqués', prefs.masquerInvendus],
    ]
      .map(([n, v]) => `${n} ${oui(v)}`)
      .join(' · ');

    /*
     * Le nom du navigateur suffit : on cherche « Firefox ou Chrome », pas une
     * empreinte. Et il se lit sous garde — un diagnostic qui LÈVE est pire
     * qu'un diagnostic incomplet : c'est le seul outil qui reste à quelqu'un
     * dont le panneau ne monte pas, et il ne doit rien pouvoir lui refuser.
     */
    const nav =
      ((((typeof navigator === 'object' && navigator && navigator.userAgent) || '')
        .match(/(Firefox|Edg|OPR|Chrome|Safari)\/(\d+)/)) || [])
        .slice(1)
        .join(' ') || 'inconnu';

    /*
     * Le dernier succès de chaque sous-système.
     *
     * La plupart de ces horodatages existaient déjà — chaque relevé porte son
     * `at` — mais ils n'étaient nulle part réunis : il fallait connaître le nom
     * de la clé pour aller le lire, ce qui revient à ne pas les avoir. Réunis,
     * ils répondent d'un coup d'œil à « lequel est en retard ? », qui est la
     * question qu'on pose vraiment quand quelque chose ne marche plus.
     *
     * Aucun de ces chiffres n'identifie un compte : ce sont des dates, pas des
     * quantités. C'est la règle qui a fait retirer d'ici la taille de la
     * collection, le nombre de Légendaires et l'avancement des succès.
     */
    const succes = [
      ['boucle', (state.sains.boucle || {}).ok],
      ['marché', state.sales.at],
      ['amis', state.amis.at],
      ['classement', state.classement.at],
      ['souhaits', state.wishHits.at],
      ['revente', sell.at],
    ]
      .map(([n, at]) => `${n} ${at ? fmtAge(at) : 'jamais'}`)
      .join(' · ');

    /*
     * Le verrou. Un panneau qui dit « Déjà actif dans un autre onglet » sans
     * dire depuis quand, ni si c'est lui-même, envoie chercher un onglet
     * fantôme — le cas classique étant l'onglet tué brutalement dont le verrou
     * traîne jusqu'à expiration.
     */
    const tenu = lockHolder();
    const verrou = !tenu
      ? 'libre'
      : tenu === instanceId
        ? 'tenu par cet onglet'
        : `tenu par un autre onglet (il expire dans ${Math.max(0, Math.round(LOCK_TTL / 1000))} s au plus)`;

    // Les sélecteurs du site qui ont cessé de trouver quoi que ce soit.
    const perdus = Object.entries(state.selecteurs)
      .filter(([, s]) => s.perdu)
      .map(([n, s]) => `${n} — ${s.manques} passages à vide depuis ${fmtSpan(Date.now() - s.depuis)}`);

    /*
     * Et la trajectoire. Un instantané dit où on est ; c'est cet anneau qui dit
     * comment on y est arrivé. Sans lui, un message collé sur le Discord décrit
     * un présent dont personne ne peut rien tirer — « ça ne marche pas » avec
     * plus de détails. Les faits sont datés en RELATIF : « il y a 4 min » se
     * lit sans connaître le fuseau de celui qui colle, et ne le dit pas non
     * plus.
     */
    /*
     * `fmtSpan` compte en minutes : sur un anneau où quatre échecs tiennent en
     * quarante secondes, il écrivait « il y a 0 min » quatre fois de suite —
     * c'est-à-dire précisément l'inverse de ce qu'on lui demande. En dessous
     * d'une minute, on compte donc en secondes.
     */
    const ilYA = (at) => {
      const ms = Math.max(0, Date.now() - at);
      return ms < 60000 ? `${Math.round(ms / 1000)} s` : fmtSpan(ms);
    };
    const faits = state.faits.length
      ? ['Journal des sous-systèmes (le plus récent en dernier) :'].concat(
        state.faits.map((f) => `  il y a ${ilYA(f.at).padStart(7)} · ${f.nom} ${f.verdict}`
          + (f.detail ? ` — ${f.detail}` : ''))
      )
      : [];

    return [
      `WikiMasters Tools ${VERSION}`
        + (state.majDispo ? ` — ${state.majDispo} est en ligne, pas encore installée` : ''),
      `Navigateur : ${nav}`,
      `Page : ${location.pathname}`,
      `Boucle : ${state.running ? 'en marche' : 'arrêtée'}`
        + (state.message ? ` — ${state.message}` : ''),
      `Session : ${state.packs} paquet(s), ${state.cards} carte(s)`,
      /*
       * La cadence apprise, qui explique à elle seule la plupart des « c'est
       * lent chez moi » : un plancher monté à 30 s après une série de refus se
       * lit ici, et nulle part ailleurs.
       */
      `Cadence : ${state.delayMs} ms`
        + (state.probeFloorMs ? `, plancher appris ${state.probeFloorMs} ms` : ', aucun plancher appris')
        // D'affilée, et non « depuis le départ » : chaque paquet ouvert le remet à zéro.
        + ` · ${state.throttles} refus 429 d’affilée`,
      `Verrou : ${verrou}`,
      `Derniers succès : ${succes}`,
      perdus.length ? `Sélecteurs perdus : ${perdus.join(' ; ')}` : null,
      /*
       * L'état de la lecture de la collection, sans jamais dire sa taille.
       *
       * Deux choses seulement, et ce sont des faits sur le SERVEUR, pas sur le
       * compte : le balayage est-il allé au bout, et la pagination a-t-elle
       * rendu deux fois la même ligne. Elles expliquent à elles deux la
       * question « pourquoi cette carte n'est-elle jamais retrouvée ».
       */
      owned.at && (owned.tronque || owned.repetitions)
        ? 'Lecture de la collection : '
          + [owned.tronque ? 'bornée avant la fin' : null,
            owned.repetitions ? 'la pagination a rendu des lignes en double' : null]
            .filter(Boolean).join(' · ')
        : null,
      `Réglages : ${opts}`,
      state.dbNote ? `Base : ${state.dbNote}` : null,
      state.bonusNote ? `Bonus : ${state.bonusNote}` : null,
    ]
      .filter(Boolean)
      .concat(faits)
      // En dernier : il ne sert que le jour où le jeu ne répond plus.
      .concat(releveBlocage())
      .join('\n');
  }

  // Poignée de diagnostic : `__wmAuto.version`, `__wmAuto.state`, `__wmAuto.prefs`.
  window.__wmAuto = {
    version: VERSION,
    start, stop, resetStats, exportCsv, exportJson, claimBonusPacks,
    state, prefs, CFG, sell, openSell, diagCote, diagTri,
    // Ce que la cote couvre, et si l'écart mérite d'être signalé :
    // `__wmAuto.couverture()` rend le détail, `couvertureDistancee()` le filtre.
    couverture, couvertureDistancee,
    // De quoi vérifier la protection par étiquette sans lire le code :
    // `__wmAuto.ownedIndex(true)` reconstruit l'index, `__wmAuto.owned.tagged`
    // liste les cartes hors de portée, `__wmAuto.isTagged(id)` tranche.
    ownedIndex, owned, isTagged,
    /*
     * Et de quoi éprouver le COMPTE des exemplaires, qui décide seul si une
     * carte gardée peut quand même laisser partir une copie :
     * `__wmAuto.cartesDistinctes(await __wmAuto.fetchCollection())`.
     */
    cartesDistinctes, fetchCollection,
    // La cote d'un lot de cartes tirées : `__wmAuto.priceCards([{ id, t, r, tags }])`.
    priceCards,
    // Pour éprouver que des conditions LUES n'écrasent pas celles que vous choisissez.
    enrolWatch,
    // Et que la pause se lève quand plus rien n'attend : `__wmAuto.reveillerAuRepos(ids)`.
    reveillerAuRepos,
    // Ce que le canal des notifications a fait passer, pour voir sa vraie forme.
    notifTrames,
    // Le filet du DOM, atteignable pour l’éprouver : `__wmAuto.appliquerMasquage()`.
    appliquerMasquage, masquerLignesInvendues, rendreLignesInvendues,
    /*
     * Les deux calculs de la Revente, sortis du gabarit et donc éprouvables :
     * ce qu'une ligne propose (« Vendre », « en file », « en vente »,
     * « protégée ») et le résumé de l'en-tête avec ses mises en garde.
     */
    etatLigne, resumeRevente,
    /*
     * Le filet des tours secondaires, atteignable lui aussi. Éprouver qu'une
     * boucle abandonne au bout de quatre échecs demanderait sinon d'attendre
     * quatre vraies pannes du serveur — c'est-à-dire de ne jamais l'éprouver.
     * `noterEchec('relances', new Error('essai'))` quatre fois pose la note.
     */
    noterEchec, noterSucces, enPanne,
    /*
     * Le relevé que le bouton des Réglages met dans le presse-papiers, sans
     * passer par le presse-papiers : `__wmAuto.diagnostic()` l'écrit en clair
     * pour qui a la console ouverte, et le banc le lit sans DOM.
     */
    diagnostic: construireDiagnostic,
  };
})();
