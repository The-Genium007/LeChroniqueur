/**
 * Mock data for DRY_RUN + MOCK_APIS mode.
 * Provides fake SearXNG results and Anthropic responses.
 */

import type { SearxngResult } from '../services/searxng.js';

export const MOCK_SEARXNG_RESULTS: readonly SearxngResult[] = [
  {
    url: 'https://www.reddit.com/r/dndnext/mock-dragon-homebrew',
    title: 'New Dragon Homebrew That Changes Everything',
    content: 'A homebrew system for dragon encounters that adds lair phases and dynamic terrain. Already tested in 3 campaigns.',
    engine: 'reddit',
    publishedDate: new Date().toISOString(),
    thumbnail: undefined,
  },
  {
    url: 'https://www.polygon.com/mock-dnd-2025-update',
    title: 'D&D 2025 Core Rules: What We Know So Far',
    content: 'Wizards of the Coast confirms major changes to the action economy and spellcasting in the 2025 revision.',
    engine: 'google news',
    publishedDate: new Date().toISOString(),
    thumbnail: undefined,
  },
  {
    url: 'https://www.youtube.com/watch?v=mock-cr-episode',
    title: 'Critical Role C4 Episode 1 Breaks Records',
    content: 'The premiere of Campaign 4 drew 500k concurrent viewers on Twitch, the highest for any TTRPG stream.',
    engine: 'google',
    publishedDate: new Date().toISOString(),
    thumbnail: 'https://img.youtube.com/vi/mock/0.jpg',
  },
  {
    url: 'https://www.tiktok.com/@mock-dnd-creator/viral-nat20',
    title: 'TikTok: "When the bard rolls a nat 20 on seduction" — 2M views',
    content: 'Viral TikTok format showing dramatic D&D moments with cinematic transitions. Perfect for trend content.',
    engine: 'google',
    publishedDate: new Date().toISOString(),
    thumbnail: undefined,
  },
  {
    url: 'https://foundryvtt.com/releases/mock-v13',
    title: 'Foundry VTT v13 — Scene Regions & Enhanced Lighting',
    content: 'Major update brings scene regions, dynamic token lighting, and improved module API for developers.',
    engine: 'reddit',
    publishedDate: new Date().toISOString(),
    thumbnail: undefined,
  },
  {
    url: 'https://old-article.example.com/stale',
    title: 'Old Article That Should Be Filtered',
    content: 'This article is too old and should be filtered by maxAgeHours.',
    engine: 'google',
    publishedDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    thumbnail: undefined,
  },
];

export function mockAnalysisResponse(articles: readonly { url: string }[]): string {
  const analyzed = articles.map((a, i) => ({
    url: a.url,
    score: Math.max(3, 10 - i),
    pillar: (['trend', 'tuto', 'community', 'product'] as const)[i % 4],
    suggestedAngle: `Angle mock #${String(i + 1)} — Idée de contenu pour Le Chroniqueur`,
    translatedTitle: `[FR] Titre traduit #${String(i + 1)}`,
    translatedSnippet: `[FR] Extrait traduit #${String(i + 1)}`,
  }));

  return JSON.stringify({ articles: analyzed });
}

export function mockSuggestionsResponse(count: number): string {
  const pillars = ['trend', 'tuto', 'community', 'product'] as const;
  const platforms = ['tiktok', 'instagram', 'both'] as const;
  const formats = ['reel', 'carousel', 'story'] as const;

  const suggestions = Array.from({ length: count }, (_, i) => ({
    hook: `🎲 Mock hook #${String(i + 1)} — Et si ton MJ faisait ça en pleine session ?`,
    script: [
      `[0-3s] Accroche visuelle — plan serré sur des dés qui roulent`,
      `[3-8s] "Tu sais ce moment où le MJ sourit et dit 'Tu es sûr ?'"`,
      `[8-15s] Montage rapide de situations JDR mock #${String(i + 1)}`,
      `[15-20s] Punchline + appel à l'action`,
    ].join('\n'),
    pillar: pillars[i % pillars.length],
    platform: platforms[i % platforms.length],
    format: formats[i % formats.length],
    hashtags: ['#jdr', '#dnd', '#ttrpg', '#lechroniqueur', `#mock${String(i + 1)}`],
    suggestedTime: `${String(18 + (i % 3))}h00`,
  }));

  return JSON.stringify({ suggestions });
}

export function mockCompleteResponse(userMessage: string): string {
  // Detect context from prompt content
  if (userMessage.includes('"suggestions"')) {
    const countMatch = userMessage.match(/exactement (\d+) suggestions/);
    const count = countMatch !== null ? parseInt(countMatch[1] ?? '3', 10) : 3;
    return mockSuggestionsResponse(count);
  }

  // Default: analysis response
  const urlMatches = [...userMessage.matchAll(/URL: (https?:\/\/\S+)/g)];
  const articles = urlMatches.map((m) => ({ url: m[1] ?? '' }));
  return mockAnalysisResponse(articles);
}
