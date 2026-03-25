import { getLogger } from '../core/logger.js';
import type { SqliteDatabase } from '../core/database.js';
import { generateVideo, type VideoOptions } from '../services/google-ai.js';
import { uploadMedia } from '../services/postiz.js';
import { recordGoogleVideoUsage } from '../budget/tracker.js';

export interface VideoSegmentRequest {
  readonly prompt: string;
  readonly slug: string;
  readonly segmentIndex: number;
  readonly duration?: '4' | '6' | '8' | undefined;
  readonly aspectRatio?: '16:9' | '9:16' | undefined;
  readonly referenceImages?: readonly Buffer[] | undefined;
  readonly firstFrame?: Buffer | undefined;
  readonly publicationId?: number | undefined;
}

export interface GeneratedVideoSegment {
  readonly buffer: Buffer;
  readonly naming: string;
  readonly durationSeconds: number;
  readonly postizId?: string | undefined;
  readonly postizPath?: string | undefined;
  readonly dbId: number;
}

function buildSegmentNaming(slug: string, segmentIndex: number): string {
  const today = new Date().toISOString().split('T')[0] ?? '';
  return `SEG-${today}-${slug}-${String(segmentIndex).padStart(2, '0')}.mp4`;
}

export async function generateVideoSegment(
  db: SqliteDatabase,
  request: VideoSegmentRequest,
): Promise<GeneratedVideoSegment> {
  const logger = getLogger();
  const duration = request.duration ?? '6';

  logger.info(
    { slug: request.slug, segment: request.segmentIndex, duration },
    'Generating video segment',
  );

  const videoOptions: VideoOptions = {
    duration,
    aspectRatio: request.aspectRatio ?? '9:16',
    referenceImages: request.referenceImages,
    firstFrame: request.firstFrame,
  };

  const video = await generateVideo(db, request.prompt, videoOptions);

  // Track cost
  recordGoogleVideoUsage(db, video.durationSeconds);

  const naming = buildSegmentNaming(request.slug, request.segmentIndex);

  // Upload to Postiz
  let postizId: string | undefined;
  let postizPath: string | undefined;

  try {
    const uploaded = await uploadMedia(video.data, naming);
    postizId = uploaded.id;
    postizPath = uploaded.path;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error), naming },
      'Postiz upload failed for video segment',
    );
  }

  // Save to database
  const result = db.prepare(`
    INSERT INTO media (type, generator, prompt, postiz_id, postiz_path, naming, publication_id)
    VALUES ('video_segment', 'veo', ?, ?, ?, ?, ?)
  `).run(
    request.prompt,
    postizId ?? null,
    postizPath ?? null,
    naming,
    request.publicationId ?? null,
  );

  logger.info({ naming, duration: video.durationSeconds }, 'Video segment ready');

  return {
    buffer: video.data,
    naming,
    durationSeconds: video.durationSeconds,
    postizId,
    postizPath,
    dbId: Number(result.lastInsertRowid),
  };
}

export interface StoryboardSegment {
  readonly prompt: string;
  readonly duration: '4' | '6' | '8';
  readonly useReferenceImages: boolean;
  readonly useFirstFrame: boolean;
}

export interface StoryboardResult {
  readonly segments: readonly GeneratedVideoSegment[];
  readonly totalDuration: number;
}

export async function generateStoryboard(
  db: SqliteDatabase,
  slug: string,
  storyboard: readonly StoryboardSegment[],
  referenceImages?: readonly Buffer[] | undefined,
  publicationId?: number | undefined,
): Promise<StoryboardResult> {
  const logger = getLogger();
  const segments: GeneratedVideoSegment[] = [];
  let lastFrameBuffer: Buffer | undefined;

  logger.info({ slug, segmentCount: storyboard.length }, 'Generating storyboard');

  for (let i = 0; i < storyboard.length; i++) {
    const seg = storyboard[i];
    if (seg === undefined) continue;

    const segment = await generateVideoSegment(db, {
      prompt: seg.prompt,
      slug,
      segmentIndex: i + 1,
      duration: seg.duration,
      aspectRatio: '9:16',
      // Segment 1: reference images. Following segments: first frame from previous
      referenceImages: i === 0 && seg.useReferenceImages ? referenceImages : undefined,
      firstFrame: i > 0 && seg.useFirstFrame ? lastFrameBuffer : undefined,
      publicationId,
    });

    segments.push(segment);
    // Store buffer as potential first frame for next segment
    lastFrameBuffer = segment.buffer;
  }

  const totalDuration = segments.reduce((sum, s) => sum + s.durationSeconds, 0);

  logger.info({ slug, totalDuration, segments: segments.length }, 'Storyboard complete');

  return { segments, totalDuration };
}
