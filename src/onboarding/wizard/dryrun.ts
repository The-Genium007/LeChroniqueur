import { search as searxngSearch } from '../../services/searxng.js';
import { getLogger } from '../../core/logger.js';
import type { InstanceVeilleCategory } from '../../core/config.js';
import {
  type V2MessagePayload,
  buildContainer, txt, sep, btn, row, v2, getColor,
  ButtonStyle,
} from '../../discord/component-builder-v2.js';
import { type WizardSession, getStepLabel } from './state-machine.js';

/**
 * Run a dry-run of SearXNG queries for each category.
 * Shows real results so the user can validate the keywords.
 * Cost: 0 tokens (SearXNG is free).
 */
export async function dryRunCategories(
  session: WizardSession,
): Promise<V2MessagePayload> {
  const logger = getLogger();
  const categories = session.data.categories ?? [];

  if (categories.length === 0) {
    return v2([buildContainer(getColor('warning'), (c) => {
      c.addTextDisplayComponents(txt('⚠️ Aucune catégorie à tester. Retourne à l\'étape précédente.'));
    })]);
  }

  const results: Array<{ category: InstanceVeilleCategory; resultCount: number; samples: string[] }> = [];

  for (const cat of categories.slice(0, 6)) {
    // Pick 1 keyword from each language
    const keyword = cat.keywords.fr[0] ?? cat.keywords.en[0] ?? cat.label;

    try {
      const searchResults = await searxngSearch(keyword, {
        engines: cat.engines.length > 0 ? cat.engines : undefined,
        language: cat.keywords.fr.length > 0 ? 'fr' : 'en',
        timeRange: cat.maxAgeHours <= 72 ? 'day' : 'week',
      });

      results.push({
        category: cat,
        resultCount: searchResults.length,
        samples: searchResults.slice(0, 3).map((r) => `► ${r.title.slice(0, 60)}`),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn({ category: cat.id, error: msg }, 'Dry run query failed');
      results.push({
        category: cat,
        resultCount: 0,
        samples: ['(requête échouée)'],
      });
    }
  }

  const lines = results.map((r) => {
    const emoji = r.resultCount > 0 ? '✅' : '⚠️';
    const samplesText = r.samples.length > 0 ? r.samples.join('\n') : '(aucun résultat)';
    return `${emoji} **${r.category.label}** — ${String(r.resultCount)} résultats\n${samplesText}`;
  }).join('\n\n');

  return v2([buildContainer(getColor('primary'), (c) => {
    c.addTextDisplayComponents(txt([
      `## 🔍 Dry-run — Étape ${getStepLabel(session.step)}`,
      '',
      'Voici ce que tes catégories ramènent comme résultats réels :',
      '',
      lines,
      '',
      'Les catégories avec ⚠️ ne ramènent rien — tu peux les modifier ou les retirer.',
    ].join('\n')));
    c.addSeparatorComponents(sep());
    c.addActionRowComponents(row(
      btn('wizard:next', 'C\'est bon, continuer', ButtonStyle.Success, '✅'),
      btn('wizard:back', 'Modifier les catégories', ButtonStyle.Primary, '✏️'),
      btn('wizard:redo', 'Retester', ButtonStyle.Secondary, '🔄'),
    ));
  })]);
}
