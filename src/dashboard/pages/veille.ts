import type { SqliteDatabase } from '../../core/database.js';
import {
  type V2MessagePayload,
  buildContainer, txt, sep, btn, row, v2, getColor,
  ButtonStyle,
} from '../../discord/component-builder-v2.js';

export function buildVeillePage(db: SqliteDatabase, instanceName: string): V2MessagePayload {
  // Stats
  const todayRow = db.prepare(`
    SELECT COUNT(*) AS cnt FROM veille_articles
    WHERE collected_at >= datetime('now', 'start of day')
  `).get() as { cnt: number };

  const weekRow = db.prepare(`
    SELECT COUNT(*) AS cnt FROM veille_articles
    WHERE collected_at >= datetime('now', '-7 days')
  `).get() as { cnt: number };

  const pendingRow = db.prepare(
    "SELECT COUNT(*) AS cnt FROM veille_articles WHERE status IN ('new', 'proposed')",
  ).get() as { cnt: number };

  const transformedRow = db.prepare(
    "SELECT COUNT(*) AS cnt FROM veille_articles WHERE status = 'transformed'",
  ).get() as { cnt: number };

  const archivedRow = db.prepare(
    "SELECT COUNT(*) AS cnt FROM veille_articles WHERE status = 'archived'",
  ).get() as { cnt: number };

  // Categories
  const categories = db.prepare(
    'SELECT id, label FROM veille_categories WHERE is_active = 1 ORDER BY sort_order',
  ).all() as Array<{ id: string; label: string }>;

  const catList = categories.length > 0
    ? categories.map((c) => c.label).join(' · ')
    : '(aucune — utilise les catégories par défaut)';

  // Last cron
  const lastRun = db.prepare(
    "SELECT last_run_at, status, error FROM cron_runs WHERE job_name = 'veille'",
  ).get() as { last_run_at: string; status: string; error: string | null } | undefined;

  const lastRunInfo = lastRun !== undefined
    ? `Dernière exécution : ${lastRun.last_run_at} (${lastRun.status})`
    : 'Dernière exécution : jamais';

  return v2([buildContainer(getColor('veille'), (c) => {
    c.addTextDisplayComponents(txt(`# 📰 Veille — ${instanceName}`));
    c.addSeparatorComponents(sep());

    c.addTextDisplayComponents(txt([
      '### Statistiques',
      `Aujourd'hui : **${String(todayRow.cnt)}** articles collectés`,
      `Cette semaine : **${String(weekRow.cnt)}** articles collectés`,
      `En attente : **${String(pendingRow.cnt)}** · Transformés : **${String(transformedRow.cnt)}** · Archivés : **${String(archivedRow.cnt)}**`,
    ].join('\n')));

    c.addSeparatorComponents(sep());

    c.addTextDisplayComponents(txt(`### Catégories actives\n${catList}\n${String(categories.length)} catégories`));

    c.addSeparatorComponents(sep());

    c.addTextDisplayComponents(txt(`### Scheduler\n${lastRunInfo}`));

    c.addSeparatorComponents(sep());

    c.addActionRowComponents(row(
      btn('dash:veille:run', 'Lancer maintenant', ButtonStyle.Success, '🔄'),
      btn('dash:veille:top', 'Top articles semaine', ButtonStyle.Secondary, '📊'),
    ));
    c.addActionRowComponents(row(
      btn('dash:veille:categories', 'Modifier catégories', ButtonStyle.Secondary, '⚙️'),
      btn('dash:home', 'Retour', ButtonStyle.Secondary, '←'),
    ));
  })]);
}
