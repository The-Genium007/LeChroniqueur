import { getConfig } from '../core/config.js';
import { getLogger } from '../core/logger.js';
import { writePostizSocialEnv, restartPostiz } from '../services/docker.js';

export interface PostizPlatformKeys {
  readonly platform: string;
  readonly envKeys: Array<{ key: string; value: string }>;
}

/**
 * Supported social platforms and their required Postiz env vars.
 */
export const PLATFORM_CONFIG = {
  tiktok: {
    label: 'TikTok',
    emoji: '📱',
    requiresHttps: true,
    envVars: ['TIKTOK_CLIENT_ID', 'TIKTOK_CLIENT_SECRET'],
    scopes: 'user.info.basic, video.create, video.upload, video.publish',
  },
  instagram: {
    label: 'Instagram',
    emoji: '📸',
    requiresHttps: false,
    envVars: ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET'],
    scopes: 'Business ou Creator account requis',
  },
  x: {
    label: 'X / Twitter',
    emoji: '🐦',
    requiresHttps: false,
    envVars: ['X_API_KEY', 'X_API_SECRET'],
    scopes: 'Type d\'app = "Native App", permissions "Read and Write"',
  },
  linkedin: {
    label: 'LinkedIn',
    emoji: '💼',
    requiresHttps: false,
    envVars: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
    scopes: 'Advertising API permissions recommandées',
  },
} as const;

export type PlatformId = keyof typeof PLATFORM_CONFIG;

/**
 * Get the redirect URI for a platform.
 */
export function getRedirectUri(platform: PlatformId): string {
  const config = getConfig();
  return `${config.POSTIZ_URL}/integrations/social/${platform}`;
}

/**
 * Check if HTTPS is available (needed for TikTok).
 */
export function isHttpsAvailable(): boolean {
  const config = getConfig();
  return config.POSTIZ_URL.startsWith('https://');
}

/**
 * Get available platforms (exclude TikTok if no HTTPS).
 */
export function getAvailablePlatforms(): PlatformId[] {
  const https = isHttpsAvailable();
  return (Object.keys(PLATFORM_CONFIG) as PlatformId[]).filter((p) => {
    if (PLATFORM_CONFIG[p].requiresHttps && !https) return false;
    return true;
  });
}

/**
 * Write platform keys to Postiz env and restart the container.
 */
export async function configurePlatform(
  platform: PlatformId,
  keys: Record<string, string>,
): Promise<void> {
  const logger = getLogger();
  const platformConfig = PLATFORM_CONFIG[platform];

  logger.info({ platform }, 'Configuring Postiz platform');

  // Write each env var
  for (const envVar of platformConfig.envVars) {
    const value = keys[envVar];
    if (value !== undefined && value.length > 0) {
      await writePostizSocialEnv(envVar, value);
    }
  }

  // Restart Postiz to pick up new env
  await restartPostiz();

  logger.info({ platform }, 'Postiz platform configured and restarted');
}

/**
 * Verify which integrations are connected in Postiz.
 */
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
