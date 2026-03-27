import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../../core/database.js';
import type { InstanceVeilleCategory } from '../../core/config.js';

// ─── Wizard Steps ───

export type WizardStep =
  | 'describe_project'
  | 'review_categories'
  | 'refine_categories'
  | 'dryrun_searxng'
  | 'choose_persona_tone'
  | 'review_persona_identity'
  | 'review_persona_tone'
  | 'review_persona_vocabulary'
  | 'review_persona_art_direction'
  | 'review_persona_examples'
  | 'configure_platforms'
  | 'configure_schedule'
  | 'confirm';

export const WIZARD_STEPS_ORDER: readonly WizardStep[] = [
  'describe_project',
  'review_categories',
  'refine_categories',
  'dryrun_searxng',
  'choose_persona_tone',
  'review_persona_identity',
  'review_persona_tone',
  'review_persona_vocabulary',
  'review_persona_art_direction',
  'review_persona_examples',
  'configure_platforms',
  'configure_schedule',
  'confirm',
] as const;

export function getStepIndex(step: WizardStep): number {
  return WIZARD_STEPS_ORDER.indexOf(step);
}

export function getStepLabel(step: WizardStep): string {
  return `${String(getStepIndex(step) + 1)}/${String(WIZARD_STEPS_ORDER.length)}`;
}

// ─── Wizard Data (accumulated through steps) ───

export interface WizardData {
  // From describe_project
  projectDescription?: string;
  projectName?: string;
  projectNiche?: string;
  projectLanguage?: string;
  projectPlatforms?: string[];

  // From review/refine categories
  categories?: InstanceVeilleCategory[];

  // From persona steps
  personaTone?: string;
  personaIdentity?: string;
  personaToneSection?: string;
  personaVocabulary?: string;
  personaArtDirection?: string;
  personaExamples?: string;
  personaFull?: string;

  // From configure_platforms
  platforms?: string[];
  formats?: string[];

  // From configure_schedule
  veilleCron?: string;
  suggestionsCron?: string;
  rapportCron?: string;

  // Instance name (derived from projectName)
  instanceName?: string;
}

// ─── Wizard Session ───

export interface WizardSession {
  readonly id: string;
  readonly guildId: string;
  readonly userId: string;
  step: WizardStep;
  data: WizardData;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  tokensUsed: number;
  iterationCount: number;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

const MAX_ITERATIONS = 20;
const SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

// ─── Session CRUD ───

export function createWizardSession(
  globalDb: SqliteDatabase,
  guildId: string,
  userId: string,
): WizardSession {
  const session: WizardSession = {
    id: randomUUID(),
    guildId,
    userId,
    step: 'describe_project',
    data: {},
    conversationHistory: [],
    tokensUsed: 0,
    iterationCount: 0,
    expiresAt: new Date(Date.now() + SESSION_TIMEOUT_MS),
    createdAt: new Date(),
  };

  globalDb.prepare(`
    INSERT INTO wizard_sessions (id, guild_id, user_id, step, data, conversation_history, tokens_used, iteration_count, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    session.id,
    session.guildId,
    session.userId,
    session.step,
    JSON.stringify(session.data),
    JSON.stringify(session.conversationHistory),
    session.tokensUsed,
    session.iterationCount,
    session.expiresAt.toISOString(),
  );

  return session;
}

export function saveWizardSession(globalDb: SqliteDatabase, session: WizardSession): void {
  globalDb.prepare(`
    UPDATE wizard_sessions
    SET step = ?, data = ?, conversation_history = ?, tokens_used = ?, iteration_count = ?
    WHERE id = ?
  `).run(
    session.step,
    JSON.stringify(session.data),
    JSON.stringify(session.conversationHistory),
    session.tokensUsed,
    session.iterationCount,
    session.id,
  );
}

export function getActiveWizardSession(
  globalDb: SqliteDatabase,
  guildId: string,
  userId: string,
): WizardSession | undefined {
  const row = globalDb.prepare(`
    SELECT * FROM wizard_sessions
    WHERE guild_id = ? AND user_id = ? AND expires_at > datetime('now')
    ORDER BY created_at DESC LIMIT 1
  `).get(guildId, userId) as {
    id: string;
    guild_id: string;
    user_id: string;
    step: string;
    data: string;
    conversation_history: string;
    tokens_used: number;
    iteration_count: number;
    expires_at: string;
    created_at: string;
  } | undefined;

  if (row === undefined) return undefined;

  return {
    id: row.id,
    guildId: row.guild_id,
    userId: row.user_id,
    step: row.step as WizardStep,
    data: JSON.parse(row.data) as WizardData,
    conversationHistory: JSON.parse(row.conversation_history) as Array<{ role: 'user' | 'assistant'; content: string }>,
    tokensUsed: row.tokens_used,
    iterationCount: row.iteration_count,
    expiresAt: new Date(row.expires_at),
    createdAt: new Date(row.created_at),
  };
}

export function deleteWizardSession(globalDb: SqliteDatabase, sessionId: string): void {
  globalDb.prepare('DELETE FROM wizard_sessions WHERE id = ?').run(sessionId);
}

export function cleanExpiredSessions(globalDb: SqliteDatabase): number {
  const result = globalDb.prepare(
    "DELETE FROM wizard_sessions WHERE expires_at <= datetime('now')",
  ).run();
  return result.changes;
}

// ─── Step Navigation ───

export function advanceStep(session: WizardSession): WizardStep | null {
  const currentIndex = getStepIndex(session.step);
  const nextIndex = currentIndex + 1;

  if (nextIndex >= WIZARD_STEPS_ORDER.length) {
    return null; // Wizard complete
  }

  const nextStep = WIZARD_STEPS_ORDER[nextIndex];
  if (nextStep === undefined) return null;

  session.step = nextStep;
  return nextStep;
}

export function goToStep(session: WizardSession, step: WizardStep): void {
  session.step = step;
}

export function canIterate(session: WizardSession): boolean {
  return session.iterationCount < MAX_ITERATIONS;
}

export function recordIteration(session: WizardSession, tokensIn: number, tokensOut: number): void {
  session.iterationCount++;
  session.tokensUsed += tokensIn + tokensOut;
}

// ─── DM Message Tracking ───

export function trackDmMessageId(session: WizardSession, messageId: string): void {
  const data = session.data as Record<string, unknown>;
  const ids = (data['_dmMessageIds'] as string[] | undefined) ?? [];
  ids.push(messageId);
  data['_dmMessageIds'] = ids;
}

export function getDmMessageIds(session: WizardSession): string[] {
  return ((session.data as Record<string, unknown>)['_dmMessageIds'] as string[] | undefined) ?? [];
}

export function addToHistory(
  session: WizardSession,
  role: 'user' | 'assistant',
  content: string,
): void {
  session.conversationHistory.push({ role, content });
  // Keep history manageable — last 20 messages
  if (session.conversationHistory.length > 20) {
    session.conversationHistory = session.conversationHistory.slice(-20);
  }
}
