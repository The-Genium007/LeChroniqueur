# Spec V2 — Discord (Components V2, Dashboard, Recherche)

## Prérequis

- discord.js 14.25.1
- Flag `MessageFlags.IsComponentsV2` sur tous les messages du bot

## Intents requis

```typescript
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageTyping,  // Pour la détection d'activité
  ],
});
```

## Permissions bot requises

- `ManageChannels` — créer catégories + channels
- `ManageRoles` — définir les permissions des channels
- `ViewChannel` — voir les channels
- `SendMessages` — envoyer des messages
- `ManageMessages` — supprimer des messages (nettoyage #recherche)
- `EmbedLinks` — liens dans les messages
- `AttachFiles` — envoi de médias

## Structure des channels par instance

```
📁 {Nom de l'instance}          ← Catégorie Discord (privée)
├── 📊╏dashboard                ← 1 message permanent (accueil)
├── 🔍╏recherche                ← Interface permanente + résultats temporaires
├── 📰╏veille                   ← Append-only : digest + articles
├── 💡╏idées                    ← Append-only : suggestions
├── 🎬╏production               ← Append-only : scripts + galerie
├── 📤╏publication              ← Append-only : kits de publication
└── 📋╏logs                     ← Append-only : logs + alertes
```

Tous les channels sont privés (visibles par le bot + l'admin qui a onboardé).
Les channels de contenu sont append-only (on ne supprime/modifie jamais les messages).

## Components V2 — Composants utilisés

### Layout
- **Container** (type 17) — carte avec barre de couleur latérale
- **Section** (type 9) — texte + accessoire (bouton ou thumbnail)
- **Separator** (type 14) — divider avec espacement
- **ActionRow** (type 1) — groupe de boutons/select menus

### Contenu
- **TextDisplay** (type 10) — texte Markdown
- **MediaGallery** (type 12) — grille d'images
- **Thumbnail** (type 11) — petite image dans une Section

### Interactif
- **Button** — boutons d'action
- **StringSelectMenu** — sélection dans une liste
- **Modal** — formulaire pop-up (5 champs max)

### Limite de composants

- 40 composants max par message (10 top-level, 30 nested)
- Règle interne : ne jamais dépasser 30/40 pour garder de la marge
- Chaque page du dashboard doit être budgétée avant implémentation

## Le Dashboard (`#dashboard`)

### Principe

Un seul message permanent dans le channel. Ce message affiche la page **Accueil** avec les stats globales. Les sous-pages (Veille, Contenu, Budget, Config) sont envoyées en **messages éphémères** quand l'admin clique un bouton. Cela élimine les race conditions multi-admin.

### Page Accueil (message permanent)

Contenu :
- Titre : "🎛️ {Nom instance} — Dashboard"
- Section Veille : articles en attente, dernière exécution, prochaine
- Section Suggestions : en attente, taux de Go cette semaine
- Section Publications : programmées, prochain post
- Section Budget : jour + mois avec barre de progression
- Section Santé : status des services (Discord, Anthropic, SearXNG, Postiz, SQLite)
- Boutons navigation : [Veille] [Contenu] [Budget] [Config]
- Boutons action : [Rafraîchir] [Pause instance]

Auto-refresh : le message est mis à jour automatiquement après chaque job cron.

Recréation au boot : si le message n'existe plus, le bot le recrée.

### Page Veille (éphémère)

Contenu :
- Stats (aujourd'hui, semaine, en attente, transformés, archivés)
- Catégories actives (liste)
- Scheduler (cron actuel, dernière/prochaine exécution)
- Boutons : [Lancer maintenant] [Top articles semaine] [Modifier catégories] [Retour]

### Page Contenu (éphémère)

Contenu :
- Stats suggestions (total, Go, Skip, modifiées, taux)
- Stats publications (programmées, publiées, métriques)
- Boutons : [Générer suggestions] [Voir en attente] [Retour]

### Page Budget (éphémère)

Contenu :
- Détail jour/semaine/mois avec barres de progression
- Détail par service (Anthropic, Google AI)
- Boutons : [Modifier seuils] [Retour]

Le bouton [Modifier seuils] ouvre un Modal avec les 3 champs (jour, semaine, mois en centimes).

### Page Config (éphémère)

Contenu :
- Section Suggestions : nombre par cycle, score minimum, plateformes
- Section Scheduler : crons actuels
- Section Budget : seuils actuels
- Section Persona : nom du fichier, taille, dernière modification
- Section Publication : mode actuel (Manuel / Postiz)
- Boutons [✏️] sur chaque section → ouvrent un Modal d'édition
- Bouton Persona → sous-menu éphémère :
  - [Voir le persona actuel]
  - [Uploader un fichier .md]
  - [Modifier avec l'IA]
  - [Modifier une section] → Select Menu + Modal
- Boutons : [Annuler dernier changement] [Reset aux défauts] [Nouvelle instance] [Retour]

## La Recherche (`#recherche`)

### Principe

Un message permanent (interface de recherche) + des messages de résultats temporaires nettoyés après 12h d'inactivité ou au boot du bot.

### Interface permanente

- Titre : "🔍 Recherche — {Nom instance}"
- Description : "Recherche dans la veille, les suggestions et les publications."
- Boutons : [Rechercher] [Articles récents] [Suggestions récentes] [Publications]

Le bouton [Rechercher] ouvre un Modal avec un champ "Termes de recherche".

### Résultats (temporaires)

Postés en dessous de l'interface permanente. Contiennent :
- Titre : "Résultats pour '{query}'"
- Nombre de résultats
- Sections par table (Veille, Suggestions, Publications)
- Pagination : [Précédent] [Page X/Y] [Suivant]
- Actions : [Nouvelle recherche] [Effacer résultats]

### Nettoyage

- **Explicite** : bouton [Effacer résultats]
- **Timeout** : 12h sans interaction dans #recherche → suppression des résultats
- **Boot** : au démarrage du bot, suppression de tous les messages sauf l'interface permanente
- L'ID du message permanent est stocké en DB

## Messages de contenu (V2)

### Article de veille (`#veille`)

```
Container (couleur: veille)
├── Section (titre article + score + thumbnail)
├── TextDisplay (angle suggéré)
├── Separator
└── ActionRow [👍] [👎] [🎯 Deep dive] [⏭️ Archiver]
```

### Suggestion (`#idées`)

```
Container (couleur: suggestion)
├── TextDisplay (titre)
├── Section (contenu de la suggestion)
├── Section (pilier, inline) + Section (plateforme, inline)
├── Separator
└── ActionRow [✅ Go] [✏️ Modifier] [⏭️ Skip] [⏰ Later]
```

### Script final (`#production`)

```
Container (couleur: production)
├── TextDisplay (titre)
├── TextDisplay (texte overlay)
├── Separator
├── TextDisplay (script complet)
├── Separator
├── MediaGallery (variantes d'images)
├── Separator
└── ActionRow [✅ Valider] [✏️ Retoucher]
```

### Kit de publication (`#publication`)

```
Container (couleur: publication)
├── TextDisplay (titre + plateforme + heure)
├── Separator
├── TextDisplay (caption à copier, dans un bloc code)
├── Separator
├── MediaGallery (images prêtes)
├── TextDisplay (notes de production)
├── Separator
├── ActionRow [📋 Copier caption] [📥 Télécharger tout]
└── ActionRow [✅ Marqué comme publié] [📅 Reporter]
```

[Copier caption] → envoie la caption en éphémère (facile à copier).
[Télécharger tout] → envoie les images en pièces jointes dans un éphémère.
[Marqué comme publié] → enregistre, retire les boutons.

## Boutons — Custom IDs

Format V2 (inchangé, extensible) :

```
{action}:{targetTable}:{targetId}
```

Nouveaux custom IDs pour le dashboard et la recherche :

```
# Dashboard navigation
dash:home                          → Rafraîchir l'accueil
dash:veille                        → Page Veille (éphémère)
dash:content                       → Page Contenu (éphémère)
dash:budget                        → Page Budget (éphémère)
dash:config                        → Page Config (éphémère)
dash:pause                         → Pause/Resume instance
dash:veille:run                    → Lancer veille maintenant
dash:veille:top                    → Top articles semaine
dash:veille:categories             → Modifier catégories
dash:suggestions:generate          → Générer suggestions
dash:suggestions:pending           → Voir en attente
dash:config:edit:{section}         → Ouvrir Modal d'édition
dash:config:persona                → Sous-menu persona
dash:config:undo                   → Annuler dernier changement
dash:config:reset                  → Reset aux défauts
dash:config:new_instance           → Lancer le wizard pour une nouvelle instance

# Recherche
search:open                        → Ouvrir Modal de recherche
search:recent:articles             → Articles récents
search:recent:suggestions          → Suggestions récentes
search:recent:publications         → Publications
search:page:{n}                    → Pagination
search:clear                       → Effacer résultats

# Publication
pub:copy:{id}                      → Copier caption
pub:download:{id}                  → Télécharger médias
pub:done:{id}                      → Marqué comme publié
pub:postpone:{id}                  → Reporter

# Onboarding
onboard:start                      → Démarrer l'onboarding
onboard:key:{type}                 → Entrer une clé API
onboard:postiz:have                → J'ai un Postiz
onboard:postiz:guide               → Comment installer
onboard:postiz:social:{platform}   → Configurer une plateforme
onboard:postiz:verify              → Vérifier les intégrations
onboard:postiz:apikey              → Entrer clé API Postiz
onboard:continue                   → Continuer
onboard:skip                       → Plus tard
```

## Fallback V1

Le `component-builder-v2.ts` est le primary. Si la construction V2 échoue (exception), fallback sur le `message-builder.ts` existant (V1 embeds) avec un log d'alerte.
