import { z } from 'zod';

// ─── Couche 1 : Infrastructure (env vars, set by deployer) ───

const infraSchema = z.object({
  DISCORD_TOKEN: z.string().default(''),
  MASTER_ENCRYPTION_KEY: z.string().default(''),
  POSTIZ_URL: z.string().default(''),
  POSTIZ_INTERNAL_URL: z.string().default('http://postiz:4007'),
  SEARXNG_URL: z.string().default('http://searxng:8080'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
  DRY_RUN: z.string().default('false').transform((v) => v === 'true' || v === '1'),
  MOCK_APIS: z.string().default('false').transform((v) => v === 'true' || v === '1'),
});

export type InfraConfig = z.infer<typeof infraSchema>;

// ─── Couche 2 : Legacy env vars (backward compat, will move to DB in Phase 3+) ───

const legacySchema = z.object({
  DISCORD_GUILD_ID: z.string().default(''),
  DISCORD_OWNER_ID: z.string().default('dry-run-owner'),

  CHANNEL_VEILLE: z.string().default(''),
  CHANNEL_IDEES: z.string().default(''),
  CHANNEL_PRODUCTION: z.string().default(''),
  CHANNEL_PUBLICATION: z.string().default(''),
  CHANNEL_LOGS: z.string().default(''),
  CHANNEL_ADMIN: z.string().default(''),
  CHANNEL_BUGS: z.string().default(''),
  CHANNEL_FEEDBACK: z.string().default(''),

  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-20250514'),
  GOOGLE_AI_API_KEY: z.string().default(''),
  LLM_PROVIDER: z.string().default('anthropic'),
  LLM_MODEL: z.string().default(''),
  LLM_API_KEY: z.string().default(''),
  LLM_BASE_URL: z.string().default(''),
  POSTIZ_API_URL: z.string().default(''),
  POSTIZ_API_KEY: z.string().default(''),

  BUDGET_DAILY_CENTS: z.coerce.number().int().positive().default(300),
  BUDGET_WEEKLY_CENTS: z.coerce.number().int().positive().default(1500),
  BUDGET_MONTHLY_CENTS: z.coerce.number().int().positive().default(5000),

  VEILLE_CRON: z.string().default('0 7 * * *'),
  SUGGESTIONS_CRON: z.string().default('0 8 * * *'),
  RAPPORT_CRON: z.string().default('0 21 * * 0'),
});

// ─── Combined config (infra + legacy) ───

const envSchema = infraSchema.merge(legacySchema);

export type Config = z.infer<typeof envSchema>;

let _config: Config | undefined;

export function loadConfig(): Config {
  if (_config !== undefined) {
    return _config;
  }

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${formatted}`);
  }

  _config = result.data;

  // In production mode, Discord token is always mandatory
  if (!_config.DRY_RUN) {
    if (_config.DISCORD_TOKEN.length === 0) {
      throw new Error('Missing DISCORD_TOKEN (set DRY_RUN=true to skip)');
    }

    // Legacy mode: if channel IDs are provided via env, validate them
    const hasLegacyChannels = _config.CHANNEL_VEILLE.length > 0;
    if (hasLegacyChannels) {
      const required: Array<[string, string]> = [
        ['DISCORD_GUILD_ID', _config.DISCORD_GUILD_ID],
        ['CHANNEL_VEILLE', _config.CHANNEL_VEILLE],
        ['CHANNEL_IDEES', _config.CHANNEL_IDEES],
        ['CHANNEL_PRODUCTION', _config.CHANNEL_PRODUCTION],
        ['CHANNEL_PUBLICATION', _config.CHANNEL_PUBLICATION],
        ['CHANNEL_LOGS', _config.CHANNEL_LOGS],
        ['CHANNEL_ADMIN', _config.CHANNEL_ADMIN],
        ['CHANNEL_BUGS', _config.CHANNEL_BUGS],
        ['CHANNEL_FEEDBACK', _config.CHANNEL_FEEDBACK],
        ['ANTHROPIC_API_KEY', _config.ANTHROPIC_API_KEY],
      ];

      const missing = required.filter(([, v]) => v.length === 0).map(([k]) => k);
      if (missing.length > 0) {
        throw new Error(`Missing required env vars (set DRY_RUN=true to skip):\n  ${missing.join('\n  ')}`);
      }
    }
    // If no legacy channels → onboarding mode (Phase 3+), channels come from DB
  }

  return _config;
}

export function getConfig(): Config {
  if (_config === undefined) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return _config;
}

/**
 * Returns true if legacy channel IDs are configured via env vars.
 * When false, the bot expects channels to come from the instance registry (Phase 3+).
 */
export function isLegacyMode(): boolean {
  const config = getConfig();
  return config.CHANNEL_VEILLE.length > 0;
}

// ─── Couche 3 : Instance config (from DB, not env) ───

export interface InstanceConfig {
  readonly name: string;
  readonly persona: string;
  readonly categories: readonly InstanceVeilleCategory[];
  readonly scheduler: {
    readonly veilleCron: string;
    readonly suggestionsCron: string;
    readonly rapportCron: string;
  };
  readonly budget: {
    readonly dailyCents: number;
    readonly weeklyCents: number;
    readonly monthlyCents: number;
  };
  readonly content: {
    readonly suggestionsPerCycle: number;
    readonly minScoreToPropose: number;
    readonly platforms: readonly string[];
    readonly formats: readonly string[];
    readonly pillars: readonly string[];
  };
  readonly theme: {
    readonly primary: number;
    readonly success: number;
    readonly warning: number;
    readonly error: number;
    readonly info: number;
    readonly veille: number;
    readonly suggestion: number;
    readonly production: number;
    readonly publication: number;
  };
}

export interface InstanceVeilleCategory {
  readonly id: string;
  readonly label: string;
  readonly keywords: {
    readonly en: readonly string[];
    readonly fr: readonly string[];
  };
  readonly engines: readonly string[];
  readonly maxAgeHours: number;
  readonly isActive: boolean;
}

export const DEFAULT_INSTANCE_CONFIG: Omit<InstanceConfig, 'name' | 'persona' | 'categories'> = {
  scheduler: {
    veilleCron: '0 7 * * *',
    suggestionsCron: '0 8 * * *',
    rapportCron: '0 21 * * 0',
  },
  budget: {
    dailyCents: 300,
    weeklyCents: 1500,
    monthlyCents: 5000,
  },
  content: {
    suggestionsPerCycle: 3,
    minScoreToPropose: 6,
    platforms: ['tiktok', 'instagram'],
    formats: ['reel', 'carousel', 'story', 'post'],
    pillars: ['trend', 'tuto', 'community', 'product'],
  },
  theme: {
    primary: 0x5865f2,
    success: 0x57f287,
    warning: 0xfee75c,
    error: 0xed4245,
    info: 0x5865f2,
    veille: 0x5865f2,
    suggestion: 0x5865f2,
    production: 0xeb459e,
    publication: 0x57f287,
  },
};
