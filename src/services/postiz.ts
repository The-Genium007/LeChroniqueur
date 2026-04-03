import { getConfig } from '../core/config.js';
import { getLogger } from '../core/logger.js';

export interface PostizMedia {
  readonly id: string;
  readonly name: string;
  readonly path: string;
}

export interface PostizIntegration {
  readonly id: string;
  readonly name: string;
  readonly identifier: string;
  readonly picture: string;
  readonly disabled: boolean;
  readonly profile: string;
}

export interface PostizPostPayload {
  readonly type: 'draft' | 'schedule' | 'now';
  readonly date?: string;
  readonly posts: readonly PostizPostEntry[];
}

export interface PostizPostValue {
  readonly content: string;
  readonly image?: readonly PostizMedia[] | undefined;
}

export interface PostizPostEntry {
  readonly integration: { readonly id: string };
  readonly value: readonly PostizPostValue[];
  readonly settings: { readonly __type: string };
}

export interface PostizPostResult {
  readonly postId: string;
  readonly integration: string;
}

interface PostizListPost {
  readonly id: string;
  readonly content: string;
  readonly state: string;
  readonly publishDate: string;
  readonly integration: PostizIntegration;
}

async function apiRequest<T>(
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<T> {
  const config = getConfig();
  const logger = getLogger();

  const url = `${config.POSTIZ_API_URL}${endpoint}`;

  logger.debug({ method, endpoint }, 'Postiz API request');

  const init: RequestInit = {
    method,
    headers: {
      Authorization: config.POSTIZ_API_KEY,
      'Content-Type': 'application/json',
    },
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const response = await fetch(url, init);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Postiz API ${method} ${endpoint} returned ${String(response.status)}: ${text}`);
  }

  return (await response.json()) as T;
}

export async function uploadMedia(
  buffer: Buffer,
  filename: string,
): Promise<PostizMedia> {
  const config = getConfig();
  const logger = getLogger();

  const url = `${config.POSTIZ_API_URL}/upload`;

  const formData = new FormData();
  const blob = new Blob([buffer]);
  formData.append('file', blob, filename);

  logger.debug({ filename }, 'Uploading media to Postiz');

  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: config.POSTIZ_API_KEY },
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Postiz upload failed: ${String(response.status)} ${text}`);
  }

  return (await response.json()) as PostizMedia;
}

export async function schedulePost(
  payload: PostizPostPayload,
): Promise<readonly PostizPostResult[]> {
  return apiRequest<PostizPostResult[]>('POST', '/posts', payload);
}

export async function listIntegrations(): Promise<readonly PostizIntegration[]> {
  return apiRequest<PostizIntegration[]>('GET', '/integrations');
}

export async function listPosts(
  start: Date,
  end: Date,
): Promise<readonly PostizListPost[]> {
  const startStr = start.toISOString().split('T')[0];
  const endStr = end.toISOString().split('T')[0];

  if (startStr === undefined || endStr === undefined) {
    throw new Error('Invalid date range');
  }

  return apiRequest<PostizListPost[]>(
    'GET',
    `/posts?start=${startStr}&end=${endStr}`,
  );
}

// ─── Analytics ───

export interface PostizAnalyticsDataPoint {
  readonly total: string;
  readonly date: string;
}

export interface PostizAnalyticsMetric {
  readonly label: string;
  readonly data: readonly PostizAnalyticsDataPoint[];
  readonly percentageChange: number;
}

/**
 * Gets analytics for a specific published post.
 * @param postId - The Postiz post ID
 * @param days - Number of days to look back (7, 30, or 90)
 */
export async function getPostAnalytics(
  postId: string,
  days: number = 7,
): Promise<readonly PostizAnalyticsMetric[]> {
  return apiRequest<PostizAnalyticsMetric[]>(
    'GET',
    `/analytics/post/${postId}?date=${String(days)}`,
  );
}

/**
 * Gets analytics for a platform integration (account-level metrics).
 * @param integrationId - The Postiz integration ID
 * @param days - Number of days to look back (7, 30, or 90)
 */
export async function getPlatformAnalytics(
  integrationId: string,
  days: number = 7,
): Promise<readonly PostizAnalyticsMetric[]> {
  return apiRequest<PostizAnalyticsMetric[]>(
    'GET',
    `/analytics/${integrationId}?date=${String(days)}`,
  );
}
