# Spec — Veille V3 : Pipeline intelligent, profil de recherche, nettoyage hardcodé

## Vue d'ensemble

Refonte profonde du pipeline de veille pour résoudre 3 problèmes fondamentaux :
1. **Données hardcodées** — catégories, mots-clés, seuils, persona disséminés dans le code au lieu de venir de la DB
2. **Bruit massif** — 81% des articles scorés 5/10 (indécision LLM), pages de profils sociaux, posts "LFG" non filtrés
3. **Données onboarding perdues** — seules les catégories et le persona sont sauvegardés, tout le reste (sources, schedule, niche, plateformes, domaines) est perdu au redémarrage

**Résultat visé** : un pipeline où 100% de la configuration vient de la DB, alimentée par un onboarding structuré, avec un pré-filtrage qui élimine le bruit avant le LLM.

---

## 1. Table `instance_profile` — Profil de recherche par instance

### 1.1 Schéma

```sql
CREATE TABLE IF NOT EXISTS instance_profile (
  id               INTEGER PRIMARY KEY DEFAULT 1,
  project_name     TEXT NOT NULL,
  project_niche    TEXT NOT NULL,
  project_description TEXT NOT NULL DEFAULT '',
  project_language TEXT NOT NULL DEFAULT 'fr',
  project_url      TEXT,

  -- Plateformes & formats cibles
  target_platforms  TEXT NOT NULL DEFAULT '[]',   -- JSON array: ['tiktok', 'instagram', ...]
  target_formats    TEXT NOT NULL DEFAULT '[]',   -- JSON array: ['reel', 'carousel', ...]
  content_types     TEXT NOT NULL DEFAULT '[]',   -- JSON array: ['news', 'tutos', 'opinions', ...]

  -- Domaines de référence et exclusion
  include_domains   TEXT NOT NULL DEFAULT '[]',   -- JSON array: ['screenrant.com', 'polygon.com', ...]
  exclude_domains   TEXT NOT NULL DEFAULT '[]',   -- JSON array: ['linkedin.com', 'quora.com', ...]
  negative_keywords TEXT NOT NULL DEFAULT '[]',   -- JSON array: ['looking for players', 'hiring', ...]

  -- Pilliers de contenu (configurables, pas hardcodés)
  pillars           TEXT NOT NULL DEFAULT '["trend","tuto","community","product"]',

  -- Contexte enrichi par le LLM (questions/réponses onboarding)
  onboarding_context TEXT NOT NULL DEFAULT '',    -- Texte libre structuré (Q&A compilées)

  -- Exemples calibrés (générés en background post-onboarding)
  calibrated_examples TEXT,                       -- JSON: exemples de scoring pour le prompt LLM
  calibrated_at       DATETIME,

  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### 1.2 Interface TypeScript

```typescript
interface InstanceProfile {
  readonly projectName: string;
  readonly projectNiche: string;
  readonly projectDescription: string;
  readonly projectLanguage: string;
  readonly projectUrl: string | null;
  readonly targetPlatforms: readonly string[];
  readonly targetFormats: readonly string[];
  readonly contentTypes: readonly string[];
  readonly includeDomains: readonly string[];
  readonly excludeDomains: readonly string[];
  readonly negativeKeywords: readonly string[];
  readonly pillars: readonly string[];
  readonly onboardingContext: string;
  readonly calibratedExamples: CalibratedExample[] | null;
}

interface CalibratedExample {
  readonly title: string;
  readonly expectedScore: number;
  readonly reasoning: string;
}
```

### 1.3 CRUD

Nouveau module `src/core/instance-profile.ts` :

```typescript
function getProfile(db: SqliteDatabase): InstanceProfile | undefined;
function saveProfile(db: SqliteDatabase, profile: InstanceProfile): void;
function updateProfileField(db: SqliteDatabase, field: string, value: unknown): void;
```

### 1.4 Migration

Migration 026 : `CREATE TABLE instance_profile (...)`.

---

## 2. Onboarding restructuré — Questionnaire guidé

### 2.1 Nouveau flow (remplacement de `describe_project`)

L'étape `describe_project` actuelle (texte libre unique) est remplacée par **3 sous-étapes** :

#### Sous-étape 2.1a : Modal structuré (5 champs Discord)

Un modal Discord avec les champs :

| # | Custom ID | Label | Style | Placeholder | Required |
|---|-----------|-------|-------|-------------|----------|
| 1 | `project_name` | Nom du projet / marque | Short | "Tumulte" | Oui |
| 2 | `project_url` | Site web (optionnel) | Short | "https://tumulte.app" | Non |
| 3 | `project_niche` | Ta niche en une phrase | Short | "Outils pour MJ de jeu de rôle" | Oui |
| 4 | `project_content_types` | Types de contenu que tu publies | Short | "News, tutos, opinions, memes, reviews" | Oui |
| 5 | `project_platforms` | Plateformes cibles | Short | "TikTok, Instagram, YouTube, X" | Oui |

**Après soumission** : le LLM analyse les réponses et extrait les données structurées (comme aujourd'hui avec `processDescription`). Affichage du résumé avec boutons Valider / Modifier / Régénérer.

#### Sous-étape 2.1b : Questions LLM de suivi (V2 Components)

**6 questions fixes** affichées dans un container V2. L'utilisateur répond en texte libre dans le DM. Le bot traite les réponses point par point.

| # | Question | But | Données extraites |
|---|----------|-----|-------------------|
| 1 | Quels sont tes **concurrents ou références** dans ta niche ? (comptes, sites, créateurs) | Identifier les domaines de référence | `include_domains`, inspiration |
| 2 | Quels **sujets ou mots-clés** tu veux absolument surveiller ? | Keywords à haute priorité | Keywords catégories |
| 3 | Quels **sujets tu veux exclure** de ta veille ? (bruit, hors-sujet) | Filtrage négatif | `negative_keywords` |
| 4 | Quels **sites ou blogs** font référence dans ta niche ? | Sources de qualité | `include_domains`, RSS auto-discover |
| 5 | Quel est le **but principal** de ta communication ? (vendre un produit, construire une audience, éduquer, divertir...) | Affiner le scoring | `onboarding_context` |
| 6 | **Informations supplémentaires** : autre chose à savoir sur ton projet, ton produit, ta cible, etc. (optionnel) | Contexte libre | `onboarding_context` |

**Format d'affichage** (V2 Container) :

```
📋 Quelques questions pour affiner ta veille

Réponds à chaque question ci-dessous. Tu peux répondre à tout d'un coup
ou question par question. Numérote tes réponses (1. ... 2. ... etc.)

1️⃣ Quels sont tes concurrents ou références dans ta niche ?
   (comptes, sites, créateurs que tu suis ou admires)

2️⃣ Quels sujets ou mots-clés tu veux absolument surveiller ?
   (termes précis que tu ne veux pas rater)

3️⃣ Quels sujets tu veux exclure de ta veille ?
   (bruit récurrent, hors-sujet, spam)

4️⃣ Quels sites ou blogs font référence dans ta niche ?
   (sources fiables que tu consultes toi-même)

5️⃣ Quel est le but principal de ta communication ?
   (vendre un produit, construire une audience, éduquer, divertir...)

6️⃣ Autre chose à savoir sur ton projet, ton produit, ta cible ?
   (optionnel — texte libre)

[Valider mes réponses ✅]  [Passer cette étape ⏭️]
```

**Traitement des réponses** :
- Le texte brut de l'utilisateur est envoyé au LLM avec le contexte du modal
- Le LLM extrait et structure : `include_domains`, `negative_keywords`, keywords supplémentaires, contexte enrichi
- Le tout est stocké dans `session.data` et affiché pour validation
- Si l'utilisateur clique "Passer", on continue avec les données du modal uniquement

#### Sous-étape 2.1c : Validation du profil de recherche

Affichage du profil compilé (V2 Container) :

```
🔍 Ton profil de recherche

📌 Projet : Tumulte
🎯 Niche : Outils pour MJ de jeu de rôle
🌐 Site : tumulte.app
📱 Plateformes : TikTok, Instagram, YouTube
📝 Types de contenu : News, tutos, opinions

✅ Domaines de référence : screenrant.com, polygon.com, reddit.com/r/dnd, ...
❌ Domaines exclus : linkedin.com, quora.com, ...
🚫 Mots-clés exclus : "looking for players", "hiring", ...

[Valider ✅]  [Modifier ✏️]  [Retour ◀️]
```

### 2.2 Nouveau step dans le wizard

Le `WIZARD_STEPS_ORDER` devient :

```typescript
const WIZARD_STEPS_ORDER = [
  'describe_project',        // Modal structuré (2.1a)
  'refine_project',          // Questions LLM (2.1b) — NOUVEAU
  'validate_profile',        // Validation profil (2.1c) — NOUVEAU
  'review_categories',       // Catégories de veille (existant)
  'dryrun_searxng',          // Dry-run SearXNG (existant)
  'configure_sources',       // Configuration sources (existant)
  'mini_dryrun_sources',     // Mini dry-run sources (existant)
  'choose_persona_tone',     // Ton persona (existant)
  'review_persona_identity', // Identité (existant)
  // ... reste identique
] as const;
```

### 2.3 WizardData — Nouveaux champs

```typescript
interface WizardData {
  // ... champs existants ...

  // Nouveaux champs profil (2.1a)
  projectUrl?: string;
  contentTypes?: string[];

  // Nouveaux champs profil enrichi (2.1b)
  includeDomains?: string[];
  excludeDomains?: string[];
  negativeKeywords?: string[];
  onboardingContext?: string;
}
```

### 2.4 Sauvegarde complète à la confirmation

La fonction `handleWizardConfirm()` doit sauvegarder TOUT :

```typescript
// 1. instance_profile (NOUVEAU)
saveProfile(instanceDb, {
  projectName: session.data.projectName,
  projectNiche: session.data.projectNiche,
  projectDescription: session.data.projectDescription,
  projectLanguage: session.data.projectLanguage,
  projectUrl: session.data.projectUrl ?? null,
  targetPlatforms: session.data.projectPlatforms ?? ['tiktok', 'instagram'],
  targetFormats: session.data.formats ?? ['reel', 'carousel', 'story', 'post'],
  contentTypes: session.data.contentTypes ?? [],
  includeDomains: session.data.includeDomains ?? [],
  excludeDomains: session.data.excludeDomains ?? [],
  negativeKeywords: session.data.negativeKeywords ?? [],
  pillars: ['trend', 'tuto', 'community', 'product'],
  onboardingContext: session.data.onboardingContext ?? '',
  calibratedExamples: null,
});

// 2. veille_categories (existant, déjà fait)

// 3. persona (existant, déjà fait)

// 4. veille_sources (MANQUANT — à ajouter)
if (session.data.enabledSources) {
  for (const sourceType of session.data.enabledSources) {
    upsertSource(instanceDb, {
      type: sourceType,
      enabled: true,
      config: buildSourceConfig(session.data, sourceType),
    });
  }
}

// 5. schedule_config (MANQUANT — à ajouter)
upsertScheduleConfig(instanceDb, {
  mode: session.data.scheduleMode ?? 'daily',
  veilleDay: session.data.veilleDay ?? null,
  veilleHour: session.data.veilleHour ?? 7,
  publicationDays: session.data.publicationDays ?? [],
  suggestionsPerCycle: session.data.suggestionsPerCycle ?? 3,
});

// 6. config_overrides (MANQUANT — crons + budget)
upsertConfigOverrides(instanceDb, {
  veilleCron: session.data.veilleCron,
  suggestionsCron: session.data.suggestionsCron,
  rapportCron: session.data.rapportCron,
});

// 7. LLM provider config (MANQUANT — à ajouter)
if (session.data.llmProvider) {
  upsertConfigOverride(instanceDb, 'llm_provider', session.data.llmProvider);
  upsertConfigOverride(instanceDb, 'llm_model', session.data.llmModel);
}
```

---

## 3. Nettoyage du hardcodé — Liste exhaustive

### 3.1 Catégories hardcodées → suppression

**Fichier** : `src/veille/queries.ts`

| Action | Détail |
|--------|--------|
| Supprimer | Constante `CATEGORIES` (9 catégories hardcodées, lignes 12-114) |
| Supprimer | `getCategories()` → remplacer par `getCategoriesFromDb()` partout |
| Supprimer | `getDefaultCategories()` → plus de fallback hardcodé |
| Modifier | `getCategoriesFromDb()` → ne retourne plus de fallback hardcodé. Si DB vide, retourne `[]` |
| Conserver | `buildSearxngQueries()` — utile, pas hardcodé |
| Conserver | `seedCategories()` — mais ne seed plus les catégories hardcodées. Seed uniquement si appelé explicitement avec des catégories en paramètre |

**Impact** : `src/veille/collector.ts` ligne 78 utilise `getCategories()` comme fallback → sera cassé → **supprimer le collecteur legacy** (voir 3.3).

### 3.2 Persona hardcodé → dynamique

| Fichier | Ligne | Valeur hardcodée | Action |
|---------|-------|------------------|--------|
| `deep-dive.ts` | 181 | `"Le Chroniqueur"` | Remplacer par persona chargé depuis DB |
| `deep-dive.ts` | 28-30 | `loadPersona()` → legacy | Changer pour `loadForInstance(instanceId, db)` |
| `content/suggestions.ts` | 34-35 | `loadPersona()` → legacy | Changer pour `loadForInstance(instanceId, db)` |
| `persona-loader.ts` | 6 | `DEFAULT_PERSONA` | Conserver comme ultime fallback mais ne jamais l'utiliser en mode multi-instance |

**Méthode** : tous les handlers reçoivent déjà `ctx: InstanceContext`. Il faut que `suggestions.ts` et `deep-dive.ts` acceptent `instanceId` + `db` au lieu d'utiliser le mode legacy.

### 3.3 Collecteur legacy → suppression

**Fichier** : `src/veille/collector.ts`

| Action | Détail |
|--------|--------|
| Conserver | `RawArticle` interface, `CollectorResult` interface, `CollectorStats` interface |
| Supprimer | `collect()` function — tout passe par `collectFromAllSources()` |
| Conserver | `isWithinMaxAge()` — utile pour le filtrage temporel, déplacer dans un module utilitaire si besoin |

**Fichier** : `src/handlers/veille.ts`

| Action | Détail |
|--------|--------|
| Supprimer | Branche `if/else hasMultiSource` (lignes 70-85) — toujours utiliser `collectFromAllSources()` |
| Modifier | Charger les catégories depuis DB uniquement via `getCategoriesFromDb(db)` |

### 3.4 Seuils et constantes → config DB

| Constante | Fichier | Ligne | Valeur actuelle | Source future |
|-----------|---------|-------|-----------------|---------------|
| Score digest | `handlers/veille.ts` | 163 | `>= 8` | `config_overrides.min_score_digest` (défaut 7) |
| Score thread | `handlers/veille.ts` | 187 | `>= 5` | `config_overrides.min_score_thread` (défaut 5) |
| Score suggestions | `content/suggestions.ts` | 56 | `>= 6` | `config_overrides.min_score_to_propose` (existant) |
| Score deep-dive | `veille/deep-dive.ts` | 110 | `>= 8` | `config_overrides.min_score_deep_dive` (défaut 8) |
| Score rapport | `handlers/rapport.ts` | 50 | `>= 7` | `config_overrides.min_score_rapport` (défaut 7) |
| Batch size | `handlers/veille.ts` | 116 | `20` | Garder hardcodé (c'est une contrainte technique, pas métier) |
| Suggestions/cycle | `handlers/suggestions.ts` | 57 | `3` | `config_overrides.suggestions_per_cycle` (existant) |
| Resurfacing jours | `veille/resurfacing.ts` | 51,67,83 | `14, 30, 7` | Garder hardcodé (raisonnable, pas un paramètre utilisateur) |

### 3.5 Sources hardcodées dans les sous-collecteurs

| Fichier | Valeur hardcodée | Action |
|---------|------------------|--------|
| `sources/rss.ts` L54-55 | `language: 'fr'`, `category: 'rss'` | Language → détecter depuis URL ou config. Category → `'rss_feed'` |
| `sources/youtube-transcript.ts` L64-66 | `source: 'youtube'`, `category: 'youtube'` | Category → `category.id` du parent |
| `sources/web-search.ts` L63 | `source: 'web_search'`, `category: 'web_search'` | Category → `category.id` du parent |

### 3.6 Config par défaut → `InstanceConfig`

| Champ | Source actuelle | Source future |
|-------|----------------|---------------|
| `platforms` | `DEFAULT_INSTANCE_CONFIG` hardcodé | `instance_profile.target_platforms` (DB) |
| `formats` | `DEFAULT_INSTANCE_CONFIG` hardcodé | `instance_profile.target_formats` (DB) |
| `pillars` | `DEFAULT_INSTANCE_CONFIG` hardcodé | `instance_profile.pillars` (DB) |
| Thème/couleurs | `DEFAULT_INSTANCE_CONFIG` | Garder hardcodé (cosmétique, pas métier) |

**Modifier `instance-registry.ts`** : charger `platforms`, `formats`, `pillars` depuis `instance_profile` au lieu de `DEFAULT_INSTANCE_CONFIG`.

### 3.7 Prompts LLM

| Fichier | Valeur hardcodée | Action |
|---------|------------------|--------|
| `analyzer.ts` L23-26 | Piliers enum `['trend', 'tuto', 'community', 'product']` | Charger depuis `instance_profile.pillars` |
| `analyzer.ts` L103-104 | `DEFAULT_SYSTEM_PROMPT` | Conserver comme fallback |
| `production.ts` L149-161 | Style visuel "dark fantasy, parchment" | Charger depuis persona (art_direction) |
| `derivation.ts` L542-552 | Même style visuel | Idem |
| `categories.ts` L16-28 | Liste engines SearXNG | Conserver (c'est la liste des engines SearXNG disponibles, pas de la config utilisateur) |

---

## 4. Pré-filtrage intelligent — Funnel en 3 étapes

### 4.1 Architecture

Nouveau module : `src/veille/prefilter.ts`

```typescript
interface PrefilterResult {
  readonly passed: readonly RawArticle[];
  readonly rejected: readonly RejectedArticle[];
  readonly stats: PrefilterStats;
}

interface RejectedArticle {
  readonly article: RawArticle;
  readonly reason: string;
}

interface PrefilterStats {
  readonly input: number;
  readonly afterUrlFilter: number;
  readonly afterContentFilter: number;
  readonly afterDedup: number;
  readonly rejectedByReason: Record<string, number>;
}

function prefilter(
  articles: readonly RawArticle[],
  profile: InstanceProfile,
): PrefilterResult;
```

### 4.2 Filtre 1 — Patterns URL (coût zéro)

Rejeter les articles dont l'URL correspond à un pattern de bruit :

```typescript
const NOISE_URL_PATTERNS: readonly RegExp[] = [
  // Profils sociaux (pas de contenu)
  /^https?:\/\/(www\.)?twitch\.tv\/[^/]+\/?$/,            // twitch.tv/username
  /^https?:\/\/(www\.)?twitch\.tv\/directory\//,           // twitch.tv/directory/...
  /^https?:\/\/(www\.)?linkedin\.com\/in\//,               // linkedin.com/in/...
  /^https?:\/\/(www\.)?linkedin\.com\/jobs\//,             // linkedin.com/jobs/...

  // Pages d'index / tags / recherche
  /\/tag\/[^/]+\/?$/,
  /\/category\/[^/]+\/?$/,
  /\/search\?/,
  /\/author\/[^/]+\/?$/,

  // Pages de stats / changelog
  /steamcharts\.com/,
  /\/changelog$/i,

  // Raccourcisseurs d'URL
  /^https?:\/\/(bit\.ly|tinyurl\.com|t\.co|goo\.gl)\//,
];
```

**Domaines exclus** : vérifier `profile.excludeDomains` en plus des patterns fixes.

### 4.3 Filtre 2 — Qualité titre + snippet (heuristique)

```typescript
interface ContentFilter {
  readonly minTitleLength: number;       // 15 (augmenté de 10)
  readonly maxTitleLength: number;       // 200 (réduit de 300)
  readonly minSnippetLength: number;     // 20 (augmenté de 5)
  readonly rejectAllCapsTitle: boolean;  // true
}
```

**Filtres appliqués** :
1. Titre < 15 chars → rejet (raison: `title_too_short`)
2. Titre > 200 chars → rejet (raison: `title_too_long`)
3. Titre tout en majuscules → rejet (raison: `title_all_caps`)
4. Snippet < 20 chars ET ne commence pas par `[Transcription]` → rejet (raison: `snippet_too_short`)
5. Titre contient un `negative_keyword` du profil → rejet (raison: `negative_keyword:{keyword}`)
6. URL dans un `exclude_domain` → rejet (raison: `excluded_domain:{domain}`)

### 4.4 Filtre 3 — Déduplication near-duplicate par titre

Plutôt qu'un MinHash complet (overkill pour ~500 articles), on utilise une **normalisation de titre + similarité Jaccard** :

```typescript
function normalizeTitle(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-zà-ÿ0-9\s]/g, '')  // retirer ponctuation
      .split(/\s+/)
      .filter(w => w.length > 2)          // retirer stop words courts
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}
```

**Seuil** : similarité > 0.7 → garder le premier, fusionner les sources.

Quand deux articles sont near-duplicates :
- Garder celui avec le snippet le plus long
- Concaténer les sources : `"google, reddit"` → pour affichage

### 4.5 Logging

Chaque étape du filtre logue les stats :

```typescript
logger.info({
  input: stats.input,
  afterUrlFilter: stats.afterUrlFilter,
  afterContentFilter: stats.afterContentFilter,
  afterDedup: stats.afterDedup,
  rejectedByReason: stats.rejectedByReason,
}, 'Pre-filter complete');
```

---

## 5. Scoring LLM amélioré

### 5.1 Prompt enrichi avec profil de recherche

Le prompt de scoring (`analyzer.ts`) reçoit désormais le profil complet :

```
Tu es un analyste de veille pour le projet "{projectName}" dans la niche "{projectNiche}".

Contexte du projet :
{onboardingContext}

Types de contenu recherchés : {contentTypes.join(', ')}
Plateformes cibles : {targetPlatforms.join(', ')}

{preferenceContext}

{calibratedExamplesContext}

RÈGLES DE SCORING :
- Le score 5 est INTERDIT. Tu DOIS trancher : 4 (pas assez pertinent) ou 6 (assez pertinent).
- Score 0-2 : hors-sujet, aucun rapport avec la niche
- Score 3-4 : vaguement lié mais pas exploitable pour du contenu
- Score 6-7 : pertinent, exploitable avec un bon angle
- Score 8-10 : très pertinent, fort potentiel viral/engagement

Les pilliers de contenu sont : {pillars.join(', ')}

Pour chaque article, fournis :
- score (0-10, PAS de 5)
- pillar : un des pilliers ci-dessus
- suggestedAngle : un angle de contenu en français (1-2 phrases)
- translatedTitle : traduction FR si article en anglais
- translatedSnippet : traduction FR si article en anglais
```

### 5.2 Exemples calibrés — Génération automatique post-onboarding

Après la confirmation de l'onboarding, un job background génère des exemples calibrés :

```typescript
async function generateCalibratedExamples(
  db: SqliteDatabase,
  profile: InstanceProfile,
  persona: string,
): Promise<CalibratedExample[]> {
  const prompt = `
    Tu es un expert en veille pour le projet "${profile.projectName}" (niche: ${profile.projectNiche}).

    Génère 10 exemples d'articles fictifs mais réalistes qui correspondent à cette niche.
    Pour chaque exemple, donne :
    - title: un titre d'article réaliste
    - expectedScore: le score que tu donnerais (0-10, PAS de 5)
    - reasoning: pourquoi ce score (1 phrase)

    Répartis les scores : 2 articles à 0-2, 2 à 3-4, 3 à 6-7, 3 à 8-10.

    Réponds en JSON : { "examples": [...] }
  `;

  // Appel LLM, parse JSON, sauvegarde en DB
}
```

**Déclenchement** : après `handleWizardConfirm()`, en fire-and-forget avec logging :

```typescript
logger.info({ instanceId }, 'Starting calibrated examples generation (background)');
generateCalibratedExamples(db, profile, persona)
  .then((examples) => {
    logger.info({ instanceId, count: examples.length }, 'Calibrated examples generated');
  })
  .catch((error) => {
    logger.error({ instanceId, error: error instanceof Error ? error.message : String(error) }, 'Calibrated examples generation failed');
  });
```

### 5.3 Changement des seuils Discord

| Avant | Après |
|-------|-------|
| Digest : score ≥ 8 | Digest : score ≥ 7 |
| Thread : score ≥ 5 | Thread : score ≥ 5 (inchangé) |

---

## 6. Wiring complet — Tous les consommateurs

### 6.1 Fichiers à modifier

| Fichier | Modification | Raison |
|---------|-------------|--------|
| `handlers/veille.ts` | Charger `InstanceProfile` + passer au prefilter + passer au scoring | Coeur du pipeline |
| `handlers/suggestions.ts` | Accepter `ctx: InstanceContext` au lieu d'appeler `generateSuggestions(db, 3)` | Persona + config depuis ctx |
| `handlers/rapport.ts` | Charger platforms depuis `instance_profile` au lieu de `ctx.config.content.platforms` | Déhardcoder |
| `handlers/production.ts` | Charger style visuel depuis persona (art_direction) au lieu du hardcodé | Déhardcoder |
| `handlers/derivation.ts` | Idem production.ts pour `buildImagePrompt()` | Déhardcoder |
| `content/suggestions.ts` | Accepter `instanceId` + `db` pour persona. Lire `suggestionsPerCycle` et `minScoreToPropose` depuis config | Déhardcoder |
| `veille/deep-dive.ts` | Accepter `instanceId` + `db` pour persona. Lire seuil depuis config | Déhardcoder |
| `veille/analyzer.ts` | Accepter `InstanceProfile` pour enrichir le prompt. Piliers dynamiques | Déhardcoder |
| `veille/resurfacing.ts` | Lire seuils depuis config (ou garder hardcodé, cf. 3.4) | Optionnel |
| `veille/queries.ts` | Supprimer `CATEGORIES`, `getCategories()`, `getDefaultCategories()`. Modifier `getCategoriesFromDb()` pour ne plus avoir de fallback | Déhardcoder |
| `veille/collector.ts` | Supprimer `collect()`. Conserver types | Supprimer legacy |
| `veille/sources/rss.ts` | Category dynamique, language depuis config | Déhardcoder |
| `veille/sources/youtube-transcript.ts` | Category dynamique | Déhardcoder |
| `veille/sources/web-search.ts` | Category dynamique | Déhardcoder |
| `registry/instance-registry.ts` | Charger `instance_profile` dans `InstanceContext`. Lire platforms/formats/pillars depuis profile | Déhardcoder |
| `core/config.ts` | Retirer `platforms`, `formats`, `pillars` de `DEFAULT_INSTANCE_CONFIG.content` (ils viennent du profil) | Déhardcoder |
| `onboarding/wizard/orchestrator.ts` | Ajouter gestion des nouveaux steps. Sauvegarder TOUT à la confirmation | Wiring onboarding |
| `onboarding/wizard/state-machine.ts` | Ajouter steps `refine_project`, `validate_profile`. Ajouter champs WizardData | Nouveau flow |
| `onboarding/wizard/describe.ts` | Réécrire pour le modal structuré | Nouveau flow |
| `dashboard/pages/config.ts` | Afficher et permettre l'édition des domaines, keywords négatifs, etc. | Dashboard |

### 6.2 `InstanceContext` enrichi

```typescript
interface InstanceContext {
  readonly id: string;
  readonly db: SqliteDatabase;
  readonly config: InstanceConfig;
  readonly channels: InstanceChannels;
  readonly profile: InstanceProfile;  // NOUVEAU
}
```

Le `InstanceRegistry` charge le profil au démarrage et le rend disponible dans le contexte.

### 6.3 Pipeline veille modifié

```
handleVeilleCron(ctx)
  → Charger profile depuis ctx.profile
  → Charger catégories depuis DB (getCategoriesFromDb)
  → collectFromAllSources(db, categories)    // plus de branche legacy
  → prefilter(articles, profile)             // NOUVEAU
  → analyze(filtered, preferences, persona, profile)  // profil enrichi
  → saveArticle + indexDocument
  → Discord digest (seuil depuis config)
  → Discord thread (seuil depuis config)
  → Budget alerts
```

---

## 7. Fichiers créés / modifiés

### Fichiers créés

| Fichier | Description |
|---------|-------------|
| `src/core/instance-profile.ts` | CRUD pour `instance_profile` table |
| `src/veille/prefilter.ts` | Funnel de pré-filtrage en 3 étapes |
| `src/onboarding/wizard/refine-project.ts` | Questions LLM de suivi (sous-étape 2.1b) |
| `src/veille/calibrated-examples.ts` | Génération des exemples calibrés (background) |
| `specs/VEILLE_V3_PIPELINE.md` | Cette spec |

### Fichiers modifiés (résumé)

| Fichier | Nature du changement |
|---------|---------------------|
| `core/migrations/index.ts` | Migration 026 : table instance_profile |
| `veille/queries.ts` | Supprimer hardcodé, garder utilitaires |
| `veille/collector.ts` | Supprimer `collect()`, garder types |
| `veille/analyzer.ts` | Prompt enrichi avec profil |
| `veille/deep-dive.ts` | Persona dynamique, seuil config |
| `veille/sources/rss.ts` | Category/language dynamique |
| `veille/sources/youtube-transcript.ts` | Category dynamique |
| `veille/sources/web-search.ts` | Category dynamique |
| `handlers/veille.ts` | Prefilter + profil + seuils config |
| `handlers/suggestions.ts` | Persona instance + config |
| `handlers/rapport.ts` | Platforms depuis profil |
| `handlers/production.ts` | Style visuel depuis persona |
| `handlers/derivation.ts` | Style visuel depuis persona |
| `content/suggestions.ts` | Persona instance + config params |
| `registry/instance-registry.ts` | Charger profil + platforms/formats/pillars depuis profil |
| `core/config.ts` | Retirer platforms/formats/pillars du default |
| `onboarding/wizard/state-machine.ts` | Nouveaux steps + champs WizardData |
| `onboarding/wizard/orchestrator.ts` | Nouveaux steps + sauvegarde complète |
| `onboarding/wizard/describe.ts` | Modal structuré |
| `onboarding/wizard/confirm.ts` | Afficher profil complet |
| `dashboard/pages/config.ts` | Édition profil |
| `tests/core/database.test.ts` | Migration count → 26 |

---

## 8. Ordre d'implémentation

### Phase 1 — Fondations (critique, bloquant pour le reste)

1. Migration 026 : table `instance_profile`
2. Module `src/core/instance-profile.ts` (CRUD)
3. Nettoyage `queries.ts` : supprimer hardcodé
4. Supprimer `collect()` dans `collector.ts`
5. Supprimer la branche legacy dans `handlers/veille.ts`
6. Sauvegarder sources/schedule/config dans `handleWizardConfirm()`
7. Charger `instance_profile` dans `InstanceContext` (registry)

### Phase 2 — Pré-filtrage

8. Module `src/veille/prefilter.ts` (3 filtres)
9. Intégrer prefilter dans `handlers/veille.ts`
10. Tests prefilter

### Phase 3 — Onboarding restructuré

11. Modifier `describe.ts` → modal structuré
12. Nouveau module `refine-project.ts` → questions LLM
13. Mise à jour state-machine (steps + WizardData)
14. Mise à jour orchestrator (routing + handlers)
15. Mise à jour confirm.ts (affichage profil complet)

### Phase 4 — Scoring amélioré + consommateurs

16. Modifier `analyzer.ts` → prompt enrichi avec profil
17. Module `calibrated-examples.ts` → génération background
18. Déhardcoder persona dans `suggestions.ts` et `deep-dive.ts`
19. Déhardcoder seuils dans tous les handlers
20. Déhardcoder style visuel dans `production.ts` et `derivation.ts`
21. Modifier `instance-registry.ts` pour platforms/formats/pillars depuis profil

### Phase 5 — Validation

22. Mettre à jour tous les tests (migration count, mocks, etc.)
23. `npm run typecheck`
24. `npm test`

---

## 9. Risques et points d'attention

| Risque | Mitigation |
|--------|------------|
| Instance sans profil (créée avant V3) | `getProfile()` retourne `undefined` → fallback sur defaults raisonnables |
| Catégories DB vides | `getCategoriesFromDb()` retourne `[]` → le pipeline skip la collecte + log warning |
| LLM rate limit pendant calibrated examples | Fire-and-forget avec retry — pas bloquant |
| Modal Discord limité à 5 champs | On met les 5 champs les plus importants. Le reste est dans les questions LLM |
| Réponse utilisateur aux questions non structurée | Le LLM est bon pour extraire des données structurées depuis du texte libre |
| Near-duplicate trop agressif | Seuil Jaccard 0.7 est conservateur. Tester et ajuster |
| `exactOptionalPropertyTypes` TS | Construire les objets avec spread conditionnel, pas `undefined` |
| `config_overrides` pas d'upsert | Créer `upsertConfigOverride(db, key, value)` — actuellement c'est DELETE+INSERT manuel |
| `schedule_config` existe déjà | Module `scheduler-weekly.ts` a `saveScheduleConfig()` — le réutiliser, pas recréer |
| `InstanceContext` a plus de champs | L'interface réelle a aussi `name`, `guildId`, `ownerId`, `categoryId`, `secrets`, `status`, `createdAt`, `cronOffsetMinutes` — le profil s'ajoute en plus |
| `content/suggestions.ts` pas d'instanceId | `generateSuggestions(db, count)` n'a pas d'instanceId — il faut ajouter le param |
| `buildImagePrompt()` existe aussi dans `derivation.ts` | Deux copies du même prompt hardcodé — les deux doivent être rendues dynamiques |
| Pas de dédup DB dans `collectFromAllSources()` | Le collecteur enhanced ne déduplique PAS contre la DB (contrairement au legacy `collect()` qui le fait) — à ajouter |

---

## 10. Points de challenge résolus

### 10.1 Dédup contre la DB

Le collecteur legacy (`collect()` dans `collector.ts`) vérifie chaque URL contre `veille_articles` en DB (lignes 130-143) pour éviter de recollectionner des articles déjà vus. Le collecteur multi-source (`collectFromAllSources()`) ne fait PAS cette vérification.

**Action** : ajouter la dédup DB dans `collectFromAllSources()` ou dans `prefilter.ts` (après la collecte, avant le scoring). Le prefilter est le meilleur endroit car il centralise tout le filtrage.

### 10.2 `config_overrides` — fonction upsert

Il n'existe pas de fonction upsert dédiée pour `config_overrides`. Le pattern actuel est DELETE+INSERT dans `import.ts`. On crée une fonction utilitaire :

```typescript
function upsertConfigOverride(db: SqliteDatabase, key: string, value: string): void {
  db.prepare(`
    INSERT INTO config_overrides (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, value);
}
```

### 10.3 `schedule_config` — module existant

Le module `src/core/scheduler-weekly.ts` existe déjà avec `saveScheduleConfig(db, config)`. L'onboarding doit simplement appeler cette fonction existante dans `handleWizardConfirm()` au lieu de recréer la logique.

### 10.4 Rétrocompatibilité instances V2

Les instances créées avant V3 n'auront pas de `instance_profile`. La solution :

```typescript
function getProfile(db: SqliteDatabase): InstanceProfile | undefined {
  const row = db.prepare('SELECT * FROM instance_profile WHERE id = 1').get();
  if (row === undefined) return undefined;
  return parseProfile(row);
}

// Dans le registry, au chargement :
const profile = getProfile(db);
// Si undefined, construire un profil par défaut à partir des données existantes :
// - projectName depuis instance.name
// - catégories depuis veille_categories
// - persona depuis persona table
// - le reste en defaults raisonnables
```

### 10.5 Dédup DB intégrée au prefilter

Ajouter un **Filtre 0** au prefilter — la dédup contre la DB :

```typescript
// Filtre 0 — Dédup contre articles existants en DB
const existingStmt = db.prepare('SELECT url FROM veille_articles WHERE url = ?');
const newArticles = articles.filter((a) => {
  const existing = existingStmt.get(a.url) as { url: string } | undefined;
  return existing === undefined;
});
```

Ce filtre se place AVANT les filtres URL/contenu/near-dedup pour éliminer immédiatement les articles déjà collectés.
