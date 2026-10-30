# shell-watch

Mod pour Claude Code : un panneau, à côté de la conversation, qui montre en direct
les commandes shell que Claude lance, les sous-agents au travail, et ta consommation
d'abonnement (limites 5h / 7j / semaine par modèle) avec ton rythme et une projection.

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

Il se lit de haut en bas.

### En-tête

Le nom du projet en grandes lettres, son dossier, depuis quand la session est ouverte, la
date et l'heure, le modèle de la session et son niveau d'effort.

### Abonnement

```
5h     ━━━━━━   20%  reset dans 3h50 (09:30) · 6%/h → 43%
7j     ━━━━━━   13%  reset dans 2j 15h (dim. 21:00) · 0,4%/h → 32%
Fable  ━━━━━━   17%  reset dans 2j 15h (dim. 20:59) · 0,5%/h → 38%

ctx    ━━━━━━   41%  82k / 200k
coût   $3.10 · 2,58 $/h · 2,4k tok/min
```

- **5h** et **7j** : les limites de l'abonnement, tous modèles confondus.
- **Fable** (ou un autre modèle) : la semaine propre à un modèle, quand ton abonnement en a
  une. L'API ne la donne pas : le mod la lit dans `/usage`, toutes les 5 minutes.
- Après le reset, le **rythme** et la **projection** :
  - `6%/h` : la vitesse à laquelle la fenêtre se remplit, mesurée sur les 30 dernières
    minutes (5h) ou les dernières 24 h (semaine). Tant que l'historique est plus court,
    c'est la moyenne depuis le début de la fenêtre.
  - sa couleur : gris tant que tu as de la marge, orange quand tu approches du rythme qui
    t'amènerait pile à 100 % au reset, rouge quand tu le dépasses.
  - `→ 43%` : le pourcentage que tu auras au reset si tu gardes ce rythme.
  - `→ limite dans 1h20 (15:40)` en rouge : à ce rythme, la limite tombe avant le reset.
- **ctx** : le remplissage de la fenêtre de contexte de la session.
- **coût** : le coût de la session en équivalent API, ce coût par heure, et les tokens
  consommés par minute (sous-agents compris, lectures du cache non comptées).

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
  sessions et tous les projets, ce qui donne un rythme même juste après l'ouverture d'une
  session.
- **Shells, agents, tokens** : propres à la session, ils repartent de zéro à chaque démarrage.
- **`/usage`** : lu par `claude -p --safe-mode --no-session-persistence /usage`, sans
  plugins, sans session enregistrée et sans requête au modèle.

## Limites connues

- La croix en haut à droite du panneau est dessinée par Claude Code : le mod ne peut pas la
  changer.
- La fenêtre par modèle (Fable) dépend du texte affiché par `/usage` : si une version de
  Claude Code le change, cette barre disparaît, le reste du panneau continue de marcher.
- Le pourcentage d'une limite n'a qu'une décimale : le rythme récent n'est fiable qu'après
  quelques minutes de travail.

## Développement

```bash
claude plugin validate .
```

- `hooks/register.tsx` : tout le mod (hooks, calculs, rendu du panneau).
- `hooks/bigfont.ts` : les grandes lettres du nom de projet.
- `types/index.d.ts` : le contrat des valeurs que le mod garde (`$.state`).
