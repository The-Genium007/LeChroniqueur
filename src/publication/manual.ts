import type { TextChannel } from 'discord.js';
import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';
import { publicationKit, type V2PublicationKit } from '../discord/component-builder-v2.js';
import { sendSplit } from '../discord/message-splitter.js';

/**
 * Mode 1 — Manual publication kit.
 * The bot prepares everything (caption, hashtags, media) in a ready-to-copy format.
 * The user copies and publishes manually on each platform.
 */
export async function postPublicationKit(
  channel: TextChannel,
  db: SqliteDatabase,
  suggestionId: number,
): Promise<void> {
  const logger = getLogger();

  // Fetch the suggestion + script data
  const suggestion = db.prepare(`
    SELECT s.id, s.platform, s.content, p.content AS script_content,
           p.media_ids, p.scheduled_at
    FROM suggestions s
    LEFT JOIN publications p ON p.suggestion_id = s.id
    WHERE s.id = ?
    ORDER BY p.created_at DESC LIMIT 1
  `).get(suggestionId) as {
    id: number;
    platform: string;
    content: string;
    script_content: string | null;
    media_ids: string | null;
    scheduled_at: string | null;
  } | undefined;

  if (suggestion === undefined) {
    logger.warn({ suggestionId }, 'Suggestion not found for publication kit');
    return;
  }

  // Extract caption and hashtags from the script content
  const scriptContent = suggestion.script_content ?? suggestion.content;
  const { caption, hashtags } = extractCaptionAndHashtags(scriptContent);

  const kitData: V2PublicationKit = {
    id: suggestion.id,
    platform: suggestion.platform,
    suggestedTime: suggestion.scheduled_at ?? 'non définie',
    caption,
    hashtags,
    notes: '',
  };

  const payload = publicationKit(kitData);

  await sendSplit(channel, payload);

  logger.info({ suggestionId, platform: suggestion.platform }, 'Publication kit posted');
}

/**
 * Extract caption and hashtags from a script content string.
 */
function extractCaptionAndHashtags(content: string): { caption: string; hashtags: string } {
  const lines = content.split('\n');
  const hashtagLines: string[] = [];
  const captionLines: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith('#') && !line.trim().startsWith('##')) {
      // Looks like hashtags (starts with # but not a markdown heading)
      hashtagLines.push(line.trim());
    } else {
      captionLines.push(line);
    }
  }

  return {
    caption: captionLines.join('\n').trim(),
    hashtags: hashtagLines.join(' ').trim(),
  };
}
