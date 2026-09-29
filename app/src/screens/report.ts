// Экран «Отчёт». Расширенный контракт analytics-api: период четырёх видов,
// фильтры по И, четыре представления одних и тех же данных и два режима
// сравнения.
//
// Данные тянутся ровно двумя запросами на смену периода/фильтра: /api/report
// и /api/compare. Смена представления (круговая/столбцы/линия/таблица),
// сортировки и скрытие рядов в легенде запросов НЕ делают — отчёт уже в
// памяти, перерисовывается только DOM.
import { el, mount } from "../dom.js";
import { formatMoney, formatSigned, formatDateHuman, currentYm } from "../format.js";
import {
  categoryPie,
  categoryBars,
  categoryTable,
  dynamicsLine,
  type LegendState,
  type TableSort,
} from "../charts.js";
import { periodControl, periodShortLabel, previousPeriod, yearAgo } from "../period.js";
import { emptyFilters, filterBar, filtersCount, type AuthorRef } from "../report-filters.js";
import { authorsCompare, periodsCompare } from "./report-compare.js";
import { emptyState, errorState, listSkeleton } from "../states.js";
import * as api from "../api.js";
import type {
  AuthorBreakdown,
  Category,
  MonthlyReport,
  PeriodSel,
  ReportCategorySlice,
  ReportComparisonRow,
  ReportFilters,
} from "../api-types.js";

type View = "pie" | "bars" | "line" | "table";
type CompareMode = "authors" | "periods";
type BaseKind = "previous" | "year";

const VIEWS: { id: View; label: string }[] = [
  { id: "pie", label: "Круговая" },
  { id: "bars", label: "Столбцы" },
  { id: "line", label: "Линия" },
  { id: "table", label: "Таблица" },
];

/** Простой сегмент: экран перерисовывается целиком, состояние держать негде. */
function segmented<T extends string>(
  label: string,
  options: { id: T; label: string }[],
  current: T,
  onPick: (id: T) => void,
): HTMLElement {
  return el(
    "div",
    { class: "segmented segmented-wrap", role: "group", "aria-label": label },
    options.map((o) =>
      el("button", {
        class: `segmented-btn${o.id === current ? " segmented-btn-active" : ""}`,
        type: "button",
        text: o.label,
        "aria-pressed": String(o.id === current),
        onclick: () => o.id !== current && onPick(o.id),
      }),
    ),
  );
}

function section(title: string, ...content: (HTMLElement | null)[]): HTMLElement {
  return el("section", { class: "report-section" }, [
    el("h2", { class: "report-section-title", text: title }),
    ...content,
  ]);
}

export async function renderReport(container: HTMLElement, initialMonth?: string): Promise<void> {
  let sel: PeriodSel = { kind: "month", anchor: initialMonth ?? currentYm() };
  let filters: ReportFilters = emptyFilters();
  let view: View = "pie";
  let sort: TableSort = { key: "amount", desc: true };
  let compareMode: CompareMode = "authors";
  let baseKind: BaseKind = "previous";
  // Скрытые в легенде ряды переживают смену периода намеренно: пользователь
  // прячет «Скрытое» или «Прочее», чтобы разглядеть остальное, и не должен
  // прятать это заново на каждом шаге стрелкой.
  const hidden = new Set<string>();

  let report: MonthlyReport | null = null;
  let compareRows: ReportComparisonRow[] | null = null;
  let authors: AuthorRef[] = [];
  let authorsData: AuthorBreakdown[] = [];
  let categories: Category[] = [];
  const viewerId: number | null = window.Telegram?.WebApp.initDataUnsafe?.user?.id ?? null;

  const baseSel = (): PeriodSel => (baseKind === "previous" ? previousPeriod(sel) : yearAgo(sel));

  function header(): HTMLElement[] {
    return [
      periodControl({
        value: sel,
        onChange: (next) => {
          sel = next;
          void load();
        },
      }),
      filterBar({
        filters,
        categories,
        authors,
        viewerId,
        onChange: (next) => {
          filters = next;
          void load();
        },
      }),
    ];
  }

  async function load(): Promise<void> {
    // Скелетон только под шапкой: период и фильтры остаются на месте, иначе
    // при каждом шаге стрелкой экран прыгает.
    const skeleton = listSkeleton(4);
    skeleton.classList.remove("screen");
    mount(container, el("div", { class: "screen report-screen" }, [...header(), skeleton]));

    try {
      const [loadedReport, compare, loadedCategories] = await Promise.all([
        api.getReport(sel, filters),
        loadCompare(),
        categories.length > 0 ? Promise.resolve(categories) : api.listAllCategories().catch(() => []),
      ]);
      report = loadedReport;
      categories = loadedCategories;
      if (compare !== null) applyCompare(compare);
      render();
    } catch (e) {
      mount(
        container,
        el("div", { class: "screen report-screen" }, [
          ...header(),
          errorState(e instanceof Error ? e.message : "Не удалось загрузить отчёт", () => void load()),
        ]),
      );
    }
  }

  type CompareResult =
    | { mode: "authors"; data: AuthorBreakdown[] }
    | { mode: "periods"; rows: ReportComparisonRow[] };

  async function loadCompare(): Promise<CompareResult | null> {
    if (compareMode === "authors") {
      const data = await api.compareAuthors(sel, filters);
      return { mode: "authors", data: data.authors };
    }
    // База «предыдущий период» уже посчитана сервером внутри /api/report
    // (блок comparison) — второй запрос за теми же числами не нужен.
    if (baseKind === "previous") return null;
    const data = await api.comparePeriods(sel, baseSel(), filters);
    return { mode: "periods", rows: data.categories };
  }

  function applyCompare(result: CompareResult): void {
    if (result.mode === "authors") {
      authorsData = result.data;
      // Имена и id авторов берём отсюда: отдельного /api/users нет, а фильтру
      // по автору список нужен.
      if (authors.length === 0) authors = result.data.map((a) => ({ id: a.authorId, name: a.name }));
      compareRows = null;
    } else {
      compareRows = result.rows;
    }
  }

  /** Перерисовка без запроса — смена вида, сортировки, легенды. */
  function render(): void {
    if (!report) return;
    const slices = report.expensesByCategory;
    const legend: LegendState = {
      hidden,
      onToggle: (key: string) => {
        if (hidden.has(key)) hidden.delete(key);
        else hidden.add(key);
        render();
      },
    };

    const empty = report.income === 0 && report.expense === 0;

    const body = empty
      ? [
          emptyState(
            "Нет данных за период",
            filtersCount(filters) > 0
              ? "Фильтры отсекли все операции. Сбросьте их или возьмите период шире."
              : "За этот период записей нет. Выберите другой период или добавьте трату.",
            filtersCount(filters) > 0
              ? {
                  label: "Сбросить фильтры",
                  onClick: () => {
                    filters = emptyFilters();
                    void load();
                  },
                }
              : undefined,
          ),
        ]
      : [
          totals(report),
          section(
            view === "line"
              ? report.period.granularity === "day"
                ? "Динамика по дням"
                : "Динамика по месяцам"
              : "Расходы по категориям",
            segmented("Вид графика", VIEWS, view, (id) => {
              view = id;
              render();
            }),
            chart(slices, legend),
          ),
          compareSection(),
          topExpenses(report),
        ];

    mount(container, el("div", { class: "screen report-screen" }, [...header(), ...body]));
  }

  function chart(slices: ReportCategorySlice[], legend: LegendState): HTMLElement {
    if (!report) return el("div");
    if (view === "line") return dynamicsLine(report.dynamics, legend);
    if (slices.length === 0) return el("p", { class: "chart-empty", text: "За период нет расходов." });
    if (view === "bars") return categoryBars(slices);
    if (view === "table") {
      return categoryTable(slices, sort, (next) => {
        sort = next;
        render();
      });
    }
    return el("div", {}, [
      categoryPie(slices, legend),
      // Больше шести секторов круговая не держит — хвост уже схлопнут в
      // «Прочее», и честнее сразу предложить представление, где видно всё.
      slices.length > 6
        ? el("div", { class: "chart-note" }, [
            el("span", { text: "Показаны 5 крупнейших категорий, остальные собраны в «Прочее»." }),
            el("button", {
              class: "btn btn-ghost chart-note-action",
              type: "button",
              text: "Показать столбцами",
              onclick: () => {
                view = "bars";
                render();
              },
            }),
          ])
        : null,
    ]);
  }

  function totals(r: MonthlyReport): HTMLElement {
    return el("div", { class: "report-totals" }, [
      el("div", { class: "hero-card" }, [
        el("div", { class: "hero-label", text: "Сэкономлено за период" }),
        el("div", {
          class: `hero-value ${r.saved < 0 ? "negative" : "positive"}`,
          text: formatSigned(r.saved),
        }),
      ]),
      el("div", { class: "secondary-row" }, [
        el("div", { class: "stat-card" }, [
          el("div", { class: "stat-label", text: "Доходы" }),
          el("div", { class: "stat-value income", text: formatMoney(r.income) }),
        ]),
        el("div", { class: "stat-card" }, [
          el("div", { class: "stat-label", text: "Расходы" }),
          el("div", { class: "stat-value expense", text: formatMoney(r.expense) }),
        ]),
      ]),
    ]);
  }

  function compareSection(): HTMLElement {
    const modeSwitch = segmented<CompareMode>(
      "Режим сравнения",
      [
        { id: "authors", label: "Я и жена" },
        { id: "periods", label: "Период к периоду" },
      ],
      compareMode,
      (id) => {
        compareMode = id;
        void load();
      },
    );

    if (compareMode === "authors") {
      return section("Сравнение", modeSwitch, authorsCompare(authorsData, viewerId));
    }

    const rows = compareRows ?? report?.comparison ?? [];
    return section(
      "Сравнение",
      modeSwitch,
      segmented<BaseKind>(
        "База сравнения",
        [
          { id: "previous", label: "Предыдущий" },
          { id: "year", label: "Год назад" },
        ],
        baseKind,
        (id) => {
          baseKind = id;
          void load();
        },
      ),
      periodsCompare(rows, periodShortLabel(sel), periodShortLabel(baseSel())),
    );
  }

  function topExpenses(r: MonthlyReport): HTMLElement {
    if (r.topExpenses.length === 0) {
      return section("Крупнейшие траты", el("p", { class: "muted", text: "За период нет трат." }));
    }
    const nameById = new Map(
      r.expensesByCategory.filter((c) => c.categoryId != null).map((c) => [c.categoryId as number, c.name]),
    );
    return section(
      "Крупнейшие траты",
      el(
        "ul",
        { class: "tx-list" },
        r.topExpenses.map((t) => {
          // Скрытая запись приходит без категории, комментария и автора —
          // показываем только сумму и не даём открыть её на правку (R3).
          const title = t.isMasked
            ? "Скрытая трата"
            : (t.categoryId != null && nameById.get(t.categoryId)) || "Расход";
          const sub = [formatDateHuman(t.occurredOn), t.isMasked ? null : t.comment].filter(Boolean).join(" · ");
          return el("li", { class: `tx-row${t.isMasked ? " tx-row-masked" : ""}` }, [
            el("div", { class: "tx-row-main" }, [
              el("div", { class: "tx-row-title", text: title }),
              el("div", { class: "tx-row-sub", text: sub }),
            ]),
            el("div", { class: "tx-row-amount expense", text: `−${formatMoney(t.amount)}` }),
          ]);
        }),
      ),
    );
  }

  await load();
}
