# Spec : Onboarding V2 — Enrichissement profond + Smart Model Routing

## 1. Objectif

Refondre l'onboarding pour que le bot comprenne en profondeur le projet de l'utilisateur
AVANT de lancer la veille. Plus l'onboarding est riche, moins on gaspille de tokens en scoring.

Principes :
- L'utilisateur ne choisit JAMAIS de modèle, seulement un provider + clé
- Le bot sélectionne automatiquement le modèle optimal par tâche
- L'onboarding pose des questions jusqu'à atteindre 80% de confiance
- Pas d'emojis dans les posts par défaut (sauf demande explicite)
- Les messages longs sont toujours découpés (jamais tronqués)

---

## 2. Smart Model Routing

L'utilisateur fournit une clé API. Le bot choisit le modèle selon la tâche.

### Table de routage par provider

| Tâche | Rôle | Anthropic | Google (Gemini) | OpenAI |
|---|---|---|---|---|
| `onboarding` | Enrichissement profond, questions intelligentes | claude-opus-4-6 | gemini-2.5-pro | gpt-5.4 |
| `scraping` | Extraction contenu site web | claude-sonnet-4-6 | gemini-2.5-flash | gpt-5.2 |
| `scoring` | Scoring articles (volume, coût min) | claude-haiku-4-5-20251001 | gemini-2.5-flash | gpt-5-nano |
| `suggestions` | Génération idées contenu | claude-sonnet-4-6 | gemini-2.5-pro | gpt-5.2 |
| `scripts` | Rédaction scripts/posts | claude-sonnet-4-6 | gemini-2.5-pro | gpt-5.2 |
| `persona` | Génération persona | claude-sonnet-4-6 | gemini-2.5-pro | gpt-5.2 |

### Implémentation

Nouveau type dans `llm-factory.ts` :

```typescript
type LlmTask = 'onboarding' | 'scraping' | 'scoring' | 'suggestions' | 'scripts' | 'persona';

function getModelForTask(providerId: string, task: LlmTask): string { ... }

// Usage dans les handlers :
const response = await complete(system, user, { task: 'scoring' });
```

Le factory lit le provider configuré et sélectionne le modèle depuis la table de routage.
L'utilisateur ne voit jamais de sélection de modèle dans l'onboarding.

### Stockage

- `config_overrides.llm_provider` → provider ID (anthropic, google, openai, etc.)
- `instance_secrets.llm` → clé API
- Pas de `llm_model` en config — le routing est automatique

---

## 3. Flow d'onboarding révisé

### Étape 1 — Clé Gemini (OBLIGATOIRE)
- Modal : clé Google AI Studio
- Validation : test Generative AI API
- "Utiliser Gemini comme LLM aussi ?" → Oui/Non
- Si Oui : Gemini = provider LLM, skip étape 2

### Étape 2 — Clé Provider LLM (si pas Gemini)
- Choix provider : Anthropic, OpenAI, Mistral, DeepSeek, etc.
- PAS de choix de modèle (smart routing)
- Modal : clé API seulement
- Validation de la clé

### Étape 3 — Clé Google Cloud (OPTIONNEL)
- Modal : clé Google Cloud Console
- Validation : test YouTube Data API v3
- Si skip → YouTube via SearXNG en fallback

### Étape 4 — Description projet (modal structuré)
- 5 champs :
  - Nom du projet (obligatoire)
  - URL du site web (optionnel)
  - Niche/secteur (obligatoire)
  - Types de contenu (news, tuto, memes, pub produit)
  - Plateformes cibles (TikTok, Instagram, YouTube Shorts)

### Étape 5 — Scraping site web (automatique)
- Si URL fournie :
  1. `fetch(url)` + `@mozilla/readability` pour extraire le contenu
  2. Si le contenu est vide/insuffisant → fallback LLM `web_search` tool
  3. Le LLM (modèle `onboarding`) analyse :
     - Description du produit/service
     - Ton de communication utilisé
     - Public cible identifié
     - Concurrents mentionnés ou détectés
     - Mots-clés récurrents
  4. Résultat stocké dans `session.data.siteAnalysis`
- Si pas d'URL → skip, le LLM posera plus de questions

### Étape 6 — Enrichissement par questions (confidence loop)
- Le LLM (modèle `onboarding`) pose des questions en format libre
- L'utilisateur répond en texte dans le chat DM
- Flow :
  1. Le LLM reçoit : description projet + site analysis + réponses précédentes
  2. Il retourne : `{ confidence: number, question: string | null, insights: string[] }`
  3. Si `confidence < 80` et questions < 30 → affiche la question + barre de progression
  4. Si `confidence >= 80` ou questions >= 30 → passe à l'étape 7
- Affichage :
  ```
  📊 Compréhension du projet : 65%
  ████████████░░░░░░░░

  Question 8/30 :
  Quels sont vos 3 principaux concurrents et en quoi
  votre produit se différencie ?
  ```
- Le LLM génère automatiquement à partir des réponses :
  - Negative keywords enrichis (20-30)
  - Include/exclude domains
  - Keywords de veille (EN)
  - Public cible détaillé
  - Positionnement produit

### Étape 7 — Validation du profil
- Le LLM compile tout en un résumé structuré
- L'utilisateur valide ou demande des corrections
- Si correction → retour à l'étape 6 avec contexte mis à jour
- Résumé affiché :
  ```
  📋 Profil compilé (confiance : 87%)

  🏢 Projet : Tumulte — plateforme de JDR tabletop streaming
  🎯 Public : MJs et joueurs 18-35 ans, streamers JDR
  📱 Plateformes : TikTok, Instagram, YouTube Shorts
  🏷️ Niche : JDR tabletop, streaming, communauté RPG

  ✅ Keywords veille (EN) : tabletop rpg, dnd streaming, ttrpg...
  ❌ Mots exclus : video games, mobile gaming, MMORPG, casino...
  🌐 Domaines inclus : dndbeyond.com, roll20.com, reddit.com/r/rpg...
  🚫 Domaines exclus : (aucun)

  [Valider] [Corriger]
  ```

### Étape 8 — Catégories (auto-générées)
- Générées automatiquement depuis le profil enrichi
- Keywords EN uniquement pour la collecte
- Keywords FR pour l'affichage
- Engines ignorés (SearXNG utilise google/bing/duckduckgo fixe)
- L'utilisateur peut ajouter/supprimer/modifier

### Étape 9 — Persona
- Comme maintenant (ton, identité, style)
- Règle par défaut ajoutée : "N'utilise PAS d'emojis sauf demande explicite"
- Les messages de preview du persona passent par `dmSplit` (fix troncation)

### Étape 10 — Plateformes & Schedule
- Inchangé

### Étape 11 — Sources (Reddit, YouTube, RSS, SearXNG)
- Inchangé (auto-populate déjà en place)

### Étape 12 — Dry run & Confirmation
- Inchangé

---

## 4. Prefilter renforcé

L'onboarding enrichi produit plus de données pour le prefilter :

### Avant (V1)
- ~10 negative keywords
- exclude_domains vide
- Filtre URL basique

### Après (V2)
- **20-30 negative keywords** (générés par le LLM onboarding)
- **Include domains** utilisés comme bonus de score
- **Concurrents** identifiés → articles les mentionnant = pertinents
- **Filtre de pertinence par titre** : si le titre ne contient aucun keyword EN
  des catégories NI aucun terme du profil → rejeté avant scoring LLM

### Nouveau filtre titre (prefilter étape 5)

```typescript
function filterTitleRelevance(
  articles: RawArticle[],
  profile: InstanceProfile,
  categories: VeilleCategory[],
): RawArticle[] {
  const allKeywords = new Set<string>();
  for (const cat of categories) {
    for (const kw of cat.keywords.en) allKeywords.add(kw.toLowerCase());
  }
  // Ajouter les termes du profil
  for (const term of profile.projectNiche.split(/\s+/)) {
    if (term.length > 3) allKeywords.add(term.toLowerCase());
  }

  return articles.filter((a) => {
    const lower = a.title.toLowerCase();
    for (const kw of allKeywords) {
      if (lower.includes(kw)) return true;
    }
    return false;
  });
}
```

---

## 5. Cooldown rate limit

- Cooldown entre batches : **65 secondes** (au lieu de 30)
- Garantit qu'on ne dépasse jamais la fenêtre de 1 minute d'Anthropic
- Avec ~5-6 batches (après prefilter renforcé) : ~6 min de scoring total

---

## 6. Pas d'emojis par défaut

### Dans le persona builder (`persona.ts`)

Ajouter à la fin du persona généré :
```
RÈGLE IMPORTANTE : N'utilise JAMAIS d'emojis dans tes posts, légendes ou scripts
sauf si l'utilisateur te le demande explicitement.
```

### Dans les suggestions/scripts

Vérifier que les prompts de `suggestions.ts` et `scripts.ts` n'encouragent pas
l'utilisation d'emojis.

---

## 7. Messages tronqués

### Vérification

Tous les envois DM dans `orchestrator.ts` passent déjà par `dmSplit()`.
Le problème restant est dans la **génération de persona** (`persona.ts`) où
le contenu peut dépasser 3800 chars.

### Fix

Dans `persona.ts`, les fonctions `generatePersonaSection()` et
`buildPersonaPreview()` doivent construire des payloads V2 qui seront
naturellement splittés par `dmSplit()`. Vérifier que le contenu n'est pas
tronqué manuellement avec `.slice(0, 1500)` — laisser le splitter faire
son travail.

---

## 8. Ordre d'implémentation

1. Smart model routing (`llm-factory.ts`)
2. Cooldown 65s + prefilter titre (`veille.ts`, `prefilter.ts`)
3. Site scraping avec Readability + fallback web_search
4. Confidence loop (étapes 6-7 onboarding)
5. No-emoji default + fix troncation persona
6. Mise à jour orchestrator avec le nouveau flow
7. Tests

---

## 9. Challenges

### C1 : Et si le LLM onboarding (Opus) rate limite pendant les questions ?
→ Le modèle onboarding n'est utilisé que pour 20-30 questions, chacune courte.
  Avec Opus, c'est ~500 tokens/question × 30 = ~15k tokens total.
  Bien en dessous des limites. Pas de risque.

### C2 : Et si Readability ne parse rien (SPA, paywall) ?
→ Fallback LLM `web_search` tool qui cherche des infos sur le site
  via des résultats tiers (avis, mentions, descriptions).
  Si ça échoue aussi → le LLM posera plus de questions à l'utilisateur.

### C3 : 20-30 questions c'est long — l'utilisateur peut abandonner ?
→ La barre de progression (%) motive. Et le LLM ne pose que des questions
  pertinentes — pas de questions génériques. Si le site a été bien scrapé,
  le LLM aura déjà 60-70% de confiance → ~10 questions seulement.

### C4 : Le scoring avec Haiku est-il assez bon ?
→ Haiku est suffisant pour un score 0-10 avec des instructions claires.
  Le scoring prompt inclut les calibrated examples + le profil enrichi.
  La qualité du scoring dépend plus du prompt que du modèle.
  Si les résultats sont mauvais, on peut remonter à Sonnet pour le scoring.

### C5 : Le smart routing fonctionne-t-il avec les providers OpenAI-compatible ?
→ Oui. Les providers comme Mistral, DeepSeek, Groq ont aussi des modèles
  de tailles différentes. On définit la table de routage pour chaque provider
  avec ses modèles disponibles (petit/moyen/gros).

### C6 : Les sessions wizard ont un timeout de 2h — 30 questions + scraping ça tient ?
→ À vérifier. Si l'utilisateur prend son temps entre les questions, la session
  peut expirer. Solution : augmenter le timeout à 4h ou rafraîchir le timestamp
  à chaque interaction.

### C7 : Le format libre des questions — comment parser la réponse ?
→ L'utilisateur répond en texte dans le DM. Le handler de messages détecte
  le step actuel (confidence_loop) et envoie le texte au LLM qui analyse
  la réponse + génère la question suivante. Pas de parsing côté code.

### C8 : Que se passe-t-il si le LLM est trop confiant trop vite (80% en 3 questions) ?
→ On impose un minimum de 5 questions avant de permettre la validation,
  même si la confiance est à 80%+. Ça garantit un profil minimum viable.

### C9 : Les negative keywords générés par le LLM — en quelle langue ?
→ Anglais ET français. Le prefilter doit filtrer les deux puisque les titres
  peuvent être dans les deux langues (SearXNG retourne parfois du FR malgré
  la recherche EN, et les RSS sont souvent FR).
