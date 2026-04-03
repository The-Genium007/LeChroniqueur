# Spec — AI Providers (Multi-provider LLM + Image)

## Vue d'ensemble

Permettre le choix du provider LLM (texte) pendant l'onboarding, avec support des providers natifs et des gateways OpenAI-compatibles. Le choix est **global** (s'applique à toutes les instances). Le provider image reste Google Imagen, le provider vidéo reste Google Veo.

## Providers supportés

### LLM (texte) — Providers natifs

| Provider | SDK | Modèles |
|---|---|---|
| **Anthropic** | `@anthropic-ai/sdk` | Opus 4.6, Sonnet 4.6, Haiku 4.5 |
| **OpenAI** | `openai` | GPT-5.4, GPT-5.2, GPT-5 Mini, GPT-5 Nano |
| **Google** | `@google/generative-ai` | Gemini 3.1 Pro, Gemini 2.5 Pro, Gemini 2.5 Flash |

### LLM (texte) — Providers OpenAI-compatibles

Utilisent le SDK `openai` avec un `baseURL` custom :

| Provider | Base URL | Modèles |
|---|---|---|
| **Mistral** | `https://api.mistral.ai/v1/` | Large 3, Small 4, Devstral 2 |
| **DeepSeek** | `https://api.deepseek.com/v1/` | V3, R1 |
| **xAI (Grok)** | `https://api.x.ai/v1/` | Grok 3, Grok 3 Mini |
| **Groq** | `https://api.groq.com/openai/v1/` | Llama 4, Mixtral |
| **Together** | `https://api.together.xyz/v1/` | 200+ modèles open-source |
| **OpenRouter** | `https://openrouter.ai/api/v1/` | 200+ modèles multi-provider |
| **LiteLLM** | Custom (self-hosted) | 100+ modèles, configurable |
| **Custom** | Saisie libre | Tout endpoint OpenAI-compatible |

### Image — Provider unique

| Provider | SDK | Modèles |
|---|---|---|
| **Google Imagen** | `@google/genai` | Imagen 4 (inchangé) |

### Vidéo — Provider unique

| Provider | SDK | Modèles |
|---|---|---|
| **Google Veo** | `@google/genai` | Veo 3.1 (inchangé) |

## Architecture — 3 modes de client LLM

```
                    ┌─────────────────────┐
                    │   LLM Factory       │
                    │   (llm-factory.ts)   │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
     ┌─────────────┐  ┌─────────────┐  ┌──────────────┐
     │  Anthropic   │  │   OpenAI    │  │  OpenAI-     │
     │  natif       │  │   natif     │  │  compatible  │
     │ (@anthropic) │  │  (openai)   │  │  (openai +   │
     │              │  │             │  │   baseURL)   │
     └─────────────┘  └─────────────┘  └──────────────┘
```

Un seul point d'entrée `complete()` qui route vers le bon client selon la config globale.

## Flow onboarding — Sélection du provider

### Step 1 : Choix du provider (Select Menu)

```
┌──────────────────────────────────────┐
│ 🤖 Choisis ton provider IA          │
│                                      │
│ [Select Menu — Providers]            │
│  ├── Anthropic (Claude)              │
│  ├── OpenAI (GPT)                    │
│  ├── Google (Gemini)                 │
│  ├── Mistral                         │
│  ├── DeepSeek                        │
│  ├── xAI (Grok)                      │
│  ├── Groq                            │
│  ├── Together AI                     │
│  ├── OpenRouter (multi-provider)     │
│  ├── LiteLLM (self-hosted)           │
│  └── Custom (OpenAI-compatible)      │
└──────────────────────────────────────┘
```

### Step 2 : Choix du modèle (Select Menu filtré par provider)

Le select menu affiche les modèles du provider choisi :

**Anthropic :**
- Claude Opus 4.6 (`claude-opus-4-6`)
- Claude Sonnet 4.6 (`claude-sonnet-4-6`)
- Claude Haiku 4.5 (`claude-haiku-4-5-20251001`)

**OpenAI :**
- GPT-5.4 (`gpt-5-4`)
- GPT-5.2 (`gpt-5-2`)
- GPT-5 Mini (`gpt-5-mini`)
- GPT-5 Nano (`gpt-5-nano`)

**Google :**
- Gemini 3.1 Pro (`gemini-3.1-pro-preview`)
- Gemini 2.5 Pro (`gemini-2.5-pro`)
- Gemini 2.5 Flash (`gemini-2.5-flash`)

**Mistral :**
- Mistral Large 3 (`mistral-large-latest`)
- Mistral Small 4 (`mistral-small-latest`)
- Devstral 2 (`devstral-latest`)

**DeepSeek :**
- DeepSeek V3 (`deepseek-chat`)
- DeepSeek R1 (`deepseek-reasoner`)

**xAI :**
- Grok 3 (`grok-3-beta`)
- Grok 3 Mini (`grok-3-mini-beta`)

**Groq / Together / OpenRouter :**
- Input libre (model ID à taper dans un modal)

**Custom :**
- Input libre (baseURL + model ID + clé API)

### Step 3 : Clé API (Modal)

Modal avec les champs adaptés au provider :

**Providers natifs (Anthropic, OpenAI, Google) :**
- 1 champ : Clé API

**Providers OpenAI-compatibles (Mistral, DeepSeek, xAI, Groq, Together) :**
- 1 champ : Clé API
- (Base URL pré-rempli, non modifiable)

**Gateways (OpenRouter, LiteLLM) :**
- 1 champ : Clé API
- 1 champ : Base URL (pré-rempli mais modifiable)

**Custom :**
- 1 champ : Base URL
- 1 champ : Clé API
- 1 champ : Model ID

### Step 4 : Validation

Validation par **mini appel API** (la plus fiable) :
- Envoie `"ping"` avec `max_tokens: 10`
- Si succès → clé valide
- Si échec → message d'erreur + retry

## Stockage

### Secrets globaux (DB globale `bot.db`)

Les secrets LLM sont stockés dans `instance_secrets` avec l'instance ID de la première instance, mais appliqués globalement.

Nouvelles `key_type` :
- `llm_provider` — ID du provider (ex: `anthropic`, `openai`, `mistral`, `openrouter`, `custom`)
- `llm_model` — Model ID (ex: `claude-sonnet-4-6`, `gpt-5-mini`)
- `llm_api_key` — Clé API du provider LLM
- `llm_base_url` — Base URL (pour les OpenAI-compatibles)

### Config globale en mémoire

```typescript
interface LlmProviderConfig {
  readonly provider: string;       // 'anthropic' | 'openai' | 'google' | 'mistral' | ...
  readonly model: string;          // model ID
  readonly apiKey: string;         // API key
  readonly baseUrl?: string;       // for OpenAI-compatible providers
  readonly clientType: 'anthropic' | 'openai' | 'openai_compatible';
}
```

## LLM Factory — `src/services/llm-factory.ts`

### Interface unifiée

```typescript
interface LlmResponse {
  readonly text: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly provider: string;
  readonly model: string;
}

async function complete(
  systemPrompt: string,
  userMessage: string,
  options?: { maxTokens?: number; temperature?: number },
): Promise<LlmResponse>;
```

### Routing interne

```typescript
function getClientType(provider: string): 'anthropic' | 'openai' | 'openai_compatible' {
  switch (provider) {
    case 'anthropic': return 'anthropic';
    case 'openai': return 'openai';
    case 'google': return 'openai'; // Gemini via OpenAI-compatible endpoint
    default: return 'openai_compatible';
  }
}
```

**Note Google** : Gemini peut être appelé via l'endpoint OpenAI-compatible de Google (`https://generativelanguage.googleapis.com/v1beta/openai/`), ce qui évite un 3ème SDK pour le texte.

### Initialisation

Le factory est initialisé une fois au boot depuis les secrets globaux. Si aucun secret LLM n'existe (bot fraîchement installé), il tombe en mode onboarding.

## Budget tracker — Adaptation multi-provider

### Tarification par provider

```typescript
interface ProviderPricing {
  readonly inputCostPerMillion: number;   // cents
  readonly outputCostPerMillion: number;  // cents
}

const PROVIDER_PRICING: Record<string, Record<string, ProviderPricing>> = {
  anthropic: {
    'claude-opus-4-6': { inputCostPerMillion: 500, outputCostPerMillion: 2500 },
    'claude-sonnet-4-6': { inputCostPerMillion: 300, outputCostPerMillion: 1500 },
    'claude-haiku-4-5-20251001': { inputCostPerMillion: 100, outputCostPerMillion: 500 },
  },
  openai: {
    'gpt-5-4': { inputCostPerMillion: 60, outputCostPerMillion: 240 },
    'gpt-5-2': { inputCostPerMillion: 175, outputCostPerMillion: 1400 },
    'gpt-5-mini': { inputCostPerMillion: 25, outputCostPerMillion: 200 },
    'gpt-5-nano': { inputCostPerMillion: 5, outputCostPerMillion: 40 },
  },
  mistral: {
    'mistral-large-latest': { inputCostPerMillion: 200, outputCostPerMillion: 600 },
    'mistral-small-latest': { inputCostPerMillion: 10, outputCostPerMillion: 30 },
  },
  deepseek: {
    'deepseek-chat': { inputCostPerMillion: 27, outputCostPerMillion: 110 },
    'deepseek-reasoner': { inputCostPerMillion: 55, outputCostPerMillion: 219 },
  },
  // ... autres providers
};
```

### Fonction de coût unifiée

```typescript
function computeLlmCostCents(
  provider: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
): number;
```

Remplace `computeAnthropicCostCents()`. Si le modèle n'est pas dans la table de tarification (ex: gateway custom), utilise un coût estimé par défaut.

### Colonne metrics

La table `metrics` existante garde `anthropic_cost_cents` pour la rétrocompatibilité. On ajoute une colonne :

```sql
ALTER TABLE metrics ADD COLUMN llm_cost_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE metrics ADD COLUMN llm_provider TEXT;
ALTER TABLE metrics ADD COLUMN llm_model TEXT;
```

`llm_cost_cents` est la source de vérité pour le budget. `anthropic_cost_cents` reste mis à jour en parallèle pour la rétrocompatibilité.

## Modifications aux modules existants

### `src/services/anthropic.ts`

`complete()` et `completeWithSearch()` sont conservés mais deviennent des wrappers qui délèguent au factory :
- Si le provider global est `anthropic` → utilise le SDK natif (comportement actuel)
- Sinon → route via `llm-factory.ts`

### `src/onboarding/api-keys.ts`

Ajouter :
- `validateLlmKey(provider, apiKey, baseUrl?, model?)` — validation par mini appel adapté au provider
- `validateOpenAiKey(apiKey)` — test via OpenAI SDK
- `validateOpenAiCompatibleKey(apiKey, baseUrl, model)` — test via OpenAI SDK + baseURL

### `src/onboarding/wizard/orchestrator.ts`

Ajouter les steps de sélection provider **avant** la collecte de clé Anthropic existante :
1. Select provider
2. Select model
3. Enter API key (+ base URL si nécessaire)
4. Validation

### `src/budget/tracker.ts`

- `computeLlmCostCents()` remplace `computeAnthropicCostCents()` avec routing par provider
- `recordLlmUsage()` remplace `recordAnthropicUsage()`
- Les fonctions existantes restent pour rétrocompatibilité

### `src/core/config.ts`

Ajout env vars legacy :
```
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-4-6
LLM_API_KEY=sk-ant-...
LLM_BASE_URL=
```

## Nouveau module : `src/services/llm-factory.ts`

```
src/services/
├── llm-factory.ts        # Factory LLM multi-provider
├── llm-providers.ts       # Registry des providers, modèles, pricing
├── anthropic.ts           # Conservé, wrapper vers factory
├── google-ai.ts           # Inchangé (image + vidéo seulement)
├── postiz.ts              # Inchangé
└── ...
```

## Custom IDs Discord — Onboarding provider

```
onboard:llm:provider:{providerId}     → Provider sélectionné
onboard:llm:model:{modelId}           → Modèle sélectionné
onboard:llm:key                       → Modal clé API
onboard:llm:validate                  → Lancer la validation
onboard:llm:change                    → Changer de provider (retour step 1)
```

## Modules critiques (tests obligatoires)

- `services/llm-factory.ts` — routing par provider, instanciation client
- `services/llm-providers.ts` — registry complet, pricing
- `budget/tracker.ts` — calcul coût multi-provider
- `onboarding/api-keys.ts` — validation multi-provider

## ADR

| # | Décision | Raison |
|---|---|---|
| 023 | 2 SDK seulement (Anthropic + OpenAI) | Couvre ~95% des providers, maintenance réduite |
| 024 | Gemini via endpoint OpenAI-compatible | Évite un 3ème SDK pour le texte |
| 025 | Choix global, pas par instance | Simplification UX, 1 seule clé à gérer |
| 026 | Validation par mini appel API | Plus fiable que check de format de clé |
| 027 | Groupement provider → modèle dans l'UI | Respecte la limite 25 options du select Discord |
| 028 | Tarification hardcodée avec fallback | Les prix changent rarement, mise à jour manuelle acceptable |
| 029 | Rétrocompatibilité metrics Anthropic | Pas de migration destructive, données historiques préservées |
