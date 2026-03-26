import {
  type V2MessagePayload,
  buildContainer, txt, sep, btn, row, v2, getColor,
  ButtonStyle,
} from '../../discord/component-builder-v2.js';
import { type WizardSession, getStepLabel } from './state-machine.js';

/**
 * Build the confirmation summary before creating the instance.
 */
export function buildConfirmation(session: WizardSession): V2MessagePayload {
  const d = session.data;
  const categories = d.categories ?? [];
  const platforms = d.platforms ?? d.projectPlatforms ?? [];

  const catList = categories.map((c) => `  • ${c.label}`).join('\n');
  const personaPreview = d.personaFull !== undefined
    ? d.personaFull.slice(0, 300) + (d.personaFull.length > 300 ? '...' : '')
    : '(non généré)';

  return v2([buildContainer(getColor('success'), (c) => {
    c.addTextDisplayComponents(txt([
      `## ✅ Résumé — Étape ${getStepLabel(session.step)}`,
      '',
      `🏷️ **Nom** : ${d.instanceName ?? d.projectName ?? 'mon-instance'}`,
      `🎯 **Niche** : ${d.projectNiche ?? '—'}`,
      `🌐 **Langue** : ${d.projectLanguage ?? 'fr'}`,
      `📱 **Plateformes** : ${platforms.join(', ') || '—'}`,
      '',
      `**📰 Catégories de veille** (${String(categories.length)}) :`,
      catList || '  (aucune)',
      '',
      `**🎭 Persona** :`,
      `> ${personaPreview}`,
      '',
      `**⏰ Scheduler** : veille ${d.veilleCron ?? '7h'} · suggestions ${d.suggestionsCron ?? '8h'} · rapport ${d.rapportCron ?? 'dim 21h'}`,
      '',
      `*Tokens utilisés : ${String(session.tokensUsed)} · Itérations : ${String(session.iterationCount)}/20*`,
      '',
      '**Confirmer va créer :**',
      '• 1 catégorie Discord privée',
      '• 7 channels (dashboard, recherche, veille, idées, production, publication, logs)',
      '• 1 base de données dédiée',
      '• Les crons automatiques',
    ].join('\n')));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn('wizard:confirm', 'Créer l\'instance', ButtonStyle.Success, '🚀'),
      btn('wizard:back', 'Revenir en arrière', ButtonStyle.Secondary, '←'),
      btn('wizard:cancel', 'Annuler', ButtonStyle.Danger, '✖️'),
    ));
  })]);
}
