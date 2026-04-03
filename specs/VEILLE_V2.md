# Spec — Veille V2 (Multi-source, Scheduler, Resurfacing, Deep Dive)

## Vue d'ensemble

Refonte du moteur de veille pour passer d'un système linéaire (SearXNG → oubli) à un **moteur d'intelligence de contenu** avec : collecte multi-source, mémoire long terme, scoring adaptatif, resurfacing intelligent, et deep dive automatique.

## 1. Scheduler — Deux modes

### Mode quotidien (existant, conservé)

| Cron | Action |
|---|---|
| Veille Xh | Collecte + analyse (1 cycle/jour) |
| Suggestions Xh | 3 suggestions/jour |
| Rapport dim 20h | Analytics + recommandations |

### Mode hebdomadaire (nouveau)

| Moment | Action |
|---|---|
| **Veille -1 jour 20h** | Rapport hebdo (analytics, recommandations créneaux) |
| **Jour de veille Xh** | Cycle complet : collecte → scoring → deep dive auto → suggestions |
| **Jours de publication** | Publications programmées via Postiz |

Le jour de veille et l'heure sont **configurables** (onboarding + dashboard).
Le rapport se déclenche automatiquement **la veille du jour de veille à 20h** (non configurable).

**Suggestions par cycle** : 21 par défaut en hebdo, modifiable via input libre.
En quotidien : 3/jour (existant).

**Changement en cours de route** : effet immédiat avec warning :
> ⚠️ Le prochain cycle de veille sera [Nouveau jour]. Les publications déjà programmées ne sont pas modifiées.

## 2. Collecte multi-source

### Sources supportées

| Source | Type | Valeur | Config utilisateur | Coût |
|---|---|---|---|---|
| **SearXNG** | Meta-search | Large couverture web + Reddit via `site:reddit.com` | Toujours actif | Gratuit |
| **RSS/Atom** | Flux structurés | Blogs, médias spécialisés. Flux recommandés par LLM | URLs de flux | Gratuit |
| **YouTube Transcripts** | Vidéo → texte | Contenu profond des créateurs (transcript API + fallback SearXNG) | Keywords de recherche | Gratuit |
| **LLM Web Search** | Search IA natif | Recherche contextuelle profonde | Toggle on/off | Tokens LLM |

**Reddit** : pas de client dédié. SearXNG avec `engines: ['reddit']` et/ou queries `site:reddit.com/r/{subreddit}`. L'utilisateur configure des subreddits qui sont convertis en requêtes SearXNG ciblées.

### Activation par l'utilisateur

Chaque source (sauf SearXNG) est un **toggle activable** :
- Pendant l'onboarding (step dédié)
- Dans les réglages du dashboard

Claude Web Search affiche un avertissement : "Consomme des tokens LLM supplémentaires" avec un toggle explicite.

### Propositions de sources par défaut

Pendant l'onboarding, selon la niche détectée, le bot propose des sources par défaut :
- **Flux RSS** : blogs majeurs de la niche (générés par l'IA lors de l'analyse du projet)
- **Subreddits** : subs pertinents (générés par l'IA)
- **YouTube keywords** : termes de recherche (générés par l'IA)

L'utilisateur peut les modifier ou en ajouter via le dashboard.

### Architecture des sources

```typescript
interface VeilleSource {
  readonly type: 'searxng' | 'rss' | 'reddit' | 'youtube_transcript' | 'web_search';
  readonly enabled: boolean;
  readonly config: Record<string, unknown>;
}

// Exemples de config par type :
// rss: { urls: ['https://blog.roll20.net/rss', ...] }
// reddit: { subreddits: ['rpg', 'dndnext', 'FoundryVTT'], sortBy: 'hot', limit: 25 }
// youtube_transcript: { keywords: ['D&D news', 'TTRPG review'], maxResults: 10 }
// web_search: { enabled: true }
```

### Nouveau module : `src/veille/sources/`

```
src/veille/sources/
├── index.ts              # Orchestrateur multi-source
├── searxng-enhanced.ts   # SearXNG renforcé (Reddit via site:, multi-keyword, pagination)
├── rss.ts                # Collecteur RSS/Atom
├── youtube-transcript.ts # Collecteur YouTube transcriptions (API + fallback)
└── web-search.ts         # Collecteur LLM web_search
```

**Pas de client Reddit dédié** — SearXNG couvre Reddit via `engines: ['reddit']` et `site:reddit.com/r/{sub}`.

Chaque source implémente une interface commune :

```typescript
interface SourceCollector {
  readonly type: string;
  collect(categories: readonly VeilleCategory[], config: Record<string, unknown>): Promise<readonly RawArticle[]>;
}
```

L'orchestrateur appelle toutes les sources actives en parallèle, puis déduplique et fusionne les résultats.

### SearXNG renforcé

Le SearXNG actuel est basique (1 requête par keyword). Le SearXNG renforcé :

- **Multi-keyword** : teste 2-3 keywords par catégorie (pas juste le premier)
- **Pagination** : fetch page 1 et 2 pour plus de résultats
- **Reddit ciblé** : convertit les subreddits configurés en queries `site:reddit.com/r/{sub} {keyword}`
- **Multi-engine** : lance les mêmes keywords sur plusieurs moteurs en parallèle
- **Déduplication cross-engine** : fusionne les résultats par URL

### YouTube Transcripts

- **Source primaire** : librairie `youtube-transcript` pour récupérer les sous-titres auto
- **Fallback** : si la librairie échoue (scraping cassé), utilise SearXNG `site:youtube.com` pour trouver les vidéos, et le deep dive auto fetch la transcription lors de l'analyse approfondie
- **Recherche** : les keywords YouTube sont cherchés via YouTube Search API ou SearXNG `engines: ['youtube']`

### Flux RSS recommandés par LLM

Quand l'utilisateur active RSS pendant l'onboarding, un appel LLM dédié génère des flux recommandés :

```
Prompt : "Pour la niche '{niche}', recommande 5-10 flux RSS pertinents.
Retourne un JSON : { "feeds": [{ "url": "...", "name": "...", "description": "..." }] }"
```

L'utilisateur peut accepter tous, modifier, ou en ajouter.

## 3. Pipeline de veille — Entonnoir intelligent

```
┌─────────────────────────────────────────────────────────┐
│ SURFACE (rapide, gratuit/cheap, large)                   │
│ SearXNG + RSS + Reddit + YouTube                         │
│ → ~100-200 résultats bruts dédupliqués                   │
└──────────────────────────┬──────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────┐
│ SCORING (LLM, peu de tokens)                             │
│ Titre + snippet → score 1-10 + pillar + angle suggéré    │
│ → ~20-40 articles score ≥ 6                              │
└──────────────────────────┬──────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────┐
│ DEEP DIVE AUTO (LLM, plus de tokens)                     │
│ Articles score ≥ 8 :                                     │
│ → Fetch contenu complet (HTML → texte via readability)   │
│ → YouTube : récupère transcript                          │
│ → Analyse approfondie + extraction insights              │
│ → ~5-10 articles enrichis                                │
└──────────────────────────┬──────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────┐
│ RESURFACING (LLM, tokens moyens)                         │
│ Candidats : skippés <3 fois, publiés >30j, anciens ≥7   │
│ → LLM décide du ratio neuf/resurfacé                     │
│ → Justification en 2-3 phrases                           │
└──────────────────────────┬──────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────┐
│ SUGGESTIONS (LLM, tokens moyens)                         │
│ Articles enrichis + resurfacés + historique               │
│ → N suggestions pour le cycle                            │
│ → Récap groupé dans #idées                               │
└─────────────────────────────────────────────────────────┘
```

## 4. Deep dive automatique

### Déclenchement

Automatique pour les articles avec **score ≥ 8** lors du cycle de veille.

### Processus

1. **Fetch contenu complet** de la page web :
   - Utiliser `@mozilla/readability` + `jsdom` pour un parsing propre (remplace le regex strip actuel)
   - Limite : 5000 caractères (au lieu de 3000 actuellement)
2. **YouTube** : si l'URL est une vidéo YouTube, récupérer la **transcription** au lieu du HTML
3. **Analyse LLM approfondie** :
   - Contexte du persona
   - Contenu complet de l'article
   - Génération de 3 suggestions de contenu concrètes
4. **Stockage** : les insights sont sauvegardés dans une nouvelle colonne `deep_dive_content` de `veille_articles`

### Limites

- Maximum **5 deep dives par cycle** quotidien, **10 par cycle** hebdomadaire
- Le deep dive existant (bouton manuel) reste disponible pour tout article

## 5. Resurfacing intelligent

### Statuts d'article enrichis

```
Actuel :  new → proposed → (published | archived)
Nouveau : new → scored → proposed → go | skipped | hors_contexte
                                      │      │           │
                                      │      │           └─ blacklisté (jamais reproposé)
                                      │      └─ skip_count++ (resurfacable si <3)
                                      │
                                      ├─ published → resurfacable (après 30 jours)
                                      └─ deep_dived → enriched → proposed
```

### Modifications DB

```sql
ALTER TABLE veille_articles ADD COLUMN skip_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE veille_articles ADD COLUMN deep_dive_content TEXT;
ALTER TABLE veille_articles ADD COLUMN source_type TEXT NOT NULL DEFAULT 'searxng';
ALTER TABLE veille_articles ADD COLUMN resurfaced_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE veille_articles ADD COLUMN last_resurfaced_at DATETIME;
```

### Requêtes de resurfacing

```sql
-- Skippés 1-2 fois, pas vus depuis 14 jours
SELECT * FROM veille_articles
WHERE status = 'skipped' AND skip_count < 3
AND collected_at < date('now', '-14 days')
ORDER BY score DESC LIMIT 5;

-- Publiés il y a longtemps, recyclables sous un nouvel angle
SELECT * FROM veille_articles
WHERE status = 'published'
AND published_at < date('now', '-30 days')
AND score >= 7
ORDER BY score DESC LIMIT 5;

-- Anciens articles jamais proposés mais bien scorés
SELECT * FROM veille_articles
WHERE status = 'scored' AND score >= 7
AND collected_at < date('now', '-7 days')
ORDER BY score DESC LIMIT 5;
```

### Ratio intelligent

Le LLM reçoit la liste complète des candidats (frais + resurfacables) et décide lui-même du ratio optimal. Pas de ratio hardcodé.

Prompt :
```
Tu as [N] articles frais et [M] candidats au resurfacing.
Choisis les [X] meilleurs pour un cycle de suggestions.
Si le contenu frais est abondant et de haute qualité, privilégie-le.
Si le contenu frais est faible, inclus plus de resurfacés.
Pour chaque resurfacé, explique en 2-3 phrases pourquoi il est pertinent maintenant.
```

### Bouton "Hors contexte" 🚫

Nouveau bouton dans #idées, à côté de Go/Skip/Modifier :

- **Effet** : marque l'article comme `hors_contexte` (blacklisté)
- **Impact scoring** : le preference learner reçoit un signal fort négatif sur la catégorie/source
- **Jamais reproposé** : contrairement au skip qui est temporaire
- **Accumulation** : si beaucoup d'articles d'une catégorie sont marqués hors-contexte, le système ajuste les keywords de cette catégorie

### Tags visuels dans #idées

| Tag | Signification |
|---|---|
| 🆕 | Suggestion basée sur un article de ce cycle |
| 🔄 | Resurfacé (article ancien, contexte nouveau) |
| ♻️ | Recyclé (déjà publié, nouvel angle proposé) |

Chaque suggestion resurfacée/recyclée inclut :
- 📅 Date de collecte/publication originale
- 💡 Justification de pourquoi c'est pertinent maintenant (2-3 phrases, générées par le LLM)

## 6. Récap groupé pour #idées (mode hebdomadaire)

Au lieu de N messages individuels, un récap structuré :

```
Container (couleur: suggestion)
├── TextDisplay : "📰 Suggestions de la semaine — {N} propositions"
├── Separator
├── TextDisplay : "🆕 NOUVELLES ({count})"
├── TextDisplay : liste des suggestions neuves avec scores
├── Separator
├── TextDisplay : "🔄 RESURFACÉES ({count})"
├── TextDisplay : liste avec date originale + justification
├── Separator
├── TextDisplay : "♻️ RECYCLABLES ({count})"
├── TextDisplay : liste avec date publi + nouvel angle
├── Separator
├── ActionRow : [✅ Valider la sélection] [⏭️ Tout voir en détail]
```

Chaque suggestion dans le récap a un bouton Go/Skip/🚫 individuel.

Le récap utilise le `sendSplit()` existant avec pagination automatique (5 suggestions par page) pour respecter les limites Discord (4000 chars, 40 composants).

En mode quotidien, le comportement existant (messages individuels) est conservé.

## 7. Onboarding — Nouveau step "Sources de veille"

### Position dans le wizard

Après le dry-run des catégories, avant la persona :

```
1. describe_project
2. review_categories
3. dryrun_searxng
4. configure_sources     ← NOUVEAU
5. mini_dryrun_sources   ← NOUVEAU (test rapide des nouvelles sources)
6. choose_persona_tone
...
```

Le **mini dry-run** (étape 5) lance un test rapide des sources nouvellement activées (RSS, YouTube) pour valider qu'elles retournent des résultats. Format identique au dry-run existant mais ne teste que les sources ajoutées (pas SearXNG qui a déjà été testé).

### Interface V2

```
Container (couleur: primary)
├── TextDisplay : "📡 Sources de veille — Étape 4/13"
│   "Configure les sources de données pour ta veille."
│   "SearXNG est toujours actif. Active les sources supplémentaires."
├── Separator
├── TextDisplay : statut de chaque source (✅/❌)
├── ActionRow : [✅ SearXNG] [RSS] [Reddit] [YouTube] [🔍 Web Search IA]
├── Separator
├── TextDisplay : "⚠️ Web Search IA consomme des tokens LLM supplémentaires"
├── ActionRow : [✅ Valider] [⚙️ Configurer RSS] [⚙️ Configurer Reddit]
```

Les boutons RSS/Reddit ouvrent un modal pour saisir les URLs/subreddits.

### Propositions par défaut

Quand l'utilisateur active RSS ou Reddit, le bot propose des sources par défaut basées sur la niche (générées par le LLM pendant l'analyse du projet) :

```
Tu as activé RSS. Voici des flux recommandés pour "{niche}" :
• https://blog.roll20.net/rss — Blog Roll20
• https://foundryvtt.com/releases/feed — Foundry VTT
• https://www.dndbeyond.com/feed — D&D Beyond

[✅ Ajouter tous] [✏️ Modifier] [⏭️ Passer]
```

## 8. Onboarding — Rework step Scheduler

### Interface V2

```
Container (couleur: primary)
├── TextDisplay : "⏰ Planification — Étape 11/13"
│   "Choisis ton mode de fonctionnement."
├── Separator
├── ActionRow : [📅 Hebdomadaire] [🔄 Quotidien]
├── Separator

── Si hebdomadaire : ──
├── TextDisplay : "Jour et heure de veille :"
├── ActionRow : [Select: Jour de la semaine ▾]
├── ActionRow : [Select: Heure de début ▾]
├── Separator
├── TextDisplay : "Jours de publication :"
├── ActionRow : [Lun] [Mar] [Mer] [Jeu] [Ven]
├── ActionRow : [Sam] [Dim]
├── Separator
├── TextDisplay : "Suggestions par cycle :"
├── ActionRow : [Select: 21 ▾] ou [✏️ Nombre custom]
├── Separator
├── TextDisplay : "📋 Aperçu de la semaine :"
│   "📊 Samedi 20h — Rapport hebdo"
│   "📰 Dimanche 08h — Veille + suggestions"
│   "📱 Lundi → Publication"
│   "📸 Mardi → Publication"
│   ...
├── Separator
├── ActionRow : [✅ Valider]

── Si quotidien : ──
├── TextDisplay : "Horaires :"
│   "📰 Veille : tous les jours à 7h"
│   "💡 Suggestions : tous les jours à 8h (3 par cycle)"
│   "📊 Rapport : dimanche à 20h"
├── ActionRow : [✅ Garder les defaults] [✏️ Modifier les horaires]
```

## 9. Stockage des sources

### Nouvelle table

```sql
CREATE TABLE veille_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL DEFAULT '{}',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(type)
);
```

### Config par défaut

```sql
INSERT INTO veille_sources (type, enabled, config) VALUES
  ('searxng', 1, '{}'),
  ('rss', 0, '{"urls": []}'),
  ('reddit', 0, '{"subreddits": [], "sortBy": "hot", "limit": 25}'),
  ('youtube_transcript', 0, '{"keywords": [], "maxResults": 10}'),
  ('web_search', 0, '{"enabled": false}');
```

## 10. Modifications DB — Scheduler

### Nouvelle table

```sql
CREATE TABLE schedule_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL DEFAULT 'daily',
    veille_day INTEGER,
    veille_hour INTEGER NOT NULL DEFAULT 7,
    publication_days TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
    suggestions_per_cycle INTEGER NOT NULL DEFAULT 3,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**Note** : cette table est dans la DB d'instance (1 par instance). Pas de `CHECK (id = 1)` pour anticiper d'éventuelles extensions.

- `mode` : `'daily'` | `'weekly'`
- `veille_day` : 0-6 (dimanche=0), null en mode daily
- `veille_hour` : 0-23
- `publication_days` : JSON array de jours (0-6)
- `suggestions_per_cycle` : 3 (daily) ou 21 (weekly) par défaut

## 11. Corrections onboarding identifiées

En parallèle de la spec veille V2, appliquer les corrections de l'audit onboarding :

| Correction | Fichier |
|---|---|
| Retirer `Tokens` et `Itérations` de tous les messages wizard | describe.ts, categories.ts, persona.ts, confirm.ts |
| Injecter les sections persona précédentes dans le prompt de chaque nouvelle section | persona.ts |
| Dry-run : tester 2-3 keywords par catégorie | dryrun.ts |
| Ajouter provider LLM + statut Google AI/Postiz dans le résumé final (confirm) | confirm.ts |
| Masquer les expressions cron, afficher juste les heures lisibles | platforms.ts |
| Lier la direction artistique aux prompts Imagen | persona.ts, production.ts |
| Ajouter bouton "Hors contexte" 🚫 dans #idées | component-builder-v2.ts, index.ts |

## 12. Modules critiques (tests obligatoires)

- `veille/sources/rss.ts` — parsing RSS/Atom, gestion erreurs
- `veille/sources/reddit.ts` — API Reddit, parsing posts
- `veille/sources/youtube-transcript.ts` — récupération transcriptions
- `veille/sources/index.ts` — orchestration multi-source, déduplication
- `veille/resurfacing.ts` — requêtes SQL, logique de sélection, ratio
- `core/scheduler-weekly.ts` — calcul crons hebdo, rapport veille-1

## ADR

| # | Décision | Raison |
|---|---|---|
| 030 | SearXNG toujours actif, renforcé (multi-keyword, pagination, Reddit ciblé) | SearXNG est gratuit, couvre le plus large, et peut cibler Reddit via `site:` sans client dédié |
| 031 | YouTube transcripts API + fallback SearXNG | Le contenu textuel est plus exploitable que la vidéo brute, fallback pour robustesse |
| 032 | Deep dive auto pour score ≥ 8 | Seuil élevé pour limiter les coûts tokens, les articles à fort potentiel méritent l'investissement |
| 033 | Max 5 deep dives/cycle quotidien, 10/hebdo | Contrôle du budget, les deep dives coûtent ~2x un scoring |
| 034 | Skip < 3 avant blacklist | Laisser une chance aux sujets qui étaient hors timing mais pas hors contexte |
| 035 | Ratio resurfacing décidé par le LLM | Plus intelligent qu'un ratio hardcodé, s'adapte au volume de contenu frais |
| 036 | Hors-contexte ≠ skip | Signal fort pour le scoring vs signal faible, permet d'affiner les keywords automatiquement |
| 037 | Récap groupé paginé en hebdo, individuel en quotidien | 20+ messages individuels seraient ingérables en hebdo, pagination via sendSplit() |
| 038 | RSS sans authentification | Les flux RSS publics couvrent la majorité des besoins, pas de gestion de credentials |
| 039 | Reddit via SearXNG (pas de client dédié) | SearXNG avec `site:reddit.com/r/{sub}` couvre le besoin sans ajouter une dépendance API |
| 040 | Rapport la veille du jour de veille | L'utilisateur reçoit les analytics avant de valider le nouveau cycle, pas après |
| 041 | LLM web_search en toggle avec warning | Coût explicite pour l'utilisateur, pas d'activation silencieuse |
| 042 | @mozilla/readability + jsdom pour le deep dive | Parsing HTML propre, bien meilleur que le regex strip actuel |
| 043 | Mini dry-run après config sources | Valide que les nouvelles sources (RSS, YouTube) retournent des résultats |
| 044 | Flux RSS recommandés par LLM | Appel dédié pendant l'onboarding, l'IA connaît les blogs majeurs par niche |
| 045 | schedule_config sans singleton | Anticipe le multi-instance, chaque instance DB a sa propre config |
