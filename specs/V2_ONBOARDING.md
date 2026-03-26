# Spec V2 — Onboarding et Wizard IA

## Déclenchement

### Première fois sur un serveur

Event `guildCreate` → le bot envoie un DM au propriétaire du serveur avec un bouton [Créer ma première instance].

### Instances suivantes (multi-instance)

Depuis le dashboard d'une instance existante, bouton [Nouvelle instance] dans la page Config. Ce bouton relance le wizard complet en DM (étapes 1-13). Les clés API déjà configurées sont pré-remplies (l'admin peut les réutiliser ou en fournir de nouvelles).

## Flow d'onboarding complet

```
1. Collecte clé Anthropic (DM)         — Modal → validation → chiffrement DB
2. Collecte clé Google AI (DM)         — Modal → validation → chiffrement DB (optionnel)
3. Configuration Postiz (DM)           — Guide réseaux sociaux → restart Postiz
4. Connexion comptes dans Postiz       — Lien vers l'UI web → vérification
5. Collecte clé API Postiz (DM)        — Modal → validation → chiffrement DB
6. Wizard IA : description du projet   — Texte libre dans le DM
7. Wizard IA : catégories de veille    — Claude génère → user valide → dry-run SearXNG
8. Wizard IA : persona                 — Claude génère section par section → user valide
9. Configuration plateforme/schedule   — Select menus + Modals
10. Résumé + confirmation              — Embed récapitulatif → bouton [Confirmer]
11. Création infrastructure Discord    — Catégorie + 7 channels + permissions
12. Initialisation DB + dashboard      — DB instance créée, dashboard posté
13. Première veille automatique        — Lancée immédiatement
```

## Étape 1-2 : Clés API IA

### Validation Anthropic

```typescript
async function validateAnthropicKey(apiKey: string): Promise<boolean> {
  const client = new Anthropic({ apiKey });
  await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'ping' }],
  });
  return true;  // Si pas d'exception
}
```

Coût de la validation : ~$0.0001 (10 tokens Haiku).

### Validation Google AI

Appel `models.list()` pour vérifier que la clé est valide.

## Étape 3 : Configuration Postiz — Réseaux sociaux

### Mécanisme technique

Le bot écrit les clés API réseaux sociaux dans `postiz-social.env` (volume partagé) puis restart le container Postiz via le Docker socket proxy.

```typescript
async function writePostizSocialEnv(key: string, value: string): Promise<void> {
  // Lire le fichier actuel
  // Mettre à jour ou ajouter la variable
  // Écrire le fichier
}

async function restartPostiz(): Promise<void> {
  // Appel HTTP au docker-socket-proxy
  // POST /containers/postiz/restart
  // Attendre le healthcheck
}
```

### Détection HTTP vs HTTPS

Si `POSTIZ_URL` commence par `http://` (pas HTTPS) :
- TikTok n'est PAS proposé (redirect URI doit être HTTPS)
- Message explicatif : "TikTok nécessite HTTPS. Tu pourras l'ajouter plus tard."

### Redirect URIs pour chaque plateforme

Affichées dans le guide étape par étape :

| Plateforme | Redirect URI |
|------------|-------------|
| TikTok | `{POSTIZ_URL}/integrations/social/tiktok` |
| Instagram | `{POSTIZ_URL}/integrations/social/instagram` |
| X/Twitter | `{POSTIZ_URL}/integrations/social/x` |
| LinkedIn | `{POSTIZ_URL}/integrations/social/linkedin` |

### Notes spécifiques par plateforme

- **X/Twitter** : type d'app = "Native App" (pas Web App, pas Bot)
- **TikTok** : scopes requis = `user.info.basic`, `video.create`, `video.upload`, `video.publish`
- **Instagram** : nécessite un compte Business ou Creator
- **LinkedIn** : permissions Advertising API recommandées pour le refresh token

## Étape 4 : Connexion comptes dans Postiz

Manuelle — l'utilisateur doit aller dans le navigateur.

Le bot affiche le lien vers `{POSTIZ_URL}` et les instructions :
1. Créer un compte
2. Settings → Integrations → Connect sur chaque plateforme

Le bouton [Vérifier les intégrations] appelle `GET {POSTIZ_INTERNAL_URL}/public/v1/integrations` et affiche les plateformes connectées.

## Étapes 6-8 : Wizard IA

### State machine

```typescript
type WizardStep =
  | 'describe_project'
  | 'review_categories'
  | 'refine_categories'
  | 'dryrun_searxng'
  | 'choose_persona_tone'
  | 'review_persona_identity'
  | 'review_persona_tone'
  | 'review_persona_vocabulary'
  | 'review_persona_art_direction'
  | 'review_persona_examples'
  | 'configure_platforms'
  | 'configure_schedule'
  | 'confirm'

interface WizardSession {
  id: string;
  guildId: string;
  userId: string;
  step: WizardStep;
  data: Partial<WizardData>;
  conversationHistory: Array<{ role: string; content: string }>;
  tokensUsed: number;
  iterationCount: number;
  expiresAt: Date;     // 2h
  createdAt: Date;
}
```

Sauvegardé en DB globale (`wizard_sessions` table) à chaque étape.

### Limites

- Max 20 itérations par session (au-delà : finaliser manuellement ou recommencer)
- Compteur de tokens affiché à chaque étape
- Session expire après 2h d'inactivité
- Reprise : au boot, si une session existe, proposer "Reprendre (étape 5/9) ou recommencer ?"

### Dry-run SearXNG

Après la génération des catégories par Claude, pour chaque catégorie :
1. Prendre 1-2 keywords
2. Lancer une vraie requête SearXNG
3. Montrer les 3 premiers résultats à l'utilisateur
4. "Voici ce que cette catégorie ramènerait. Pertinent ?"

Coût : 0 tokens (SearXNG est gratuit). Valeur : énorme (évite les catégories qui donnent du bruit).

### Persona section par section

Claude génère le persona en 5 sections distinctes. L'utilisateur valide chaque section :

1. **Identité** — nom, handle, plateformes, site
2. **Ton** — tutoiement/vouvoiement, humour, traits de personnalité avec %
3. **Vocabulaire** — expressions récurrentes, mots interdits, emojis autorisés/interdits
4. **Direction artistique** — palette de couleurs, règles visuelles
5. **Exemples de voix** — 3-4 exemples de posts dans le ton

Chaque section peut être : validée, régénérée, ou modifiée (Modal pour les sections courtes, conversation IA pour les sections longues).

## Étape 11 : Création infrastructure Discord

### Validation préalable

Avant de créer quoi que ce soit :
- Vérifier `ManageChannels` permission
- Vérifier `ManageRoles` permission
- Compter les channels existants (limite 500)
- Compter les catégories existantes (limite 50)

Si une vérification échoue → message d'erreur clair, pas de création partielle.

### Création atomique

Si la création d'un channel échoue en cours de route → rollback (supprimer la catégorie et les channels déjà créés).

### Permissions des channels

Tous les channels héritent des permissions de la catégorie :
- `@everyone` : ViewChannel = DENY
- Admin (celui qui onboard) : ViewChannel = ALLOW, SendMessages = ALLOW
- Le bot : ViewChannel + SendMessages + ManageMessages + EmbedLinks + AttachFiles = ALLOW

### Messages permanents

Après la création des channels :
1. Poster le dashboard (accueil) dans `#dashboard` → stocker le message ID
2. Poster l'interface de recherche dans `#recherche` → stocker le message ID

## Multi-instance : décalage des crons

À la création de l'instance N, les crons sont décalés de `(N-1) * 3` minutes :

| Instance | Veille | Suggestions | Rapport |
|----------|--------|-------------|---------|
| 1 | 0 7 * * * | 0 8 * * * | 0 21 * * 0 |
| 2 | 3 7 * * * | 3 8 * * * | 3 21 * * 0 |
| 3 | 6 7 * * * | 6 8 * * * | 6 21 * * 0 |

L'utilisateur peut toujours modifier les crons depuis le dashboard.
