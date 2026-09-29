// Отчёт за период (AC-19…AC-23) и сравнения — по авторам и по двум периодам.
//
// Все выборки идут через проекцию R3 из ./masking; compareAuthors — единственный
// потребитель real_author_id (см. комментарий к MASKED_COLUMNS там же).

import type { MaskedTransaction } from "../types";
import { addDays, calendarPeriod, previousPeriod } from "../time";
import type { Granularity, Period, PeriodKind } from "../time";
import type { MaskedRow, TxFilter } from "./masking";
import { MASKED_COLUMNS, binder, maskedSource, toMasked, whereSql } from "./masking";
import { listUsers } from "./state";

/** Псевдокатегория «Скрытое»: метка агрегата, в таблице categories её нет. */
export const HIDDEN_CATEGORY_NAME = "Скрытое";

export interface CategoryAmount {
  /** null — псевдокатегория «Скрытое» (агрегат замаскированных трат зрителя). */
  categoryId: number | null;
  name: string;
  amount: number;
  /** Число транзакций в категории — таблице нужны точные числа, не только высота столбика. */
  count: number;
  /** Доля от общего расхода выборки, 0..1, округлена до 4 знаков. Сумма долей = 1. */
  share: number;
}

export interface CategoryComparison {
  categoryId: number | null;
  name: string;
  current: number;
  previous: number;
  /** current − previous. */
  delta: number;
}

/** Точка блока «динамика» (AC-21). */
export interface BucketTotals {
  /** 'YYYY-MM' или 'YYYY-MM-DD' — по granularity периода. */
  bucket: string;
  /** Совместимость с v1: то же значение, что bucket. */
  month: string;
  income: number;
  expense: number;
}
/** @deprecated Историческое имя BucketTotals. */
export type MonthTotals = BucketTotals;

export interface PeriodInfo {
  kind: PeriodKind;
  label: string;
  /** Первый день периода, включительно. */
  from: string;
  /** Последний день периода, ВКЛЮЧИТЕЛЬНО (внутри слоя запросов граница полуоткрытая). */
  to: string;
  granularity: Granularity;
}

export interface PeriodReport {
  /** Совместимость с v1: равен period.label. */
  month: string;
  period: PeriodInfo;
  income: number;
  expense: number;
  /** AC-19, круговая и таблица — ТОЛЬКО расходы. */
  expensesByCategory: CategoryAmount[];
  /** AC-20, сравнение с предыдущим периодом той же длины, сопоставление по category_id. */
  comparison: CategoryComparison[];
  /** AC-21, динамика итогов. */
  dynamics: BucketTotals[];
  /** AC-22, топ-5 крупнейших трат — через ту же проекцию R3. */
  topExpenses: MaskedTransaction[];
  /** AC-23 «Сэкономлено за период» = доходы − расходы. НЕ сумма goal_allocations. */
  saved: number;
}
/** Историческое имя: отчёт за календарный месяц. */
export type MonthlyReport = PeriodReport;

export function periodInfo(p: Period): PeriodInfo {
  return {
    kind: p.kind,
    label: p.label,
    from: p.from,
    to: addDays(p.to, -1),
    granularity: p.granularity,
  };
}

interface CategoryAggRow {
  category_id: number | null;
  name: string | null;
  amount: number;
  cnt: number;
}

/** Достраивает долю от общей суммы набора. знаменатель — сумма самого набора. */
function withShares(
  rows: Array<{ categoryId: number | null; name: string; amount: number; count: number }>,
): CategoryAmount[] {
  const total = rows.reduce((acc, r) => acc + r.amount, 0);
  return rows.map((r) => ({
    ...r,
    share: total === 0 ? 0 : Math.round((r.amount / total) * 10_000) / 10_000,
  }));
}

function toCategoryAmount(r: CategoryAggRow): {
  categoryId: number | null;
  name: string;
  amount: number;
  count: number;
} {
  // category_id === null бывает только у замаскированной записи: LEFT JOIN по
  // нему не находит строки в categories, поэтому имя подставляется здесь.
  return {
    categoryId: r.category_id,
    name: r.category_id === null ? HIDDEN_CATEGORY_NAME : (r.name ?? HIDDEN_CATEGORY_NAME),
    amount: r.amount,
    count: r.cnt,
  };
}

/**
 * Расходы диапазона по категориям глазами viewer. Замаскированные для зрителя
 * траты сливаются в одну псевдокатегорию «Скрытое» — иначе круговая
 * диаграмма не сходится к общей сумме.
 */
async function expensesByCategory(
  db: D1Database,
  viewer: number,
  today: string,
  range: [string, string],
  filter: TxFilter,
): Promise<CategoryAmount[]> {
  const b = binder();
  const src = maskedSource(b, viewer, today);
  // kind = 'expense' идёт ДОПОЛНИТЕЛЬНЫМ условием, а не подменой filter.kind:
  // при ?kind=income выборка обязана оказаться пустой, а не показать расходы.
  const where = whereSql(b, range, filter, ["kind = 'expense'"]);
  const { results } = await db
    .prepare(
      `SELECT t.category_id AS category_id, c.name AS name,
              SUM(t.amount) AS amount, COUNT(*) AS cnt
         FROM ${src} t
         LEFT JOIN categories c ON c.id = t.category_id
        ${where}
        GROUP BY t.category_id, c.name
        ORDER BY amount DESC`,
    )
    .bind(...b.values)
    .all<CategoryAggRow>();
  return withShares(results.map(toCategoryAmount));
}

interface TotalsRow {
  income: number;
  expense: number;
}

async function periodTotals(
  db: D1Database,
  viewer: number,
  today: string,
  range: [string, string],
  filter: TxFilter,
): Promise<TotalsRow> {
  const b = binder();
  const src = maskedSource(b, viewer, today);
  const where = whereSql(b, range, filter);
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'income' THEN amount END), 0) AS income,
              COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount END), 0) AS expense
         FROM ${src} ${where}`,
    )
    .bind(...b.values)
    .first<TotalsRow>();
  return row ?? { income: 0, expense: 0 };
}

/**
 * AC-21. Для календарного месяца — историческая динамика по ВСЕМ месяцам базы
 * (поведение v1, на нём построен график Mini App). Для квартала и года —
 * по месяцам внутри периода, для произвольного диапазона — по гранулярности
 * периода (день до 62 дней включительно, дальше месяц).
 */
async function periodDynamics(
  db: D1Database,
  viewer: number,
  today: string,
  period: Period,
  filter: TxFilter,
): Promise<BucketTotals[]> {
  const b = binder();
  const src = maskedSource(b, viewer, today);
  const bucket = period.granularity === "day" ? "occurred_on" : "substr(occurred_on, 1, 7)";
  const range: [string, string] | null =
    period.kind === "month" ? null : [period.from, period.to];
  const where = whereSql(b, range, filter);
  const { results } = await db
    .prepare(
      `SELECT ${bucket} AS bucket,
              COALESCE(SUM(CASE WHEN kind = 'income' THEN amount END), 0) AS income,
              COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount END), 0) AS expense
         FROM ${src} ${where}
        GROUP BY bucket ORDER BY bucket`,
    )
    .bind(...b.values)
    .all<{ bucket: string; income: number; expense: number }>();
  return results.map((r) => ({
    bucket: r.bucket,
    month: r.bucket,
    income: r.income,
    expense: r.expense,
  }));
}

async function topExpenses(
  db: D1Database,
  viewer: number,
  today: string,
  range: [string, string],
  filter: TxFilter,
): Promise<MaskedTransaction[]> {
  const b = binder();
  const src = maskedSource(b, viewer, today);
  const where = whereSql(b, range, filter, ["kind = 'expense'"]);
  const { results } = await db
    .prepare(
      `SELECT ${MASKED_COLUMNS} FROM ${src} ${where} ORDER BY amount DESC, id DESC LIMIT 5`,
    )
    .bind(...b.values)
    .all<MaskedRow>();
  return results.map(toMasked);
}

/**
 * Сопоставление двух наборов по category_id, не по name: renameCategory не
 * должен рвать сравнение. null-ключ — псевдокатегория «Скрытое».
 */
function mergeComparison(
  current: CategoryAmount[],
  previous: CategoryAmount[],
): CategoryComparison[] {
  const key = (id: number | null): string => (id === null ? "hidden" : String(id));
  const merged = new Map<string, CategoryComparison>();
  for (const row of current) {
    merged.set(key(row.categoryId), {
      categoryId: row.categoryId,
      name: row.name,
      current: row.amount,
      previous: 0,
      delta: row.amount,
    });
  }
  for (const row of previous) {
    const existing = merged.get(key(row.categoryId));
    if (existing === undefined) {
      merged.set(key(row.categoryId), {
        categoryId: row.categoryId,
        name: row.name,
        current: 0,
        previous: row.amount,
        delta: -row.amount,
      });
    } else {
      existing.previous = row.amount;
      existing.delta = existing.current - row.amount;
    }
  }
  return [...merged.values()].sort((a, b) => b.current - a.current);
}

/** Отчёт из пяти блоков (AC-19…AC-23) за произвольный период глазами viewer. */
export async function periodReport(
  db: D1Database,
  viewer: number,
  period: Period,
  today: string,
  filter: TxFilter = {},
): Promise<PeriodReport> {
  const range: [string, string] = [period.from, period.to];
  const totals = await periodTotals(db, viewer, today, range, filter);
  const current = await expensesByCategory(db, viewer, today, range, filter);
  const previous = await expensesByCategory(db, viewer, today, previousPeriod(period), filter);
  const dynamics = await periodDynamics(db, viewer, today, period, filter);
  const top = await topExpenses(db, viewer, today, range, filter);

  return {
    month: period.label,
    period: periodInfo(period),
    income: totals.income,
    expense: totals.expense,
    expensesByCategory: current,
    comparison: mergeComparison(current, previous),
    dynamics,
    topExpenses: top,
    saved: totals.income - totals.expense,
  };
}

/** Отчёт за календарный месяц ym='YYYY-MM' — форма, на которую завязан cron. */
export async function monthlyReport(
  db: D1Database,
  viewer: number,
  ym: string,
  today: string,
): Promise<MonthlyReport> {
  return periodReport(db, viewer, calendarPeriod("month", ym), today);
}

// ---------------------------------------------------------------------------
// Сравнение
// ---------------------------------------------------------------------------

export interface AuthorBreakdown {
  authorId: number;
  name: string;
  income: number;
  expense: number;
  /**
   * Топ-5 категорий расходов автора. Скрытые траты партнёра учитываются в его
   * expense (это реальные деньги), но их категорийная разбивка схлопывается в
   * «Скрытое» — доля считается от полного expense автора, не от топ-5.
   */
  topCategories: CategoryAmount[];
}

interface AuthorAggRow {
  author_id: number;
  kind: string;
  category_id: number | null;
  name: string | null;
  amount: number;
  cnt: number;
}

/**
 * Разбивка по авторам за период.
 *
 * Группировка идёт по real_author_id — настоящему автору, а не по
 * замаскированному. Это осознанно: по AC-6 сумма скрытой траты обязана
 * попасть в итог, а при двух пользователях «замаскирована» уже означает
 * «не моя», то есть партнёрская (Вариант A, план: авторство при двух
 * пользователях скрыть невозможно). Категория при этом остаётся скрытой.
 */
export async function compareAuthors(
  db: D1Database,
  viewer: number,
  period: Period,
  today: string,
  filter: TxFilter = {},
): Promise<AuthorBreakdown[]> {
  const b = binder();
  const src = maskedSource(b, viewer, today);
  const where = whereSql(b, [period.from, period.to], filter);
  const { results } = await db
    .prepare(
      `SELECT t.real_author_id AS author_id, t.kind AS kind,
              t.category_id AS category_id, c.name AS name,
              SUM(t.amount) AS amount, COUNT(*) AS cnt
         FROM ${src} t
         LEFT JOIN categories c ON c.id = t.category_id
        ${where}
        GROUP BY t.real_author_id, t.kind, t.category_id, c.name`,
    )
    .bind(...b.values)
    .all<AuthorAggRow>();

  const users = await listUsers(db);

  return users.map((u) => {
    const mine = results.filter((r) => r.author_id === u.telegramId);
    const expenseRows = mine.filter((r) => r.kind === "expense");
    // Замаскированные записи приходят отдельными строками с category_id = NULL;
    // складываем их в одну псевдокатегорию «Скрытое».
    const byCategory = new Map<string, { categoryId: number | null; name: string; amount: number; count: number }>();
    for (const row of expenseRows) {
      const agg = toCategoryAmount(row);
      const key = agg.categoryId === null ? "hidden" : String(agg.categoryId);
      const existing = byCategory.get(key);
      if (existing === undefined) byCategory.set(key, agg);
      else {
        existing.amount += agg.amount;
        existing.count += agg.count;
      }
    }
    const sorted = [...byCategory.values()].sort((a, b2) => b2.amount - a.amount);
    return {
      authorId: u.telegramId,
      name: u.name,
      income: mine.filter((r) => r.kind === "income").reduce((acc, r) => acc + r.amount, 0),
      expense: expenseRows.reduce((acc, r) => acc + r.amount, 0),
      topCategories: withShares(sorted).slice(0, 5),
    };
  });
}

/** Два периода рядом: расходы по категориям с дельтой (current = a, previous = b). */
export async function comparePeriods(
  db: D1Database,
  viewer: number,
  a: Period,
  bPeriod: Period,
  today: string,
  filter: TxFilter = {},
): Promise<CategoryComparison[]> {
  const first = await expensesByCategory(db, viewer, today, [a.from, a.to], filter);
  const second = await expensesByCategory(db, viewer, today, [bPeriod.from, bPeriod.to], filter);
  return mergeComparison(first, second);
}
