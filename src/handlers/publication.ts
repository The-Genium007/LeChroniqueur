import type { TextChannel } from 'discord.js';
import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';
import { schedulePost, listIntegrations, type PostizPostPayload } from '../services/postiz.js';
import { indexDocument } from '../search/engine.js';
import {
  publicationConfirmation as buildPublicationConfirmation,
  errorMessage,
} from '../discord/message-builder.js';

interface PublicationDeps {
  readonly db: SqliteDatabase;
  readonly publicationChannel: TextChannel;
  readonly logsChannel: TextChannel;
}

export async function handlePublish(
  suggestionId: number,
  scheduledDate: Date,
  deps: PublicationDeps,
): Promise<void> {
  const logger = getLogger();
  const { db, publicationChannel, logsChannel } = deps;

  // Get suggestion data
  const suggestion = db.prepare(`
    SELECT id, content, platform, format FROM suggestions WHERE id = ?
  `).get(suggestionId) as {
    id: number;
    content: string;
    platform: string;
    format: string | null;
  } | undefined;

  if (suggestion === undefined) {
    logger.error({ suggestionId }, 'Suggestion not found for publication');
    return;
  }

  // Get media associated with this suggestion
  const media = db.prepare(`
    SELECT postiz_id, postiz_path FROM media
    WHERE publication_id = ? AND postiz_id IS NOT NULL
  `).all(suggestionId) as Array<{ postiz_id: string; postiz_path: string }>;

  // Get integrations for the target platform
  let integrations;
  try {
    integrations = await listIntegrations();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, 'Failed to list Postiz integrations');
    const payload = errorMessage(`Impossible de lister les intégrations Postiz : ${msg}`);
    await logsChannel.send({ embeds: payload.embeds });
    return;
  }

  // Filter integrations by platform
  const platformMap: Record<string, string> = {
    tiktok: 'tiktok',
    instagram: 'instagram',
    both: 'instagram', // Post to Instagram first, TikTok handled separately
  };

  const targetPlatform = platformMap[suggestion.platform] ?? 'instagram';
  const matchingIntegrations = integrations.filter(
    (i) => i.identifier === targetPlatform && !i.disabled,
  );

  if (matchingIntegrations.length === 0) {
    logger.warn({ platform: targetPlatform }, 'No active integration found for platform');
    const payload = errorMessage(`Aucune intégration active trouvée pour ${targetPlatform}. Configure-la dans Postiz.`);
    await publicationChannel.send({ embeds: payload.embeds });
    return;
  }

  const integration = matchingIntegrations[0];
  if (integration === undefined) {
    return;
  }

  // Build Postiz payload
  const postPayload: PostizPostPayload = {
    type: 'schedule',
    date: scheduledDate.toISOString(),
    posts: [
      {
        integration: { id: integration.id },
        value: [
          {
            content: extractPostText(suggestion.content),
            image: media.length > 0
              ? media.map((m) => ({ id: m.postiz_id, name: '', path: m.postiz_path }))
              : undefined,
          },
        ],
        settings: { __type: targetPlatform },
      },
    ],
  };

  try {
    const results = await schedulePost(postPayload);

    const postizPostId = results[0]?.postId;

    // Save publication in database
    const pubResult = db.prepare(`
      INSERT INTO publications (suggestion_id, postiz_post_id, platform, scheduled_at, content, media_ids, status)
      VALUES (?, ?, ?, ?, ?, ?, 'scheduled')
    `).run(
      suggestionId,
      postizPostId ?? null,
      targetPlatform,
      scheduledDate.toISOString(),
      suggestion.content,
      media.length > 0 ? JSON.stringify(media.map((m) => m.postiz_id)) : null,
    );

    const pubId = Number(pubResult.lastInsertRowid);

    // Index for search
    indexDocument(db, {
      title: `Publication ${targetPlatform} — ${scheduledDate.toLocaleDateString('fr-FR')}`,
      snippet: extractPostText(suggestion.content).slice(0, 200),
      content: suggestion.content,
      sourceTable: 'publications',
      sourceId: pubId,
    });

    // Increment metrics
    db.prepare(`
      INSERT INTO metrics (date, publications_count) VALUES (date('now'), 1)
      ON CONFLICT(date) DO UPDATE SET publications_count = publications_count + 1
    `).run();

    // Confirm in #publication
    const payload = buildPublicationConfirmation({
      platform: targetPlatform,
      scheduledAt: scheduledDate.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }),
      postizPostId: postizPostId ?? 'inconnu',
      content: extractPostText(suggestion.content).slice(0, 200),
    });

    await publicationChannel.send({ embeds: payload.embeds });

    logger.info(
      { pubId, platform: targetPlatform, scheduledAt: scheduledDate.toISOString() },
      'Publication scheduled',
    );

    // Handle "both" platform — also schedule for TikTok
    if (suggestion.platform === 'both') {
      const tiktokIntegrations = integrations.filter(
        (i) => i.identifier === 'tiktok' && !i.disabled,
      );

      if (tiktokIntegrations.length > 0 && tiktokIntegrations[0] !== undefined) {
        const tiktokPayload: PostizPostPayload = {
          ...postPayload,
          posts: [
            {
              ...postPayload.posts[0]!,
              integration: { id: tiktokIntegrations[0].id },
              settings: { __type: 'tiktok' },
            },
          ],
        };

        await schedulePost(tiktokPayload);
        logger.info('Also scheduled for TikTok');
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg, suggestionId }, 'Publication scheduling failed');
    const payload = errorMessage(`Erreur de publication : ${msg}`);
    await publicationChannel.send({ embeds: payload.embeds });
  }
}

function extractPostText(content: string): string {
  // Remove markdown formatting for social media post
  return content
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .trim();
}
