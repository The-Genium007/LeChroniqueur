import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawArticle } from '../../src/veille/collector.js';
import type { AnthropicResponse } from '../../src/services/anthropic.js';
import type { PreferenceEntryData } from '../../src/discord/message-builder.js';

// Mock Anthropic
const mockComplete = vi.fn<(system: string, user: string, options?: unknown) => Promise<AnthropicResponse>>();

vi.mock('../../src/services/anthropic.js', () => ({
  complete: (...args: unknown[]) => mockComplete(...(args as [string, string, unknown])),
}));

// Mock logger
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { analyze } from '../../src/veille/analyzer.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function makeArticle(overrides: Partial<RawArticle> = {}): RawArticle {
  return {
    url: 'https://example.com/article',
    title: 'Test Article',
    snippet: 'A test snippet',
    source: 'reddit',
    language: 'en',
    category: 'ttrpg_news',
    ...overrides,
  };
}

function makeAnalysisJson(
  articles: Array<{
    url: string;
    score: number;
    pillar: string;
    suggestedAngle: string;
    translatedTitle?: string;
    translatedSnippet?: string;
  }>,
): string {
  return JSON.stringify({ articles });
}

describe('analyze', () => {
  it('should return empty result for empty articles', async () => {
    const result = await analyze([], []);

    expect(result.articles).toHaveLength(0);
    expect(result.tokensUsed.input).toBe(0);
    expect(result.tokensUsed.output).toBe(0);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it('should parse valid JSON response and merge with original articles', async () => {
    const articles = [
      makeArticle({ url: 'https://example.com/1', title: 'Article One' }),
      makeArticle({ url: 'https://example.com/2', title: 'Article Two' }),
    ];

    const responseJson = makeAnalysisJson([
      { url: 'https://example.com/1', score: 9, pillar: 'trend', suggestedAngle: 'Angle 1' },
      { url: 'https://example.com/2', score: 6, pillar: 'tuto', suggestedAngle: 'Angle 2' },
    ]);

    mockComplete.mockResolvedValue({ text: responseJson, tokensIn: 100, tokensOut: 50 });

    const result = await analyze(articles, []);

    expect(result.articles).toHaveLength(2);
    expect(result.articles[0]?.score).toBe(9);
    expect(result.articles[0]?.pillar).toBe('trend');
    expect(result.articles[0]?.suggestedAngle).toBe('Angle 1');
    expect(result.articles[0]?.title).toBe('Article One');
    expect(result.articles[1]?.score).toBe(6);
    expect(result.articles[1]?.pillar).toBe('tuto');
    expect(result.tokensUsed).toEqual({ input: 100, output: 50 });
  });

  it('should strip markdown backticks from JSON response', async () => {
    const articles = [makeArticle({ url: 'https://example.com/md' })];

    const json = makeAnalysisJson([
      { url: 'https://example.com/md', score: 7, pillar: 'community', suggestedAngle: 'Angle MD' },
    ]);

    mockComplete.mockResolvedValue({
      text: '```json\n' + json + '\n```',
      tokensIn: 80,
      tokensOut: 40,
    });

    const result = await analyze(articles, []);

    expect(result.articles[0]?.score).toBe(7);
    expect(result.articles[0]?.pillar).toBe('community');
  });

  it('should strip bare backticks from JSON response', async () => {
    const articles = [makeArticle({ url: 'https://example.com/bare' })];

    const json = makeAnalysisJson([
      { url: 'https://example.com/bare', score: 4, pillar: 'product', suggestedAngle: 'Bare' },
    ]);

    mockComplete.mockResolvedValue({
      text: '```\n' + json + '\n```',
      tokensIn: 80,
      tokensOut: 40,
    });

    const result = await analyze(articles, []);

    expect(result.articles[0]?.score).toBe(4);
    expect(result.articles[0]?.pillar).toBe('product');
  });

  it('should fallback to default scores on invalid JSON', async () => {
    const articles = [
      makeArticle({ url: 'https://example.com/bad1' }),
      makeArticle({ url: 'https://example.com/bad2' }),
    ];

    mockComplete.mockResolvedValue({
      text: 'This is not valid JSON at all',
      tokensIn: 50,
      tokensOut: 30,
    });

    const result = await analyze(articles, []);

    expect(result.articles).toHaveLength(2);
    expect(result.articles[0]?.score).toBe(5);
    expect(result.articles[0]?.pillar).toBe('trend');
    expect(result.articles[0]?.suggestedAngle).toBe('');
    expect(result.tokensUsed).toEqual({ input: 50, output: 30 });
  });

  it('should fallback to defaults for articles missing from Claude response', async () => {
    const articles = [
      makeArticle({ url: 'https://example.com/present' }),
      makeArticle({ url: 'https://example.com/missing' }),
    ];

    const responseJson = makeAnalysisJson([
      { url: 'https://example.com/present', score: 8, pillar: 'trend', suggestedAngle: 'Present' },
      // missing article is not in the response
    ]);

    mockComplete.mockResolvedValue({ text: responseJson, tokensIn: 100, tokensOut: 50 });

    const result = await analyze(articles, []);

    expect(result.articles[0]?.score).toBe(8);
    expect(result.articles[1]?.score).toBe(5);
    expect(result.articles[1]?.pillar).toBe('trend');
    expect(result.articles[1]?.suggestedAngle).toBe('');
  });

  it('should include translations when provided', async () => {
    const articles = [makeArticle({ url: 'https://example.com/en', language: 'en' })];

    const responseJson = makeAnalysisJson([
      {
        url: 'https://example.com/en',
        score: 7,
        pillar: 'trend',
        suggestedAngle: 'Angle FR',
        translatedTitle: 'Titre traduit',
        translatedSnippet: 'Extrait traduit',
      },
    ]);

    mockComplete.mockResolvedValue({ text: responseJson, tokensIn: 100, tokensOut: 50 });

    const result = await analyze(articles, []);

    expect(result.articles[0]?.translatedTitle).toBe('Titre traduit');
    expect(result.articles[0]?.translatedSnippet).toBe('Extrait traduit');
  });

  it('should include preference context in the prompt', async () => {
    const articles = [makeArticle()];
    const preferences: PreferenceEntryData[] = [
      { dimension: 'source', value: 'reddit', score: 0.8, totalCount: 10 },
      { dimension: 'category', value: 'ttrpg_news', score: -0.5, totalCount: 5 },
    ];

    mockComplete.mockResolvedValue({
      text: makeAnalysisJson([
        { url: articles[0]?.url ?? '', score: 7, pillar: 'trend', suggestedAngle: 'Angle' },
      ]),
      tokensIn: 100,
      tokensOut: 50,
    });

    await analyze(articles, preferences);

    // Verify the user message sent to Claude includes preference data
    const userMessage = mockComplete.mock.calls[0]?.[1] ?? '';
    expect(userMessage).toContain('reddit');
    expect(userMessage).toContain('+0.80');
    expect(userMessage).toContain('-0.50');
    expect(userMessage).toContain('FORTE PRÉFÉRENCE');
  });

  it('should use default preference text when no preferences', async () => {
    const articles = [makeArticle()];

    mockComplete.mockResolvedValue({
      text: makeAnalysisJson([
        { url: articles[0]?.url ?? '', score: 5, pillar: 'trend', suggestedAngle: 'Default' },
      ]),
      tokensIn: 100,
      tokensOut: 50,
    });

    await analyze(articles, []);

    const userMessage = mockComplete.mock.calls[0]?.[1] ?? '';
    expect(userMessage).toContain('Aucun profil de préférences disponible');
  });

  it('should fallback on Zod validation failure (e.g. score out of range)', async () => {
    const articles = [makeArticle({ url: 'https://example.com/zod' })];

    // score 15 is out of range [0, 10]
    const badJson = JSON.stringify({
      articles: [{ url: 'https://example.com/zod', score: 15, pillar: 'trend', suggestedAngle: 'Bad' }],
    });

    mockComplete.mockResolvedValue({ text: badJson, tokensIn: 50, tokensOut: 30 });

    const result = await analyze(articles, []);

    // Should fallback since Zod validation rejects score > 10
    expect(result.articles[0]?.score).toBe(5);
    expect(result.articles[0]?.suggestedAngle).toBe('');
  });
});
