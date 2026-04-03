# Spec — Content Derivation (Multi-format, Multi-plateforme)

## Vue d'ensemble

Système de dérivation de contenu en cascade : à partir d'un contenu **master** (texte + image 1:1), le bot génère automatiquement des adaptations pour chaque plateforme sociale configurée, avec validation itérative par l'utilisateur via des threads Discord.

## Concepts clés

### Contenu Master

Le **master** est l'atome de contenu à partir duquel tout est dérivé :
- **Texte brut** : le script/hook de la suggestion validée
- **Image 1:1** : générée par Imagen à partir de la suggestion
- **Prompt image** : sauvegardé pour réutilisation (cohérence visuelle, personnages)

Modifier le master **invalide toutes les dérivations** précédemment validées.

### Arbre de dérivation

Les dérivations sont **indépendantes** entre elles. Refuser un format ne bloque pas les autres. Seul le master est bloquant.

```
              Master (texte + image 1:1)
         ┌───────┼───────┬────────┬─────────┐
         ▼       ▼       ▼        ▼         ▼
       Reel   Carousel  Tweet    Post    Article
       9:16    1:1×N    texte    1:1     long
      TikTok   Insta      X     LinkedIn  Reddit
```

### Ordre fixe de la cascade

L'ordre de génération est fixe pour toutes les instances :

1. **Texte master** (suggestion validée)
2. **Image master** (1:1, Imagen)
3. **Reels/Vidéos** (TikTok, Instagram Reel, Facebook Reel, YouTube Short) — même vidéo 9:16
4. **Carousel** (Instagram) — N images 1:1 (variable, décidé par Claude)
5. **Posts image** (X tweet, LinkedIn post, Facebook post, Threads, Bluesky, Mastodon)
6. **Threads X** — multi-tweets découpés par Claude en JSON
7. **Stories** (Instagram, YouTube, Facebook, X) — même image 9:16 (crop du 1:1)
8. **Pins** (Pinterest) — image 9:16 (crop du 1:1)
9. **Articles** (Reddit, LinkedIn Article) — instructions de structure spécifiques par réseau

## Flow détaillé

### Étape 1 — Suggestion validée (`#idées`)

L'utilisateur clique **"Go" ✅** sur une suggestion dans `#idées`.

**Actions :**
1. Marquer suggestion `status = 'go'`
2. Générer le script final via Claude (existant)
3. Générer l'image master 1:1 via Imagen
4. Sauvegarder le prompt image en DB (`media.prompt`)
5. Poster le master dans `#production` (texte + galerie image)
6. Boutons : **[✅ Valider master]** **[✏️ Modifier texte]** **[🖼️ Regénérer image]**

### Étape 2 — Validation du master (`#production`)

L'utilisateur valide ou modifie le master.

**Si modification du texte :**
- L'utilisateur donne des instructions textuelles
- Claude régénère le script selon les instructions
- Le master est re-posté avec les modifications
- Toutes les dérivations existantes sont **invalidées** (supprimées)

**Si regénération d'image :**
- L'utilisateur peut modifier le prompt ou demander une regénération
- Nouvelle image générée, re-postée dans le master
- Les dérivations média-dépendantes sont invalidées

**Si validation ✅ :**
- Création d'un enregistrement `derivation_trees` en DB
- Lancement de la cascade de dérivation (étape 3)

### Étape 3 — Cascade de dérivation (threads dans `#production`)

Pour **chaque plateforme configurée** dans `ctx.config.content.platforms` :

1. Créer un thread dans `#production` : `"📱 {emoji} {Plateforme} — {titre court}"`
2. Générer le texte adapté via Claude (ton, longueur, contraintes plateforme)
3. Générer le prompt média adapté (si nécessaire)
4. Poster dans le thread : texte adapté + prompt média proposé
5. Boutons : **[✅ Valider]** **[❌ Refuser]** **[✏️ Modifier]**

**Génération séquentielle** : les dérivations sont générées **une par une** via la file d'attente (voir section File d'attente). Pas de `Promise.all()`.

**Modification :**
- L'utilisateur donne des instructions textuelles dans le thread
- Claude régénère le texte adapté
- Re-posté dans le même thread

**Validation ✅ :**
- Si le format nécessite un média (image, vidéo) :
  - Ajout du job de génération à la file d'attente
  - Média généré et posté dans le thread
  - Boutons : **[✅ Valider média]** **[🔄 Regénérer]**
- Si texte seul : marqué comme prêt pour publication

**Refus ❌ :**
- Dérivation marquée `status = 'rejected'`
- Thread archivé
- N'affecte PAS les autres dérivations

### Étape 4 — Publication (`#publication`)

Quand **au moins une dérivation** est validée (texte + média) :

1. Les dérivations validées sont envoyées dans Postiz comme **drafts**
2. Un récap est posté dans `#publication` avec :
   - Liste de toutes les dérivations validées
   - Horaires proposés (IA si données suffisantes, sinon défaut)
   - Boutons : **[📅 Modifier horaires]** **[✅ Programmer tout]** **[Sélectionner]**
3. L'utilisateur valide les jours/heures
4. Scheduling Postiz programmé via API
5. Status mis à jour : `scheduled`

**Horaires :**
- Par défaut : créneaux génériques par plateforme
- Après collecte analytics : créneaux optimisés par l'IA (voir section Analytics)
- L'utilisateur peut toujours modifier manuellement

## Matrice des formats par plateforme

### Formats vidéo (même fichier 9:16)

| Plateforme | Format | Média | Contraintes texte |
|---|---|---|---|
| TikTok | Vidéo reel | Vidéo 9:16 (6-8s Veo) | Caption courte + hashtags |
| Instagram | Reel | Vidéo 9:16 (même) | Caption ≤2200 chars + hashtags |
| Facebook | Reel | Vidéo 9:16 (même) | Caption courte |
| YouTube | Short | Vidéo 9:16 (même, ≤60s) | Titre + description |

### Formats image

| Plateforme | Format | Média | Contraintes texte |
|---|---|---|---|
| Instagram | Carousel | N images 1:1 (variable, 3-10 slides) | Caption storytelling + hashtags |
| Instagram | Post image | Image 1:1 (master) | Caption + hashtags |
| X (Twitter) | Tweet + image | Image 1:1 (master) | ≤280 chars |
| X (Twitter) | Thread | Image 1:1 (1er tweet) | Multi-tweets, ≤280 chars/tweet |
| LinkedIn | Post + image | Image 1:1 (master) | Ton professionnel, ≤1300 chars |
| Facebook | Post + image | Image 1:1 (master) | Caption + lien |
| Threads | Post + image | Image 1:1 (master) | Caption courte |
| Bluesky | Post + image | Image 1:1 (master) | ≤300 chars |
| Mastodon | Toot + image | Image 1:1 (master) | ≤500 chars |

### Formats story (même image 9:16, multi-plateforme)

Les stories utilisent le même média 9:16 (crop du 1:1) et sont publiées sur toutes les plateformes qui supportent ce format :

| Plateforme | Format | Média | Contraintes texte |
|---|---|---|---|
| Instagram | Story | Image 9:16 (crop du 1:1) | Texte overlay court |
| YouTube | Story/Community | Image 9:16 (crop du 1:1) | Texte overlay court |
| Facebook | Story | Image 9:16 (crop du 1:1) | Texte overlay court |
| X (Twitter) | Fleet/Post | Image 9:16 (crop du 1:1) | Texte overlay court |

### Formats pin

| Plateforme | Format | Média | Contraintes texte |
|---|---|---|---|
| Pinterest | Pin | Image 9:16 (crop du 1:1) | Description SEO, mots-clés ciblés |

### Formats texte long (articles)

Chaque plateforme a ses propres **instructions de structure** adaptées à son audience et son ton :

| Plateforme | Format | Média | Instructions spécifiques |
|---|---|---|---|
| Reddit | Post + image | Image 1:1 (master) | Titre accrocheur, ton communautaire, structure : contexte → contenu → question ouverte pour discussion. Pas de promotion directe. |
| LinkedIn | Article | Aucun dédié | Ton professionnel, structure : insight → développement → takeaway actionable. Vocabulaire business/industrie. |

Claude reçoit des instructions de structure distinctes par réseau :
```typescript
const ARTICLE_INSTRUCTIONS: Record<string, string> = {
  reddit: 'Structure: contexte court → développement → question ouverte. Ton: communautaire, authentique, pas de jargon marketing. Inviter la discussion.',
  linkedin: 'Structure: insight percutant → analyse → takeaway actionable. Ton: professionnel, thought leadership. Vocabulaire industrie.',
};
```

### Règles de crop intelligent (1:1 → 9:16)

Le crop 1:1 → 9:16 se fait par **centrage vertical** : on prend la bande centrale verticale de l'image carrée. Perte de ~44% (les côtés).

Implémentation : utiliser `sharp` pour le recadrage automatique :
```typescript
sharp(buffer)
  .extract({ left: Math.floor(width * 0.22), top: 0, width: Math.floor(width * 0.56), height })
  .toBuffer();
```

### Génération du carousel

Le carousel génère **N images 1:1** (nombre variable, 3 à 10 slides). Le nombre est décidé par Claude en fonction de la richesse du contenu :
- Slide 1 : accroche visuelle (image master ou variante)
- Slides 2..N-1 : contenu informatif (nouvelles images Imagen avec prompts liés)
- Slide N : call-to-action / conclusion

Chaque slide a son propre prompt Imagen, dérivé du prompt master pour maintenir la cohérence visuelle (personnages, palette, style).

Claude retourne le nombre de slides + le prompt de chaque slide en JSON :
```json
{
  "slideCount": 5,
  "slides": [
    { "index": 1, "imagePrompt": "...", "overlayText": "..." },
    { "index": 2, "imagePrompt": "...", "overlayText": "..." }
  ]
}
```

### Génération des threads X (Twitter)

Claude génère le thread directement découpé en tweets individuels en JSON :
```json
{
  "tweets": [
    { "index": 1, "text": "...", "hasImage": true },
    { "index": 2, "text": "...", "hasImage": false },
    { "index": 3, "text": "...", "hasImage": false }
  ]
}
```

Chaque tweet respecte la limite de 280 caractères. L'image master est attachée uniquement au premier tweet (sauf indication contraire).

## Schéma de données

### Nouvelles tables

```sql
-- Arbre de dérivation (1 par suggestion validée)
CREATE TABLE derivation_trees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    suggestion_id INTEGER NOT NULL REFERENCES suggestions(id),
    master_text TEXT NOT NULL,
    master_image_prompt TEXT,
    master_media_id INTEGER REFERENCES media(id),
    status TEXT NOT NULL DEFAULT 'draft',
    discord_message_id TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    validated_at DATETIME,
    invalidated_at DATETIME
);

CREATE INDEX idx_derivation_trees_suggestion ON derivation_trees(suggestion_id);
CREATE INDEX idx_derivation_trees_status ON derivation_trees(status);
```

**Valeurs `status`** : `draft`, `master_validated`, `deriving`, `completed`, `invalidated`

```sql
-- Dérivation individuelle (1 par plateforme×format)
CREATE TABLE derivations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tree_id INTEGER NOT NULL REFERENCES derivation_trees(id),
    platform TEXT NOT NULL,
    format TEXT NOT NULL,
    adapted_text TEXT,
    media_type TEXT,
    media_prompt TEXT,
    media_id INTEGER REFERENCES media(id),
    status TEXT NOT NULL DEFAULT 'pending',
    postiz_post_id TEXT,
    discord_thread_id TEXT,
    discord_message_id TEXT,
    scheduled_at DATETIME,
    published_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    validated_at DATETIME,
    rejected_at DATETIME,
    modification_notes TEXT
);

CREATE INDEX idx_derivations_tree ON derivations(tree_id);
CREATE INDEX idx_derivations_status ON derivations(status);
CREATE INDEX idx_derivations_platform ON derivations(platform);
```

**Valeurs `status`** : `pending`, `text_generated`, `text_validated`, `media_generating`, `media_generated`, `media_validated`, `ready`, `scheduled`, `published`, `rejected`

**Valeurs `platform`** : `tiktok`, `instagram`, `x`, `linkedin`, `facebook`, `youtube`, `threads`, `bluesky`, `reddit`, `pinterest`, `mastodon`

**Valeurs `format`** : `reel`, `carousel`, `post_image`, `story`, `tweet`, `thread`, `post_text_image`, `pin`, `article`, `short`, `toot`

**Valeurs `media_type`** : `video_9_16`, `image_1_1`, `image_9_16_crop`, `carousel_slides`, `none`

### Modifications aux tables existantes

La table `publications` existante reste mais est enrichie :

```sql
ALTER TABLE publications ADD COLUMN derivation_id INTEGER REFERENCES derivations(id);
ALTER TABLE publications ADD COLUMN tree_id INTEGER REFERENCES derivation_trees(id);
```

## File d'attente de génération

### Pourquoi une queue

Les API de génération (Imagen, Veo) ont des rate limits. Avec 14 plateformes, une dérivation complète peut nécessiter :
- ~14 appels Claude (adaptation texte)
- ~5-6 images Imagen (master + carousel slides + variantes)
- ~1 vidéo Veo (réutilisée pour TikTok/Instagram/Facebook/YouTube)

Sans queue, on se fait bloquer. Avec une queue séquentielle, on contrôle le débit.

### Architecture

```typescript
interface GenerationJob {
  readonly id: string;
  readonly type: 'text_adaptation' | 'image_generation' | 'video_generation' | 'image_crop';
  readonly derivationId: number;
  readonly treeId: number;
  readonly priority: number;
  readonly payload: TextAdaptationPayload | ImageGenerationPayload | VideoGenerationPayload | ImageCropPayload;
  readonly status: 'queued' | 'processing' | 'completed' | 'failed' | 'retrying';
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly createdAt: Date;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly error?: string;
}
```

### Table de queue

```sql
CREATE TABLE generation_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    derivation_id INTEGER REFERENCES derivations(id),
    tree_id INTEGER NOT NULL REFERENCES derivation_trees(id),
    priority INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    result TEXT,
    error TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at DATETIME,
    completed_at DATETIME
);

CREATE INDEX idx_queue_status ON generation_queue(status, priority DESC, created_at);
```

### Comportement

- **Concurrence** : 1 job à la fois (séquentiel)
- **Priorité** : texte d'abord (rapide, pas cher), puis images, puis vidéos
- **Retry** : 3 tentatives max, backoff exponentiel (5s, 15s, 45s)
- **Reprise au boot** : les jobs `processing` au démarrage repassent en `queued`
- **Pause** : si l'instance est en pause, la queue est gelée
- **Notification** : chaque job complété poste le résultat dans le thread Discord correspondant

### Ordre de priorité des jobs

| Priorité | Type | Raison |
|---|---|---|
| 10 | `text_adaptation` | Rapide (~2s), permet à l'utilisateur de valider pendant que le reste génère |
| 5 | `image_crop` | Quasi instantané (sharp), pas d'appel API |
| 3 | `image_generation` | ~10s, nécessaire pour les posts |
| 1 | `video_generation` | ~2-5 min, le plus long, lancé en dernier |

## Analytics Postiz

### Objectif

Collecter les métriques de performance des publications pour :
1. Alimenter le rapport hebdomadaire avec des données réelles
2. Permettre à l'IA de recommander des créneaux de publication optimaux
3. Construire une base de données de performance incrémentale

### Endpoints Postiz utilisés

```
GET /public/v1/analytics/{integrationId}?date={days}
GET /public/v1/analytics/post/{postId}?date={days}
```

**Réponse :**
```json
[
  {
    "label": "Likes",
    "data": [
      {"total": "150", "date": "2025-01-01"},
      {"total": "175", "date": "2025-01-02"}
    ],
    "percentageChange": 16.7
  }
]
```

### Nouveaux endpoints dans `services/postiz.ts`

```typescript
async function getPostAnalytics(postId: string, days?: number): Promise<PostizAnalytics[]>;
async function getPlatformAnalytics(integrationId: string, days?: number): Promise<PostizAnalytics[]>;
```

### Collecte hebdomadaire

**Déclenchement** : cron hebdomadaire (même jour que le rapport, 1h avant)

**Process :**
1. Lister toutes les publications `status = 'published'` ou `'scheduled'` avec un `postiz_post_id`
2. Pour chaque publication : `getPostAnalytics(postId, 7)`
3. Stocker les métriques en DB locale
4. Agréger par plateforme, par jour de la semaine, par heure

### Table de stockage des métriques sociales

```sql
CREATE TABLE social_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    publication_id INTEGER REFERENCES publications(id),
    derivation_id INTEGER REFERENCES derivations(id),
    postiz_post_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    metric_name TEXT NOT NULL,
    metric_value INTEGER NOT NULL DEFAULT 0,
    metric_date DATE NOT NULL,
    collected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_social_metrics_publication ON social_metrics(publication_id);
CREATE INDEX idx_social_metrics_platform_date ON social_metrics(platform, metric_date);
CREATE INDEX idx_social_metrics_name ON social_metrics(metric_name);
```

### Table des créneaux optimaux

```sql
CREATE TABLE optimal_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    day_of_week INTEGER NOT NULL,
    hour INTEGER NOT NULL,
    score REAL NOT NULL DEFAULT 0.0,
    sample_size INTEGER NOT NULL DEFAULT 0,
    season_context TEXT,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(platform, day_of_week, hour)
);

CREATE INDEX idx_optimal_slots_platform ON optimal_slots(platform, score DESC);
```

### Analyse IA hebdomadaire

**Déclenchement** : dans le rapport hebdomadaire (cron dimanche 21h)

**Process :**
1. Extraire les métriques de la semaine depuis `social_metrics`
2. Charger l'historique des `optimal_slots`
3. Contexte saisonnier : vérifier si une fête/événement approche (Noël, Pâques, soldes, rentrée, etc.)
4. Envoyer à Claude avec le prompt d'analyse :
   - Données de performance par plateforme / jour / heure
   - Historique des créneaux précédents
   - Contexte saisonnier
5. Claude retourne :
   - Analyse des tendances
   - Nouveaux créneaux recommandés par plateforme
   - Justification
6. Mettre à jour `optimal_slots`
7. Inclure les recommandations dans le rapport hebdo
8. Boutons dans le rapport : **[✅ Appliquer les nouveaux créneaux]** **[❌ Garder les actuels]**

### Seuil minimum de données

- **6 publications minimum** par plateforme avant de recommander des créneaux
- Avant ce seuil : créneaux génériques par défaut
- Le rapport affiche : "📊 {N}/6 publications — données insuffisantes pour optimiser les créneaux"

### Saisonnalité

Événements pris en compte (stockés en config, extensibles) :
- Noël (15 déc - 5 jan)
- Nouvel An
- Pâques (variable)
- Soldes d'été (fin juin)
- Soldes d'hiver (début janvier)
- Rentrée (fin août - mi septembre)
- Halloween (20-31 octobre)
- Black Friday (dernier vendredi de novembre)

L'IA compare les performances pendant ces périodes vs hors-période pour ajuster ses recommandations.

## Custom IDs Discord

Nouveaux custom IDs pour la dérivation :

```
# Master
master:validate:{treeId}           → Valider le master
master:modify_text:{treeId}        → Modifier le texte master
master:regen_image:{treeId}        → Regénérer l'image master

# Dérivation
deriv:validate:{derivationId}      → Valider le texte d'une dérivation
deriv:reject:{derivationId}        → Refuser une dérivation
deriv:modify:{derivationId}        → Modifier une dérivation (attend instructions)
deriv:validate_media:{derivationId}→ Valider le média généré
deriv:regen_media:{derivationId}   → Regénérer le média

# Publication (dérivations)
pub:schedule_all:{treeId}          → Programmer toutes les dérivations validées
pub:modify_schedule:{treeId}       → Modifier les horaires
pub:select:{treeId}                → Sélectionner quelles dérivations publier
```

## Modifications aux modules existants

### `src/services/postiz.ts`

Ajouter :
- `getPostAnalytics(postId, days)` — GET `/analytics/post/{postId}`
- `getPlatformAnalytics(integrationId, days)` — GET `/analytics/{integrationId}`

### `src/handlers/suggestions.ts`

Modifier le flow du bouton **"Go"** :
- Après génération du script final → générer l'image master
- Poster dans `#production` avec les nouveaux boutons master

### `src/handlers/production.ts`

Ajouter :
- `handleMasterValidation()` — lance la cascade
- `handleDerivationValidation()` — valide une dérivation individuelle
- `handleDerivationModification()` — modification dans un thread
- `handleMediaValidation()` — valide un média généré

### `src/discord/component-builder-v2.ts`

Ajouter les composants V2 :
- `masterContent(data)` — affichage master dans `#production`
- `derivationThread(data)` — affichage dérivation dans un thread
- `derivationRecap(data)` — récap publication dans `#publication`
- `analyticsReport(data)` — section analytics dans le rapport hebdo

### `src/handlers/rapport.ts`

Enrichir avec :
- Métriques sociales réelles (plus de NULL)
- Recommandations de créneaux
- Boutons d'application des créneaux

### `src/core/config.ts`

Le champ `InstanceConfig.content.platforms` détermine quelles dérivations sont générées. Quand une plateforme est ajoutée via le dashboard, elle s'applique **uniquement aux futures dérivations**.

### Nouveau module : `src/derivation/`

```
src/derivation/
├── tree.ts              # Gestion de l'arbre de dérivation (CRUD)
├── cascade.ts           # Logique de cascade (ordre, dépendances)
├── adapters.ts          # Adaptation texte par plateforme (prompts Claude)
├── media-processor.ts   # Crop intelligent, préparation médias
└── queue.ts             # File d'attente de génération
```

### Nouveau module : `src/analytics/`

```
src/analytics/
├── collector.ts         # Collecte métriques Postiz
├── aggregator.ts        # Agrégation et stockage
├── slot-optimizer.ts    # Analyse IA des créneaux
└── seasonality.ts       # Calendrier saisonnier
```

## Modules critiques (tests obligatoires)

- `derivation/tree.ts` — CRUD arbre, invalidation
- `derivation/cascade.ts` — ordre, filtrage par plateformes configurées
- `derivation/queue.ts` — séquencement, retry, reprise au boot
- `derivation/media-processor.ts` — crop 1:1 → 9:16
- `analytics/collector.ts` — parsing réponse Postiz
- `analytics/aggregator.ts` — agrégation par plateforme/jour/heure
- `analytics/slot-optimizer.ts` — seuil minimum, mise à jour slots

## ADR

| # | Décision | Raison |
|---|---|---|
| 014 | Crop intelligent plutôt que regénération 9:16 | Économie d'appels Imagen, cohérence garantie |
| 015 | Queue séquentielle (1 job à la fois) | Évite les rate limits API, robuste |
| 016 | Même vidéo 9:16 pour TikTok/Insta/FB/YT | Économie Veo, formats identiques |
| 017 | Thread Discord par dérivation | Isolation des conversations, historique clair |
| 018 | Invalidation cascade si master modifié | Cohérence garantie, pas de dérivations orphelines |
| 019 | Analytics hebdo plutôt que quotidien | Économie tokens Claude, données suffisantes |
| 020 | Seuil 6 publications avant optimisation | Base statistique minimum viable |
| 021 | Saisonnalité configurable | Adaptable selon la niche/audience |
| 022 | Dérivations indépendantes (arbre plat) | Refuser un format ne bloque pas les autres |
