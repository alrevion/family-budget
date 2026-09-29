// Блок сравнения отчёта: «я против жены» и «период против периода».
// Отрисовка чистая — данные грузит report.ts.
//
// Приватность: скрытая трата партнёра попадает в его расход (AC-6,
// согласованное решение), а её категория схлопнута сервером в «Скрытое».
// Здесь она рисуется наравне с остальными: подсветить её сильнее — значит
// показать пальцем на подарок.
import { el } from "../dom.js";
import { formatMoney } from "../format.js";
import { categoryBars, deltaBadge } from "../charts.js";
import { authorLabel, type AuthorRef } from "../report-filters.js";
import type { AuthorBreakdown, ReportComparisonRow } from "../api-types.js";

/** Карточка одного автора: итоги плюс его топ категорий. */
function authorCard(a: AuthorBreakdown, viewerId: number | null): HTMLElement {
  const ref: AuthorRef = { id: a.authorId, name: a.name };
  return el("div", { class: "compare-card" }, [
    el("div", { class: "compare-card-head" }, [
      el("h3", { class: "compare-card-name", text: authorLabel(ref, viewerId) }),
      el("span", { class: "compare-card-amount expense", text: formatMoney(a.expense) }),
    ]),
    el("div", { class: "compare-card-sub", text: `Доход: ${formatMoney(a.income)}` }),
    a.topCategories.length === 0
      ? el("p", { class: "chart-empty", text: "Нет операций за период." })
      : categoryBars(a.topCategories),
  ]);
}

export function authorsCompare(authors: AuthorBreakdown[], viewerId: number | null): HTMLElement {
  return el(
    "div",
    { class: "compare-authors" },
    authors.map((a) => authorCard(a, viewerId)),
  );
}

/** Пара столбцов A/B по одной категории. Подписи периодов стоят на самих
 *  столбцах — какой из них какой, видно без цвета. */
function comparisonRow(row: ReportComparisonRow, max: number, labelA: string, labelB: string): HTMLElement {
  const bar = (value: number, label: string, cls: string): HTMLElement =>
    el("div", { class: "pair-row" }, [
      el("span", { class: "pair-label", text: label }),
      el("div", { class: "bar-track" }, [
        el("div", { class: `bar-fill ${cls}`, style: `width:${max > 0 ? Math.max(1.5, (value / max) * 100) : 0}%` }),
      ]),
      el("span", { class: "pair-value", text: formatMoney(value) }),
    ]);

  return el("div", { class: "compare-row" }, [
    el("div", { class: "compare-row-head" }, [
      el("span", { class: "compare-row-name", text: row.name }),
      deltaBadge(row.delta, row.previous),
    ]),
    bar(row.current, labelA, "pair-a"),
    bar(row.previous, labelB, "pair-b"),
  ]);
}

export function periodsCompare(
  rows: ReportComparisonRow[],
  labelA: string,
  labelB: string,
): HTMLElement {
  if (rows.length === 0) {
    return el("p", { class: "chart-empty", text: "Ни в одном из периодов нет расходов." });
  }
  const max = Math.max(...rows.flatMap((r) => [r.current, r.previous]), 1);
  const totalA = rows.reduce((s, r) => s + r.current, 0);
  const totalB = rows.reduce((s, r) => s + r.previous, 0);

  return el("div", { class: "compare-periods" }, [
    el("div", { class: "compare-total" }, [
      el("div", { class: "compare-total-head" }, [
        el("span", { class: "compare-total-label", text: "Расходы всего" }),
        deltaBadge(totalA - totalB, totalB),
      ]),
      el("div", { class: "compare-total-values" }, [
        el("span", { text: `${labelA}: ${formatMoney(totalA)}` }),
        el("span", { text: `${labelB}: ${formatMoney(totalB)}` }),
      ]),
    ]),
    ...rows.map((r) => comparisonRow(r, max, labelA, labelB)),
  ]);
}
