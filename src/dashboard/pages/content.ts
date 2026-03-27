import type { SqliteDatabase } from '../../core/database.js';
import {
  type V2MessagePayload,
  buildContainer, txt, sep, btn, row, v2, getColor,
  ButtonStyle,
} from '../../discord/component-builder-v2.js';

export function buildContentPage(db: SqliteDatabase, instanceName: string): V2MessagePayload {
  // Suggestions stats
  const sugStats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'go' THEN 1 ELSE 0 END) AS go_count,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skip_count,
      SUM(CASE WHEN status = 'modified' THEN 1 ELSE 0 END) AS mod_count,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count
    FROM suggestions
    WHERE created_at >= datetime('now', '-7 days')
  `).get() as { total: number; go_count: number; skip_count: number; mod_count: number; pending_count: number };

  const decided = sugStats.go_count + sugStats.skip_count;
  const goRate = decided > 0 ? Math.round((sugStats.go_count / decided) * 100) : 0;

  // Publications stats
  const pubStats = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) AS scheduled,
      SUM(CASE WHEN status = 'published' AND published_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS published_week,
      SUM(CASE WHEN status = 'published' AND published_at >= datetime('now', 'start of month') THEN 1 ELSE 0 END) AS published_month
    FROM publications
  `).get() as { scheduled: number; published_week: number; published_month: number };

  return v2([buildContainer(getColor('suggestion'), (c) => {
    c.addTextDisplayComponents(txt(`# 💡 Contenu — ${instanceName}`));
    c.addSeparatorComponents(sep());

    c.addTextDisplayComponents(txt([
      '### Suggestions (7 derniers jours)',
      `Total : **${String(sugStats.total)}**`,
      `✅ Go : **${String(sugStats.go_count)}** (${String(goRate)}%) · ⏭️ Skip : **${String(sugStats.skip_count)}** · ✏️ Modifiées : **${String(sugStats.mod_count)}**`,
      `En attente : **${String(sugStats.pending_count)}**`,
    ].join('\n')));

    c.addSeparatorComponents(sep());

    c.addTextDisplayComponents(txt([
      '### Publications',
      `Programmées : **${String(pubStats.scheduled)}**`,
      `Publiées cette semaine : **${String(pubStats.published_week)}**`,
      `Publiées ce mois : **${String(pubStats.published_month)}**`,
    ].join('\n')));

    c.addSeparatorComponents(sep());

    c.addActionRowComponents(row(
      btn('dash:suggestions:generate', 'Générer suggestions', ButtonStyle.Success, '💡'),
      btn('dash:suggestions:pending', 'Voir en attente', ButtonStyle.Secondary, '📋'),
    ));
    c.addActionRowComponents(row(
      btn('dash:home', 'Retour', ButtonStyle.Secondary, '◀️'),
    ));
  })]);
}
