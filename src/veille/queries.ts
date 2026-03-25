export interface VeilleCategory {
  readonly id: string;
  readonly label: string;
  readonly keywords: {
    readonly en: readonly string[];
    readonly fr: readonly string[];
  };
  readonly engines: readonly string[];
  readonly maxAgeHours: number;
}

const CATEGORIES: readonly VeilleCategory[] = [
  {
    id: 'ttrpg_news',
    label: 'Actus TTRPG',
    keywords: {
      en: ['D&D news', 'Pathfinder news', 'TTRPG news', 'WotC announcement', 'Critical Role'],
      fr: ['JDR actualité', 'Donjons et Dragons news', 'sortie JDR'],
    },
    engines: ['google news', 'reddit'],
    maxAgeHours: 72,
  },
  {
    id: 'ttrpg_memes',
    label: 'Memes JDR',
    keywords: {
      en: ['dnd memes', 'rpg horror stories', 'nat 20 stories', 'TPK stories', 'D&D funny'],
      fr: ['memes JDR', 'échec critique histoires', 'JDR drôle'],
    },
    engines: ['reddit', 'imgur'],
    maxAgeHours: 168, // 7 days — memes stay relevant longer
  },
  {
    id: 'streaming',
    label: 'Streaming / Twitch',
    keywords: {
      en: ['Twitch TTRPG', 'actual play stream', 'D&D stream trends', 'TTRPG live play'],
      fr: ['stream JDR', 'partie en live Twitch', 'actual play FR'],
    },
    engines: ['reddit', 'twitter', 'google'],
    maxAgeHours: 72,
  },
  {
    id: 'tiktok_trends',
    label: 'Trends TikTok / Reels',
    keywords: {
      en: ['tiktok DnD', 'tiktok TTRPG viral', 'trending sound DnD', 'DnD reel viral'],
      fr: ['tiktok JDR', 'tendance tiktok jeu de role', 'format viral JDR'],
    },
    engines: ['google', 'twitter'],
    maxAgeHours: 48,
  },
  {
    id: 'influencers',
    label: 'Influenceurs JDR',
    keywords: {
      en: ['DnD creator YouTube', 'TTRPG influencer', 'DnD content creator', 'TTRPG YouTube'],
      fr: ['créateur JDR', 'influenceur jeu de rôle', 'chaîne YouTube JDR'],
    },
    engines: ['youtube', 'google'],
    maxAgeHours: 168,
  },
  {
    id: 'vtt_tech',
    label: 'VTT / Tech',
    keywords: {
      en: ['Foundry VTT update', 'Roll20 news', 'virtual tabletop new', 'VTT module release'],
      fr: ['table virtuelle JDR', 'Foundry module', 'VTT mise à jour'],
    },
    engines: ['hackernews', 'reddit', 'google'],
    maxAgeHours: 168,
  },
  {
    id: 'community_fr',
    label: 'Communauté FR',
    keywords: {
      en: [],
      fr: [
        'convention JDR France',
        'sortie JDR francophone',
        'actual play français',
        'communauté JDR FR',
        'partie JDR en ligne',
      ],
    },
    engines: ['google', 'reddit'],
    maxAgeHours: 168,
  },
  {
    id: 'facebook_groups',
    label: 'Facebook Groups',
    keywords: {
      en: ['D&D group site:facebook.com', 'TTRPG community site:facebook.com', 'DM tips group'],
      fr: ['groupe JDR site:facebook.com', 'MJ conseils site:facebook.com'],
    },
    engines: ['google'],
    maxAgeHours: 168,
  },
  {
    id: 'competition',
    label: 'Concurrence / Outils',
    keywords: {
      en: [
        'poll overlay Twitch',
        'stream interaction tool',
        'audience participation streaming',
        'Twitch engagement tool',
      ],
      fr: ['sondage Twitch', 'interaction viewers stream', 'outil engagement stream'],
    },
    engines: ['google', 'reddit'],
    maxAgeHours: 168,
  },
];

export function getCategories(): readonly VeilleCategory[] {
  return CATEGORIES;
}

export interface SearxngQuery {
  readonly query: string;
  readonly engines: readonly string[];
  readonly language: string;
  readonly category: string;
}

export function buildSearxngQueries(category: VeilleCategory): readonly SearxngQuery[] {
  const queries: SearxngQuery[] = [];

  for (const keyword of category.keywords.en) {
    queries.push({
      query: keyword,
      engines: category.engines,
      language: 'en',
      category: category.id,
    });
  }

  for (const keyword of category.keywords.fr) {
    queries.push({
      query: keyword,
      engines: category.engines,
      language: 'fr',
      category: category.id,
    });
  }

  return queries;
}
