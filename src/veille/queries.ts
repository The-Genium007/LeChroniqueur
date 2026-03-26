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

/**
 * Returns the hardcoded default categories.
 * Used in legacy mode and as seed data for new instances.
 */
export function getCategories(): readonly VeilleCategory[] {
  return CATEGORIES;
}

/**
 * Returns the default categories as a readonly reference for seeding instance DBs.
 */
export function getDefaultCategories(): readonly VeilleCategory[] {
  return CATEGORIES;
}

interface DbCategoryRow {
  id: string;
  label: string;
  keywords_en: string;
  keywords_fr: string;
  engines: string;
  max_age_hours: number;
  is_active: number;
}

/**
 * Load active categories from an instance DB.
 * Falls back to hardcoded defaults if the DB table is empty.
 * Returns InstanceVeilleCategory[] (includes isActive field).
 */
export function getCategoriesFromDb(db: import('../core/database.js').SqliteDatabase): readonly import('../core/config.js').InstanceVeilleCategory[] {
  const rows = db.prepare(
    'SELECT id, label, keywords_en, keywords_fr, engines, max_age_hours, is_active FROM veille_categories WHERE is_active = 1 ORDER BY sort_order ASC',
  ).all() as DbCategoryRow[];

  if (rows.length === 0) {
    // Convert hardcoded categories to InstanceVeilleCategory format
    return CATEGORIES.map((cat) => ({ ...cat, isActive: true }));
  }

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    keywords: {
      en: JSON.parse(row.keywords_en) as string[],
      fr: JSON.parse(row.keywords_fr) as string[],
    },
    engines: JSON.parse(row.engines) as string[],
    maxAgeHours: row.max_age_hours,
    isActive: row.is_active === 1,
  }));
}

/**
 * Seed the veille_categories table with default categories.
 * Only inserts if the table is empty (first run).
 */
export function seedCategories(db: import('../core/database.js').SqliteDatabase): void {
  const count = db.prepare('SELECT COUNT(*) AS cnt FROM veille_categories').get() as { cnt: number };

  if (count.cnt > 0) {
    return;
  }

  const insert = db.prepare(`
    INSERT INTO veille_categories (id, label, keywords_en, keywords_fr, engines, max_age_hours, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = db.transaction(() => {
    for (let i = 0; i < CATEGORIES.length; i++) {
      const cat = CATEGORIES[i];
      if (cat === undefined) continue;
      insert.run(
        cat.id,
        cat.label,
        JSON.stringify(cat.keywords.en),
        JSON.stringify(cat.keywords.fr),
        JSON.stringify(cat.engines),
        cat.maxAgeHours,
        i,
      );
    }
  });

  insertAll();
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
