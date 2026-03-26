import { getLogger } from './logger.js';

const GITHUB_REPO = 'PowerGlove/LeChroniqueur';
const CURRENT_VERSION = '0.1.0'; // Updated by semantic-release in CI

export interface UpdateInfo {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly updateAvailable: boolean;
  readonly releaseUrl: string;
}

/**
 * Check GitHub releases for a newer version of the bot.
 * Returns null if check fails (network error, etc.).
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const logger = getLogger();

  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': `LeChroniqueur/${CURRENT_VERSION}`,
        },
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (!response.ok) {
      logger.debug({ status: response.status }, 'GitHub release check returned non-200');
      return null;
    }

    const data = (await response.json()) as {
      tag_name: string;
      html_url: string;
    };

    const latestVersion = data.tag_name.replace(/^v/, '');
    const updateAvailable = compareVersions(CURRENT_VERSION, latestVersion) < 0;

    const info: UpdateInfo = {
      currentVersion: CURRENT_VERSION,
      latestVersion,
      updateAvailable,
      releaseUrl: data.html_url,
    };

    if (updateAvailable) {
      logger.info({ current: CURRENT_VERSION, latest: latestVersion }, 'Update available');
    } else {
      logger.debug({ current: CURRENT_VERSION, latest: latestVersion }, 'Up to date');
    }

    return info;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.debug({ error: msg }, 'Failed to check for updates');
    return null;
  }
}

/**
 * Simple semver comparison. Returns:
 *  -1 if a < b
 *   0 if a == b
 *   1 if a > b
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const va = partsA[i] ?? 0;
    const vb = partsB[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }

  return 0;
}

export { CURRENT_VERSION };
