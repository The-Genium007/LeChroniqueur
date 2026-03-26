import {
  type V2MessagePayload,
  buildContainer, txt, sep, btn, row, v2, getColor,
  ButtonStyle,
} from '../../discord/component-builder-v2.js';
import { type WizardSession, getStepLabel } from './state-machine.js';
import { DEFAULT_INSTANCE_CONFIG } from '../../core/config.js';

/**
 * Build the platform selection prompt.
 */
export function buildPlatformSelection(session: WizardSession): V2MessagePayload {
  const current = session.data.projectPlatforms ?? ['tiktok', 'instagram'];

  return v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt([
      `## 📱 Plateformes — Étape ${getStepLabel(session.step)}`,
      '',
      `Plateformes actuelles : **${current.join(', ')}**`,
      '',
      'Tu peux garder cette sélection ou la modifier.',
    ].join('\n')));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn('wizard:platform:tiktok', 'TikTok', current.includes('tiktok') ? ButtonStyle.Success : ButtonStyle.Secondary, '📱'),
      btn('wizard:platform:instagram', 'Instagram', current.includes('instagram') ? ButtonStyle.Success : ButtonStyle.Secondary, '📸'),
      btn('wizard:platform:twitter', 'X/Twitter', current.includes('twitter') ? ButtonStyle.Success : ButtonStyle.Secondary, '🐦'),
      btn('wizard:platform:linkedin', 'LinkedIn', current.includes('linkedin') ? ButtonStyle.Success : ButtonStyle.Secondary, '💼'),
    ));
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
  const current = session.data.platforms ?? session.data.projectPlatforms ?? ['tiktok', 'instagram'];
  const index = current.indexOf(platform);

  if (index >= 0) {
    session.data.platforms = current.filter((p) => p !== platform);
  } else {
    session.data.platforms = [...current, platform];
  }
}
