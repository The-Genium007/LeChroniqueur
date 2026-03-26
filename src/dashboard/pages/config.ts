import type { SqliteDatabase } from '../../core/database.js';
import {
  type V2MessagePayload,
  buildContainer, txt, sep, btn, row, v2, getColor,
  ButtonStyle,
} from '../../discord/component-builder-v2.js';

export function buildConfigPage(db: SqliteDatabase, instanceName: string): V2MessagePayload {
  // Suggestions config
  const sugPerCycle = db.prepare("SELECT value FROM config_overrides WHERE key = 'suggestionsPerCycle'").get() as { value: string } | undefined;
  const minScore = db.prepare("SELECT value FROM config_overrides WHERE key = 'minScoreToPropose'").get() as { value: string } | undefined;

  // Scheduler config
  const veilleCron = db.prepare("SELECT value FROM config_overrides WHERE key = 'veilleCron'").get() as { value: string } | undefined;
  const suggestionsCron = db.prepare("SELECT value FROM config_overrides WHERE key = 'suggestionsCron'").get() as { value: string } | undefined;
  const rapportCron = db.prepare("SELECT value FROM config_overrides WHERE key = 'rapportCron'").get() as { value: string } | undefined;

  // Budget config
  const dailyCents = db.prepare("SELECT value FROM config_overrides WHERE key = 'dailyCents'").get() as { value: string } | undefined;
  const weeklyCents = db.prepare("SELECT value FROM config_overrides WHERE key = 'weeklyCents'").get() as { value: string } | undefined;
  const monthlyCents = db.prepare("SELECT value FROM config_overrides WHERE key = 'monthlyCents'").get() as { value: string } | undefined;

  // Persona
  const persona = db.prepare('SELECT length(content) AS size, updated_at FROM persona WHERE id = 1').get() as { size: number; updated_at: string } | undefined;

  return v2([buildContainer(getColor('info'), (c) => {
    c.addTextDisplayComponents(txt(`# ⚙️ Configuration — ${instanceName}`));
    c.addSeparatorComponents(sep());

    // Suggestions
    c.addTextDisplayComponents(txt([
      '### Suggestions',
      `Nombre par cycle : **${sugPerCycle?.value ?? '3'}**`,
      `Score minimum : **${minScore?.value ?? '6'}/10**`,
    ].join('\n')));

    c.addSeparatorComponents(sep());

    // Scheduler
    c.addTextDisplayComponents(txt([
      '### Scheduler',
      `Veille : \`${veilleCron?.value ?? '0 7 * * *'}\``,
      `Suggestions : \`${suggestionsCron?.value ?? '0 8 * * *'}\``,
      `Rapport : \`${rapportCron?.value ?? '0 21 * * 0'}\``,
    ].join('\n')));

    c.addSeparatorComponents(sep());

    // Budget
    c.addTextDisplayComponents(txt([
      '### Budget',
      `Jour : **${((Number(dailyCents?.value ?? 300)) / 100).toFixed(2)}€**`,
      `Semaine : **${((Number(weeklyCents?.value ?? 1500)) / 100).toFixed(2)}€**`,
      `Mois : **${((Number(monthlyCents?.value ?? 5000)) / 100).toFixed(2)}€**`,
    ].join('\n')));

    c.addSeparatorComponents(sep());

    // Persona
    const personaInfo = persona !== undefined
      ? `Taille : ${String(persona.size)} chars · Modifié le ${persona.updated_at}`
      : 'Non configuré (utilise le fichier prompts/SKILL.md)';
    c.addTextDisplayComponents(txt(`### Persona\n${personaInfo}`));

    c.addSeparatorComponents(sep());

    c.addActionRowComponents(row(
      btn('dash:config:edit:suggestions', 'Suggestions', ButtonStyle.Secondary, '✏️'),
      btn('dash:config:edit:scheduler', 'Scheduler', ButtonStyle.Secondary, '✏️'),
      btn('dash:config:edit:budget', 'Budget', ButtonStyle.Secondary, '✏️'),
    ));
    c.addActionRowComponents(row(
      btn('dash:config:persona', 'Persona', ButtonStyle.Primary, '📝'),
      btn('dash:config:new_instance', 'Nouvelle instance', ButtonStyle.Success, '➕'),
    ));
    c.addActionRowComponents(row(
      btn('dash:config:undo', 'Annuler dernier changement', ButtonStyle.Secondary, '↩️'),
      btn('dash:config:reset', 'Reset aux défauts', ButtonStyle.Danger, '🔄'),
      btn('dash:config:export', 'Export', ButtonStyle.Secondary, '📤'),
      btn('dash:home', 'Retour', ButtonStyle.Secondary, '←'),
    ));
  })]);
}
