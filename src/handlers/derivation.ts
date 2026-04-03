import type { TextChannel, ButtonInteraction } from 'discord.js';
import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';
import { generateImageVariants, type MediaGenRequest } from '../content/media-gen.js';
import { isApiAllowed, checkThresholds } from '../budget/tracker.js';
import { buildImagePrompt } from './production.js';
import {
  masterContent,
  derivationThread,
  derivationMedia,
  derivationRecap,
  errorMessage,
  budgetAlert as buildBudgetAlert,
} from '../discord/component-builder-v2.js';
import { sendSplit, replySplit } from '../discord/message-splitter.js';
import {
  createTree,
  updateTreeStatus,
  updateTreeMediaId,
  updateTreeDiscordMessageId,
  updateTreeMaster,
  getTree,
  getDerivation,
  getDerivationsByTree,
  getReadyDerivations,
  updateDerivationStatus,
  updateDerivationText,
  updateDerivationMedia,
  updateDerivationDiscord,
  invalidateAllDerivations,
  type DerivationTree,
} from '../derivation/tree.js';
import {
  createDerivationsForTree,
  getFilteredCascade,
  findPlatformFormat,
} from '../derivation/cascade.js';
import {
  adaptTextForPlatform,
  generateThread,
  generateCarouselPlan,
  generateArticle,
} from '../derivation/adapters.js';
import { cropToVertical } from '../derivation/media-processor.js';
import {
  enqueueJob,
  type JobType,
  PRIORITIES,
} from '../derivation/queue.js';
import { uploadMedia } from '../services/postiz.js';

// ─── Types ───

interface DerivationHandlerDeps {
  readonly db: SqliteDatabase;
  readonly productionChannel: TextChannel;
  readonly publicationChannel: TextChannel;
  readonly logsChannel: TextChannel;
  readonly persona: string;
  readonly configuredPlatforms: readonly string[];
}

// ─── Step 1: Create master from validated suggestion ───

export async function handleCreateMaster(
  suggestionId: number,
  deps: DerivationHandlerDeps,
): Promise<DerivationTree | undefined> {
  const logger = getLogger();
  const { db, productionChannel } = deps;

  // Get suggestion content
  const suggestion = db.prepare(
    'SELECT id, content, platform, format FROM suggestions WHERE id = ?',
  ).get(suggestionId) as { id: number; content: string; platform: string; format: string | null } | undefined;

  if (suggestion === undefined) {
    logger.error({ suggestionId }, 'Suggestion not found for master creation');
    return undefined;
  }

  // Create derivation tree
  const imagePrompt = buildImagePrompt(suggestion.content);
  const tree = createTree(db, suggestionId, suggestion.content, imagePrompt);

  // Generate master image (1:1)
  if (!isApiAllowed(db)) {
    logger.warn({ treeId: tree.id }, 'Budget exhausted, skipping master image generation');
    await sendSplit(productionChannel, errorMessage('Budget API épuisé — image master non générée.'));
    return tree;
  }

  try {
    const slug = `master-${String(tree.id)}`;
    const request: MediaGenRequest = {
      prompt: imagePrompt,
      slug,
      aspectRatio: '1:1',
      variantCount: 2,
    };

    const result = await generateImageVariants(db, request);
    const firstVariant = result.variants[0];

    if (firstVariant?.dbId !== undefined) {
      updateTreeMediaId(db, tree.id, firstVariant.dbId);
    }

    // Post master to #production
    const masterData: Parameters<typeof masterContent>[0] = {
      treeId: tree.id,
      suggestionId,
      masterText: suggestion.content,
    };
    const imageUrl = firstVariant?.postizPath;
    if (imageUrl !== undefined) {
      (masterData as { imageUrl: string }).imageUrl = imageUrl;
    }
    const payload = masterContent(masterData);

    const messageIds = await sendSplit(productionChannel, payload);
    const firstMsgId = messageIds[0];
    if (firstMsgId !== undefined) {
      updateTreeDiscordMessageId(db, tree.id, firstMsgId);
    }

    // Check budget thresholds
    await checkAndAlertBudget(db, deps.logsChannel);
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), treeId: tree.id },
      'Master image generation failed',
    );
  }

  logger.info({ treeId: tree.id, suggestionId }, 'Master content created');
  return tree;
}

// ─── Step 2: Validate master and launch cascade ───

export async function handleMasterValidation(
  interaction: ButtonInteraction,
  treeId: number,
  deps: DerivationHandlerDeps,
): Promise<void> {
  const logger = getLogger();
  const { db, productionChannel } = deps;

  const tree = getTree(db, treeId);
  if (tree === undefined) {
    await replySplit(interaction, errorMessage('Arbre de dérivation introuvable.'));
    return;
  }

  // Mark master as validated
  updateTreeStatus(db, treeId, 'master_validated');
  updateTreeStatus(db, treeId, 'deriving');

  // Create derivation records for each configured platform
  const derivations = createDerivationsForTree(db, treeId, deps.configuredPlatforms);

  logger.info({ treeId, derivationCount: derivations.length }, 'Launching derivation cascade');

  // Enqueue all text adaptation jobs
  for (const derivation of derivations) {
    const format = findPlatformFormat(derivation.platform, derivation.format);
    if (format === undefined) continue;

    let jobType: JobType;
    if (format.group === 'thread') {
      jobType = 'thread_generation';
    } else if (format.group === 'article') {
      jobType = 'article_generation';
    } else if (format.group === 'carousel') {
      jobType = 'carousel_generation';
    } else {
      jobType = 'text_adaptation';
    }

    enqueueJob(db, jobType, treeId, {
      derivationId: derivation.id,
      platform: derivation.platform,
      format: derivation.format,
      masterText: tree.masterText,
      masterImagePrompt: tree.masterImagePrompt,
      persona: deps.persona,
    }, derivation.id);
  }

  await replySplit(interaction, {
    components: [],
    flags: 0,
    content: `✅ Master validé — ${String(derivations.length)} dérivations en file d'attente.`,
  } as never);

  // Post a summary in #production
  const cascade = getFilteredCascade(deps.configuredPlatforms);
  const lines = cascade.map((c) => `⏳ ${c.emoji} ${c.label}`);
  await sendSplit(productionChannel, {
    content: `**🔄 Dérivation en cours — ${String(derivations.length)} formats**\n\n${lines.join('\n')}`,
  } as never);
}

// ─── Step 2b: Modify master text (invalidates all derivations) ───

export async function handleMasterModifyText(
  interaction: ButtonInteraction,
  treeId: number,
  newText: string,
  deps: DerivationHandlerDeps,
): Promise<void> {
  const logger = getLogger();
  const { db, productionChannel } = deps;

  const tree = getTree(db, treeId);
  if (tree === undefined) {
    await replySplit(interaction, errorMessage('Arbre de dérivation introuvable.'));
    return;
  }

  // Invalidate all existing derivations
  const invalidated = invalidateAllDerivations(db, treeId);
  logger.info({ treeId, invalidated }, 'Master modified — all derivations invalidated');

  // Update master text
  updateTreeMaster(db, treeId, newText);
  updateTreeStatus(db, treeId, 'draft');

  // Re-post master
  const payload = masterContent({
    treeId,
    suggestionId: tree.suggestionId,
    masterText: newText,
  });

  const messageIds = await sendSplit(productionChannel, payload);
  const firstMsgId = messageIds[0];
  if (firstMsgId !== undefined) {
    updateTreeDiscordMessageId(db, treeId, firstMsgId);
  }
}

// ─── Step 3: Process a derivation job (called by queue processor) ───

export async function processDerivationJob(
  db: SqliteDatabase,
  jobPayload: {
    derivationId: number;
    platform: string;
    format: string;
    masterText: string;
    masterImagePrompt: string | null;
    persona: string;
  },
  productionChannel: TextChannel,
): Promise<unknown> {
  const logger = getLogger();
  const { derivationId, platform, format: formatName, masterText, masterImagePrompt, persona } = jobPayload;

  const derivation = getDerivation(db, derivationId);
  if (derivation === undefined) {
    throw new Error(`Derivation ${String(derivationId)} not found`);
  }

  const platformFormat = findPlatformFormat(platform, formatName);
  if (platformFormat === undefined) {
    throw new Error(`Unknown platform format: ${platform}/${formatName}`);
  }

  let adaptedText: string;
  let threadData: unknown;

  // Generate adapted text based on format group
  if (platformFormat.group === 'thread') {
    const { thread } = await generateThread(db, masterText, persona);
    adaptedText = thread.tweets.map((t) => `${String(t.index)}/ ${t.text}`).join('\n\n');
    threadData = thread;
  } else if (platformFormat.group === 'article') {
    const { text } = await generateArticle(db, masterText, platform, persona);
    adaptedText = text;
  } else if (platformFormat.group === 'carousel') {
    if (masterImagePrompt === null) {
      throw new Error('Carousel requires master image prompt');
    }
    const { carousel } = await generateCarouselPlan(db, masterText, masterImagePrompt, persona);
    adaptedText = carousel.caption;
    threadData = carousel;
  } else {
    const { text } = await adaptTextForPlatform(db, masterText, platform, formatName, persona);
    adaptedText = text;
  }

  // Update derivation in DB
  updateDerivationText(db, derivationId, adaptedText);
  updateDerivationStatus(db, derivationId, 'text_generated');

  // Create thread in #production
  const threadName = `${platformFormat.emoji} ${platformFormat.label} — dérivation`;

  try {
    // Find the tree's discord message to create thread from, or post a new message
    const lastMessage = await productionChannel.messages.fetch({ limit: 1 });
    const anchorMessage = lastMessage.first();

    if (anchorMessage !== undefined) {
      const thread = await anchorMessage.startThread({
        name: threadName,
        autoArchiveDuration: 4320, // 3 days
      });

      updateDerivationDiscord(db, derivationId, thread.id);

      // Post the adapted text in the thread
      const payload = derivationThread({
        derivationId,
        platform: platformFormat.label,
        format: formatName,
        emoji: platformFormat.emoji,
        adaptedText,
        status: 'text_generated',
      });

      await sendSplit(thread as unknown as TextChannel, payload);

      logger.info({ derivationId, platform, format: formatName, threadId: thread.id }, 'Derivation thread created');
    }
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), derivationId },
      'Failed to create derivation thread',
    );
  }

  return { adaptedText, threadData };
}

// ─── Step 3b: Handle derivation validation ───

export async function handleDerivationValidation(
  interaction: ButtonInteraction,
  derivationId: number,
  deps: DerivationHandlerDeps,
): Promise<void> {
  const logger = getLogger();
  const { db } = deps;

  const derivation = getDerivation(db, derivationId);
  if (derivation === undefined) {
    await replySplit(interaction, errorMessage('Dérivation introuvable.'));
    return;
  }

  // If the derivation needs media, enqueue media generation
  if (derivation.mediaType !== 'none' && derivation.mediaType !== 'image_1_1') {
    updateDerivationStatus(db, derivationId, 'text_validated');

    const tree = getTree(db, derivation.treeId);

    // Enqueue appropriate media job
    if (derivation.mediaType === 'image_9_16_crop') {
      enqueueJob(db, 'image_crop', derivation.treeId, {
        derivationId,
        treeId: derivation.treeId,
        masterMediaId: tree?.masterMediaId,
      }, derivationId, PRIORITIES.IMAGE_CROP);
    } else if (derivation.mediaType === 'video_9_16') {
      enqueueJob(db, 'video_generation', derivation.treeId, {
        derivationId,
        treeId: derivation.treeId,
        masterText: tree?.masterText,
      }, derivationId, PRIORITIES.VIDEO_GENERATION);
    } else if (derivation.mediaType === 'carousel_slides') {
      enqueueJob(db, 'image_generation', derivation.treeId, {
        derivationId,
        treeId: derivation.treeId,
        carouselData: derivation.adaptedText,
      }, derivationId, PRIORITIES.IMAGE_GENERATION);
    }

    logger.info({ derivationId, mediaType: derivation.mediaType }, 'Derivation text validated, media queued');
  } else {
    // For image_1_1 (reuses master) or no media: mark as ready
    updateDerivationStatus(db, derivationId, 'ready');
    logger.info({ derivationId }, 'Derivation validated and ready');
  }

  // Check if all derivations are done → post recap
  await maybePostRecap(deps);
}

// ─── Step 3c: Handle derivation rejection ───

export async function handleDerivationRejection(
  interaction: ButtonInteraction,
  derivationId: number,
  deps: DerivationHandlerDeps,
): Promise<void> {
  const { db } = deps;

  updateDerivationStatus(db, derivationId, 'rejected');

  await replySplit(interaction, {
    content: '❌ Dérivation refusée.',
  } as never);

  await maybePostRecap(deps);
}

// ─── Step 3d: Handle media job completion (called by queue processor) ───

export async function processMediaJob(
  db: SqliteDatabase,
  jobPayload: {
    derivationId: number;
    treeId: number;
    masterMediaId?: number;
    masterText?: string;
    carouselData?: string;
  },
  jobType: string,
  productionChannel: TextChannel,
): Promise<unknown> {
  const logger = getLogger();
  const { derivationId, masterMediaId } = jobPayload;

  const derivation = getDerivation(db, derivationId);
  if (derivation === undefined) {
    throw new Error(`Derivation ${String(derivationId)} not found`);
  }

  const platformFormat = findPlatformFormat(derivation.platform, derivation.format);

  if (jobType === 'image_crop' && masterMediaId !== undefined) {
    // Get master image buffer from media table
    const mediaRow = db.prepare('SELECT local_path, postiz_path FROM media WHERE id = ?').get(masterMediaId) as
      { local_path: string | null; postiz_path: string | null } | undefined;

    if (mediaRow?.postiz_path !== undefined && mediaRow.postiz_path !== null) {
      // Fetch and crop the master image
      const response = await fetch(mediaRow.postiz_path);
      const buffer = Buffer.from(await response.arrayBuffer());
      const croppedBuffer = await cropToVertical(buffer);

      // Upload cropped version to Postiz
      const naming = `CROP-9-16-deriv-${String(derivationId)}.png`;
      const uploaded = await uploadMedia(croppedBuffer, naming);

      // Save to media table
      const result = db.prepare(`
        INSERT INTO media (type, generator, prompt, postiz_id, postiz_path, naming)
        VALUES ('image', 'crop', 'crop_9_16', ?, ?, ?)
      `).run(uploaded.id, uploaded.path, naming);

      updateDerivationMedia(db, derivationId, Number(result.lastInsertRowid));
      updateDerivationStatus(db, derivationId, 'media_generated');

      // Post in derivation thread
      if (derivation.discordThreadId !== null) {
        try {
          const thread = await productionChannel.threads.fetch(derivation.discordThreadId);
          if (thread !== null) {
            const payload = derivationMedia({
              derivationId,
              platform: platformFormat?.label ?? derivation.platform,
              emoji: platformFormat?.emoji ?? '📎',
              mediaUrl: uploaded.path,
              mediaType: 'Image 9:16 (crop)',
            });
            await sendSplit(thread as unknown as TextChannel, payload);
          }
        } catch {
          logger.warn({ derivationId, threadId: derivation.discordThreadId }, 'Could not post to derivation thread');
        }
      }

      logger.info({ derivationId, mediaType: 'image_crop' }, 'Crop media generated');
    }
  }

  // Video and carousel generation would follow similar patterns
  // but use generateVideoSegment() and generateImageVariants() respectively

  return { derivationId, jobType };
}

// ─── Helper: Post publication recap if all derivations are processed ───

async function maybePostRecap(deps: DerivationHandlerDeps): Promise<void> {
  const { db, publicationChannel } = deps;

  // Find active trees in deriving state
  const trees = db.prepare(
    'SELECT id FROM derivation_trees WHERE status = ?',
  ).all('deriving') as Array<{ id: number }>;

  for (const { id: treeId } of trees) {
    const derivations = getDerivationsByTree(db, treeId);
    const allProcessed = derivations.every(
      (d) => d.status === 'ready' || d.status === 'rejected' || d.status === 'text_validated' || d.status === 'media_generated',
    );

    if (!allProcessed) continue;

    const ready = getReadyDerivations(db, treeId);
    if (ready.length === 0) continue;

    const tree = getTree(db, treeId);
    if (tree === undefined) continue;

    // Post recap in #publication
    const cascade = getFilteredCascade(deps.configuredPlatforms);

    const recapDerivations = derivations.map((d) => {
      const pf = cascade.find((c) => c.platform === d.platform && c.format === d.format);
      const entry: { platform: string; emoji: string; format: string; status: string; scheduledAt?: string } = {
        platform: d.platform,
        emoji: pf?.emoji ?? '📎',
        format: d.format,
        status: d.status,
      };
      if (d.scheduledAt !== null) {
        entry.scheduledAt = d.scheduledAt;
      }
      return entry;
    });

    const payload = derivationRecap({
      treeId,
      masterTitle: tree.masterText.slice(0, 80),
      derivations: recapDerivations,
    });

    await sendSplit(publicationChannel, payload);

    // Update tree status
    updateTreeStatus(db, treeId, 'completed');
  }
}

// buildImagePrompt imported from production.ts (see top-level imports)

// ─── Helper: Check budget and send alerts ───

async function checkAndAlertBudget(db: SqliteDatabase, logsChannel: TextChannel): Promise<void> {
  const alerts = checkThresholds(db);
  for (const alert of alerts) {
    const payload = buildBudgetAlert(
      alert.period,
      alert.thresholdPercent,
      alert.costCents,
      alert.budgetCents,
    );
    await sendSplit(logsChannel, payload);
  }
}
