import { getConfig } from '../core/config.js';
import { getLogger } from '../core/logger.js';
import { writePostizSocialEnv, restartPostiz } from '../services/docker.js';
import {
  buildContainer, txt, sep, btn, row, v2, getColor,
  ButtonStyle,
  type V2MessagePayload,
} from '../discord/component-builder-v2.js';

export interface PostizPlatformKeys {
  readonly platform: string;
  readonly envKeys: Array<{ key: string; value: string }>;
}

// ─── Platform Configuration ───

interface PlatformDef {
  readonly label: string;
  readonly emoji: string;
  readonly requiresHttps: boolean;
  readonly envVars: readonly string[];
  readonly envLabels: readonly string[];
  readonly scopes: string;
  readonly devConsoleUrl: string;
  readonly instructions: readonly string[];
}

export const PLATFORM_CONFIG: Record<string, PlatformDef> = {
  x: {
    label: 'X / Twitter',
    emoji: '🐦',
    requiresHttps: false,
    envVars: ['X_API_KEY', 'X_API_SECRET'],
    envLabels: ['API Key', 'API Secret'],
    scopes: 'Type "Native App", permissions "Read and Write"',
    devConsoleUrl: 'https://developer.x.com',
    instructions: [
      '1. Crée un projet + app sur developer.x.com',
      '2. Active OAuth 2.0 avec type "Native App"',
      '3. Ajoute le **Redirect URI** ci-dessus',
      '4. Copie l\'**API Key** et l\'**API Secret**',
    ],
  },
  instagram: {
    label: 'Instagram',
    emoji: '📸',
    requiresHttps: false,
    envVars: ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET'],
    envLabels: ['App ID', 'App Secret'],
    scopes: 'Business ou Creator account requis, Instagram Graph API',
    devConsoleUrl: 'https://developers.facebook.com',
    instructions: [
      '1. Crée une app sur developers.facebook.com',
      '2. Ajoute le produit "Instagram Graph API"',
      '3. Configure le **Redirect URI** ci-dessus',
      '4. Copie l\'**App ID** et l\'**App Secret**',
    ],
  },
  linkedin: {
    label: 'LinkedIn',
    emoji: '💼',
    requiresHttps: false,
    envVars: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
    envLabels: ['Client ID', 'Client Secret'],
    scopes: 'Produits : "Share on LinkedIn", "Sign In with LinkedIn using OpenID Connect"',
    devConsoleUrl: 'https://www.linkedin.com/developers',
    instructions: [
      '1. Crée une app sur linkedin.com/developers',
      '2. Ajoute les produits requis',
      '3. Configure le **Redirect URI** ci-dessus',
      '4. Copie le **Client ID** et le **Client Secret**',
    ],
  },
  tiktok: {
    label: 'TikTok',
    emoji: '📱',
    requiresHttps: true,
    envVars: ['TIKTOK_CLIENT_ID', 'TIKTOK_CLIENT_SECRET'],
    envLabels: ['Client Key', 'Client Secret'],
    scopes: 'user.info.basic, video.create, video.upload, video.publish',
    devConsoleUrl: 'https://developers.tiktok.com',
    instructions: [
      '1. Crée une app sur developers.tiktok.com',
      '2. Ajoute les scopes vidéo requis',
      '3. Configure le **Redirect URI** (HTTPS obligatoire)',
      '4. Copie le **Client Key** et le **Client Secret**',
    ],
  },
  facebook: {
    label: 'Facebook',
    emoji: '📘',
    requiresHttps: false,
    envVars: ['FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'],
    envLabels: ['App ID', 'App Secret'],
    scopes: 'pages_manage_posts, pages_read_engagement',
    devConsoleUrl: 'https://developers.facebook.com',
    instructions: [
      '1. Crée une app sur developers.facebook.com',
      '2. Ajoute le produit "Facebook Login"',
      '3. Configure le **Redirect URI** ci-dessus',
      '4. Copie l\'**App ID** et l\'**App Secret**',
    ],
  },
  threads: {
    label: 'Threads',
    emoji: '🧵',
    requiresHttps: false,
    envVars: ['THREADS_APP_ID', 'THREADS_APP_SECRET'],
    envLabels: ['App ID', 'App Secret'],
    scopes: 'threads_basic, threads_content_publish',
    devConsoleUrl: 'https://developers.facebook.com',
    instructions: [
      '1. Crée une app sur developers.facebook.com',
      '2. Ajoute le produit "Threads API"',
      '3. Configure le **Redirect URI** ci-dessus',
      '4. Copie l\'**App ID** et l\'**App Secret**',
    ],
  },
  youtube: {
    label: 'YouTube',
    emoji: '📺',
    requiresHttps: false,
    envVars: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'],
    envLabels: ['Client ID', 'Client Secret'],
    scopes: 'YouTube Data API v3 — youtube.upload, youtube.readonly',
    devConsoleUrl: 'https://console.cloud.google.com',
    instructions: [
      '1. Crée un projet sur console.cloud.google.com',
      '2. Active "YouTube Data API v3"',
      '3. Crée des OAuth credentials avec le **Redirect URI**',
      '4. Copie le **Client ID** et le **Client Secret**',
    ],
  },
  reddit: {
    label: 'Reddit',
    emoji: '🤖',
    requiresHttps: false,
    envVars: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
    envLabels: ['Client ID', 'Client Secret'],
    scopes: 'Type "web app", scope: submit, identity',
    devConsoleUrl: 'https://www.reddit.com/prefs/apps',
    instructions: [
      '1. Va sur reddit.com/prefs/apps',
      '2. Crée une app de type "web app"',
      '3. Ajoute le **Redirect URI** ci-dessus',
      '4. Copie le **Client ID** (sous le nom) et le **Secret**',
    ],
  },
  pinterest: {
    label: 'Pinterest',
    emoji: '📌',
    requiresHttps: false,
    envVars: ['PINTEREST_CLIENT_ID', 'PINTEREST_CLIENT_SECRET'],
    envLabels: ['App ID', 'App Secret'],
    scopes: 'pins:read, pins:write, boards:read, boards:write',
    devConsoleUrl: 'https://developers.pinterest.com',
    instructions: [
      '1. Crée une app sur developers.pinterest.com',
      '2. Configure le **Redirect URI** ci-dessus',
      '3. Copie l\'**App ID** et l\'**App Secret**',
    ],
  },
  dribbble: {
    label: 'Dribbble',
    emoji: '🏀',
    requiresHttps: false,
    envVars: ['DRIBBBLE_CLIENT_ID', 'DRIBBBLE_CLIENT_SECRET'],
    envLabels: ['Client ID', 'Client Secret'],
    scopes: 'public, upload',
    devConsoleUrl: 'https://dribbble.com/account/applications',
    instructions: [
      '1. Va sur dribbble.com/account/applications',
      '2. Crée une nouvelle application',
      '3. Configure le **Redirect URI** ci-dessus',
      '4. Copie le **Client ID** et le **Client Secret**',
    ],
  },
  mastodon: {
    label: 'Mastodon',
    emoji: '🐘',
    requiresHttps: false,
    envVars: ['MASTODON_URL', 'MASTODON_CLIENT_ID', 'MASTODON_CLIENT_SECRET'],
    envLabels: ['URL de l\'instance', 'Client ID', 'Client Secret'],
    scopes: 'read, write:statuses, write:media',
    devConsoleUrl: 'https://mastodon.social/settings/applications',
    instructions: [
      '1. Va dans Préférences > Développement sur ton instance',
      '2. Crée une nouvelle application avec les scopes requis',
      '3. Note l\'**URL de ton instance** (ex: https://mastodon.social)',
      '4. Copie le **Client ID** et le **Client Secret**',
    ],
  },
  slack: {
    label: 'Slack',
    emoji: '💬',
    requiresHttps: false,
    envVars: ['SLACK_ID', 'SLACK_SECRET', 'SLACK_SIGNING_SECRET'],
    envLabels: ['Client ID', 'Client Secret', 'Signing Secret'],
    scopes: 'chat:write, channels:read',
    devConsoleUrl: 'https://api.slack.com/apps',
    instructions: [
      '1. Crée une app sur api.slack.com/apps',
      '2. Configure OAuth avec le **Redirect URI**',
      '3. Copie le **Client ID**, **Client Secret** et **Signing Secret**',
    ],
  },
  discord: {
    label: 'Discord',
    emoji: '🎮',
    requiresHttps: false,
    envVars: ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN_ID'],
    envLabels: ['Client ID', 'Client Secret', 'Bot Token'],
    scopes: 'bot, applications.commands — webhook.send',
    devConsoleUrl: 'https://discord.com/developers/applications',
    instructions: [
      '1. Crée une app sur discord.com/developers',
      '2. Configure OAuth2 avec le **Redirect URI**',
      '3. Copie le **Client ID**, **Client Secret** et **Bot Token**',
    ],
  },
  telegram: {
    label: 'Telegram',
    emoji: '✈️',
    requiresHttps: false,
    envVars: ['TELEGRAM_BOT_NAME', 'TELEGRAM_TOKEN'],
    envLabels: ['Nom du bot (sans @)', 'Token'],
    scopes: 'Pas d\'OAuth — utilise un token BotFather',
    devConsoleUrl: 'https://t.me/BotFather',
    instructions: [
      '1. Ouvre @BotFather sur Telegram',
      '2. Envoie /newbot et suis les instructions',
      '3. Copie le **nom du bot** (sans @) et le **token**',
    ],
  },
} as const;

export type PlatformId = keyof typeof PLATFORM_CONFIG;

const PLATFORM_IDS = Object.keys(PLATFORM_CONFIG) as PlatformId[];

// ─── Utilities ───

export function getRedirectUri(platform: PlatformId): string {
  const config = getConfig();
  return `${config.POSTIZ_URL}/integrations/social/${platform}`;
}

export function isHttpsAvailable(): boolean {
  const config = getConfig();
  return config.POSTIZ_URL.startsWith('https://');
}

export function getAvailablePlatforms(): PlatformId[] {
  const https = isHttpsAvailable();
  return PLATFORM_IDS.filter((p) => {
    const def = PLATFORM_CONFIG[p];
    if (def === undefined) return false;
    if (def.requiresHttps && !https) return false;
    return true;
  });
}

// ─── Env File Operations ───

export async function getConfiguredPlatforms(): Promise<PlatformId[]> {
  const fs = await import('node:fs/promises');
  const envPath = '/app/postiz-env/postiz-social.env';

  let content: string;
  try {
    content = await fs.readFile(envPath, 'utf-8');
  } catch {
    return [];
  }

  const envMap = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      envMap.set(trimmed.slice(0, eqIdx), trimmed.slice(eqIdx + 1));
    }
  }

  const configured: PlatformId[] = [];
  for (const id of PLATFORM_IDS) {
    const def = PLATFORM_CONFIG[id];
    if (def === undefined) continue;
    const allSet = def.envVars.every((v) => {
      const val = envMap.get(v);
      return val !== undefined && val.length > 0;
    });
    if (allSet) configured.push(id);
  }

  return configured;
}

export async function configurePlatform(
  platform: PlatformId,
  keys: Record<string, string>,
): Promise<void> {
  const logger = getLogger();
  const platformConfig = PLATFORM_CONFIG[platform];
  if (platformConfig === undefined) throw new Error(`Unknown platform: ${platform}`);

  logger.info({ platform }, 'Configuring Postiz platform');

  for (const envVar of platformConfig.envVars) {
    const value = keys[envVar];
    if (value !== undefined && value.length > 0) {
      await writePostizSocialEnv(envVar, value);
    }
  }

  await restartPostiz();
  logger.info({ platform }, 'Postiz platform configured and restarted');
}

export async function removePlatform(platform: PlatformId): Promise<void> {
  const logger = getLogger();
  const platformConfig = PLATFORM_CONFIG[platform];
  if (platformConfig === undefined) throw new Error(`Unknown platform: ${platform}`);

  logger.info({ platform }, 'Removing Postiz platform');

  for (const envVar of platformConfig.envVars) {
    await writePostizSocialEnv(envVar, '');
  }

  await restartPostiz();
  logger.info({ platform }, 'Postiz platform removed and restarted');
}

// ─── Integration Verification ───

export async function verifyPostizIntegrations(): Promise<{
  connected: string[];
  total: number;
}> {
  const logger = getLogger();
  const postizInternalUrl = process.env['POSTIZ_INTERNAL_URL'] ?? 'http://postiz:4007';

  try {
    const response = await fetch(`${postizInternalUrl}/public/v1/integrations`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'Failed to fetch Postiz integrations');
      return { connected: [], total: 0 };
    }

    const data = (await response.json()) as Array<{ type: string; name?: string }>;
    const connected = data.map((i) => i.type);

    return { connected, total: connected.length };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn({ error: msg }, 'Failed to verify Postiz integrations');
    return { connected: [], total: 0 };
  }
}

// ─── V2 Screen Builders ───

/**
 * Build the main Postiz configuration screen showing platform statuses.
 * Used in both onboarding and dashboard contexts.
 */
export async function buildPostizScreen(
  prefix: 'onboard:postiz' | 'dash:postiz',
  connectedPlatforms: string[],
): Promise<V2MessagePayload> {
  const available = getAvailablePlatforms();
  let configured: PlatformId[];
  try {
    configured = await getConfiguredPlatforms();
  } catch {
    configured = [];
  }

  const connectedSet = new Set(connectedPlatforms);
  const configuredSet = new Set(configured);

  // Build status lines
  const statusLines: string[] = [];
  for (const id of available) {
    const def = PLATFORM_CONFIG[id];
    if (def === undefined) continue;
    if (connectedSet.has(id)) {
      statusLines.push(`✅ **${def.label}** — connecté`);
    } else if (configuredSet.has(id)) {
      statusLines.push(`🔑 **${def.label}** — clés configurées, non connecté`);
    }
  }

  if (statusLines.length === 0) {
    statusLines.push('Aucune plateforme configurée.');
  }

  const postizUrl = process.env['POSTIZ_URL'] ?? 'http://localhost:5000';

  // Split platforms into rows of 4 (max 5 per row, but keep room)
  // First 8 platforms get buttons, rest go in a "+Plus" secondary screen
  const mainPlatforms = available.slice(0, 8);
  const extraPlatforms = available.slice(8);

  const platformRows: ReturnType<typeof row>[] = [];
  for (let i = 0; i < mainPlatforms.length; i += 4) {
    const chunk = mainPlatforms.slice(i, i + 4);
    const buttons = chunk.map((id) => {
      const def = PLATFORM_CONFIG[id];
      if (def === undefined) return btn(`${prefix}:platform:${id}`, id, ButtonStyle.Secondary);
      const style = connectedSet.has(id) ? ButtonStyle.Success
        : configuredSet.has(id) ? ButtonStyle.Primary
        : ButtonStyle.Secondary;
      return btn(`${prefix}:platform:${id}`, def.label, style, def.emoji);
    });
    platformRows.push(row(...buttons));
  }

  // Action buttons
  const actionButtons = [
    btn(`${prefix}:verify`, 'Vérifier', ButtonStyle.Primary, '🔄'),
  ];
  if (extraPlatforms.length > 0) {
    actionButtons.push(btn(`${prefix}:more`, 'Plus...', ButtonStyle.Secondary, '➕'));
  }
  if (prefix === 'onboard:postiz') {
    actionButtons.push(btn('onboard:postiz:done', 'Continuer', ButtonStyle.Success, '✅'));
  } else {
    actionButtons.push(btn('dash:home', 'Retour', ButtonStyle.Secondary, '◀️'));
  }

  return v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt([
      '## 📤 Configuration Postiz',
      '',
      statusLines.join('\n'),
      '',
      `Interface Postiz : ${postizUrl}`,
    ].join('\n')));
    c.addSeparatorComponents(sep());
    for (const r of platformRows) {
      c.addActionRowComponents(r);
    }
    c.addActionRowComponents(row(...actionButtons));
  })]);
}

/**
 * Build the "more platforms" screen for platforms beyond the first 8.
 */
export function buildPostizMoreScreen(
  prefix: 'onboard:postiz' | 'dash:postiz',
  connectedPlatforms: string[],
  configuredPlatforms: PlatformId[],
): V2MessagePayload {
  const available = getAvailablePlatforms();
  const extraPlatforms = available.slice(8);
  const connectedSet = new Set(connectedPlatforms);
  const configuredSet = new Set(configuredPlatforms);

  const platformRows: ReturnType<typeof row>[] = [];
  for (let i = 0; i < extraPlatforms.length; i += 4) {
    const chunk = extraPlatforms.slice(i, i + 4);
    const buttons = chunk.map((id) => {
      const def = PLATFORM_CONFIG[id];
      if (def === undefined) return btn(`${prefix}:platform:${id}`, id, ButtonStyle.Secondary);
      const style = connectedSet.has(id) ? ButtonStyle.Success
        : configuredSet.has(id) ? ButtonStyle.Primary
        : ButtonStyle.Secondary;
      return btn(`${prefix}:platform:${id}`, def.label, style, def.emoji);
    });
    platformRows.push(row(...buttons));
  }

  return v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt('## 📤 Autres plateformes'));
    c.addSeparatorComponents(sep());
    for (const r of platformRows) {
      c.addActionRowComponents(r);
    }
    c.addActionRowComponents(row(
      btn(`${prefix}:back`, 'Retour', ButtonStyle.Secondary, '◀️'),
    ));
  })]);
}

/**
 * Build the detail screen for a specific platform.
 */
export function buildPlatformDetail(
  prefix: 'onboard:postiz' | 'dash:postiz',
  platformId: PlatformId,
  isConfigured: boolean,
  isConnected: boolean,
): V2MessagePayload {
  const def = PLATFORM_CONFIG[platformId];
  if (def === undefined) {
    return v2([buildContainer(getColor('error'), (c) => {
      c.addTextDisplayComponents(txt('Plateforme inconnue.'));
    })]);
  }

  const redirectUri = getRedirectUri(platformId);

  const statusLine = isConnected ? '✅ Connecté dans Postiz'
    : isConfigured ? '🔑 Clés configurées — va dans Postiz pour connecter ton compte'
    : '❌ Non configuré';

  const buttons = [
    btn(`${prefix}:keys:${platformId}`, 'Entrer les clés', ButtonStyle.Primary, '🔑'),
  ];
  if (isConfigured) {
    buttons.push(btn(`${prefix}:remove:${platformId}`, 'Supprimer', ButtonStyle.Danger, '🗑️'));
  }
  buttons.push(btn(`${prefix}:back`, 'Retour', ButtonStyle.Secondary, '◀️'));

  return v2([buildContainer(getColor('info'), (c) => {
    c.addTextDisplayComponents(txt([
      `## ${def.emoji} ${def.label}`,
      '',
      `**Statut** : ${statusLine}`,
      `**Console développeur** : ${def.devConsoleUrl}`,
      `**Redirect URI** : \`${redirectUri}\``,
      `**Scopes** : ${def.scopes}`,
      '',
      '**Instructions :**',
      ...def.instructions,
    ].join('\n')));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(...buttons));
  })]);
}
