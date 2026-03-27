# V2 Lifecycle — Gestion du cycle de vie des instances

> Spec couvrant : rotation clés API, comptes Postiz, suppression instance,
> import/export config, cleanup onboarding, bouton recommencer.

---

## 1. Rotation des clés API — `dash:config:apikeys`

### Contexte

Les clés API (Anthropic, Google AI) peuvent expirer ou être révoquées.
Actuellement, la seule façon de les changer est de recréer une instance.

### UX

1. **Config page** : bouton `dash:config:apikeys` "🔑 Clés API"
2. Reply éphémère avec deux boutons :
   - `dash:config:apikey:anthropic` → modal `config:modal:apikey:anthropic`
   - `dash:config:apikey:google` → modal `config:modal:apikey:google`
3. Chaque modal a un seul champ `api_key` (Short, required)
4. Validation via `validateAnthropicKey()` / `validateGoogleAiKey()` (existants)
5. Si OK → `storeInstanceSecret(globalDb, instanceId, keyType, key)`
6. Pour Anthropic : mettre à jour `process.env.ANTHROPIC_API_KEY`
7. Reply éphémère succès ou erreur

### Sécurité

- Instance owner uniquement (garde `requireInstanceOwner`)
- Clé validée AVANT stockage (appel API réel)
- Chiffrement AES-256-GCM existant conservé

---

## 2. Gestion comptes Postiz — `dash:config:postiz`

### Contexte

L'ajout/suppression de comptes sociaux se fait dans l'UI Postiz (OAuth).
Le bot offre un raccourci pour voir les comptes et un lien direct.

### UX

1. **Config page** : bouton `dash:config:postiz` "📤 Postiz"
2. Reply éphémère V2 container :
   - Liste des intégrations via `listIntegrations()` (existant)
   - Lien vers `POSTIZ_URL` pour gérer les comptes
   - Bouton `dash:config:postiz:refresh` "🔄 Rafraîchir"

### Dépendances

- `src/services/postiz.ts` — `listIntegrations()`
- `src/core/config.ts` — `POSTIZ_URL`

---

## 3. Suppression d'instance — `dash:config:delete`

### Contexte

Pas de moyen de supprimer proprement une instance (channels, DB, secrets).
L'archivage passif (`onGuildDelete`) ne nettoie pas.

### UX

1. **Config page** : bouton `dash:config:delete` "🗑️ Supprimer" (Danger style)
2. Reply éphémère : "⚠️ Confirmer la suppression de **{name}** ?"
   - Bouton `dash:config:delete:confirm` (Danger)
   - Bouton `dash:home` "Annuler" (Secondary)
3. Sur confirmation → séquence de cleanup

### Séquence de cleanup

```
1. Stopper le scheduler → schedulers.get(id)?.stop() + schedulers.delete(id)
2. Supprimer les 7 channels Discord → channel.delete()
3. Supprimer la catégorie Discord → guild.channels.fetch(categoryId).delete()
4. DELETE FROM instance_secrets WHERE instance_id = ?
5. DELETE FROM instance_channels WHERE instance_id = ?
6. UPDATE instances SET status = 'deleted' WHERE id = ?
7. Fermer la DB instance → db.close()
8. Supprimer le dossier → fs.rm('data/instances/{id}/', { recursive: true })
9. registry.unregister(id)
```

### `InstanceRegistry.unregister(id)`

Nouvelle méthode :
```typescript
unregister(id: string): void {
  const ctx = this.instances.get(id);
  if (ctx) {
    // Remove channel index entries
    for (const channel of Object.values(ctx.channels)) {
      if (channel) this.channelIndex.delete(channel.id);
    }
    this.instances.delete(id);
  }
}
```

---

## 4. Import de configuration

### Contexte

L'export JSON existe (`dash:config:export`) mais pas d'import.
Deux cas d'usage : ré-appliquer une config sur une instance existante,
ou démarrer une nouvelle instance à partir d'une config exportée.

### Format JSON (identique à l'export)

```json
{
  "instanceName": "string",
  "persona": "string",
  "categories": [{ "id", "label", "keywords_en", "keywords_fr", "engines", "max_age_hours", "is_active", "sort_order" }],
  "configOverrides": [{ "key", "value" }]
}
```

### Validation Zod

```typescript
const ImportSchema = z.object({
  instanceName: z.string().min(1),
  persona: z.string(),
  categories: z.array(z.object({
    id: z.string(), label: z.string(),
    keywords_en: z.string(), keywords_fr: z.string(),
    engines: z.string(), max_age_hours: z.number(),
    is_active: z.number(), sort_order: z.number(),
  })),
  configOverrides: z.array(z.object({ key: z.string(), value: z.string() })),
});
```

### 4a. Import depuis le Dashboard

**Bouton** : `dash:config:import` "📥 Import" dans la config page

**Flux** :
1. Reply éphémère : "📎 Envoie le fichier JSON exporté en message dans ce channel."
2. Écouter le prochain message de l'owner dans le channel dashboard avec attachment `.json` (timeout 2 min)
3. Parser + valider avec Zod
4. Appliquer en transaction :
   - `DELETE FROM veille_categories` puis INSERT les catégories importées
   - UPSERT persona
   - `DELETE FROM config_overrides` puis INSERT les overrides importés
5. Rafraîchir le dashboard
6. Reply éphémère succès ou erreur

### 4b. Import depuis l'Onboarding

**Bouton** : `onboard:import` dans le welcome message (à côté de "Commencer")

**Flux** :
1. Demander les clés API (même modals que l'onboarding normal)
2. Setup Postiz (même étape)
3. Demander le fichier JSON (message DM avec attachment)
4. Créer l'infra Discord (`createInfrastructure`)
5. Importer persona + categories + configOverrides
6. Poster dashboard + search interface
7. Enregistrer l'instance

---

## 5. Cleanup messages DM onboarding

### Contexte

Chaque step du wizard envoie un nouveau DM via `user.send()`.
Les messages s'accumulent sans aucun nettoyage.

### Tracking

- Capturer le `Message` retourné par chaque `user.send()` call
- Stocker les IDs dans `session.data._dmMessageIds: string[]`
- Sauvegarder la session après chaque ajout

### Helper (state-machine.ts)

```typescript
export function trackDmMessageId(session: WizardSession, messageId: string): void {
  const data = session.data as Record<string, unknown>;
  const ids = (data['_dmMessageIds'] as string[] | undefined) ?? [];
  ids.push(messageId);
  data['_dmMessageIds'] = ids;
}

export function getDmMessageIds(session: WizardSession): string[] {
  return ((session.data as Record<string, unknown>)['_dmMessageIds'] as string[]) ?? [];
}
```

### Cleanup (orchestrator.ts)

```typescript
async function cleanupWizardDMs(user: User, session: WizardSession): Promise<void> {
  const messageIds = getDmMessageIds(session);
  if (messageIds.length === 0) return;
  const dmChannel = await user.createDM();
  const deletePromises = messageIds.map((id) =>
    dmChannel.messages.delete(id).catch(() => {})
  );
  await Promise.allSettled(deletePromises);
}
```

### Points d'appel

1. `wizard:confirm` (succès) — après `deleteWizardSession`
2. `wizard:cancel` — avant `deleteWizardSession`
3. `onboard:start` avec session existante + "Recommencer" (Feature 6)

### Modification de `sendWizardDM`

```typescript
async function sendWizardDM(interaction, payload, session?): Promise<void> {
  const msg = await interaction.user.send({ ... });
  if (session) {
    trackDmMessageId(session, msg.id);
  }
  // ... deferUpdate
}
```

---

## 6. Recommencer propre

### Comportement actuel
`wizard:cancel` → supprime session DB → montre "❌ Annulé" → user doit re-cliquer `onboard:start`

### Nouveau comportement
`wizard:cancel` → cleanup DMs → supprime session → envoie automatiquement un nouveau welcome DM avec `onboard:start`

Le "Recommencer" dans le resume prompt suit le même flow.

---

## 7. Bugfix — Erreur persona silencieuse

### Problème

`generatePersonaSection()` dans `persona.ts` appelle `complete()` sans try/catch.
Si l'API échoue, l'erreur remonte non catchée. L'user ne voit rien.

### Fix

Wrapper try/catch dans `handleWizardNext()` et `handleWizardRedo()` autour du dispatch :

```typescript
try {
  // ... switch/case sur le step
} catch (error) {
  logger.error({ error, step: session.step }, 'Wizard step generation failed');
  payload = v2([buildContainer(getColor('error'), (c) => {
    c.addTextDisplayComponents(txt('## ⚠️ Erreur\nLa génération a échoué. Réessaie.'));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn('wizard:redo', 'Réessayer', ButtonStyle.Primary, '🔄'),
      btn('wizard:next', 'Passer', ButtonStyle.Secondary, '⏭️'),
    ));
  })]);
}
```

---

## Ordre d'implémentation

| Phase | Feature | Fichiers |
|-------|---------|----------|
| 1 | Bugfix persona | `orchestrator.ts` |
| 2 | Cleanup DMs (F5) | `orchestrator.ts`, `state-machine.ts` |
| 3 | Recommencer (F6) | `orchestrator.ts` |
| 4 | Rotation clés (F1) | `config.ts` (dashboard), `index.ts` |
| 5 | Comptes Postiz (F2) | `config.ts` (dashboard), `index.ts` |
| 6 | Suppression (F3) | `config.ts` (dashboard), `index.ts`, `instance-registry.ts` |
| 7 | Import dashboard (F4a) | `config.ts` (dashboard), `index.ts`, `import.ts` (new) |
| 8 | Import onboarding (F4b) | `welcome.ts`, `orchestrator.ts`, `import.ts` |

---

## Custom IDs ajoutés

| Custom ID | Type | Feature |
|-----------|------|---------|
| `dash:config:apikeys` | Button | F1 |
| `dash:config:apikey:anthropic` | Button | F1 |
| `dash:config:apikey:google` | Button | F1 |
| `config:modal:apikey:anthropic` | Modal | F1 |
| `config:modal:apikey:google` | Modal | F1 |
| `dash:config:postiz` | Button | F2 |
| `dash:config:postiz:refresh` | Button | F2 |
| `dash:config:delete` | Button | F3 |
| `dash:config:delete:confirm` | Button | F3 |
| `dash:config:import` | Button | F4a |
| `onboard:import` | Button | F4b |
