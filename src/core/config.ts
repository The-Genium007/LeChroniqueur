import { z } from 'zod';

const envSchema = z.object({
  // ─── Discord ───
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_OWNER_ID: z.string().min(1),

  CHANNEL_VEILLE: z.string().min(1),
  CHANNEL_IDEES: z.string().min(1),
  CHANNEL_PRODUCTION: z.string().min(1),
  CHANNEL_PUBLICATION: z.string().min(1),
  CHANNEL_LOGS: z.string().min(1),
  CHANNEL_ADMIN: z.string().min(1),
  CHANNEL_BUGS: z.string().min(1),
  CHANNEL_FEEDBACK: z.string().min(1),

  // ─── Anthropic ───
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6-20250929'),

  // ─── Google AI ───
  GOOGLE_AI_API_KEY: z.string().default(''),

  // ─── Postiz ───
  POSTIZ_API_URL: z.string().url().default('https://postiz.tumulte.app/public/v1'),
  POSTIZ_API_KEY: z.string().default(''),

  // ─── SearXNG ───
  SEARXNG_URL: z.string().url().default('http://searxng:8080'),

  // ─── Budget (centimes) ───
  BUDGET_DAILY_CENTS: z.coerce.number().int().positive().default(300),
  BUDGET_WEEKLY_CENTS: z.coerce.number().int().positive().default(1500),
  BUDGET_MONTHLY_CENTS: z.coerce.number().int().positive().default(5000),

  // ─── Scheduler ───
  VEILLE_CRON: z.string().default('0 7 * * *'),
  SUGGESTIONS_CRON: z.string().default('0 8 * * *'),
  RAPPORT_CRON: z.string().default('0 21 * * 0'),

  // ─── Logging ───
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
});

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
  return _config;
}

export function getConfig(): Config {
  if (_config === undefined) {
    throw new Error('Config not loaded. Call loadConfig() first.');
  }
  return _config;
}
