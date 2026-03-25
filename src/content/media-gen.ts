import { getLogger } from '../core/logger.js';
import type { SqliteDatabase } from '../core/database.js';
import { generateImages } from '../services/google-ai.js';
import { uploadMedia } from '../services/postiz.js';
import { recordGoogleImageUsage } from '../budget/tracker.js';

export interface MediaGenRequest {
  readonly prompt: string;
  readonly slug: string;
  readonly aspectRatio?: '1:1' | '3:4' | '4:3' | '9:16' | '16:9' | undefined;
  readonly variantCount?: number | undefined;
  readonly publicationId?: number | undefined;
}

export interface GeneratedMediaResult {
  readonly variants: readonly MediaVariant[];
}

export interface MediaVariant {
  readonly index: number;
  readonly buffer: Buffer;
  readonly naming: string;
  readonly postizId?: string | undefined;
  readonly postizPath?: string | undefined;
  readonly dbId?: number | undefined;
}

function buildNaming(slug: string, index: number): string {
  const today = new Date().toISOString().split('T')[0] ?? '';
  return `IMG-${today}-${slug}-${String(index + 1).padStart(2, '0')}.png`;
}

export async function generateImageVariants(
  db: SqliteDatabase,
  request: MediaGenRequest,
): Promise<GeneratedMediaResult> {
  const logger = getLogger();
  const count = request.variantCount ?? 2;

  logger.info({ slug: request.slug, count }, 'Generating image variants');

  const images = await generateImages(db, request.prompt, {
    aspectRatio: request.aspectRatio ?? '9:16',
    numberOfImages: count,
  });

  // Track cost
  recordGoogleImageUsage(db, images.length);

  const variants: MediaVariant[] = [];

  for (let i = 0; i < images.length; i++) {
    const image = images[i];
    if (image === undefined) continue;

    const naming = buildNaming(request.slug, i);

    // Upload to Postiz
    let postizId: string | undefined;
    let postizPath: string | undefined;

    try {
      const uploaded = await uploadMedia(image.data, naming);
      postizId = uploaded.id;
      postizPath = uploaded.path;
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error), naming },
        'Postiz upload failed, continuing without',
      );
    }

    // Save to database
    const result = db.prepare(`
      INSERT INTO media (type, generator, prompt, postiz_id, postiz_path, naming, publication_id)
      VALUES ('image', 'imagen', ?, ?, ?, ?, ?)
    `).run(
      request.prompt,
      postizId ?? null,
      postizPath ?? null,
      naming,
      request.publicationId ?? null,
    );

    variants.push({
      index: i,
      buffer: image.data,
      naming,
      postizId,
      postizPath,
      dbId: Number(result.lastInsertRowid),
    });
  }

  logger.info({ variants: variants.length }, 'Image variants ready');

  return { variants };
}
