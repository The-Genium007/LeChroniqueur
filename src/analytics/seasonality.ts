/**
 * Seasonal events calendar for scheduling optimization.
 * Events are checked against analytics to detect seasonal performance patterns.
 */

export interface SeasonalEvent {
  readonly name: string;
  readonly startMonth: number;
  readonly startDay: number;
  readonly endMonth: number;
  readonly endDay: number;
  readonly impact: 'high' | 'medium' | 'low';
  readonly description: string;
}

const SEASONAL_EVENTS: readonly SeasonalEvent[] = [
  {
    name: 'Noël',
    startMonth: 12, startDay: 15,
    endMonth: 1, endDay: 5,
    impact: 'high',
    description: 'Période de fêtes — engagement élevé, contenu festif performant',
  },
  {
    name: 'Nouvel An',
    startMonth: 12, startDay: 28,
    endMonth: 1, endDay: 3,
    impact: 'medium',
    description: 'Bilans et résolutions — contenu rétrospectif/prospectif',
  },
  {
    name: 'Soldes d\'hiver',
    startMonth: 1, startDay: 8,
    endMonth: 2, endDay: 4,
    impact: 'medium',
    description: 'Période d\'achat — contenu produit/recommandation performant',
  },
  {
    name: 'Pâques',
    startMonth: 3, startDay: 20,
    endMonth: 4, endDay: 25,
    impact: 'low',
    description: 'Vacances scolaires — horaires décalés, plus de temps libre',
  },
  {
    name: 'Soldes d\'été',
    startMonth: 6, startDay: 25,
    endMonth: 7, endDay: 25,
    impact: 'medium',
    description: 'Période d\'achat estivale',
  },
  {
    name: 'Rentrée',
    startMonth: 8, startDay: 25,
    endMonth: 9, endDay: 15,
    impact: 'high',
    description: 'Retour d\'activité — fort engagement, nouveaux projets',
  },
  {
    name: 'Halloween',
    startMonth: 10, startDay: 20,
    endMonth: 10, endDay: 31,
    impact: 'medium',
    description: 'Contenu thématique horror/fantasy très performant en TTRPG',
  },
  {
    name: 'Black Friday',
    startMonth: 11, startDay: 20,
    endMonth: 11, endDay: 30,
    impact: 'high',
    description: 'Forte activité commerciale — bruit élevé, besoin de se démarquer',
  },
];

/**
 * Returns seasonal events active on a given date.
 */
export function getActiveSeasons(date: Date): readonly SeasonalEvent[] {
  const month = date.getMonth() + 1;
  const day = date.getDate();

  return SEASONAL_EVENTS.filter((event) => {
    // Handle events that span across year boundary (e.g. Dec-Jan)
    if (event.startMonth > event.endMonth) {
      return (month > event.startMonth || (month === event.startMonth && day >= event.startDay)) ||
        (month < event.endMonth || (month === event.endMonth && day <= event.endDay));
    }

    const afterStart = month > event.startMonth || (month === event.startMonth && day >= event.startDay);
    const beforeEnd = month < event.endMonth || (month === event.endMonth && day <= event.endDay);
    return afterStart && beforeEnd;
  });
}

/**
 * Returns upcoming seasonal events within the next N days.
 */
export function getUpcomingSeasons(date: Date, daysAhead: number = 14): readonly SeasonalEvent[] {
  const upcoming: SeasonalEvent[] = [];

  for (let i = 0; i <= daysAhead; i++) {
    const checkDate = new Date(date);
    checkDate.setDate(checkDate.getDate() + i);
    const active = getActiveSeasons(checkDate);

    for (const event of active) {
      if (!upcoming.some((e) => e.name === event.name)) {
        upcoming.push(event);
      }
    }
  }

  return upcoming;
}

/**
 * Formats seasonal context for the AI analysis prompt.
 */
export function formatSeasonalContext(date: Date): string {
  const active = getActiveSeasons(date);
  const upcoming = getUpcomingSeasons(date, 14);

  const lines: string[] = [];

  if (active.length > 0) {
    lines.push('Événements saisonniers EN COURS :');
    for (const event of active) {
      lines.push(`- ${event.name} (impact: ${event.impact}) — ${event.description}`);
    }
  }

  const upcomingOnly = upcoming.filter((u) => !active.some((a) => a.name === u.name));
  if (upcomingOnly.length > 0) {
    lines.push('Événements saisonniers À VENIR (14 prochains jours) :');
    for (const event of upcomingOnly) {
      lines.push(`- ${event.name} (impact: ${event.impact}) — ${event.description}`);
    }
  }

  if (lines.length === 0) {
    lines.push('Pas d\'événement saisonnier particulier en cours ou à venir.');
  }

  return lines.join('\n');
}
