import type { TextChannel, ButtonInteraction } from 'discord.js';
import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';
import { generateImageVariants, type MediaGenRequest } from '../content/media-gen.js';
import { generateVideoSegment } from '../content/video-gen.js';
import { checkThresholds, isApiAllowed } from '../budget/tracker.js';
import {
  imageGallery as buildImageGallery,
  videoSegmentResult as buildVideoSegmentResult,
  budgetAlert as buildBudgetAlert,
  errorMessage,
  apiErrorMessage,
} from '../discord/component-builder-v2.js';
import { sendSplit, replySplit } from '../discord/message-splitter.js';

interface ProductionHandlerDeps {
  readonly db: SqliteDatabase;
  readonly productionChannel: TextChannel;
  readonly logsChannel: TextChannel;
  readonly adminChannel: TextChannel;
}

export async function handleGenerateImages(
  interaction: ButtonInteraction,
  suggestionId: number,
  deps: ProductionHandlerDeps,
): Promise<void> {
  const logger = getLogger();
  const { db, productionChannel, logsChannel, adminChannel } = deps;

  if (!isApiAllowed(db)) {
    await replySplit(interaction, errorMessage('Budget API épuisé — génération d\'images bloquée.'));
    return;
  }

  // Get suggestion data for prompt
  const suggestion = db.prepare(`
    SELECT s.content, s.platform, s.format, s.id
    FROM suggestions s WHERE s.id = ?
  `).get(suggestionId) as { content: string; platform: string; format: string | null; id: number } | undefined;

  if (suggestion === undefined) {
    await replySplit(interaction, errorMessage('Suggestion introuvable.'));
    return;
  }

  // Build image prompt from suggestion content
  const slug = `suggestion-${String(suggestionId)}`;
  const aspectRatio = suggestion.platform === 'tiktok' ? '9:16' as const : '1:1' as const;

  const request: MediaGenRequest = {
    prompt: buildImagePrompt(suggestion.content),
    slug,
    aspectRatio,
    variantCount: 2,
  };

  logger.info({ suggestionId, slug }, 'Generating images for suggestion');

  try {
    const result = await generateImageVariants(db, request);

    // Post gallery in #production
    const payload = buildImageGallery({
      suggestionId,
      variants: result.variants.map((v) => ({
        index: v.index,
        naming: v.naming,
        url: v.postizPath,
        dbId: v.dbId,
      })),
    });

    await sendSplit(productionChannel, payload);

    // Check budget after generation
    const alerts = checkThresholds(db);
    for (const alert of alerts) {
      const alertPayload = buildBudgetAlert(
        alert.period,
        alert.thresholdPercent,
        alert.costCents,
        alert.budgetCents,
      );
      const targetChannel = alert.period === 'monthly' ? adminChannel : logsChannel;
      await sendSplit(targetChannel, alertPayload);
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ error: err.message, suggestionId }, 'Image generation failed');
    await replySplit(interaction, apiErrorMessage(err));
  }
}

export async function handleGenerateVideoSegment(
  interaction: ButtonInteraction,
  suggestionId: number,
  segmentPrompt: string,
  deps: ProductionHandlerDeps,
): Promise<void> {
  const logger = getLogger();
  const { db, productionChannel, logsChannel, adminChannel } = deps;

  if (!isApiAllowed(db)) {
    await replySplit(interaction, errorMessage('Budget API épuisé — génération vidéo bloquée.'));
    return;
  }

  const slug = `suggestion-${String(suggestionId)}`;

  logger.info({ suggestionId, slug }, 'Generating video segment');

  try {
    const segment = await generateVideoSegment(db, {
      prompt: segmentPrompt,
      slug,
      segmentIndex: 1,
      duration: '6',
      aspectRatio: '9:16',
    });

    const payload = buildVideoSegmentResult({
      naming: segment.naming,
      durationSeconds: segment.durationSeconds,
      postizPath: segment.postizPath,
      dbId: segment.dbId,
    });

    await sendSplit(productionChannel, payload);

    const alerts = checkThresholds(db);
    for (const alert of alerts) {
      const alertPayload = buildBudgetAlert(
        alert.period,
        alert.thresholdPercent,
        alert.costCents,
        alert.budgetCents,
      );
      const targetChannel = alert.period === 'monthly' ? adminChannel : logsChannel;
      await sendSplit(targetChannel, alertPayload);
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ error: err.message, suggestionId }, 'Video generation failed');
    await replySplit(interaction, apiErrorMessage(err));
  }
}

const DEFAULT_IMAGE_STYLE = [
  'Style: Modern, clean, professional.',
  'Color palette: neutral tones with accent colors.',
  'No text in the image. Abstract or conceptual illustration preferred.',
  'The image should visually represent the topic of the content.',
].join('\n');

export function buildImagePrompt(suggestionContent: string, artDirection?: string): string {
  const style = artDirection !== undefined && artDirection.length > 0
    ? artDirection.slice(0, 600)
    : DEFAULT_IMAGE_STYLE;

  return [
    style,
    '',
    'Scene description based on this content:',
    suggestionContent.slice(0, 500),
  ].join('\n');
}
