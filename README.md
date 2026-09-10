# WikiMasters Tools

**Un panneau qui joue pendant que vous faites autre chose.**

Il ouvre vos paquets dès qu'ils se régénèrent, chiffre la valeur réelle de vos
cartes, surveille les enchères et remet vos invendus en vente.

Un seul fichier, qui tourne dans votre navigateur sur
[wiki-masters.com](https://www.wiki-masters.com). Aucun identifiant demandé.
Rien envoyé nulle part.

### → [Installer](https://raw.githubusercontent.com/D1d1s/wikimasters-tools/main/wikimasters-auto.user.js) · [Discord](https://discord.gg/m5NHPSSk6B)

⚠️ Lisez les quatre étapes avant de cliquer. La deuxième, tout le monde la rate.

<p align="center">
  <img src="panneau.png" alt="Le panneau WikiMasters Tools" width="290">
</p>

---

## Ce que ça fait

### 📦 Paquets

- Ouvre vos paquets en boucle, au rythme que le serveur autorise.
- Dort jusqu'à l'heure exacte de régénération, avec le compte à rebours.
- Journal des tirages. Un clic sur une rareté ouvre votre collection dessus.

### 🪙 Marché

- Vos enchères, vos ventes, et leurs emplacements.
- Vos souhaits mis aux enchères, prix demandé comparé à leur cote.
- Remise en vente des invendus, toujours au prix que vous avez fixé.
- Après deux échecs, un prix plus bas est proposé. Il attend votre clic.

### 🏆 Succès

- Le palier de collection le plus proche, ce qu'il paie, et le temps qu'il
  demande au rythme mesuré sur votre session.
- Où vous en êtes sur les 51 succès.
- Ceux dont la récompense **attend d'être réclamée** — elle ne se crédite pas
  toute seule, et rien ne le signale ailleurs.

### 🏰 Guilde

- Les cartes que vous pouvez donner tout de suite, avec le karma de chacune.
- Un lot de cinq, prêt à publier dans le tchat.
- Vos souhaits déjà chez vos amis, Légendaires en tête, page d'échange ouverte
  au bon nom en un clic.

### Et dans les pages du jeu

- Un tri **par prix** de toute la collection.
- **Tout souhaiter** : une recherche entière en liste de souhaits. Des centaines
  de cartes en un clic.
- Une page de revente qui dit à quel prix vendre, et sur quelles cartes vous
  seriez le seul vendeur. Une carte s'y met en file : elle part toute seule
  quand un de vos dix emplacements se libère.

---

## Installation

1. **Installez Tampermonkey.** Cherchez `tampermonkey` suivi du nom de votre
   navigateur, et installez depuis la boutique officielle. Brave, Edge et Opera
   passent par le Chrome Web Store.

2. **Autorisez les scripts utilisateur.** Sur Chrome : `chrome://extensions` →
   carte Tampermonkey → **Autoriser les scripts utilisateur**.

   > ⚠️ C'est l'étape que tout le monde rate. Sans elle, le script s'installe
   > normalement mais ne s'exécute **jamais**, et rien ne vous le dit.

3. **Ouvrez [le lien d'installation](https://raw.githubusercontent.com/D1d1s/wikimasters-tools/main/wikimasters-auto.user.js).**
   Tampermonkey affiche sa page, vous cliquez sur **Installer**. Rien à
   télécharger ni à ranger : le lien *est* l'installation.

4. **Actualisez WikiMasters (`F5`).** Le panneau apparaît en bas à droite.
   Cliquez sur **Start**.

**Les mises à jour se font seules**, sous 24 h. Vous n'attendez pas jusque-là :
dès qu'une version sort, une **pastille verte** paraît à côté du titre du
panneau. Un clic dessus l'installe tout de suite.

---

## Ça ne marche pas ?

| Ce que vous voyez | Ce qu'il faut faire |
| --- | --- |
| Pas de panneau | Actualisez la page (`F5`). Un onglet ouvert avant l'installation ne charge pas le script. |
| Toujours pas de panneau | Reprenez l'étape 2. C'est presque toujours l'étape 2. |
| « réservé aux comptes PRO » sur les prix | Réglages → **Accès direct à la base**. Coché par défaut. |
| Le script s'arrête et parle d'une vérification | Faites-la à la main dans l'onglet. Il repart seul. |
| Une partie du panneau s'est arrêtée | La note dit laquelle et depuis quand. Le bouton **Réessayer** la relance sans recharger. |
| On vous demande un diagnostic, et le panneau ne s'affiche pas | `F12`, onglet **Console**, tapez `copy(__wmAuto.diagnostic())` puis `Entrée`. Le relevé est dans votre presse-papiers. |

Quand le panneau est là, le même relevé s'obtient sans console : **Réglages →
Copier le diagnostic**. Il dit la version, la page, l'état de la boucle, la
cadence apprise, la date du dernier succès de chaque partie, et les dernières
pannes horodatées. Il ne dit ni la taille de votre collection, ni vos
Légendaires, ni vos succès : vous pouvez le coller dans un salon public.

Le reste se demande sur le **[Discord](https://discord.gg/m5NHPSSk6B)** : c'est
le seul endroit. Vous y trouverez aussi les nouvelles versions et le guide du
panneau, onglet par onglet. L'invitation n'expire pas et peut être partagée.

---

## Ce qu'il ne fait pas

- Il ne demande **aucun identifiant** et n'envoie rien à personne. Il se sert de
  la session déjà ouverte dans votre onglet.
- Il ne **contourne pas** la vérification humaine du site. Il s'arrête, vous
  prévient, et repart seul quand vous avez coché.
- Il ne **vend ni ne donne** à votre place. Ces gestes sont irréversibles, ils
  restent à votre main. Les relances automatiques sont décochées par défaut.
- Il ne va pas plus vite que ce que le serveur autorise.

Le code tient dans
[un seul fichier](https://github.com/D1d1s/wikimasters-tools/blob/main/wikimasters-auto.user.js),
en clair. Vous pouvez le lire avant de l'installer.

---

## Compte PRO ou gratuit

Tout fonctionne dans les deux cas. Ce qui change vient du site, pas de l'outil :
la régénération d'un paquet (~3 min avec PRO, ~10 min sans) et le pack quotidien
bonus, réservé aux comptes PRO.
