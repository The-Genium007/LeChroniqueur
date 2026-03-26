import type { SqliteDatabase } from '../../core/database.js';
import {
  type V2MessagePayload,
  buildContainer, txt, sep, btn, row, v2, getColor, progressBar, centsToEuros,
  ButtonStyle,
} from '../../discord/component-builder-v2.js';
import { getDailyTotal, getMonthlyTotal } from '../../budget/tracker.js';

export interface DashboardHomeData {
  readonly instanceName: string;
  readonly createdAt: string;
  // Veille
  readonly articlesEnAttente: number;
  readonly derniereVeille: string;
  readonly prochaineVeille: string;
  // Suggestions
  readonly suggestionsEnAttente: number;
  readonly tauxGo: number;
  // Publications
  readonly publicationsProgrammees: number;
  readonly prochainPost: string;
  readonly pubsCeMois: number;
  // Budget
  readonly budgetJour: { totalCents: number; budgetCents: number };
  readonly budgetMois: { totalCents: number; budgetCents: number };
  // Santé
  readonly services: Record<string, 'ok' | 'warning' | 'error'>;
  // Instance status
  readonly isPaused: boolean;
}

const SERVICE_ICONS: Record<string, string> = {
  ok: '🟢',
  warning: '🟡',
  error: '🔴',
};

export function buildDashboardHome(data: DashboardHomeData): V2MessagePayload {
  const jourPercent = data.budgetJour.budgetCents > 0
    ? Math.round((data.budgetJour.totalCents / data.budgetJour.budgetCents) * 100)
    : 0;
  const moisPercent = data.budgetMois.budgetCents > 0
    ? Math.round((data.budgetMois.totalCents / data.budgetMois.budgetCents) * 100)
    : 0;

  const pauseBanner = data.isPaused ? '> ⏸️ **Instance en pause** — les crons sont suspendus\n\n' : '';

  const healthLine = Object.entries(data.services)
    .map(([name, status]) => `${SERVICE_ICONS[status] ?? '⚪'} ${name}`)
    .join(' · ');

  return v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt(`# 🎛️ ${data.instanceName} — Dashboard\n${pauseBanner}*Instance active depuis le ${data.createdAt}*`));
    c.addSeparatorComponents(sep());

    // Veille
    c.addTextDisplayComponents(txt(
      `### 📰 Veille\n${String(data.articlesEnAttente)} articles en attente · dernière : ${data.derniereVeille}\nProchaine : ${data.prochaineVeille}`,
    ));

    // Suggestions
    c.addTextDisplayComponents(txt(
      `### 💡 Suggestions\n${String(data.suggestionsEnAttente)} en attente · ✅ ${String(data.tauxGo)}% Go cette semaine`,
    ));

    // Publications
    c.addTextDisplayComponents(txt(
      `### 📤 Publications\n${String(data.publicationsProgrammees)} programmées · prochain : ${data.prochainPost}\n${String(data.pubsCeMois)} publiées ce mois`,
    ));

    // Budget
    c.addTextDisplayComponents(txt(
      `### 💰 Budget\nJour : ${centsToEuros(data.budgetJour.totalCents)}€/${centsToEuros(data.budgetJour.budgetCents)}€ ${progressBar(jourPercent, 10)} ${String(jourPercent)}%\nMois : ${centsToEuros(data.budgetMois.totalCents)}€/${centsToEuros(data.budgetMois.budgetCents)}€ ${progressBar(moisPercent, 10)} ${String(moisPercent)}%`,
    ));

    c.addSeparatorComponents(sep());

    // Santé
    c.addTextDisplayComponents(txt(`**🏥 Santé** ${healthLine}`));

    c.addSeparatorComponents(sep());

    // Navigation buttons
    c.addActionRowComponents(row(
      btn('dash:veille', 'Veille', ButtonStyle.Secondary, '📰'),
      btn('dash:content', 'Contenu', ButtonStyle.Secondary, '💡'),
      btn('dash:budget', 'Budget', ButtonStyle.Secondary, '💰'),
      btn('dash:config', 'Config', ButtonStyle.Secondary, '⚙️'),
    ));

    c.addActionRowComponents(row(
      btn('dash:home', 'Rafraîchir', ButtonStyle.Primary, '🔄'),
      btn('dash:pause', data.isPaused ? 'Reprendre' : 'Pause', ButtonStyle.Danger, data.isPaused ? '▶️' : '⏸️'),
    ));
  })]);
}

/**
 * Gather dashboard home data from the instance DB.
 */
export function collectDashboardHomeData(
  db: SqliteDatabase,
  instanceName: string,
  createdAt: string,
  isPaused: boolean,
): DashboardHomeData {
  // Articles en attente
  const articlesRow = db.prepare(
    "SELECT COUNT(*) AS cnt FROM veille_articles WHERE status IN ('new', 'proposed')",
  ).get() as { cnt: number };

  // Dernière veille
  const lastVeille = db.prepare(
    "SELECT last_run_at FROM cron_runs WHERE job_name = 'veille'",
  ).get() as { last_run_at: string } | undefined;

  // Suggestions en attente
  const suggestionsRow = db.prepare(
    "SELECT COUNT(*) AS cnt FROM suggestions WHERE status = 'pending'",
  ).get() as { cnt: number };

  // Taux de Go cette semaine
  const goStats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'go' THEN 1 ELSE 0 END) AS go_count
    FROM suggestions
    WHERE decided_at >= datetime('now', '-7 days')
      AND status IN ('go', 'skipped')
  `).get() as { total: number; go_count: number };
  const tauxGo = goStats.total > 0 ? Math.round((goStats.go_count / goStats.total) * 100) : 0;

  // Publications
  const pubsRow = db.prepare(
    "SELECT COUNT(*) AS cnt FROM publications WHERE status = 'scheduled'",
  ).get() as { cnt: number };

  const pubsMoisRow = db.prepare(
    "SELECT COUNT(*) AS cnt FROM publications WHERE published_at >= datetime('now', 'start of month')",
  ).get() as { cnt: number };

  const prochainPost = db.prepare(
    "SELECT scheduled_at FROM publications WHERE status = 'scheduled' ORDER BY scheduled_at ASC LIMIT 1",
  ).get() as { scheduled_at: string } | undefined;

  // Budget
  const budgetJour = getDailyTotal(db);
  const budgetMois = getMonthlyTotal(db);

  return {
    instanceName,
    createdAt,
    articlesEnAttente: articlesRow.cnt,
    derniereVeille: lastVeille?.last_run_at ?? 'jamais',
    prochaineVeille: '—',
    suggestionsEnAttente: suggestionsRow.cnt,
    tauxGo,
    publicationsProgrammees: pubsRow.cnt,
    prochainPost: prochainPost?.scheduled_at ?? 'aucun',
    pubsCeMois: pubsMoisRow.cnt,
    budgetJour: {
      totalCents: budgetJour.totalCents,
      budgetCents: budgetJour.budgetCents,
    },
    budgetMois: {
      totalCents: budgetMois.totalCents,
      budgetCents: budgetMois.budgetCents,
    },
    services: {
      Discord: 'ok',
      Anthropic: 'ok',
      SearXNG: 'ok',
      Postiz: 'ok',
      SQLite: 'ok',
    },
    isPaused,
  };
}
