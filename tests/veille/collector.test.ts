import { describe, it, expect } from 'vitest';
import { isWithinMaxAge, resultToArticle } from '../../src/veille/collector.js';
import type { SearxngResult } from '../../src/services/searxng.js';

function makeSearxngResult(overrides: Partial<SearxngResult> = {}): SearxngResult {
  return {
    url: 'https://example.com/article',
    title: 'Test Article',
    content: 'A snippet about TTRPG',
    engine: 'google',
    publishedDate: new Date().toISOString(),
    ...overrides,
  };
}

describe('resultToArticle', () => {
  it('should map SearXNG fields to RawArticle fields correctly', () => {
    const result = makeSearxngResult({
      url: 'https://example.com/mapped',
      title: 'Mapped Title',
      content: 'Mapped snippet',
      engine: 'reddit',
      thumbnail: 'https://img.example.com/thumb.jpg',
    });

    const article = resultToArticle(result, 'en', 'test_cat');

    expect(article.url).toBe('https://example.com/mapped');
    expect(article.title).toBe('Mapped Title');
    expect(article.snippet).toBe('Mapped snippet');
    expect(article.source).toBe('reddit');
    expect(article.thumbnailUrl).toBe('https://img.example.com/thumb.jpg');
    expect(article.language).toBe('en');
    expect(article.category).toBe('test_cat');
  });
});

describe('isWithinMaxAge', () => {
  it('should return true for undefined publishedDate', () => {
    expect(isWithinMaxAge(undefined, 72)).toBe(true);
  });

  it('should return true for recent articles', () => {
    const recent = new Date().toISOString();
    expect(isWithinMaxAge(recent, 72)).toBe(true);
  });

  it('should return false for old articles beyond 2x maxAge', () => {
    const old = new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString(); // 200h ago
    expect(isWithinMaxAge(old, 72)).toBe(false);
  });

  it('should return true for articles within 2x maxAge', () => {
    const recent = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(); // 100h ago
    expect(isWithinMaxAge(recent, 72)).toBe(true); // 100h < 144h (72*2)
  });

  it('should return true for invalid dates', () => {
    expect(isWithinMaxAge('not-a-date', 72)).toBe(true);
  });

  it('should return true for future dates (garbage data)', () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    expect(isWithinMaxAge(future, 72)).toBe(true);
  });
});
