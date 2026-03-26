import { describe, it, expect } from 'vitest';
import { ButtonStyle } from 'discord.js';
import {
  veilleDigest,
  veilleArticle,
  suggestion,
  production,
  deepDiveResult,
  searchResults,
  budgetReport,
  budgetAlert,
  preferenceProfile,
  imageGallery,
  videoSegmentResult,
  publicationConfirmation,
  weeklyReport,
  errorMessage,
  successMessage,
  infoMessage,
  type VeilleArticleSummary,
  type SuggestionData,
  type ProductionData,
  type DeepDiveData,
  type SearchResultData,
  type BudgetPeriodData,
  type PreferenceEntryData,
  type ImageGalleryData,
  type VideoSegmentResultData,
  type PublicationConfirmationData,
  type WeeklyReportData,
} from '../../src/discord/message-builder.js';

// ─── Helpers ───

function makeArticleSummary(overrides: Partial<VeilleArticleSummary> = {}): VeilleArticleSummary {
  return {
    id: 1,
    title: 'Test Article',
    source: 'reddit',
    url: 'https://example.com/article',
    score: 8,
    ...overrides,
  };
}

// ─── Veille ───

describe('veilleDigest', () => {
  it('should create an embed with top articles', () => {
    const articles = [
      makeArticleSummary({ id: 1, title: 'Top 1', score: 9 }),
      makeArticleSummary({ id: 2, title: 'Top 2', score: 8 }),
    ];
    const stats = { totalFetched: 50, deduplicated: 10, kept: 20 };

    const payload = veilleDigest(articles, stats);

    expect(payload.embeds).toHaveLength(1);
    const embed = payload.embeds[0]?.toJSON();
    expect(embed?.title).toContain('Veille du');
    expect(embed?.color).toBe(0xc8a87c);

    const topField = embed?.fields?.find((f) => f.name.includes('TOP'));
    expect(topField).toBeDefined();
    expect(topField?.value).toContain('Top 1');
    expect(topField?.value).toContain('Top 2');
  });

  it('should show empty state when no top articles', () => {
    const payload = veilleDigest([], { totalFetched: 10, deduplicated: 2, kept: 5 });

    const embed = payload.embeds[0]?.toJSON();
    const emptyField = embed?.fields?.find((f) => f.name.includes('Rien de marquant'));
    expect(emptyField).toBeDefined();
  });

  it('should include stats in the embed', () => {
    const payload = veilleDigest([], { totalFetched: 100, deduplicated: 20, kept: 30 });

    const embed = payload.embeds[0]?.toJSON();
    const statsField = embed?.fields?.find((f) => f.name === 'Stats');
    expect(statsField?.value).toContain('100');
    expect(statsField?.value).toContain('30');
  });
});

describe('veilleArticle', () => {
  it('should create embed with rating and action buttons', () => {
    const article = makeArticleSummary({ id: 42, score: 9, suggestedAngle: 'Un angle cool' });

    const payload = veilleArticle(article);

    expect(payload.embeds).toHaveLength(1);
    expect(payload.components).toHaveLength(1);

    const embed = payload.embeds[0]?.toJSON();
    expect(embed?.title).toContain('🔥');
    expect(embed?.title).toContain('9/10');
    expect(embed?.url).toBe('https://example.com/article');

    const angleField = embed?.fields?.find((f) => f.name.includes('Angle'));
    expect(angleField?.value).toBe('Un angle cool');

    // Check buttons
    const buttons = payload.components[0]?.toJSON().components;
    expect(buttons).toHaveLength(4);

    const thumbUp = buttons?.find((b) => 'custom_id' in b && b.custom_id === 'thumbup:veille_articles:42');
    expect(thumbUp).toBeDefined();

    const transform = buttons?.find((b) => 'custom_id' in b && b.custom_id === 'transform:veille_articles:42');
    expect(transform).toBeDefined();
  });

  it('should use sword emoji for score < 8', () => {
    const article = makeArticleSummary({ score: 6 });

    const payload = veilleArticle(article);
    const embed = payload.embeds[0]?.toJSON();
    expect(embed?.title).toContain('⚔️');
  });

  it('should use translated title when available', () => {
    const article = makeArticleSummary({ translatedTitle: 'Titre traduit' });

    const payload = veilleArticle(article);
    const embed = payload.embeds[0]?.toJSON();
    expect(embed?.title).toContain('Titre traduit');
  });
});

// ─── Suggestions ───

describe('suggestion', () => {
  it('should create embed with Go/Modify/Skip/Later buttons', () => {
    const data: SuggestionData = {
      id: 5,
      content: 'Faire une vidéo sur les dragons',
      pillar: 'trend',
      platform: 'TikTok',
      format: 'Short',
    };

    const payload = suggestion(data);

    expect(payload.embeds).toHaveLength(1);
    const embed = payload.embeds[0]?.toJSON();
    expect(embed?.description).toBe('Faire une vidéo sur les dragons');
    expect(embed?.color).toBe(0x5865f2);

    const buttons = payload.components[0]?.toJSON().components;
    expect(buttons).toHaveLength(4);

    const goBtn = buttons?.find((b) => 'custom_id' in b && b.custom_id === 'go:suggestions:5');
    expect(goBtn).toBeDefined();
    if (goBtn && 'style' in goBtn) {
      expect(goBtn.style).toBe(ButtonStyle.Success);
    }
  });

  it('should include format field when provided', () => {
    const data: SuggestionData = {
      id: 1,
      content: 'Test',
      pillar: 'tuto',
      platform: 'Instagram',
      format: 'Reel',
    };

    const payload = suggestion(data);
    const embed = payload.embeds[0]?.toJSON();
    const formatField = embed?.fields?.find((f) => f.name.includes('Format'));
    expect(formatField?.value).toBe('Reel');
  });
});

// ─── Production ───

describe('production', () => {
  it('should create embed with script fields and validate/retouch buttons', () => {
    const data: ProductionData = {
      id: 10,
      textOverlay: 'Texte overlay test',
      fullScript: 'Script complet...',
      hashtags: '#jdr #dnd',
      platform: 'TikTok',
      suggestedTime: '18h00',
      notes: 'Notes de prod',
    };

    const payload = production(data);

    const embed = payload.embeds[0]?.toJSON();
    expect(embed?.color).toBe(0xeb459e);
    expect(embed?.title).toContain('Script final');

    const overlayField = embed?.fields?.find((f) => f.name.includes('overlay'));
    expect(overlayField?.value).toBe('Texte overlay test');

    const buttons = payload.components[0]?.toJSON().components;
    const validateBtn = buttons?.find((b) => 'custom_id' in b && b.custom_id === 'validate:productions:10');
    expect(validateBtn).toBeDefined();
  });
});

// ─── Deep Dive ───

describe('deepDiveResult', () => {
  it('should display analysis and content suggestions', () => {
    const data: DeepDiveData = {
      articleTitle: 'Dragon Homebrew',
      analysis: 'Analyse détaillée...',
      contentSuggestions: ['Suggestion 1', 'Suggestion 2'],
      articleId: 7,
    };

    const payload = deepDiveResult(data);

    const embed = payload.embeds[0]?.toJSON();
    expect(embed?.title).toContain('Dragon Homebrew');

    const suggFields = embed?.fields?.filter((f) => f.name.includes('Suggestion'));
    expect(suggFields).toHaveLength(2);

    const buttons = payload.components[0]?.toJSON().components;
    const createBtn = buttons?.find((b) => 'custom_id' in b && b.custom_id === 'transform_accept:veille_articles:7');
    expect(createBtn).toBeDefined();
  });
});

// ─── Search ───

describe('searchResults', () => {
  it('should display grouped results by source table', () => {
    const results: SearchResultData[] = [
      { sourceTable: 'veille_articles', sourceId: 1, title: 'Article 1', snippet: 'Snippet long enough...' },
      { sourceTable: 'suggestions', sourceId: 2, title: 'Suggestion 1', snippet: 'Snippet long enough...' },
    ];

    const payload = searchResults(results, 'dragon', 1, 2);

    const embed = payload.embeds[0]?.toJSON();
    expect(embed?.title).toContain('dragon');
    expect(embed?.description).toContain('2 résultats');

    const veilleField = embed?.fields?.find((f) => f.name.includes('Veille'));
    expect(veilleField).toBeDefined();

    const suggField = embed?.fields?.find((f) => f.name.includes('Suggestions'));
    expect(suggField).toBeDefined();
  });

  it('should show empty state for no results', () => {
    const payload = searchResults([], 'nothing', 1, 0);

    const embed = payload.embeds[0]?.toJSON();
    expect(embed?.description).toContain('Aucun résultat');
    expect(payload.components).toHaveLength(0);
  });

  it('should add pagination buttons when multiple pages', () => {
    const results: SearchResultData[] = [
      { sourceTable: 'veille_articles', sourceId: 1, title: 'R1', snippet: 'S1...' },
    ];

    const payload = searchResults(results, 'test', 1, 25);

    expect(payload.components).toHaveLength(1);
    const buttons = payload.components[0]?.toJSON().components;
    const nextBtn = buttons?.find((b) => 'custom_id' in b && b.custom_id === 'page:search:2');
    expect(nextBtn).toBeDefined();
  });

  it('should show previous button when not on first page', () => {
    const results: SearchResultData[] = [
      { sourceTable: 'veille_articles', sourceId: 1, title: 'R1', snippet: 'S1...' },
    ];

    const payload = searchResults(results, 'test', 2, 25);

    const buttons = payload.components[0]?.toJSON().components;
    const prevBtn = buttons?.find((b) => 'custom_id' in b && b.custom_id === 'page:search:1');
    expect(prevBtn).toBeDefined();
  });
});

// ─── Budget ───

describe('budgetReport', () => {
  it('should display budget periods with progress bars', () => {
    const periods: BudgetPeriodData[] = [
      { label: 'Aujourd\'hui', anthropicCents: 50, googleCents: 30, totalCents: 80, budgetCents: 300 },
      { label: 'Semaine', anthropicCents: 200, googleCents: 100, totalCents: 300, budgetCents: 1500 },
    ];

    const payload = budgetReport(periods);

    const embed = payload.embeds[0]?.toJSON();
    expect(embed?.title).toContain('Budget');
    expect(embed?.fields).toHaveLength(2);

    const dayField = embed?.fields?.[0];
    expect(dayField?.value).toContain('0.50€');
    expect(dayField?.value).toContain('0.30€');
    expect(dayField?.value).toContain('█');
  });
});

describe('budgetAlert', () => {
  it('should show warning for 80% threshold', () => {
    const payload = budgetAlert('Semaine', 80, 1200, 1500);

    const embed = payload.embeds[0]?.toJSON();
    expect(embed?.title).toContain('⚠️');
    expect(embed?.title).toContain('80%');
    expect(embed?.color).toBe(0xfee75c); // WARNING
  });

  it('should show error for 100% threshold with suspension notice', () => {
    const payload = budgetAlert('Mois', 100, 5000, 5000);

    const embed = payload.embeds[0]?.toJSON();
    expect(embed?.title).toContain('⛔');
    expect(embed?.color).toBe(0xed4245); // ERROR

    const actionField = embed?.fields?.find((f) => f.name.includes('Action'));
    expect(actionField?.value).toContain('suspendues');
  });
});

// ─── Preference Profile ───

describe('preferenceProfile', () => {
  it('should group entries by dimension', () => {
    const entries: PreferenceEntryData[] = [
      { dimension: 'source', value: 'reddit', score: 0.8, totalCount: 10 },
      { dimension: 'source', value: 'google', score: -0.5, totalCount: 5 },
      { dimension: 'category', value: 'ttrpg_news', score: 0.4, totalCount: 8 },
    ];

    const payload = preferenceProfile(entries);

    const embed = payload.embeds[0]?.toJSON();
    const sourceField = embed?.fields?.find((f) => f.name.includes('Sources'));
    expect(sourceField?.value).toContain('reddit');
    expect(sourceField?.value).toContain('FORTE PRÉFÉRENCE');

    const catField = embed?.fields?.find((f) => f.name.includes('Catégories'));
    expect(catField?.value).toContain('ttrpg_news');
  });

  it('should show empty state when no entries', () => {
    const payload = preferenceProfile([]);

    const embed = payload.embeds[0]?.toJSON();
    expect(embed?.description).toContain('Aucune donnée');
  });
});

// ─── Image Gallery ───

describe('imageGallery', () => {
  it('should create variant buttons', () => {
    const data: ImageGalleryData = {
      suggestionId: 3,
      variants: [
        { index: 0, naming: 'v1_dragon.png', dbId: 10 },
        { index: 1, naming: 'v2_dragon.png', dbId: 11 },
      ],
    };

    const payload = imageGallery(data);

    expect(payload.embeds).toHaveLength(1);
    const embed = payload.embeds[0]?.toJSON();
    expect(embed?.description).toContain('2 variantes');

    const buttons = payload.components[0]?.toJSON().components;
    expect(buttons).toHaveLength(2);
  });
});

// ─── Video Segment ───

describe('videoSegmentResult', () => {
  it('should display video info', () => {
    const data: VideoSegmentResultData = {
      naming: 'scene1_dragon.mp4',
      durationSeconds: 15,
      postizPath: 'https://postiz.example.com/media/1',
      dbId: 20,
    };

    const payload = videoSegmentResult(data);

    const embed = payload.embeds[0]?.toJSON();
    expect(embed?.color).toBe(0xeb459e);

    const fileField = embed?.fields?.find((f) => f.name.includes('Fichier'));
    expect(fileField?.value).toBe('scene1_dragon.mp4');

    const durationField = embed?.fields?.find((f) => f.name.includes('Durée'));
    expect(durationField?.value).toBe('15s');
  });
});

// ─── Publication ───

describe('publicationConfirmation', () => {
  it('should display publication details', () => {
    const data: PublicationConfirmationData = {
      platform: 'TikTok',
      scheduledAt: '2025-03-26T18:00:00Z',
      postizPostId: 'post-123',
      content: 'Un contenu de publication test qui peut être assez long pour être tronqué...',
    };

    const payload = publicationConfirmation(data);

    const embed = payload.embeds[0]?.toJSON();
    expect(embed?.color).toBe(0x57f287); // PUBLICATION
    expect(embed?.title).toContain('Publication programmée');

    const platformField = embed?.fields?.find((f) => f.name.includes('Plateforme'));
    expect(platformField?.value).toBe('TikTok');
  });
});

// ─── Weekly Report ───

describe('weeklyReport', () => {
  it('should include all sections', () => {
    const data: WeeklyReportData = {
      topArticles: [{ title: 'Best Article', score: 10, source: 'reddit', url: 'https://example.com/best' }],
      articleStats: { collected: 100, proposed: 50, transformed: 10, archived: 30 },
      suggestionStats: { total: 20, goCount: 12, skipCount: 5, modifiedCount: 3 },
      feedbackStats: { total: 30, positive: 25, negative: 5 },
      publications: [{ platform: 'TikTok', content: 'Vidéo sur les dragons', scheduledAt: null, views: 1500, likes: 200 }],
      budget: {
        weekly: { totalCents: 800, budgetCents: 1500, percentUsed: 53 },
        monthly: { totalCents: 2500, budgetCents: 5000, percentUsed: 50 },
      },
      preferenceHighlights: [{ dimension: 'source', value: 'reddit', score: 0.85 }],
    };

    const payload = weeklyReport(data);

    const embed = payload.embeds[0]?.toJSON();
    expect(embed?.title).toContain('Rapport hebdomadaire');
    expect(embed?.color).toBe(0xc8a87c);

    const topField = embed?.fields?.find((f) => f.name.includes('Top articles'));
    expect(topField?.value).toContain('Best Article');

    const veilleField = embed?.fields?.find((f) => f.name.includes('Veille'));
    expect(veilleField?.value).toContain('100');

    const suggField = embed?.fields?.find((f) => f.name.includes('Suggestions'));
    expect(suggField?.value).toContain('60%');

    const pubField = embed?.fields?.find((f) => f.name.includes('Publications'));
    expect(pubField?.value).toContain('1500 vues');

    const budgetField = embed?.fields?.find((f) => f.name.includes('Budget'));
    expect(budgetField?.value).toContain('53%');

    const prefField = embed?.fields?.find((f) => f.name.includes('préférences'));
    expect(prefField?.value).toContain('reddit');
  });

  it('should show empty publications state', () => {
    const data: WeeklyReportData = {
      topArticles: [],
      articleStats: { collected: 0, proposed: 0, transformed: 0, archived: 0 },
      suggestionStats: { total: 0, goCount: 0, skipCount: 0, modifiedCount: 0 },
      feedbackStats: { total: 0, positive: 0, negative: 0 },
      publications: [],
      budget: {
        weekly: { totalCents: 0, budgetCents: 1500, percentUsed: 0 },
        monthly: { totalCents: 0, budgetCents: 5000, percentUsed: 0 },
      },
      preferenceHighlights: [],
    };

    const payload = weeklyReport(data);

    const embed = payload.embeds[0]?.toJSON();
    const pubField = embed?.fields?.find((f) => f.name.includes('Publications'));
    expect(pubField?.value).toContain('Aucune');
  });
});

// ─── Utility Messages ───

describe('utility messages', () => {
  it('errorMessage should use ERROR color', () => {
    const payload = errorMessage('Something went wrong');
    const embed = payload.embeds[0]?.toJSON();
    expect(embed?.color).toBe(0xed4245);
    expect(embed?.description).toBe('Something went wrong');
  });

  it('successMessage should use SUCCESS color', () => {
    const payload = successMessage('Done!');
    const embed = payload.embeds[0]?.toJSON();
    expect(embed?.color).toBe(0x57f287);
    expect(embed?.description).toBe('Done!');
  });

  it('infoMessage should use INFO color', () => {
    const payload = infoMessage('FYI');
    const embed = payload.embeds[0]?.toJSON();
    expect(embed?.color).toBe(0x5865f2);
    expect(embed?.description).toBe('FYI');
  });
});
