import {
  type V2MessagePayload,
  buildContainer, txt, sep, btn, row, v2, getColor,
  ButtonStyle,
} from '../../discord/component-builder-v2.js';
import { type WizardSession, getStepLabel } from './state-machine.js';
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
      btn('wizard:back', 'Retour', ButtonStyle.Secondary, '◀️'),
    ));
  })]);
}

/**
 * Build the schedule configuration prompt.
 */
export function buildScheduleConfig(session: WizardSession): V2MessagePayload {
  const mode = session.data.scheduleMode ?? 'daily';
  const veilleDay = session.data.veilleDay ?? 0;
  const veilleHour = session.data.veilleHour ?? 7;
  const pubDays = new Set(session.data.publicationDays ?? [1, 2, 3, 4, 5]);
  const suggestionsPerCycle = session.data.suggestionsPerCycle ?? (mode === 'weekly' ? 21 : 3);

  const dayNames = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
  const fullDayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

  const previewLines: string[] = [];
  if (mode === 'weekly') {
    const rapportDay = (veilleDay + 6) % 7;
    previewLines.push(`📊 ${fullDayNames[rapportDay] ?? ''} 20h — Rapport hebdo`);
    previewLines.push(`📰 ${fullDayNames[veilleDay] ?? ''} ${String(veilleHour)}h — Veille + ${String(suggestionsPerCycle)} suggestions`);
    const pubDayNames = [...pubDays].sort().map((d) => fullDayNames[d] ?? '?').join(', ');
    previewLines.push(`📱 ${pubDayNames} — Publications`);
  } else {
    previewLines.push(`📰 Tous les jours à ${String(veilleHour)}h — Veille`);
    previewLines.push(`💡 Tous les jours à ${String(veilleHour + 1)}h — ${String(suggestionsPerCycle)} suggestions`);
    previewLines.push('📊 Dimanche 20h — Rapport hebdo');
  }

  return v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt([
      `## ⏰ Planification — Étape ${getStepLabel(session.step)}`,
      '',
      'Choisis ton mode de fonctionnement :',
    ].join('\n')));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn('wizard:schedule:mode:weekly', 'Hebdomadaire', mode === 'weekly' ? ButtonStyle.Success : ButtonStyle.Secondary, '📅'),
      btn('wizard:schedule:mode:daily', 'Quotidien', mode === 'daily' ? ButtonStyle.Success : ButtonStyle.Secondary, '🔄'),
    ));

    if (mode === 'weekly') {
      c.addSeparatorComponents(sep());
      c.addTextDisplayComponents(txt('**Jour de veille :**'));
      const dayBtns = dayNames.map((name, i) =>
        btn(`wizard:schedule:day:${String(i)}`, name, i === veilleDay ? ButtonStyle.Success : ButtonStyle.Secondary),
      );
      c.addActionRowComponents(row(...dayBtns.slice(0, 5)));
      c.addActionRowComponents(row(...dayBtns.slice(5)));

      c.addSeparatorComponents(sep());
      c.addTextDisplayComponents(txt('**Jours de publication :**'));
      const pubBtns = dayNames.map((name, i) =>
        btn(`wizard:schedule:pub:${String(i)}`, name, pubDays.has(i) ? ButtonStyle.Success : ButtonStyle.Secondary),
      );
      c.addActionRowComponents(row(...pubBtns.slice(0, 5)));
      c.addActionRowComponents(row(...pubBtns.slice(5)));
    }

    c.addSeparatorComponents(sep());
    c.addTextDisplayComponents(txt(['**📋 Aperçu :**', ...previewLines].join('\n')));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn('wizard:next', 'Valider', ButtonStyle.Success, '✅'),
      btn('wizard:back', 'Retour', ButtonStyle.Secondary, '◀️'),
    ));
  })]);
}

export function setScheduleMode(session: WizardSession, mode: 'daily' | 'weekly'): void {
  session.data.scheduleMode = mode;
  if (mode === 'weekly') {
    session.data.suggestionsPerCycle = session.data.suggestionsPerCycle ?? 21;
    session.data.veilleDay = session.data.veilleDay ?? 0;
    session.data.publicationDays = session.data.publicationDays ?? [1, 2, 3, 4, 5];
  } else {
    session.data.suggestionsPerCycle = session.data.suggestionsPerCycle ?? 3;
  }
}

export function setVeilleDay(session: WizardSession, day: number): void {
  session.data.veilleDay = day;
}

export function togglePublicationDay(session: WizardSession, day: number): void {
  const current = new Set(session.data.publicationDays ?? [1, 2, 3, 4, 5]);
  if (current.has(day)) {
    current.delete(day);
  } else {
    current.add(day);
  }
  session.data.publicationDays = [...current].sort();
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
