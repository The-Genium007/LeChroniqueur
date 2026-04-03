import { GoogleGenAI } from '@google/genai';
import { getConfig } from '../core/config.js';
import { getLogger } from '../core/logger.js';
import { isApiAllowed } from '../budget/tracker.js';
import type { SqliteDatabase } from '../core/database.js';
import { ApiNotConfiguredError, classifyApiError } from './api-errors.js';

// ─── Types ───

export interface ImageOptions {
  readonly aspectRatio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9' | undefined;
  readonly numberOfImages?: number | undefined;
  readonly model?: string | undefined;
}

export interface GeneratedImage {
  readonly data: Buffer;
  readonly mimeType: string;
}

export interface VideoOptions {
  readonly duration?: '4' | '6' | '8' | undefined;
  readonly resolution?: '720p' | '1080p' | '4k' | undefined;
  readonly aspectRatio?: '16:9' | '9:16' | undefined;
  readonly referenceImages?: readonly Buffer[] | undefined;
  readonly firstFrame?: Buffer | undefined;
}

export interface GeneratedVideo {
  readonly data: Buffer;
  readonly mimeType: string;
  readonly durationSeconds: number;
}

// ─── Client ───

let _client: GoogleGenAI | undefined;

function getClient(): GoogleGenAI {
  if (_client !== undefined) {
    return _client;
  }

  const config = getConfig();

  const envKey = process.env['GOOGLE_AI_API_KEY'] ?? config.GOOGLE_AI_API_KEY;

  if (envKey.length === 0) {
    throw new ApiNotConfiguredError('google');
  }

  _client = new GoogleGenAI({ apiKey: envKey });
  return _client;
}

// ─── Image Generation (Imagen / Nano Banana) ───

export async function generateImages(
  db: SqliteDatabase,
  prompt: string,
  options?: ImageOptions,
): Promise<readonly GeneratedImage[]> {
  const logger = getLogger();

  if (!isApiAllowed(db)) {
    throw new Error('API budget exhausted — image generation blocked');
  }

  const client = getClient();
  const model = options?.model ?? 'imagen-4.0-generate-001';
  const count = options?.numberOfImages ?? 2;

  logger.info({ model, prompt: prompt.slice(0, 80), count }, 'Generating images');

  let response;
  try {
    response = await client.models.generateImages({
      model,
      prompt,
      config: {
        numberOfImages: count,
        aspectRatio: options?.aspectRatio ?? '9:16',
      },
    });
  } catch (error) {
    throw classifyApiError('google', error);
  }

  const images: GeneratedImage[] = [];

  if (response.generatedImages) {
    for (const img of response.generatedImages) {
      if (img.image?.imageBytes) {
        images.push({
          data: Buffer.from(img.image.imageBytes, 'base64'),
          mimeType: 'image/png',
        });
      }
    }
  }

  logger.info({ generated: images.length }, 'Images generated');

  return images;
}

// ─── Video Generation (Veo 3.1) ───

const VIDEO_POLL_INTERVAL_MS = 10_000;
const VIDEO_MAX_POLL_ATTEMPTS = 120; // 20 minutes max

export async function generateVideo(
  db: SqliteDatabase,
  prompt: string,
  options?: VideoOptions,
): Promise<GeneratedVideo> {
  const logger = getLogger();

  if (!isApiAllowed(db)) {
    throw new Error('API budget exhausted — video generation blocked');
  }

  const client = getClient();
  const duration = options?.duration ?? '6';
  const resolution = options?.resolution ?? '1080p';
  const aspectRatio = options?.aspectRatio ?? '9:16';

  logger.info(
    { prompt: prompt.slice(0, 80), duration, resolution, aspectRatio },
    'Starting video generation',
  );

  const generateConfig: Record<string, unknown> = {
    duration,
    resolution,
    aspectRatio,
  };

  const generateParams: Record<string, unknown> = {
    model: 'veo-3.1-generate-001',
    prompt,
    config: generateConfig,
  };

  // Reference images (up to 3, cannot combine with firstFrame)
  if (options?.referenceImages !== undefined && options.referenceImages.length > 0) {
    generateParams['referenceImages'] = options.referenceImages.map((buf) => ({
      data: buf.toString('base64'),
      mimeType: 'image/png',
    }));
  } else if (options?.firstFrame !== undefined) {
    generateParams['image'] = {
      data: options.firstFrame.toString('base64'),
      mimeType: 'image/png',
    };
  }

  // The Veo API types are not fully stabilized in the SDK.
  // We use the models namespace with type assertions for forward compatibility.
  const generateVideos = client.models.generateVideos.bind(client.models) as (
    params: unknown,
  ) => Promise<{ done?: boolean; response?: unknown; name?: string }>;

  const getOperation = (client.models as unknown as {
    getVideosOperation: (params: unknown) => Promise<{ done?: boolean; response?: unknown }>;
  }).getVideosOperation?.bind(client.models);

  let operation = await generateVideos(generateParams);

  // Poll for completion
  let attempts = 0;

  while (!operation.done && attempts < VIDEO_MAX_POLL_ATTEMPTS) {
    logger.debug({ attempts, state: 'polling' }, 'Waiting for video generation');

    await new Promise((resolve) => {
      setTimeout(resolve, VIDEO_POLL_INTERVAL_MS);
    });

    if (getOperation !== undefined) {
      operation = await getOperation({ operation });
    } else {
      // Fallback: re-fetch by operation name if method not available
      throw new Error('getVideosOperation not available in SDK — video polling not supported');
    }
    attempts++;
  }

  if (!operation.done) {
    throw new Error(`Video generation timed out after ${String(attempts * VIDEO_POLL_INTERVAL_MS / 1000)}s`);
  }

  // Extract video data with safe navigation
  const result = operation.response as {
    generatedVideos?: Array<{ video?: { videoBytes?: string } }>;
  } | undefined;

  const videoBytes = result?.generatedVideos?.[0]?.video?.videoBytes;
  if (videoBytes === undefined) {
    throw new Error('No video data in generation response');
  }

  logger.info({ duration, attempts }, 'Video generated');

  return {
    data: Buffer.from(videoBytes, 'base64'),
    mimeType: 'video/mp4',
    durationSeconds: parseInt(duration, 10),
  };
}
