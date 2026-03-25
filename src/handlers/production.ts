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
} from '../discord/message-builder.js';

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
    const payload = errorMessage('Budget API épuisé — génération d\'images bloquée.');
    await interaction.editReply({ embeds: payload.embeds });
    return;
  }

  // Get suggestion data for prompt
  const suggestion = db.prepare(`
    SELECT s.content, s.platform, s.format, s.id
    FROM suggestions s WHERE s.id = ?
  `).get(suggestionId) as { content: string; platform: string; format: string | null; id: number } | undefined;

  if (suggestion === undefined) {
    const payload = errorMessage('Suggestion introuvable.');
    await interaction.editReply({ embeds: payload.embeds });
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
        postizPath: v.postizPath,
        dbId: v.dbId,
      })),
    });

    await productionChannel.send({
      embeds: payload.embeds,
      components: payload.components,
    });

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
      await targetChannel.send({ embeds: alertPayload.embeds });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg, suggestionId }, 'Image generation failed');
    const payload = errorMessage(`Génération d'images échouée : ${msg}`);
    await interaction.editReply({ embeds: payload.embeds });
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
    const payload = errorMessage('Budget API épuisé — génération vidéo bloquée.');
    await interaction.editReply({ embeds: payload.embeds });
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

    await productionChannel.send({
      embeds: payload.embeds,
      components: payload.components,
    });

    const alerts = checkThresholds(db);
    for (const alert of alerts) {
      const alertPayload = buildBudgetAlert(
        alert.period,
        alert.thresholdPercent,
        alert.costCents,
        alert.budgetCents,
      );
      const targetChannel = alert.period === 'monthly' ? adminChannel : logsChannel;
      await targetChannel.send({ embeds: alertPayload.embeds });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg, suggestionId }, 'Video generation failed');
    const payload = errorMessage(`Génération vidéo échouée : ${msg}`);
    await interaction.editReply({ embeds: payload.embeds });
  }
}

function buildImagePrompt(suggestionContent: string): string {
  // Extract the key visual elements from the suggestion
  // The persona DA (palette, ambiance) is injected here
  return [
    'Style: Dark fantasy, warm tones, parchment texture.',
    'Color palette: backgrounds #1A1210, text areas #2A2220, gold accents #C8A87C, cream text #F0DCC0.',
    'Atmosphere: Ancient parchment in a dungeon, warm, immersive, fantasy RPG.',
    'No text in the image. No faces. Mysterious hooded figure if character needed.',
    '',
    'Scene description based on this content:',
    suggestionContent.slice(0, 500),
  ].join('\n');
}
