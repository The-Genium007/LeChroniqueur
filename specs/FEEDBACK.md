# Spec — Système de feedback et apprentissage

## Modules

- `src/feedback/ratings.ts` — Enregistrement et lecture des 👍/👎
- `src/feedback/preference-learner.ts` — Agrégation du profil de préférences

## Principe

Chaque interaction de Lucas (👍/👎 sur un article, Go/Skip sur une suggestion)
est un signal de préférence. Ces signaux sont agrégés en un profil qui est
injecté dans le prompt Claude pour améliorer le scoring et les suggestions.

## ratings.ts — Contrat

```typescript
interface Rating {
  id: number;
  targetTable: 'veille_articles' | 'suggestions';
  targetId: number;
  rating: 1 | -1;
  discordUserId: string;
  ratedAt: Date;
}

// Enregistre ou met à jour un rating (UPSERT)
function upsertRating(
  targetTable: string,
  targetId: number,
  rating: 1 | -1,
  userId: string
): void;

// Récupère les ratings pour un élément
function getRatingsForTarget(
  targetTable: string,
  targetId: number
): Rating[];

// Compte les ratings par type pour une période
function getRatingStats(since: Date): {
  total: number;
  positive: number;
  negative: number;
};
```

### Mapping boutons → ratings

| Contexte | Bouton | Rating enregistré |
|----------|--------|-------------------|
| Veille (#veille thread) | 👍 | `+1` sur `veille_articles` |
| Veille (#veille thread) | 👎 | `-1` sur `veille_articles` |
| Suggestions (#idées) | ✅ Go | `+1` sur `suggestions` |
| Suggestions (#idées) | ⏭️ Skip | `-1` sur `suggestions` |
| Suggestions (#idées) | ✏️ Modifier | pas de rating (neutre) |
| Suggestions (#idées) | ⏰ Plus tard | pas de rating (neutre) |

## preference-learner.ts — Contrat

```typescript
interface PreferenceEntry {
  dimension: string;  // "source", "category", "keyword", "pillar"
  value: string;      // "reddit", "ttrpg_memes", "Critical Role"...
  positiveCount: number;
  negativeCount: number;
  totalCount: number;
  score: number;      // -1.0 à +1.0
}

// Recalcule toutes les préférences à partir des ratings
function recalculate(): void;

// Retourne le profil complet
function getProfile(): PreferenceEntry[];

// Génère le texte du profil pour injection dans le prompt Claude
function formatProfileForPrompt(): string;
```

### Algorithme de recalcul

Pour chaque dimension (source, category, keyword, pillar) :

1. **Source** : JOIN `feedback_ratings` + `veille_articles` sur `source`
   ```sql
   SELECT source AS value,
          SUM(CASE WHEN r.rating = 1 THEN 1 ELSE 0 END) AS positive,
          SUM(CASE WHEN r.rating = -1 THEN 1 ELSE 0 END) AS negative,
          COUNT(*) AS total
   FROM feedback_ratings r
   JOIN veille_articles a ON r.target_id = a.id AND r.target_table = 'veille_articles'
   GROUP BY a.source
   ```

2. **Category** : même JOIN sur `category`

3. **Pillar** : même JOIN sur `pillar`

4. **Keyword** : extraction des mots significatifs (> 4 caractères) des titres
   des articles notés, comptage positif/négatif par mot.
   Filtrer les stop words (le, la, les, the, a, an, de, du, des, etc.)

### Formule du score

```
score = (positive - negative) / total
```

- Score de +1.0 = 100% positif
- Score de 0.0 = neutre
- Score de -1.0 = 100% négatif

Minimum 3 ratings par entrée pour être inclus dans le profil (éviter le bruit).

### Format du profil pour le prompt Claude

```
Profil de préférences Lucas (basé sur 247 ratings) :

Sources :
  reddit: +0.82 (56 ratings) — FORTE PRÉFÉRENCE
  youtube: +0.71 (24 ratings) — préférence
  twitter: +0.65 (31 ratings) — préférence
  google: +0.40 (45 ratings) — légèrement positif
  facebook: -0.30 (20 ratings) — à éviter

Catégories :
  ttrpg_memes: +0.92 (38 ratings) — FORTE PRÉFÉRENCE
  tiktok_trends: +0.78 (18 ratings) — préférence
  streaming: +0.55 (22 ratings) — légèrement positif
  vtt_tech: -0.10 (15 ratings) — neutre
  competition: -0.45 (11 ratings) — à éviter

Piliers :
  trend: +0.85 (67 ratings) — FORTE PRÉFÉRENCE
  community: +0.76 (34 ratings) — préférence
  tuto: +0.60 (28 ratings) — préférence
  product: +0.30 (12 ratings) — légèrement positif

Mots-clés appréciés :
  "Critical Role" (+0.95), "nat 20" (+0.90), "TPK" (+0.88),
  "homebrew" (+0.85), "dragon" (+0.80)

Mots-clés à éviter :
  "Roll20 pricing" (-0.70), "D&D Beyond" (-0.50)

Instructions : utilise ce profil pour pondérer ton scoring.
Un article sur un sujet FORTE PRÉFÉRENCE devrait recevoir un bonus de +2.
Un article sur un sujet à éviter devrait recevoir un malus de -2.
```

### Labels de score

| Score | Label |
|-------|-------|
| >= +0.75 | FORTE PRÉFÉRENCE |
| >= +0.40 | préférence |
| >= +0.10 | légèrement positif |
| > -0.10 | neutre |
| > -0.40 | légèrement négatif |
| <= -0.40 | à éviter |

## Fréquence de recalcul

- **Quotidien** : avant chaque veille (au moment du cron 7h)
- Le recalcul est une agrégation SQL pure — pas d'appel API
- Temps d'exécution estimé : < 50ms même avec des milliers de ratings
