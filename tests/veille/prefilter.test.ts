import { describe, it, expect, vi } from 'vitest';
import type { RawArticle } from '../../src/veille/collector.js';

// Mock logger
vi.mock('../../src/core/logger.js', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { prefilter } from '../../src/veille/prefilter.js';
import type { InstanceProfile } from '../../src/core/instance-profile.js';

function makeArticle(overrides: Partial<RawArticle> = {}): RawArticle {
  return {
    url: 'https://example.com/article',
    title: 'A Valid Test Article Title',
    snippet: 'This is a valid snippet with enough content.',
    source: 'google',
    language: 'en',
    category: 'test',
    ...overrides,
  };
}

function makeProfile(overrides: Partial<InstanceProfile> = {}): InstanceProfile {
  return {
    projectName: 'test',
    projectNiche: 'testing',
    projectDescription: '',
    projectLanguage: 'fr',
    projectUrl: null,
    targetPlatforms: [],
    targetFormats: [],
    contentTypes: [],
    includeDomains: [],
    excludeDomains: [],
    negativeKeywords: [],
    pillars: ['trend', 'tuto', 'community', 'product'],
    onboardingContext: '',
    calibratedExamples: null,
    calibratedAt: null,
    ...overrides,
  };
}

describe('prefilter', () => {
  it('should pass valid articles', () => {
    const articles = [makeArticle()];
    const result = prefilter(articles, makeProfile());
    expect(result.passed).toHaveLength(1);
  });

  it('should reject Twitch profile URLs', () => {
    const articles = [
      makeArticle({ url: 'https://www.twitch.tv/somechannel' }),
      makeArticle({ url: 'https://twitch.tv/somechannel/' }),
      makeArticle({ url: 'https://twitch.tv/somechannel/videos/123', title: 'A valid Twitch video title' }),
    ];
    const result = prefilter(articles, makeProfile());
    // Twitch profiles rejected, but video URL should pass
    expect(result.passed).toHaveLength(1);
    expect(result.stats.rejectedByReason['noise_url_pattern']).toBe(2);
  });

  it('should reject LinkedIn profile URLs', () => {
    const articles = [
      makeArticle({ url: 'https://www.linkedin.com/in/johndoe' }),
      makeArticle({ url: 'https://linkedin.com/jobs/view/123' }),
    ];
    const result = prefilter(articles, makeProfile());
    expect(result.passed).toHaveLength(0);
  });

  it('should reject articles with excluded domains', () => {
    const profile = makeProfile({ excludeDomains: ['quora.com', 'medium.com'] });
    const articles = [
      makeArticle({ url: 'https://www.quora.com/some-question' }),
      makeArticle({ url: 'https://medium.com/some-article' }),
      makeArticle({ url: 'https://example.com/valid-article' }),
    ];
    const result = prefilter(articles, profile);
    expect(result.passed).toHaveLength(1);
    expect(result.passed[0]?.url).toBe('https://example.com/valid-article');
  });

  it('should reject articles with title too short', () => {
    const articles = [
      makeArticle({ title: 'Short' }),
      makeArticle({ title: 'A Valid Longer Title Here' }),
    ];
    const result = prefilter(articles, makeProfile());
    expect(result.passed).toHaveLength(1);
    expect(result.stats.rejectedByReason['title_too_short']).toBe(1);
  });

  it('should reject articles with title too long', () => {
    const articles = [
      makeArticle({ title: 'A'.repeat(250) }),
    ];
    const result = prefilter(articles, makeProfile());
    expect(result.passed).toHaveLength(0);
    expect(result.stats.rejectedByReason['title_too_long']).toBe(1);
  });

  it('should reject all-caps titles', () => {
    const articles = [
      makeArticle({ title: 'THIS IS ALL CAPS TITLE FOR SURE' }),
      makeArticle({ title: 'This Is Normal Case Title' }),
    ];
    const result = prefilter(articles, makeProfile());
    expect(result.passed).toHaveLength(1);
    expect(result.stats.rejectedByReason['title_all_caps']).toBe(1);
  });

  it('should reject articles with snippet too short', () => {
    const articles = [
      makeArticle({ snippet: 'too short' }),
      makeArticle({ snippet: '[Transcription] This is ok even if short' }),
    ];
    const result = prefilter(articles, makeProfile());
    expect(result.passed).toHaveLength(1);
  });

  it('should reject articles matching negative keywords', () => {
    const profile = makeProfile({ negativeKeywords: ['looking for players', 'hiring'] });
    const articles = [
      makeArticle({ title: 'Looking for players in my D&D game' }),
      makeArticle({ title: 'We are hiring for a game designer' }),
      makeArticle({ title: 'Amazing new RPG release this week' }),
    ];
    const result = prefilter(articles, profile);
    expect(result.passed).toHaveLength(1);
    expect(result.passed[0]?.title).toBe('Amazing new RPG release this week');
  });

  it('should deduplicate near-duplicate titles', () => {
    const articles = [
      makeArticle({ url: 'https://site1.com/art', title: 'SessionFlow v0.6 massive update brings tools' }),
      makeArticle({ url: 'https://site2.com/art', title: 'SessionFlow v0.6 massive update brings new tools' }),
      makeArticle({ url: 'https://site3.com/art', title: 'Completely different article about gaming' }),
    ];
    const result = prefilter(articles, makeProfile());
    expect(result.passed).toHaveLength(2);
    expect(result.stats.rejectedByReason['near_duplicate']).toBe(1);
  });

  it('should work with undefined profile', () => {
    const articles = [makeArticle()];
    const result = prefilter(articles, undefined);
    expect(result.passed).toHaveLength(1);
  });

  it('should report complete stats', () => {
    const profile = makeProfile({ excludeDomains: ['spam.com'] });
    const articles = [
      makeArticle({ url: 'https://example.com/1', title: 'Valid article one' }),
      makeArticle({ url: 'https://spam.com/2', title: 'Valid title from spam domain' }),
      makeArticle({ url: 'https://twitch.tv/user', title: 'Twitch profile page name here' }),
      makeArticle({ url: 'https://example.com/3', title: 'Hi' }),
    ];
    const result = prefilter(articles, profile);
    expect(result.stats.input).toBe(4);
    expect(result.stats.afterUrlFilter).toBe(2);
    expect(result.stats.afterContentFilter).toBe(1);
    expect(result.passed).toHaveLength(1);
  });
});
