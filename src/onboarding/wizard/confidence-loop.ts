import { complete } from '../../services/anthropic.js';
import { getLogger } from '../../core/logger.js';
import type { WizardSession } from './state-machine.js';
import type { SiteAnalysis } from './site-scraper.js';
import {
  type V2MessagePayload,
  buildContainer, txt, sep, v2, getColor,
} from '../../discord/component-builder-v2.js';

// ─── Types ───

export interface ConfidenceResult {
  readonly confidence: number;
  readonly question: string | null;
  readonly insights: string[];
  readonly negativeKeywords: string[];
  readonly includeKeywords: string[];
  readonly includeDomains: string[];
  readonly excludeDomains: string[];
  readonly targetAudience: string;
  readonly productPositioning: string;
}

// ─── Constants ───

const MIN_QUESTIONS = 5;
const MAX_QUESTIONS = 30;
const CONFIDENCE_THRESHOLD = 80;

// ─── Core function ───

/**
 * Ask the LLM to evaluate its understanding of the project and generate the next question.
 * Returns the confidence level and either a question (if < threshold) or null (if satisfied).
 */
export async function evaluateAndAsk(
  session: WizardSession,
  siteAnalysis: SiteAnalysis | undefined,
  questionNumber: number,
): Promise<ConfidenceResult> {
  const logger = getLogger();

  const context = buildContext(session, siteAnalysis);
  const history = getQuestionHistory(session);

  const systemPrompt = `You are an expert marketing strategist analyzing a project to set up automated content monitoring (veille) and social media content generation.

Your goal: understand the project deeply enough to configure an AI system that will:
1. Monitor the web for relevant content (news, trends, discussions)
2. Filter out irrelevant noise
3. Generate content ideas for social media (TikTok, Instagram, YouTube Shorts)
4. Promote the product effectively

You must evaluate your CONFIDENCE LEVEL (0-100%) in your understanding of:
- What the product/service does and its unique value proposition
- Who the target audience is (demographics, interests, online behavior)
- What content topics are relevant vs irrelevant
- What competitors exist and how the product differentiates
- What tone and style should be used for social media content

RULES:
- Ask ONE focused question at a time
- Questions should be specific, not generic
- Build on previous answers — don't repeat
- Focus on what you DON'T know yet
- Generate useful metadata (keywords, domains, audience) from each answer
- ${questionNumber < MIN_QUESTIONS ? `You MUST ask a question (minimum ${String(MIN_QUESTIONS)} questions required)` : `If confidence >= ${String(CONFIDENCE_THRESHOLD)}%, you may stop asking`}

Return ONLY valid JSON:
{
  "confidence": <number 0-100>,
  "question": "<your next question, or null if confidence >= ${String(CONFIDENCE_THRESHOLD)}% and questions >= ${String(MIN_QUESTIONS)}>",
  "insights": ["<insight extracted from latest answer>", ...],
  "negativeKeywords": ["<keywords that indicate IRRELEVANT content>", ...],
  "includeKeywords": ["<EN keywords for content monitoring>", ...],
  "includeDomains": ["<relevant domains to monitor>", ...],
  "excludeDomains": ["<domains to exclude>", ...],
  "targetAudience": "<updated audience description>",
  "productPositioning": "<updated product positioning>"
}`;

  const userMessage = `${context}

${history}

Question number: ${String(questionNumber)} / ${String(MAX_QUESTIONS)}
${questionNumber >= MAX_QUESTIONS ? 'MAXIMUM QUESTIONS REACHED — you must finalize now (set question to null).' : ''}`;

  const response = await complete(systemPrompt, userMessage, {
    maxTokens: 2048,
    temperature: 0.5,
    task: 'onboarding',
  });

  try {
    const jsonMatch = response.text.match(/\{[\s\S]*\}/);
    if (jsonMatch === null) throw new Error('No JSON in response');

    const parsed = JSON.parse(jsonMatch[0]) as ConfidenceResult;

    // Enforce min questions
    if (questionNumber < MIN_QUESTIONS && parsed.question === null) {
      return { ...parsed, confidence: Math.min(parsed.confidence, CONFIDENCE_THRESHOLD - 1), question: parsed.question ?? 'Can you describe your ideal customer in detail?' };
    }

    // Enforce max questions
    if (questionNumber >= MAX_QUESTIONS) {
      return { ...parsed, question: null };
    }

    logger.info({ confidence: parsed.confidence, questionNumber, hasQuestion: parsed.question !== null }, 'Confidence loop evaluation');
    return parsed;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, 'Failed to parse confidence loop response');
    return {
      confidence: 0,
      question: 'Could you describe what your product or service does in a few sentences?',
      insights: [],
      negativeKeywords: [],
      includeKeywords: [],
      includeDomains: [],
      excludeDomains: [],
      targetAudience: '',
      productPositioning: '',
    };
  }
}

/**
 * Check if the confidence loop is complete.
 */
export function isConfidenceReached(confidence: number, questionNumber: number): boolean {
  return (confidence >= CONFIDENCE_THRESHOLD && questionNumber >= MIN_QUESTIONS) || questionNumber >= MAX_QUESTIONS;
}

// ─── UI builders ───

/**
 * Build the question display with progress bar.
 */
export function buildQuestionMessage(
  question: string,
  confidence: number,
  questionNumber: number,
): V2MessagePayload {
  const barLength = 20;
  const filled = Math.round((confidence / 100) * barLength);
  const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);

  return v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt([
      `## 📊 Compréhension du projet : ${String(confidence)}%`,
      bar,
      '',
      `**Question ${String(questionNumber)}/${String(MAX_QUESTIONS)} :**`,
      '',
      question,
      '',
      '*Réponds directement dans ce chat.*',
    ].join('\n')));
  })]);
}

/**
 * Build the final profile summary for validation.
 */
export function buildProfileSummary(
  session: WizardSession,
  confidence: number,
  siteAnalysis: SiteAnalysis | undefined,
): V2MessagePayload {
  const data = session.data;
  const enrichment = getEnrichmentData(session);

  const lines: string[] = [
    `## 📋 Profil compilé (confiance : ${String(confidence)}%)`,
    '',
    `🏢 **Projet** : ${data.projectName ?? '(non défini)'}`,
    `🌐 **Site** : ${data.projectUrl ?? '(aucun)'}`,
    `🎯 **Niche** : ${data.projectNiche ?? '(non définie)'}`,
    `📱 **Plateformes** : ${(data.projectPlatforms ?? []).join(', ') || '(non définies)'}`,
    `📝 **Types de contenu** : ${(data.contentTypes ?? []).join(', ') || '(non définis)'}`,
  ];

  if (siteAnalysis !== undefined && siteAnalysis.productDescription.length > 0) {
    lines.push('', `📦 **Produit** : ${siteAnalysis.productDescription.slice(0, 200)}`);
    if (siteAnalysis.targetAudience.length > 0) {
      lines.push(`👥 **Public cible** : ${siteAnalysis.targetAudience.slice(0, 200)}`);
    }
  }

  if (enrichment.targetAudience.length > 0) {
    lines.push(`👥 **Public cible (enrichi)** : ${enrichment.targetAudience.slice(0, 200)}`);
  }
  if (enrichment.productPositioning.length > 0) {
    lines.push(`🎯 **Positionnement** : ${enrichment.productPositioning.slice(0, 200)}`);
  }

  if (enrichment.includeKeywords.length > 0) {
    lines.push('', `✅ **Keywords veille (EN)** : ${enrichment.includeKeywords.slice(0, 15).join(', ')}`);
  }
  if (enrichment.negativeKeywords.length > 0) {
    lines.push(`❌ **Mots exclus** : ${enrichment.negativeKeywords.slice(0, 15).join(', ')}`);
  }
  if (enrichment.includeDomains.length > 0) {
    lines.push(`🌐 **Domaines inclus** : ${enrichment.includeDomains.slice(0, 10).join(', ')}`);
  }

  const insights = enrichment.insights;
  if (insights.length > 0) {
    lines.push('', '💡 **Insights clés** :');
    for (const insight of insights.slice(0, 5)) {
      lines.push(`  • ${insight}`);
    }
  }

  return v2([buildContainer(getColor('success'), (c) => {
    c.addTextDisplayComponents(txt(lines.join('\n')));
    c.addSeparatorComponents(sep());
  })]);
}

// ─── Session data helpers ───

interface EnrichmentData {
  negativeKeywords: string[];
  includeKeywords: string[];
  includeDomains: string[];
  excludeDomains: string[];
  targetAudience: string;
  productPositioning: string;
  insights: string[];
  confidence: number;
  questionCount: number;
}

const ENRICHMENT_KEY = '_enrichment';

export function getEnrichmentData(session: WizardSession): EnrichmentData {
  const raw = (session.data as Record<string, unknown>)[ENRICHMENT_KEY] as EnrichmentData | undefined;
  return raw ?? {
    negativeKeywords: [],
    includeKeywords: [],
    includeDomains: [],
    excludeDomains: [],
    targetAudience: '',
    productPositioning: '',
    insights: [],
    confidence: 0,
    questionCount: 0,
  };
}

export function updateEnrichmentFromResult(session: WizardSession, result: ConfidenceResult): void {
  const current = getEnrichmentData(session);

  // Merge arrays (deduplicate)
  const mergeUnique = (existing: string[], incoming: string[]): string[] =>
    [...new Set([...existing, ...incoming])];

  const updated: EnrichmentData = {
    negativeKeywords: mergeUnique(current.negativeKeywords, result.negativeKeywords),
    includeKeywords: mergeUnique(current.includeKeywords, result.includeKeywords),
    includeDomains: mergeUnique(current.includeDomains, result.includeDomains),
    excludeDomains: mergeUnique(current.excludeDomains, result.excludeDomains),
    targetAudience: result.targetAudience.length > 0 ? result.targetAudience : current.targetAudience,
    productPositioning: result.productPositioning.length > 0 ? result.productPositioning : current.productPositioning,
    insights: mergeUnique(current.insights, result.insights),
    confidence: result.confidence,
    questionCount: current.questionCount + 1,
  };

  (session.data as Record<string, unknown>)[ENRICHMENT_KEY] = updated;
}

/**
 * Apply enrichment data to session.data fields used by the rest of the pipeline.
 */
export function applyEnrichmentToSession(session: WizardSession): void {
  const enrichment = getEnrichmentData(session);

  // Merge into existing session data (don't overwrite user-provided values)
  const existing = session.data;

  if (enrichment.negativeKeywords.length > 0) {
    const merged = [...new Set([...(existing.negativeKeywords ?? []), ...enrichment.negativeKeywords])];
    session.data.negativeKeywords = merged;
  }
  if (enrichment.includeDomains.length > 0) {
    const merged = [...new Set([...(existing.includeDomains ?? []), ...enrichment.includeDomains])];
    session.data.includeDomains = merged;
  }
  if (enrichment.excludeDomains.length > 0) {
    const merged = [...new Set([...(existing.excludeDomains ?? []), ...enrichment.excludeDomains])];
    session.data.excludeDomains = merged;
  }
  if (enrichment.insights.length > 0) {
    const ctx = existing.onboardingContext ?? '';
    const insightsText = enrichment.insights.join('. ');
    session.data.onboardingContext = ctx.length > 0 ? `${ctx}\n\n${insightsText}` : insightsText;
  }
}

// ─── Context builder ───

function buildContext(session: WizardSession, siteAnalysis: SiteAnalysis | undefined): string {
  const data = session.data;
  const parts: string[] = [];

  parts.push('=== PROJECT INFORMATION ===');
  if (data.projectName !== undefined) parts.push(`Name: ${data.projectName}`);
  if (data.projectNiche !== undefined) parts.push(`Niche: ${data.projectNiche}`);
  if (data.projectUrl !== undefined) parts.push(`Website: ${data.projectUrl}`);
  if (data.projectDescription !== undefined) parts.push(`Description: ${data.projectDescription}`);
  if (data.contentTypes !== undefined) parts.push(`Content types: ${data.contentTypes.join(', ')}`);
  if (data.projectPlatforms !== undefined) parts.push(`Target platforms: ${data.projectPlatforms.join(', ')}`);

  if (siteAnalysis !== undefined && siteAnalysis.rawContent.length > 0) {
    parts.push('', '=== WEBSITE ANALYSIS ===');
    if (siteAnalysis.productDescription.length > 0) parts.push(`Product: ${siteAnalysis.productDescription}`);
    if (siteAnalysis.targetAudience.length > 0) parts.push(`Audience: ${siteAnalysis.targetAudience}`);
    if (siteAnalysis.communicationTone.length > 0) parts.push(`Tone: ${siteAnalysis.communicationTone}`);
    if (siteAnalysis.competitors.length > 0) parts.push(`Competitors: ${siteAnalysis.competitors.join(', ')}`);
    if (siteAnalysis.keywords.length > 0) parts.push(`Keywords: ${siteAnalysis.keywords.join(', ')}`);
  }

  const enrichment = getEnrichmentData(session);
  if (enrichment.insights.length > 0) {
    parts.push('', '=== ACCUMULATED INSIGHTS ===');
    for (const insight of enrichment.insights) {
      parts.push(`- ${insight}`);
    }
  }

  return parts.join('\n');
}

function getQuestionHistory(session: WizardSession): string {
  const history = session.conversationHistory;
  if (history.length === 0) return 'No questions asked yet.';

  const parts: string[] = ['=== CONVERSATION HISTORY ==='];
  for (const entry of history) {
    const label = entry.role === 'assistant' ? 'Q' : 'A';
    parts.push(`${label}: ${entry.content}`);
  }
  return parts.join('\n');
}
