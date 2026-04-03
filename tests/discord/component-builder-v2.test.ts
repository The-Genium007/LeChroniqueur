import { describe, it, expect } from 'vitest';
import {
  errorMessage,
  successMessage,
  infoMessage,
  veilleDigest,
  veilleArticle,
  suggestion,
  production,
  publicationKit,
  deepDiveResult,
  budgetReport,
  budgetAlert,
  searchResults,
  preferenceProfile,
  weeklyReport,
  imageGallery,
} from '../../src/discord/component-builder-v2.js';
import { MessageFlags } from 'discord.js';

describe('component-builder-v2', () => {
  describe('utility messages', () => {
    it('should build error message with V2 flag', () => {
      const payload = errorMessage('Something went wrong');
      expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
      expect(payload.components.length).toBe(1);
      expect(payload.components[0]?.type).toBe(17); // Container
    });

    it('should build success message', () => {
      const payload = successMessage('All good');
      expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
      expect(payload.components.length).toBe(1);
    });

    it('should build info message', () => {
      const payload = infoMessage('Info here');
      expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    });
  });

  describe('veille', () => {
    it('should build veille digest with articles', () => {
      const payload = veilleDigest(
        [{ id: 1, title: 'Test', source: 'reddit', url: 'https://x.com', score: 9 }],
        { totalFetched: 50, deduplicated: 5, kept: 10 },
      );
      expect(payload.components.length).toBe(1);
    });

    it('should build veille digest without articles', () => {
      const payload = veilleDigest([], { totalFetched: 0, deduplicated: 0, kept: 0 });
      expect(payload.components.length).toBe(1);
    });

    it('should build veille article with buttons', () => {
      const payload = veilleArticle({ id: 1, title: 'T', source: 's', url: 'https://x.com', score: 8 });
      expect(payload.components.length).toBe(1);
    });
  });

  describe('suggestion', () => {
    it('should build suggestion with action buttons', () => {
      const payload = suggestion({ id: 1, content: 'Hook here', pillar: 'trend', platform: 'tiktok', format: 'reel' });
      expect(payload.components.length).toBe(1);
    });
  });

  describe('production', () => {
    it('should build production script', () => {
      const payload = production({ id: 1, textOverlay: 'overlay', fullScript: 'script', hashtags: '#test', platform: 'tiktok', suggestedTime: '19h', notes: 'notes' });
      expect(payload.components.length).toBe(1);
    });
  });

  describe('publicationKit', () => {
    it('should build kit with copy/download buttons', () => {
      const payload = publicationKit({ id: 1, platform: 'instagram', suggestedTime: 'mardi 19h', caption: 'Caption text', hashtags: '#tag', notes: '' });
      expect(payload.components.length).toBe(1);
    });
  });

  describe('deepDiveResult', () => {
    it('should build deep dive with suggestions', () => {
      const payload = deepDiveResult({ articleTitle: 'Article', analysis: 'Analysis', contentSuggestions: ['Sug1', 'Sug2'], articleId: 1 });
      expect(payload.components.length).toBe(1);
    });
  });

  describe('budget', () => {
    it('should build budget report', () => {
      const payload = budgetReport([{ label: 'Jour', anthropicCents: 100, googleCents: 50, totalCents: 150, budgetCents: 300 }]);
      expect(payload.components.length).toBe(1);
    });

    it('should build budget alert', () => {
      const payload = budgetAlert('Semaine', 80, 1200, 1500);
      expect(payload.components.length).toBe(1);
    });
  });

  describe('search', () => {
    it('should build search results with individual cards', () => {
      const payload = searchResults([{ sourceTable: 'veille_articles', sourceId: 1, title: 'T', snippet: 'S', status: 'new', score: 8 }], 'test', 1, 1);
      // header + 1 result card + navigation = 3 containers
      expect(payload.components.length).toBe(3);
    });

    it('should handle empty results', () => {
      const payload = searchResults([], 'nothing', 1, 0);
      // header + navigation = 2 containers
      expect(payload.components.length).toBe(2);
    });
  });

  describe('preferenceProfile', () => {
    it('should build profile with entries', () => {
      const payload = preferenceProfile([{ dimension: 'source', value: 'reddit', score: 0.8, totalCount: 10 }]);
      expect(payload.components.length).toBe(1);
    });

    it('should handle empty profile', () => {
      const payload = preferenceProfile([]);
      expect(payload.components.length).toBe(1);
    });
  });

  describe('weeklyReport', () => {
    it('should build weekly report', () => {
      const payload = weeklyReport({
        topArticles: [],
        articleStats: { collected: 10, proposed: 2, transformed: 1, archived: 3 },
        suggestionStats: { total: 5, goCount: 3, skipCount: 1, modifiedCount: 1 },
        feedbackStats: { total: 20, positive: 15, negative: 5 },
        publications: [],
        budget: {
          weekly: { totalCents: 500, budgetCents: 1500, percentUsed: 33 },
          monthly: { totalCents: 2000, budgetCents: 5000, percentUsed: 40 },
        },
        preferenceHighlights: [],
      });
      expect(payload.components.length).toBe(1);
    });
  });

  describe('imageGallery', () => {
    it('should build image gallery with variants', () => {
      const payload = imageGallery({
        suggestionId: 1,
        variants: [{ index: 0, naming: 'v1.png', dbId: 1 }, { index: 1, naming: 'v2.png', dbId: 2 }],
      });
      expect(payload.components.length).toBe(1);
    });
  });
});
