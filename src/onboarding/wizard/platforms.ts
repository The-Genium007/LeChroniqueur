import {
  type V2MessagePayload,
  buildContainer, txt, sep, btn, row, v2, getColor,
  ButtonStyle,
} from '../../discord/component-builder-v2.js';
import { type WizardSession, getStepLabel } from './state-machine.js';
import { DEFAULT_INSTANCE_CONFIG } from '../../core/config.js';
import { PLATFORM_CONFIG } from '../postiz-setup.js';

/**
 * Build the platform selection prompt.
 * Shows only platforms that were configured in the Postiz step,
 * falling back to all available if none were configured.
 */
export function buildPlatformSelection(session: WizardSession): V2MessagePayload {
  const selected = session.data.platforms ?? session.data.projectPlatforms ?? [];

  // Get platforms configured in Postiz step (stored in session) or show all
  const configuredPostiz = (session.data as Record<string, unknown>)['_configuredPostizPlatforms'] as string[] | undefined;
  const availableIds = configuredPostiz !== undefined && configuredPostiz.length > 0
    ? configuredPostiz
    : Object.keys(PLATFORM_CONFIG);

  const selectedSet = new Set(selected);

  const statusLines = availableIds.map((id) => {
    const def = PLATFORM_CONFIG[id];
    if (def === undefined) return null;
    return selectedSet.has(id) ? `✅ **${def.label}**` : `❌ ${def.label}`;
  }).filter((l): l is string => l !== null);

  // Build platform buttons in rows of 4
  const platformRows: ReturnType<typeof row>[] = [];
  for (let i = 0; i < availableIds.length; i += 4) {
    const chunk = availableIds.slice(i, i + 4);
    const buttons = chunk.map((id) => {
      const def = PLATFORM_CONFIG[id];
      if (def === undefined) return btn(`wizard:platform:${id}`, id, ButtonStyle.Secondary);
      const isSelected = selectedSet.has(id);
      return btn(`wizard:platform:${id}`, def.label, isSelected ? ButtonStyle.Success : ButtonStyle.Secondary, def.emoji);
    });
    platformRows.push(row(...buttons));
  }

  return v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt([
      `## 📱 Plateformes de publication — Étape ${getStepLabel(session.step)}`,
      '',
      'Sélectionne les plateformes sur lesquelles publier.',
      'Clique pour activer/désactiver.',
      '',
      statusLines.join('\n'),
    ].join('\n')));
    c.addSeparatorComponents(sep());
    for (const r of platformRows) {
      c.addActionRowComponents(r);
    }
    c.addActionRowComponents(row(
      btn('wizard:next', 'Valider', ButtonStyle.Success, '✅'),
    ));
  })]);
}

/**
 * Build the schedule configuration prompt.
 */
export function buildScheduleConfig(session: WizardSession): V2MessagePayload {
  const veille = session.data.veilleCron ?? DEFAULT_INSTANCE_CONFIG.scheduler.veilleCron;
  const suggestions = session.data.suggestionsCron ?? DEFAULT_INSTANCE_CONFIG.scheduler.suggestionsCron;
  const rapport = session.data.rapportCron ?? DEFAULT_INSTANCE_CONFIG.scheduler.rapportCron;

  return v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt([
      `## ⏰ Scheduler — Étape ${getStepLabel(session.step)}`,
      '',
      'Voici les horaires par défaut :',
      '',
      `📰 **Veille** : tous les jours à 7h (\`${veille}\`)`,
      `💡 **Suggestions** : tous les jours à 8h (\`${suggestions}\`)`,
      `📊 **Rapport** : dimanche à 21h (\`${rapport}\`)`,
      '',
      'Tu peux garder ces defaults ou les modifier via le dashboard plus tard.',
    ].join('\n')));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn('wizard:next', 'Garder les defaults', ButtonStyle.Success, '✅'),
      btn('wizard:schedule:edit', 'Modifier', ButtonStyle.Primary, '✏️'),
    ));
  })]);
}

export function togglePlatform(session: WizardSession, platform: string): void {
  const current = session.data.platforms ?? session.data.projectPlatforms ?? [];
  const index = current.indexOf(platform);

  if (index >= 0) {
    session.data.platforms = current.filter((p) => p !== platform);
  } else {
    session.data.platforms = [...current, platform];
  }
}
