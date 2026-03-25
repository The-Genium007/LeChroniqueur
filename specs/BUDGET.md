# Spec — Budget tracker et alertes

## Module

`src/budget/tracker.ts`

## Responsabilités

- Enregistrer les coûts après chaque appel API
- Calculer les totaux par période (jour, semaine, mois)
- Déclencher des alertes à 80% des seuils
- Couper les API payantes à 100% du budget mensuel

## Configuration

Via variables d'environnement (validées par Zod) :

```
BUDGET_DAILY_CENTS=300      # 3€
BUDGET_WEEKLY_CENTS=1500    # 15€
BUDGET_MONTHLY_CENTS=5000   # 50€
```

## Grille tarifaire (pour le calcul des coûts)

### Anthropic (Claude Sonnet 4.6)

| Métrique | Coût |
|----------|------|
| Input tokens | $3 / 1M tokens |
| Output tokens | $15 / 1M tokens |

### Google AI

| Service | Coût |
|---------|------|
| Imagen (par image) | ~$0.02-0.04 |
| Veo 3.1 (par seconde de vidéo) | ~$0.35-0.40 |

### SearXNG

Gratuit (auto-hébergé).

## Interface

```typescript
interface BudgetTracker {
  // Enregistre un appel Anthropic
  recordAnthropicUsage(tokensIn: number, tokensOut: number): void;

  // Enregistre une génération Google AI
  recordGoogleImageUsage(count: number): void;
  recordGoogleVideoUsage(seconds: number): void;

  // Enregistre une requête SearXNG (pour les stats, pas le coût)
  recordSearxngQuery(count: number): void;

  // Calcule les totaux
  getDailyTotal(): BudgetPeriod;
  getWeeklyTotal(): BudgetPeriod;
  getMonthlyTotal(): BudgetPeriod;

  // Vérifie les seuils et alerte si nécessaire
  checkThresholds(): BudgetAlert[];

  // Vérifie si les API payantes sont autorisées
  isApiAllowed(): boolean;
}

interface BudgetPeriod {
  anthropicCents: number;
  googleCents: number;
  totalCents: number;
  budgetCents: number;
  percentUsed: number;
}

interface BudgetAlert {
  period: 'daily' | 'weekly' | 'monthly';
  thresholdPercent: number;
  costCents: number;
  budgetCents: number;
}
```

## Flux après chaque appel API

```
1. Service API retourne usage (tokens, images, secondes)
2. BudgetTracker.record*(usage)
3. BudgetTracker.checkThresholds()
4. Si seuil franchi et pas déjà alerté aujourd'hui :
   a. Enregistrer l'alerte dans budget_alerts
   b. Envoyer un message dans #logs (jour/semaine) ou #admin (mois)
5. Si budget mensuel >= 100% :
   a. BudgetTracker.isApiAllowed() retourne false
   b. Les services Anthropic et Google refusent les appels
   c. Message dans #admin : "⛔ Budget mensuel atteint. API payantes suspendues."
```

## Format Discord — Commande /budget

```
💰 Budget — 25 mars 2026

📅 Aujourd'hui
  Anthropic : 0.45€ / 3.00€ (15%)
  Google AI : 0.00€ / 3.00€ (0%)
  Total : 0.45€ / 3.00€ (15%)
  ████░░░░░░░░░░░░ 15%

📅 Cette semaine
  Anthropic : 2.30€ / 15.00€ (15%)
  Google AI : 0.00€ / 15.00€ (0%)
  Total : 2.30€ / 15.00€ (15%)
  ████░░░░░░░░░░░░ 15%

📅 Ce mois
  Anthropic : 8.50€ / 50.00€ (17%)
  Google AI : 3.20€ / 50.00€ (6%)
  Total : 11.70€ / 50.00€ (23%)
  ████░░░░░░░░░░░░ 23%
```

## Format Discord — Alerte budget

```
⚠️ Alerte budget — Seuil 80% atteint

📅 Période : Semaine
💰 Dépensé : 12.40€ / 15.00€ (83%)
📊 Détail :
  Anthropic : 9.20€
  Google AI : 3.20€

████████████████░░░░ 83%

Prochaine action à 100% : suspension des API payantes.
```

## Calcul des coûts

```typescript
function computeAnthropicCostCents(tokensIn: number, tokensOut: number): number {
  const inputCost = (tokensIn / 1_000_000) * 300;  // $3 = 300 cents per 1M
  const outputCost = (tokensOut / 1_000_000) * 1500; // $15 = 1500 cents per 1M
  return Math.ceil(inputCost + outputCost);
}

function computeGoogleImageCostCents(count: number): number {
  return Math.ceil(count * 3); // ~$0.03 = 3 cents par image
}

function computeGoogleVideoCostCents(seconds: number): number {
  return Math.ceil(seconds * 38); // ~$0.38 = 38 cents par seconde
}
```
