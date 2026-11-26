# shell-watch

Mod pour Claude Code : un panneau, à côté de la conversation, qui montre en direct
les commandes shell que Claude lance, les sous-agents au travail, ta consommation
d'abonnement (limites 5h / 7j / semaine par modèle) avec ton rythme et une projection,
et ce que coûte une heure de travail sur le projet.

## Installation

Depuis GitHub :

```bash
claude plugin marketplace add ziedBennour/shell-watch
claude plugin install shell-watch@shell-watch
```

Puis redémarre Claude Code (`/restart`).

Depuis un clone local (pour modifier le mod) :

```bash
git clone https://github.com/ziedBennour/shell-watch.git
claude plugin marketplace add ./shell-watch
claude plugin install shell-watch@shell-watch
```

### Mettre à jour

Au premier lancement, le mod demande s'il peut se mettre à jour tout seul. Avec un oui, il
active l'auto-update de son marketplace, comme le fait `/plugin` → Marketplaces →
shell-watch → Turn on auto-update. Ensuite, à chaque démarrage, Claude Code installe la
nouvelle version et propose `/reload-plugins`. `/maj-auto` active l'auto-update plus tard,
`/maj-auto off` le coupe.

À la main :

```bash
claude plugin marketplace update shell-watch
claude plugin update shell-watch@shell-watch
```

Puis `/restart`. Le mod est installé sous forme de copie (dans `~/.claude/plugins/cache/`) :
une modification du code ne compte qu'après cette mise à jour, et le numéro de version de
`.claude-plugin/plugin.json` doit changer pour qu'elle soit prise.

## Usage

Le panneau s'ouvre tout seul au démarrage d'une session quand le terminal est assez large
(environ 110 à 144 colonnes). Sinon, ou après l'avoir fermé : tape `/shells`.

Il se lit de haut en bas. Chaque section (Abonnement, Projet, Agents, Shells) se plie et
se déplie d'un clic sur son titre (▾ ouverte, ▸ pliée, avec un résumé sur la ligne du
titre) ; une section pliée le reste d'une session à l'autre.

### En-tête

```
mer. 18 nov.  ·  22:31:05          /home/moi/projet  Opus 5.5  ▰▰▰▱▱ moyen
session depuis 2 h 10 (ouverte à 20:15)
```

À gauche la date et l'heure ; à droite le dossier du projet, le modèle de la session et son
niveau d'effort, chacun de sa couleur. Dessous, depuis quand la session est ouverte.

### Abonnement

```
5h     ━━━━━━━━━━  20%  +57% au reset dans 3h50 (09:30)
7j     ━━━━━━━━━━  13%  +68% au reset dans 2j 15h (dim. 21:00)
Fable  ━━━━━━━━━━  90%  -26% au reset dans 2j 15h (dim. 20:59)

ctx    ━━━━━━━━━━  41%    82k / 200k
coût   $3.10 · 2,58 $/h · 2,4k tok/min
```

Une ligne par limite, les colonnes alignées d'une limite à l'autre. Quand le panneau est
trop étroit (moins de 65 à 70 colonnes environ), chaque limite passe sur deux lignes : la
barre avec son reset, puis ce qu'il restera en dessous.

- **5h** et **7j** : les limites de l'abonnement, tous modèles confondus.
- **Fable** (ou un autre modèle) : la semaine propre à un modèle, quand ton abonnement en a
  une. L'API ne la donne pas : le mod la lit dans `/usage`, toutes les 5 minutes.
- La barre : verte, orange quand il te restera moins de 10 % au reset à ce rythme (ou que
  la limite tombe avant), rouge à partir de 80 %.
- Après le pourcentage, à ton rythme (la moyenne depuis le début de la fenêtre, connue après
  10 minutes pour 5h, 2 heures pour une semaine) :
  - `+57% au reset` : en vert, ce qu'il te restera au reset.
  - `-26% au reset` : en rouge, la limite tombe avant le reset et serait dépassée de 26 %.
  - `dans 3h50 (09:30)` : le reset de la fenêtre, dans combien de temps et à quelle heure.
- **ctx** : le remplissage de la fenêtre de contexte de la session.
- **coût** : le coût de la session en équivalent API, ce coût par heure, et les tokens
  consommés par minute (sous-agents compris, lectures du cache non comptées).

### Projet

```
▾ Projet  commencé le jeu. 30 oct. 2026 · coût estimé au prix de l'API

séance          $1.20   0h40  1,80 $/h
  Opus 5.5      $1.00         1,50 $/h  83%
  Sonnet 5.5    $0.20         0,30 $/h  17%

depuis ↻ 7j    $12.40   6h10  2,01 $/h
  Opus 5.5     $10.00         1,62 $/h  81%
  Sonnet 5.5    $2.40         0,39 $/h  19%

total          $40.10  21h00  1,91 $/h
  Opus 5.5     $35.00         1,67 $/h  87%
  Sonnet 5.5    $5.10         0,24 $/h  13%
```

Ce que coûte le projet (le dossier de la session), toutes ses sessions additionnées, celles
qui tournent en parallèle comprises, sur trois périodes :

- **séance** : la session en cours, depuis son début ; elle continue après un `/restart` et
  repart à zéro après `/clear`.
- **depuis ↻ 7j** : depuis le dernier reset de la limite 7j (à l'heure près). Sans limite
  connue (clé API) : **7 derniers j**.
- **total** : depuis l'installation de la version 0.10.0 (rien de rétroactif) ; le titre
  donne le premier jour compté (**commencé le**), tous ordinateurs confondus.

Sur chaque ligne :

- **coût** : une estimation en équivalent API (le coût que donne `/cost`), pas la facture de
  l'abonnement. Chaque hausse va au modèle de la requête qui vient de finir, sous-agents
  compris ; des requêtes finies en même temps se la partagent au prorata de leurs tokens,
  pondérés comme l'API les facture (écriture du cache ×1,25, lecture ×0,1, sortie ×5).
- **travail** : le temps où quelqu'un travaille. Toi : tu tapes, envoies un message, réponds
  à une autorisation, cliques dans le panneau ou ouvres la session, il y a moins de 5 min.
  Ou le modèle : un tour en cours (même s'il attend un shell lancé dans ce tour), ou un
  sous-agent en marche. Claude qui attend ta réponse à une autorisation ou une question ne
  travaille pas ; un shell en fond ou une minuterie seuls non plus. Après 5 min sans rien,
  le compteur s'arrête et ce trou compte 3 min ; il repart au signe suivant.
- **$/h** : le coût divisé par le temps de travail (`–` sous 5 min). Par modèle, sa part :
  les parts s'additionnent au $/h de la période.
- **%** (par modèle) : sa part du coût de la période.

`/couts` donne le détail jour par jour, chaque modèle avec ses quatre types de tokens
(entrée, écriture du cache, lecture du cache, sortie).

Une session compte pour le dossier où elle a démarré. Le travail fait sur un projet depuis
un autre dossier (une session lancée sur le Bureau) se rattache à la main :
`/projet-rattacher` liste les dossiers qui ont un coût compté, et
`/projet-rattacher <dossier>` (son chemin, ou son nom s'il est le seul à le porter)
déplace tout ce que ce dossier a compté vers le projet de la session. Une session encore
ouverte dans ce dossier bloque le déplacement : il faut la fermer avant.

### Agents

N'apparaît qu'une fois qu'un sous-agent a été lancé dans la session.

```
Agents  1 en cours · 1 terminé                         x tout effacer

 ◐ Opus 5.5 high  14:05:12 → +38s  Lit le manifeste du mod  general
     5 outils · 33k tok · bg  ↳ Bash · Pause de test

 ✓ Haiku 4.5  14:02:31 → 14:03:10  Compte les lignes  Explore         x
     39s · 5 outils · 17k tok · bg
```

- Chaque agent : son état (◐ en cours, ✓ terminé, ■ stoppé, ✗ échec), son modèle et son
  effort, son heure de début et de fin (ou le temps écoulé), sa tâche et son type.
- Dessous : sa durée, ses appels d'outils, ses tokens, `bg` s'il tourne en fond, et pour un
  agent en cours ce qu'il fait (`↳`), ou « en attente » quand il attend une autorisation.
- Un agent lancé par un autre agent est décalé sous son parent.
- Les agents terminés restent affichés (les 50 derniers). `x` au bout d'une ligne retire un
  agent terminé ; `x tout effacer`, quand tous sont terminés, vide la liste et la section.

### Shells

Chaque commande Bash lancée par Claude ou par un agent, avec son heure, sa durée, son
code de sortie et ses dernières lignes de sortie, en direct tant qu'elle tourne.

- Les compteurs en haut filtrent la liste (tous, en cours, en fond, réussis, en erreur,
  stoppés) ; un second clic les retire.
- Clique une commande terminée pour voir sa sortie.
- `bg` : lancée en fond. `agent` : lancée par un sous-agent.
- Le mod garde les 200 dernières commandes et affiche les 50 dernières terminées.
- Le titre d'une commande est sa description quand Claude en donne une, sinon la commande.

### Son de fin de travail

Quand Claude a fini (la fin d'un tour, sauf si tu l'as interrompu ; pas les sous-agents), le
son de notification du système : celui de Windows (`Windows Notify System Generic.wav`),
`Glass` sur macOS, `complete.oga` (freedesktop) sur Linux. `/son` le coupe ou le remet ;
le choix est gardé d'une session à l'autre.

## Où sont les données

- **Historique des limites** : chaque relevé des fenêtres 5h / 7j / Fable est gardé 8 jours
  dans `~/.claude/plugins/store/shell-watch_*.json`. Ce fichier est commun à toutes les
  sessions et tous les projets : chaque session voit le pourcentage le plus haut relevé
  par les autres.
- **Projet** : un enregistrement par session (chaque session n'écrit que le sien) dans ce même
  fichier, écrit chaque minute et à la fermeture, avec ses 8 derniers jours heure par heure
  (pour couper au reset de 7j) ; les jours d'avant-hier et plus anciens sont regroupés en un
  enregistrement par projet. Les sections pliées y sont aussi gardées.
- **Projet dans le dépôt git** : à chaque `git commit` lancé par Claude, le mod écrit
  `.shell-watch/<ordinateur>.json` (ce que cet ordinateur a compté pour le projet, jour par
  jour) et l'ajoute au commit. Un clone sur un autre ordinateur lit tous ces fichiers et
  ajoute ce que son propre store n'a pas : les totaux suivent le dépôt, sans double compte
  (chaque session a un identifiant unique). Un fichier par ordinateur : pas de conflit de
  fusion. Un commit fait à la main ne met rien à jour : le prochain commit de Claude le fait.
  Pour ne pas versionner ces stats : `.shell-watch/` dans `.gitignore`.
- **Shells, agents, tokens** : propres à la session, ils repartent de zéro à chaque démarrage.
- **`/usage`** : lu par `claude -p --safe-mode --no-session-persistence /usage`, sans
  plugins, sans session enregistrée et sans requête au modèle.

## Limites connues

- La croix en haut à droite du panneau est dessinée par Claude Code : le mod ne peut pas la
  changer.
- La fenêtre par modèle (Fable) dépend du texte affiché par `/usage` : si une version de
  Claude Code le change, cette barre disparaît, le reste du panneau continue de marcher.
- Le pourcentage d'une limite n'a qu'une décimale : en début de fenêtre, le rythme bouge
  par paliers.
- Le coût par modèle est une répartition : un coût qui ne vient pas d'une requête de la
  conversation ou d'un sous-agent (le classifieur du mode auto, l'appel au modèle d'un autre
  mod) va à la requête suivante. Le total du projet, lui, est exact au sens de `/cost`.
- La séance compte les sessions écrites depuis moins de 8 jours : une session reprise plus
  tard repart de ce qui a été fait depuis sa reprise.

## Développement

```bash
claude plugin validate .
```

- `hooks/register.tsx` : le mod (hooks, calculs, rendu du panneau).
- `hooks/project.ts` : les enregistrements de la section Projet (par jour, par session, archive).
- `types/index.d.ts` : le contrat des valeurs que le mod garde (`$.state`).

## Licence

[MIT](LICENSE)
