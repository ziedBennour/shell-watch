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

Le nom du projet, son dossier en entier, depuis quand la session est ouverte, puis la date
et l'heure, le modèle de la session et son niveau d'effort, une ligne vide entre chaque.

### Abonnement

```
5h     ━━━━━━━━━━  20%  6,0%/h → 43%  +57%  ↻ 3h50 (09:30)
7j     ━━━━━━━━━━  13%  0,4%/h → 32%  +68%  ↻ 2j 15h (dim. 21:00)
Fable  ━━━━━━━━━━  17%  0,5%/h → 38%  +62%  ↻ 2j 15h (dim. 20:59)

ctx    ━━━━━━━━━━  41%    82k / 200k
coût   $3.10 · 2,58 $/h · 2,4k tok/min
```

Une ligne par limite, les colonnes alignées d'une limite à l'autre. Quand le panneau est
trop étroit (moins de 65 à 70 colonnes environ), chaque limite passe sur deux lignes : la
barre avec son reset, puis le rythme et la projection en dessous.

- **5h** et **7j** : les limites de l'abonnement, tous modèles confondus.
- **Fable** (ou un autre modèle) : la semaine propre à un modèle, quand ton abonnement en a
  une. L'API ne la donne pas : le mod la lit dans `/usage`, toutes les 5 minutes.
- La barre : verte, orange quand il te restera moins de 10 % au reset à ce rythme (ou que
  la limite tombe avant), rouge à partir de 80 %.
- Après le pourcentage, le **rythme**, la **projection** et le **reset** :
  - `6%/h` : la vitesse à laquelle la fenêtre se remplit, en moyenne depuis son début
    (toute la fenêtre 5h, toute la semaine). Elle apparaît après 10 minutes (5h) ou
    2 heures (semaine).
  - sa couleur : gris tant que tu as de la marge, orange quand tu approches du rythme qui
    t'amènerait pile à 100 % au reset, rouge quand tu le dépasses.
  - `→ 32%  +68%` : le pourcentage que tu auras au reset si tu gardes ce rythme, puis ce
    qu'il te restera.
  - `→ -15:40  -12%` en rouge : à ce rythme, la limite tombe avant le reset, à 15:40
    (avec le jour si ce n'est pas aujourd'hui), et serait dépassée de 12 % au reset.
  - `↻ 3h50 (09:30)` : le reset de la fenêtre, dans combien de temps et à quelle heure.
- **ctx** : le remplissage de la fenêtre de contexte de la session.
- **coût** : le coût de la session en équivalent API, ce coût par heure, et les tokens
  consommés par minute (sous-agents compris, lectures du cache non comptées).

### Projet

```
▾ Projet  coût estimé au prix de l'API

         coût  travail   $/h  ouvert   $/h
auj.    $4.20     1h20  3,15    2h05  2,01
7 j    $31.00     9h10  3,38   14h20  2,16
total  $52.10    15h40  3,33   22h05  2,36

Opus 5.5    $40.10  2,56 $/h  1,2M tok
Haiku 4.5    $2.00  0,13 $/h  300k tok
```

Ce que coûte le projet (le dossier de la session), toutes ses sessions additionnées, celles
qui tournent en parallèle comprises : aujourd'hui, les 7 derniers jours, et depuis
l'installation de la version 0.10.0 (rien de rétroactif).

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
- **ouvert** : le temps où la session est ouverte ; une machine en veille ne compte pas.
- **$/h** : le coût divisé par le temps de travail, puis par le temps ouvert (`–` sous 5 min).
- Par modèle, sur le total : son coût, sa part du $/h de travail (les parts s'additionnent
  au $/h du projet) et ses tokens, lectures du cache non comptées.

`/couts` donne le détail jour par jour, chaque modèle avec ses quatre types de tokens
(entrée, écriture du cache, lecture du cache, sortie).

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

## Où sont les données

- **Historique des limites** : chaque relevé des fenêtres 5h / 7j / Fable est gardé 8 jours
  dans `~/.claude/plugins/store/shell-watch_*.json`. Ce fichier est commun à toutes les
  sessions et tous les projets : chaque session voit le pourcentage le plus haut relevé
  par les autres.
- **Projet** : un enregistrement par session (chaque session n'écrit que le sien) dans ce même
  fichier, écrit chaque minute et à la fermeture ; les jours d'avant-hier et plus anciens
  sont regroupés en un enregistrement par projet. Les sections pliées y sont aussi gardées.
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

## Développement

```bash
claude plugin validate .
```

- `hooks/register.tsx` : le mod (hooks, calculs, rendu du panneau).
- `hooks/project.ts` : les enregistrements de la section Projet (par jour, par session, archive).
- `types/index.d.ts` : le contrat des valeurs que le mod garde (`$.state`).

## Licence

[MIT](LICENSE)
