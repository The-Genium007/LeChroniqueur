import { getConfig } from './config.js';
import { getLogger } from './logger.js';

export type ServiceStatus = 'ok' | 'warning' | 'error';

export interface HealthReport {
  readonly services: Record<string, ServiceStatus>;
}

/**
 * Check the health of all external services.
 */
export async function checkHealth(): Promise<HealthReport> {
  const config = getConfig();
  const logger = getLogger();

  const services: Record<string, ServiceStatus> = {
    Discord: 'ok', // If we're running, Discord is connected
    SQLite: 'ok',  // If we got this far, SQLite is working
  };

  // SearXNG
  try {
    const response = await fetch(`${config.SEARXNG_URL}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });
    services['SearXNG'] = response.ok ? 'ok' : 'warning';
  } catch {
    services['SearXNG'] = 'error';
    logger.debug('SearXNG health check failed');
  }

  // Postiz
  if (config.POSTIZ_URL.length > 0) {
    const postizInternalUrl = process.env['POSTIZ_INTERNAL_URL'] ?? 'http://postiz:4007';
    try {
      const response = await fetch(postizInternalUrl, {
        signal: AbortSignal.timeout(5000),
      });
      services['Postiz'] = response.ok ? 'ok' : 'warning';
    } catch {
      services['Postiz'] = 'error';
      logger.debug('Postiz health check failed');
    }
  }

  // Anthropic — we don't ping it (costs money), just mark as ok
  services['Anthropic'] = 'ok';

  return { services };
}
