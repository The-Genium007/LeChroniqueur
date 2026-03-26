import { getLogger } from '../core/logger.js';

const DOCKER_PROXY_URL = 'http://docker-proxy:2375';
const POSTIZ_CONTAINER_NAME = 'postiz';

/**
 * Restart the Postiz container via the Docker socket proxy.
 * The proxy only allows container operations (CONTAINERS=1, POST=1).
 */
export async function restartPostiz(): Promise<void> {
  const logger = getLogger();

  logger.info('Restarting Postiz container');

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, 30_000);

  try {
    const response = await fetch(
      `${DOCKER_PROXY_URL}/containers/${POSTIZ_CONTAINER_NAME}/restart`,
      {
        method: 'POST',
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Docker proxy returned ${String(response.status)}: ${body}`);
    }

    logger.info('Postiz container restarted, waiting for health');

    // Wait for Postiz to be healthy
    await waitForPostizHealthy();

    logger.info('Postiz is healthy after restart');
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Postiz restart timed out after 30s', { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Wait for Postiz to respond to health checks.
 * Polls every 3 seconds for up to 60 seconds.
 */
async function waitForPostizHealthy(): Promise<void> {
  const logger = getLogger();
  const postizInternalUrl = process.env['POSTIZ_INTERNAL_URL'] ?? 'http://postiz:4007';
  const maxAttempts = 20;
  const delayMs = 3000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(postizInternalUrl, {
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        return;
      }
    } catch {
      logger.debug({ attempt, maxAttempts }, 'Postiz not ready yet');
    }

    await new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }

  throw new Error('Postiz did not become healthy after restart');
}

/**
 * Write a key-value pair to the postiz-social.env file.
 */
export async function writePostizSocialEnv(key: string, value: string): Promise<void> {
  const fs = await import('node:fs/promises');
  const envPath = '/app/postiz-env/postiz-social.env';

  let content: string;
  try {
    content = await fs.readFile(envPath, 'utf-8');
  } catch {
    content = '';
  }

  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }

  await fs.writeFile(envPath, content, 'utf-8');
}
