import type { SqliteDatabase } from '../../core/database.js';
import {
  type V2MessagePayload,
  budgetReport as buildBudgetReport,
  type V2BudgetPeriodData,
  buildContainer, btn, row, v2, getColor,
  ButtonStyle,
} from '../../discord/component-builder-v2.js';
import { getDailyTotal, getWeeklyTotal, getMonthlyTotal } from '../../budget/tracker.js';

export function buildBudgetPage(db: SqliteDatabase, _instanceName: string): V2MessagePayload {
  const daily = getDailyTotal(db);
  const weekly = getWeeklyTotal(db);
  const monthly = getMonthlyTotal(db);

  const periods: V2BudgetPeriodData[] = [
    { label: "Aujourd'hui", ...daily },
    { label: 'Cette semaine', ...weekly },
    { label: 'Ce mois', ...monthly },
  ];

  // Use the budget report builder but wrap it with extra dashboard controls
  const report = buildBudgetReport(periods);

  // We return a separate container with nav buttons
  return v2([
    ...report.components,
    buildContainer(getColor('primary'), (c) => {
      c.addActionRowComponents(row(
        btn('dash:config:edit:budget', 'Modifier seuils', ButtonStyle.Primary, '✏️'),
        btn('dash:home', 'Retour', ButtonStyle.Secondary, '◀️'),
      ));
    }),
  ]);
}
