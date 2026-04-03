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

  // Persona preview — handle both full persona and neutral mode
  let personaPreview: string;
  if (d.personaFull !== undefined && d.personaFull.length > 0) {
    // Extract first meaningful line (skip markdown headers)
    const lines = d.personaFull.split('\n').filter((l) => l.trim().length > 0 && !l.startsWith('#'));
    const firstLines = lines.slice(0, 3).join(' ').slice(0, 200);
    personaPreview = firstLines.length > 0 ? firstLines + '...' : d.personaTone ?? 'Configuré';
  } else if (d.personaTone !== undefined) {
    personaPreview = d.personaTone;
  } else {
    personaPreview = '(non généré)';
  }

  // Schedule display
  const scheduleMode = d.scheduleMode ?? 'daily';
  const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  let scheduleDisplay: string;
  if (scheduleMode === 'weekly' && d.veilleDay !== undefined) {
    const veilleName = dayNames[d.veilleDay] ?? '?';
    const hour = String(d.veilleHour ?? 7);
    const count = String(d.suggestionsPerCycle ?? 21);
    scheduleDisplay = `Hebdomadaire — ${veilleName} ${hour}h (${count} suggestions/cycle)`;
  } else {
    const hour = String(d.veilleHour ?? 7);
    scheduleDisplay = `Quotidien — veille ${hour}h · suggestions ${String((d.veilleHour ?? 7) + 1)}h · rapport dim 20h`;
  }

  // Sources display
  const enabledSources = d.enabledSources ?? ['searxng'];
  const sourcesDisplay = enabledSources.join(', ');

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
      `**📡 Sources** : ${sourcesDisplay}`,
      '',
      `**🎭 Persona** : ${personaPreview}`,
      '',
      `**⏰ Scheduler** : ${scheduleDisplay}`,
      '',
      `**🤖 Provider IA** : ${d.llmProvider ?? 'anthropic'} — ${d.llmModel ?? 'claude-sonnet-4-6'}`,
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
      btn('wizard:back', 'Revenir en arrière', ButtonStyle.Secondary, '◀️'),
      btn('wizard:cancel', 'Annuler', ButtonStyle.Danger, '✖️'),
    ));
  })]);
}
