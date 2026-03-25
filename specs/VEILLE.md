# Spec — Pipeline de veille

## Modules

- `src/veille/queries.ts` — Définition des requêtes par catégorie
- `src/veille/collector.ts` — Collecte SearXNG + déduplication
- `src/veille/analyzer.ts` — Analyse Claude (scoring, classification, traduction)
- `src/veille/deep-dive.ts` — Analyse approfondie d'un article (on-demand)
- `src/handlers/veille.ts` — Orchestration du pipeline complet

## Déclenchement

- **Cron quotidien** à 7h (configurable via `VEILLE_CRON`)
- **Manuel** via `/veille` dans #admin
- **Rattrapage** au boot si la dernière veille date de > 24h

## Catégories de recherche

| ID | Label | Mots-clés EN | Mots-clés FR | Moteurs SearXNG |
|----|-------|-------------|-------------|-----------------|
| `ttrpg_news` | Actus TTRPG | D&D, Pathfinder, TTRPG news, WotC, Critical Role | JDR, Donjons et Dragons | google news, reddit |
| `ttrpg_memes` | Memes JDR | dnd memes, rpg horror stories, nat 20, TPK | memes JDR, échec critique | reddit, imgur |
| `streaming` | Streaming | Twitch trends, TTRPG stream, actual play | stream JDR, partie en live | reddit, twitter, google |
| `tiktok_trends` | Trends TikTok | tiktok trending, viral format, dnd tiktok | tiktok tendance, format viral | google, twitter |
| `influencers` | Influenceurs JDR | dnd influencer, ttrpg creator, dnd youtube | créateur JDR, influenceur JDR | youtube, google |
| `vtt_tech` | VTT / Tech | Foundry VTT, Roll20, virtual tabletop | table virtuelle, Foundry module | hackernews, reddit, google |
| `community_fr` | Communauté FR | — | convention JDR, sortie JDR FR, actual play FR | google, reddit |
| `facebook_groups` | Facebook | D&D group, TTRPG community, DM tips | groupe JDR, MJ conseils | google (site:facebook.com) |
| `competition` | Concurrence | poll overlay twitch, stream interaction tool | sondage twitch, interaction viewers | google, reddit |

## queries.ts — Contrat

```typescript
interface VeilleCategory {
  id: string;
  label: string;
  keywords: {
    en: string[];
    fr: string[];
  };
  engines: string[];
  maxAge: number; // heures — articles plus vieux sont ignorés
}

function getCategories(): VeilleCategory[];
function buildSearxngQueries(category: VeilleCategory): SearxngQuery[];
```

## collector.ts — Contrat

```typescript
interface CollectorResult {
  articles: RawArticle[];
  stats: {
    totalFetched: number;
    deduplicated: number;
    filtered: number;
    kept: number;
  };
}

interface RawArticle {
  url: string;
  title: string;
  snippet: string;
  source: string;      // "reddit", "google", etc.
  language: string;     // "en" ou "fr"
  category: string;     // ID de la catégorie
  thumbnailUrl?: string;
  publishedAt?: Date;
}

async function collect(categories: VeilleCategory[]): Promise<CollectorResult>;
```

### Pipeline du collector

1. Pour chaque catégorie, construire les requêtes SearXNG
2. Exécuter les requêtes (parallèle par catégorie, séquentiel dans la catégorie)
3. Agréger les résultats
4. Dédupliquer par URL vs base SQLite (articles déjà collectés)
5. Filtrer par fraîcheur (< `maxAge` heures)
6. Retourner les articles retenus + stats

### Rate limiting SearXNG

- Max 2 requêtes par seconde vers SearXNG
- Pause de 500ms entre chaque requête
- Timeout de 10s par requête

## analyzer.ts — Contrat

```typescript
interface AnalyzedArticle extends RawArticle {
  score: number;           // 0-10
  pillar: string;          // "trend", "tuto", "community", "product"
  suggestedAngle: string;  // Angle de contenu suggéré
  translatedTitle?: string;  // Si l'article est en anglais
  translatedSnippet?: string;
}

interface AnalysisResult {
  articles: AnalyzedArticle[];
  tokensUsed: { input: number; output: number };
}

async function analyze(
  articles: RawArticle[],
  preferences: PreferenceProfile[]
): Promise<AnalysisResult>;
```

### Prompt Claude pour l'analyse

Un seul appel Claude pour toute la veille. Le prompt contient :
1. Le profil de préférences (agrégé depuis `preference_profiles`)
2. La liste des articles (titre + snippet + source + catégorie)
3. Les instructions de scoring, classification, traduction

Claude retourne un JSON structuré avec les champs enrichis.

### Format de retour attendu de Claude

```json
{
  "articles": [
    {
      "url": "https://...",
      "score": 8,
      "pillar": "trend",
      "suggestedAngle": "Quand le dragon du copyright lâche son souffle...",
      "translatedTitle": "WotC annonce un nouveau SRD open source",
      "translatedSnippet": "Wizards of the Coast a publié..."
    }
  ]
}
```

Validé par un schéma Zod côté bot.

## deep-dive.ts — Contrat

```typescript
interface DeepDiveResult {
  fullContent: string;       // Texte complet de l'article
  analysis: string;          // Analyse détaillée par Claude
  contentSuggestions: string[]; // 2-3 suggestions de contenu
  tokensUsed: { input: number; output: number };
}

async function deepDive(article: VeilleArticle): Promise<DeepDiveResult>;
```

### Pipeline deep dive

1. Fetch la page complète de l'article via SearXNG ou fetch HTTP direct
2. Extraire le texte principal (nettoyage HTML)
3. Envoyer à Claude avec le persona du Chroniqueur
4. Claude génère une analyse détaillée + 2-3 suggestions de contenu

Déclenché uniquement quand Lucas clique 🎯 "Transformer en contenu".

## handlers/veille.ts — Orchestration

```typescript
async function handleVeilleCron(): Promise<void>;
async function handleVeilleManual(interaction: ChatInputCommandInteraction): Promise<void>;
async function handleTransformButton(interaction: ButtonInteraction, articleId: number): Promise<void>;
```

### Flux complet (veille cron)

```
1. PreferenceLearner.recalculate()
2. categories = getCategories()
3. { articles, stats } = await collect(categories)
4. if (articles.length === 0) → log + skip
5. { articles: analyzed } = await analyze(articles, preferences)
6. Database.saveArticles(analyzed)
7. SearchEngine.indexArticles(analyzed)
8. topArticles = analyzed.filter(a => a.score >= 7)
9. embed = MessageBuilder.veilleDigest(topArticles, stats)
10. message = await channel.send(embed)
11. thread = await message.startThread({ name: "Détails veille..." })
12. Pour chaque article analysé (score >= 5) :
    a. embed = MessageBuilder.veilleArticle(article)
    b. msg = await thread.send(embed)  // avec boutons 👍/👎/🎯
    c. Database.updateArticleMessageId(article.id, msg.id)
13. BudgetTracker.record(tokensUsed)
14. CronRuns.recordSuccess("veille")
```

## Format Discord — Embed résumé

```
📜 Veille du 25 mars 2026

🔥 TOP (3 articles — score ≥ 8)
► WotC annonce un nouveau SRD open source
  💡 "Quand le dragon du copyright lâche son souffle..."
  Reddit — il y a 6h

► Son viral TikTok #DnD atteint 2M de vues
  💡 "Même les bardes level 1 font des hits..."
  Google — il y a 12h

► Critical Role lance un format court sur YouTube
  💡 "Format parfait pour un carrousel 'Comment je gère...'"
  YouTube — il y a 18h

📊 47 articles scannés → 12 retenus → 3 top
📈 Profil : memes JDR (+0.92) | Reddit (+0.84)

[📋 Voir le thread détaillé]
```

## Format Discord — Article individuel (dans le thread)

```
⚔️ WotC annonce un nouveau SRD open source (8/10)

WotC a publié une version open source complète du SRD 5.2,
incluant toutes les classes de base et les monstres...

📂 Catégorie : Actus TTRPG
🏷️ Pilier : trend
🔗 Source : Reddit — r/dndnext — il y a 6h
💡 Angle : "Quand le dragon du copyright lâche son souffle..."

[👍] [👎] [🎯 Transformer en contenu]
```
