import type { SqliteDatabase } from '../core/database.js';
import { getLogger } from '../core/logger.js';

// ─── Types ───

export type DerivationTreeStatus =
  | 'draft'
  | 'master_validated'
  | 'deriving'
  | 'completed'
  | 'invalidated';

export type DerivationStatus =
  | 'pending'
  | 'text_generated'
  | 'text_validated'
  | 'media_generating'
  | 'media_generated'
  | 'media_validated'
  | 'ready'
  | 'scheduled'
  | 'published'
  | 'rejected';

export interface DerivationTree {
  readonly id: number;
  readonly suggestionId: number;
  readonly masterText: string;
  readonly masterImagePrompt: string | null;
  readonly masterMediaId: number | null;
  readonly status: DerivationTreeStatus;
  readonly discordMessageId: string | null;
  readonly createdAt: string;
  readonly validatedAt: string | null;
  readonly invalidatedAt: string | null;
}

export interface Derivation {
  readonly id: number;
  readonly treeId: number;
  readonly platform: string;
  readonly format: string;
  readonly adaptedText: string | null;
  readonly mediaType: string | null;
  readonly mediaPrompt: string | null;
  readonly mediaId: number | null;
  readonly status: DerivationStatus;
  readonly postizPostId: string | null;
  readonly discordThreadId: string | null;
  readonly discordMessageId: string | null;
  readonly scheduledAt: string | null;
  readonly publishedAt: string | null;
  readonly createdAt: string;
  readonly validatedAt: string | null;
  readonly rejectedAt: string | null;
  readonly modificationNotes: string | null;
}

// ─── Row types (DB snake_case) ───

interface DerivationTreeRow {
  id: number;
  suggestion_id: number;
  master_text: string;
  master_image_prompt: string | null;
  master_media_id: number | null;
  status: string;
  discord_message_id: string | null;
  created_at: string;
  validated_at: string | null;
  invalidated_at: string | null;
}

interface DerivationRow {
  id: number;
  tree_id: number;
  platform: string;
  format: string;
  adapted_text: string | null;
  media_type: string | null;
  media_prompt: string | null;
  media_id: number | null;
  status: string;
  postiz_post_id: string | null;
  discord_thread_id: string | null;
  discord_message_id: string | null;
  scheduled_at: string | null;
  published_at: string | null;
  created_at: string;
  validated_at: string | null;
  rejected_at: string | null;
  modification_notes: string | null;
}

// ─── Row mappers ───

function mapTreeRow(row: DerivationTreeRow): DerivationTree {
  return {
    id: row.id,
    suggestionId: row.suggestion_id,
    masterText: row.master_text,
    masterImagePrompt: row.master_image_prompt,
    masterMediaId: row.master_media_id,
    status: row.status as DerivationTreeStatus,
    discordMessageId: row.discord_message_id,
    createdAt: row.created_at,
    validatedAt: row.validated_at,
    invalidatedAt: row.invalidated_at,
  };
}

function mapDerivationRow(row: DerivationRow): Derivation {
  return {
    id: row.id,
    treeId: row.tree_id,
    platform: row.platform,
    format: row.format,
    adaptedText: row.adapted_text,
    mediaType: row.media_type,
    mediaPrompt: row.media_prompt,
    mediaId: row.media_id,
    status: row.status as DerivationStatus,
    postizPostId: row.postiz_post_id,
    discordThreadId: row.discord_thread_id,
    discordMessageId: row.discord_message_id,
    scheduledAt: row.scheduled_at,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    validatedAt: row.validated_at,
    rejectedAt: row.rejected_at,
    modificationNotes: row.modification_notes,
  };
}

// ─── Tree CRUD ───

export function createTree(
  db: SqliteDatabase,
  suggestionId: number,
  masterText: string,
  masterImagePrompt?: string,
): DerivationTree {
  const logger = getLogger();

  const result = db.prepare(`
    INSERT INTO derivation_trees (suggestion_id, master_text, master_image_prompt, status)
    VALUES (?, ?, ?, 'draft')
  `).run(suggestionId, masterText, masterImagePrompt ?? null);

  const id = Number(result.lastInsertRowid);
  logger.info({ treeId: id, suggestionId }, 'Derivation tree created');

  const tree = getTree(db, id);
  if (tree === undefined) {
    throw new Error(`Failed to retrieve newly created derivation tree ${String(id)}`);
  }
  return tree;
}

export function getTree(db: SqliteDatabase, id: number): DerivationTree | undefined {
  const row = db.prepare('SELECT * FROM derivation_trees WHERE id = ?').get(id) as DerivationTreeRow | undefined;
  return row !== undefined ? mapTreeRow(row) : undefined;
}

export function getTreeBySuggestion(db: SqliteDatabase, suggestionId: number): DerivationTree | undefined {
  const row = db.prepare(
    'SELECT * FROM derivation_trees WHERE suggestion_id = ? AND status != ? ORDER BY id DESC LIMIT 1',
  ).get(suggestionId, 'invalidated') as DerivationTreeRow | undefined;
  return row !== undefined ? mapTreeRow(row) : undefined;
}

export function updateTreeStatus(
  db: SqliteDatabase,
  id: number,
  status: DerivationTreeStatus,
): void {
  const extra = status === 'master_validated' ? ', validated_at = CURRENT_TIMESTAMP' :
    status === 'invalidated' ? ', invalidated_at = CURRENT_TIMESTAMP' : '';

  db.prepare(`UPDATE derivation_trees SET status = ?${extra} WHERE id = ?`).run(status, id);
}

export function updateTreeMaster(
  db: SqliteDatabase,
  id: number,
  masterText: string,
  masterImagePrompt?: string,
): void {
  db.prepare(`
    UPDATE derivation_trees
    SET master_text = ?, master_image_prompt = COALESCE(?, master_image_prompt)
    WHERE id = ?
  `).run(masterText, masterImagePrompt ?? null, id);
}

export function updateTreeMediaId(db: SqliteDatabase, id: number, mediaId: number): void {
  db.prepare('UPDATE derivation_trees SET master_media_id = ? WHERE id = ?').run(mediaId, id);
}

export function updateTreeDiscordMessageId(db: SqliteDatabase, id: number, messageId: string): void {
  db.prepare('UPDATE derivation_trees SET discord_message_id = ? WHERE id = ?').run(messageId, id);
}

// ─── Derivation CRUD ───

export function createDerivation(
  db: SqliteDatabase,
  treeId: number,
  platform: string,
  format: string,
  mediaType: string,
): Derivation {
  const result = db.prepare(`
    INSERT INTO derivations (tree_id, platform, format, media_type, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(treeId, platform, format, mediaType);

  const derivation = getDerivation(db, Number(result.lastInsertRowid));
  if (derivation === undefined) {
    throw new Error(`Failed to retrieve newly created derivation ${String(Number(result.lastInsertRowid))}`);
  }
  return derivation;
}

export function getDerivation(db: SqliteDatabase, id: number): Derivation | undefined {
  const row = db.prepare('SELECT * FROM derivations WHERE id = ?').get(id) as DerivationRow | undefined;
  return row !== undefined ? mapDerivationRow(row) : undefined;
}

export function getDerivationsByTree(db: SqliteDatabase, treeId: number): readonly Derivation[] {
  const rows = db.prepare('SELECT * FROM derivations WHERE tree_id = ? ORDER BY id').all(treeId) as DerivationRow[];
  return rows.map(mapDerivationRow);
}

export function getDerivationsByStatus(
  db: SqliteDatabase,
  treeId: number,
  status: DerivationStatus,
): readonly Derivation[] {
  const rows = db.prepare(
    'SELECT * FROM derivations WHERE tree_id = ? AND status = ? ORDER BY id',
  ).all(treeId, status) as DerivationRow[];
  return rows.map(mapDerivationRow);
}

export function getReadyDerivations(db: SqliteDatabase, treeId: number): readonly Derivation[] {
  const rows = db.prepare(
    'SELECT * FROM derivations WHERE tree_id = ? AND status IN (?, ?) ORDER BY id',
  ).all(treeId, 'ready', 'text_validated') as DerivationRow[];
  return rows.map(mapDerivationRow);
}

export function updateDerivationStatus(
  db: SqliteDatabase,
  id: number,
  status: DerivationStatus,
): void {
  const extra = status === 'text_validated' || status === 'media_validated' || status === 'ready'
    ? ', validated_at = CURRENT_TIMESTAMP'
    : status === 'rejected'
      ? ', rejected_at = CURRENT_TIMESTAMP'
      : '';

  db.prepare(`UPDATE derivations SET status = ?${extra} WHERE id = ?`).run(status, id);
}

export function updateDerivationText(db: SqliteDatabase, id: number, text: string): void {
  db.prepare('UPDATE derivations SET adapted_text = ? WHERE id = ?').run(text, id);
}

export function updateDerivationMedia(
  db: SqliteDatabase,
  id: number,
  mediaId: number,
  mediaPrompt?: string,
): void {
  db.prepare(`
    UPDATE derivations SET media_id = ?, media_prompt = COALESCE(?, media_prompt) WHERE id = ?
  `).run(mediaId, mediaPrompt ?? null, id);
}

export function updateDerivationDiscord(
  db: SqliteDatabase,
  id: number,
  threadId: string,
  messageId?: string,
): void {
  db.prepare(`
    UPDATE derivations SET discord_thread_id = ?, discord_message_id = COALESCE(?, discord_message_id) WHERE id = ?
  `).run(threadId, messageId ?? null, id);
}

export function updateDerivationPostiz(db: SqliteDatabase, id: number, postizPostId: string): void {
  db.prepare('UPDATE derivations SET postiz_post_id = ? WHERE id = ?').run(postizPostId, id);
}

export function updateDerivationSchedule(db: SqliteDatabase, id: number, scheduledAt: string): void {
  db.prepare('UPDATE derivations SET scheduled_at = ? WHERE id = ?').run(scheduledAt, id);
}

// ─── Invalidation ───

export function invalidateAllDerivations(db: SqliteDatabase, treeId: number): number {
  const logger = getLogger();

  const result = db.prepare(`
    UPDATE derivations SET status = 'rejected', rejected_at = CURRENT_TIMESTAMP
    WHERE tree_id = ? AND status NOT IN ('rejected', 'published')
  `).run(treeId);

  logger.info({ treeId, invalidated: result.changes }, 'All derivations invalidated');

  return result.changes;
}

// ─── Stats ───

export function getTreeStats(db: SqliteDatabase, treeId: number): {
  total: number;
  pending: number;
  validated: number;
  rejected: number;
  ready: number;
  scheduled: number;
  published: number;
} {
  const rows = db.prepare(`
    SELECT status, COUNT(*) as count FROM derivations WHERE tree_id = ? GROUP BY status
  `).all(treeId) as Array<{ status: string; count: number }>;

  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.status] = row.count;
  }

  return {
    total: rows.reduce((sum, r) => sum + r.count, 0),
    pending: counts['pending'] ?? 0,
    validated: (counts['text_validated'] ?? 0) + (counts['media_validated'] ?? 0),
    rejected: counts['rejected'] ?? 0,
    ready: counts['ready'] ?? 0,
    scheduled: counts['scheduled'] ?? 0,
    published: counts['published'] ?? 0,
  };
}
