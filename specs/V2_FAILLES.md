# Spec V2 — Failles identifiées et mitigations

Audit exhaustif de toutes les failles détectées pendant le brainstorming.

## Config

| # | Faille | Mitigation |
|---|--------|------------|
| 1 | Persona chargé une seule fois (cache stale) | PersonaLoader centralisé avec invalidation |
| 2 | Pas de validation du persona.md | Taille min 500 chars / max 15 KB. Sanity check Claude optionnel |
| 3 | Pas de versioning de la config | Table `config_history` avec timestamp + who + old/new |
| 4 | Pas de rollback de config | Bouton [Annuler] dans dashboard + historique |
| 5 | Conflit YAML vs DB overrides | Plus de YAML. DB gagne toujours. Bouton [Reset aux défauts] |
| 6 | Certains params nécessitent restart | Classification hot/warm/cold reload |

## Dashboard

| # | Faille | Mitigation |
|---|--------|------------|
| 10 | Message dashboard = SPOF | Recréation auto au boot si supprimé |
| 11 | Race condition multi-admin | Sous-pages en éphémère (chacun voit la sienne) |
| 12 | Stats du dashboard périmées | Auto-refresh après chaque job cron |
| 13 | Modification persona difficile dans Discord | Mix : upload fichier + conversation IA + Modal par section |
| 14 | Résultats recherche périmés après 12h | Consultation-only, pas d'action dangereuse sur les résultats |

## Components V2

| # | Faille | Mitigation |
|---|--------|------------|
| 7 | discord.js upgrade breaking changes | 14.18 → 14.25 est semver minor, rétrocompatible. Tester quand même |
| 8 | Limite 40 composants serrée | Budget 30/40 par page. Comptage préalable de chaque page |
| 9 | Pas de fallback si V2 échoue | component-builder-v2 primary, message-builder V1 fallback |

## Onboarding

| # | Faille | Mitigation |
|---|--------|------------|
| 15 | Wizard consomme des tokens | Compteur affiché, max 20 itérations, Haiku pour la validation |
| 16 | Wizard crash = perte de progression | Sauvegarde état en DB à chaque étape + reprise |
| 17 | Catégories IA inutiles / bruyantes | Dry-run SearXNG pour montrer les résultats réels |
| 18 | Persona IA peut dévier du brief | Validation section par section (pas en bloc) |

## Multi-instance

| # | Faille | Mitigation |
|---|--------|------------|
| 19 | Création channels peut échouer | Validation préalable (permissions, limites). Rollback si échec |
| 20 | Admin supprime un channel manuellement | Event channelDelete → alerte + bouton [Recréer] |
| 21 | Clés API partagées mais budget per-instance | Budget tracké per-instance. Queue Anthropic avec fair scheduling |
| 22 | DMs sans contexte d'instance | Instance ID embedé dans les custom IDs des boutons DM |
| 23 | Pas de mode maintenance/pause | Bouton [Pause] dans dashboard. Suspend crons, garde les boutons |
| 24 | Pas de monitoring de santé | Section Santé dans le dashboard accueil (ping services) |
| 25 | Pas d'export/backup | Bouton [Export] dans dashboard Config (config + persona + DB) |

## Installation / Déploiement

| # | Faille | Mitigation |
|---|--------|------------|
| 26 | Install = trop de fichiers/étapes | Script `curl \| bash` unique qui pose 3 questions |
| 27 | POSTIZ_JWT_SECRET non généré | Généré automatiquement par install.sh |
| 28 | Bot démarre avant que Postiz soit ready | healthcheck + depends_on condition: service_healthy |
| 29 | Pas de notification de mise à jour | Check GitHub Releases au boot + alerte dashboard |
| 30 | TikTok bloqué sans HTTPS | Détection protocole, TikTok non proposé si HTTP |
| 31 | Specs mentionnent "Lucas" en dur | Nettoyé — owner = celui qui a onboardé |
| 32 | Crons simultanés multi-instance | Décalage automatique de 3 minutes par instance |

## Sécurité

| # | Faille | Mitigation |
|---|--------|------------|
| S1 | Docker socket = accès root | Docker socket proxy (Tecnativa) limité à restart |
| S2 | Clés API en clair en DB | AES-256-GCM avec MASTER_ENCRYPTION_KEY |
| S3 | Clés API collectées en DM | DMs sont chiffrés end-to-end par Discord. Jamais dans un channel public |
| S4 | .env lisible sur le filesystem | chmod 600 dans install.sh. 3 vars seulement (pas de clés API utilisateur) |
| S5 | postiz-social.env contient des clés en clair | Fichier dans un volume Docker, pas accessible de l'extérieur. chmod 600 |
