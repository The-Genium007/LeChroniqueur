# Architecture — tumulte-bot

## Vue d'ensemble

```
┌─────────────────────────────────────────────────────────┐
│                    docker-compose                        │
│                                                          │
│  ┌─────────────┐    ┌──────────────┐                    │
│  │  tumulte-bot │───▶│   searxng     │                   │
│  │  (Node.js)   │    │  (port 8080)  │                   │
│  └──────┬───────┘    └──────────────┘                    │
│         │                                                │
│         │  Volume: bot_data (SQLite + cache médias)      │
│         │  Volume: ./prompts (SKILL.md, CHRONIQUEUR.md)  │
└─────────────────────────────────────────────────────────┘
           │              │              │
           ▼              ▼              ▼
     Discord API    Anthropic API    Google AI API
                                         │
                          ┌──────────────┘
                          ▼
                    Postiz API
                    (postiz.tumulte.app)
```

## Principes architecturaux

### 1. Services isolés

Chaque client API externe (`services/`) est un module isolé avec :
- Un schéma Zod pour valider les réponses
- Une interface TypeScript claire (entrées/sorties)
- Aucune dépendance vers Discord ou les handlers

### 2. Handlers comme orchestrateurs

Les `handlers/` connectent les modules entre eux. Un handler :
- Reçoit un événement (cron, interaction Discord, message)
- Appelle les services nécessaires dans l'ordre
- Formate le résultat via `message-builder`
- Envoie dans le bon channel Discord
- Enregistre en base

### 3. Message Builder réutilisable

Toute sortie Discord passe par `discord/message-builder.ts`.
Jamais de construction d'embed en ligne dans un handler.

### 4. Base de données comme source de vérité

Tout ce que le bot produit est stocké en SQLite :
- Articles de veille
- Suggestions
- Publications
- Feedbacks
- Métriques de coûts
- Historique cron

### 5. Économie de tokens

Le bot fait le maximum AVANT d'appeler Claude :
- SearXNG collecte (gratuit)
- Déduplication côté bot (gratuit)
- Filtrage par date côté bot (gratuit)
- Seuls les titres + snippets vont à Claude

## Flux de données principaux

### Veille quotidienne

```
Cron 7h → PreferenceLearner.recalculate()
        → Collector.collect(categories)
        → Analyzer.analyze(articles, preferences)
        → MessageBuilder.veilleDigest(analyzed)
        → Discord #veille (embed résumé)
        → Discord #veille (thread avec détails + boutons 👍/👎)
        → Database.saveArticles(analyzed)
```

### Suggestion de contenu

```
Cron 8h ou bouton "Transformer" depuis veille
        → Anthropic.generateSuggestion(article, persona)
        → MessageBuilder.suggestion(content)
        → Discord #idées (embed + boutons Go/Modifier/Skip/Plus tard)
        → Database.saveSuggestion(content)
```

### Validation et publication

```
Bouton Go dans #idées
        → Anthropic.generateScript(suggestion, persona)
        → MessageBuilder.production(script)
        → Discord #production (embed + boutons Valider/Retoucher)

Bouton Valider dans #production
        → MessageBuilder.publication(final)
        → Discord #publication (embed + boutons Publier/Reporter)

Bouton Publier dans #publication
        → Postiz.schedule(content, media, date)
        → Database.savePublication(scheduled)
        → Discord #logs (confirmation)
```

### Recherche interne

```
/search <query> dans #admin
        → SearchEngine.search(query)
        → MessageBuilder.searchResults(results)
        → Discord #admin (embed paginé)
```

## ADR (Architecture Decision Records)

| # | Décision | Raison |
|---|----------|--------|
| 001 | Pas de connexion GitHub directe | Bot existant forward les issues |
| 002 | Postiz comme hub médias | Déjà installé, API disponible |
| 003 | Montage vidéo manuel (CapCut) | Créatif, nécessite un œil humain |
| 004 | Chroniqueur avec capuche | Cohérence IA + mystère |
| 005 | Segments Veo 6-8s | Durées natives Veo 3.1 |
| 006 | Tout dans Discord | Un seul point d'entrée |
| 007 | Bot standalone, pas OpenClaw | Components V2 non supportés par OpenClaw |
| 008 | SearXNG au lieu de Brave/web_search | Gratuit, ciblable, économise tokens |
| 009 | SQLite + FTS5, pas Elasticsearch | Suffisant pour le volume |
| 010 | Feedback injecté dans prompt Claude | Pas de ML complexe |
| 011 | Métriques manuelles pour le MVP | API Postiz ne les expose pas |
| 012 | TypeScript strict | Robustesse structures de données |
| 013 | Branche unique main | Un seul développeur |
