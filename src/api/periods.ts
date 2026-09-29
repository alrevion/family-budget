// Разбор периода и фильтров из query-параметров.
//
// Приватность (R3): САМО применение фильтров живёт в src/queries/masking.ts и
// идёт после маскирования — здесь только валидация значений на границе.

import * as q from "../queries";
import { isValidAmount } from "../money";
import { addMonths, calendarPeriod, rangePeriod } from "../time";
import type { Period } from "../time";
import type { TransactionKind } from "../types";
import { KINDS, isValidDate, isValidMonth } from "./validate";

type ParseError = { ok: false; error: string };
type Parsed<T> = { ok: true; value: T } | ParseError;

function bad(error: string): ParseError {
  return { ok: false, error };
}

const PERIOD_KINDS: readonly string[] = ["month", "quarter", "year"];

/** Потолок длины произвольного диапазона — 5 лет: запрос не должен выгребать всю базу. */
function rangeTooLong(from: string, toInclusive: string): boolean {
  return addMonths(from, 60) <= toInclusive;
}

function parseRange(from: unknown, to: unknown, today: string): Parsed<Period> {
  if (!isValidDate(from) || !isValidDate(to)) return bad("bad_date");
  if (from > to) return bad("bad_range");
  // Проверка «не в будущем» только для явного диапазона: календарный месяц,
  // квартал и год, содержащие сегодняшний день, законны и на них завязан cron.
  if (to > today) return bad("future_range");
  if (rangeTooLong(from, to)) return bad("range_too_long");
  return { ok: true, value: rangePeriod(from, to) };
}

/**
 * Период из query-параметров. Три взаимоисключающие формы:
 *   ?month=YYYY-MM                    — обратная совместимость, форма cron;
 *   ?period=month|quarter|year[&anchor=YYYY-MM];
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD    — обе границы включительно.
 * Без параметров — текущий месяц по Ташкенту.
 */
export function parsePeriodQuery(
  c: { req: { query: (k: string) => string | undefined } },
  today: string,
): Parsed<Period> {
  const month = c.req.query("month");
  const kind = c.req.query("period");
  const from = c.req.query("from");
  const to = c.req.query("to");

  const forms = [month !== undefined, kind !== undefined, from !== undefined || to !== undefined];
  if (forms.filter(Boolean).length > 1) return bad("conflicting_period");

  if (from !== undefined || to !== undefined) return parseRange(from, to, today);
  if (kind !== undefined) {
    if (!PERIOD_KINDS.includes(kind)) return bad("bad_period");
    const anchor = c.req.query("anchor") ?? today.slice(0, 7);
    if (!isValidMonth(anchor)) return bad("bad_anchor");
    return { ok: true, value: calendarPeriod(kind as "month" | "quarter" | "year", anchor) };
  }
  const m = month ?? today.slice(0, 7);
  if (!isValidMonth(m)) return bad("bad_month");
  return { ok: true, value: calendarPeriod("month", m) };
}

/**
 * Период одной строкой — форма параметров a/b у GET /api/compare:
 *   'YYYY-MM' | 'quarter:YYYY-MM' | 'year:YYYY-MM' | 'YYYY-MM-DD..YYYY-MM-DD'.
 */
export function parsePeriodSpec(spec: string, today: string): Parsed<Period> {
  if (spec.includes("..")) {
    const parts = spec.split("..");
    if (parts.length !== 2) return bad("bad_period");
    return parseRange(parts[0], parts[1], today);
  }
  const sep = spec.indexOf(":");
  if (sep === -1) {
    if (!isValidMonth(spec)) return bad("bad_period");
    return { ok: true, value: calendarPeriod("month", spec) };
  }
  const kind = spec.slice(0, sep);
  const anchor = spec.slice(sep + 1);
  if (!PERIOD_KINDS.includes(kind)) return bad("bad_period");
  if (!isValidMonth(anchor)) return bad("bad_anchor");
  return { ok: true, value: calendarPeriod(kind as "month" | "quarter" | "year", anchor) };
}

/** Потолок на длину списка категорий — чтобы IN (...) не разросся до тысяч биндингов. */
const MAX_CATEGORY_FILTER = 50;

/**
 * Необязательные фильтры выборки. Неизвестный id категории или автора → 400,
 * а не молча пустой ответ: иначе опечатка выглядит как «трат нет».
 *
 * Приватность (R3): САМО применение фильтров живёт в src/queries.ts и идёт
 * после маскирования — здесь только валидация значений на границе.
 */
export async function parseFilter(
  db: D1Database,
  c: { req: { query: (k: string) => string | undefined } },
): Promise<Parsed<q.TxFilter>> {
  const filter: q.TxFilter = {};

  const categories = c.req.query("categories");
  if (categories !== undefined && categories.trim() !== "") {
    const ids: number[] = [];
    for (const part of categories.split(",")) {
      const id = Number(part.trim());
      if (!Number.isInteger(id) || id <= 0) return bad("bad_category");
      ids.push(id);
    }
    const unique = [...new Set(ids)];
    if (unique.length > MAX_CATEGORY_FILTER) return bad("too_many_categories");
    const { results } = await db
      .prepare(
        `SELECT id FROM categories WHERE id IN (${unique.map((_, i) => `?${i + 1}`).join(", ")})`,
      )
      .bind(...unique)
      .all<{ id: number }>();
    if (results.length !== unique.length) return bad("unknown_category");
    filter.categoryIds = unique;
  }

  const author = c.req.query("author");
  if (author !== undefined && author.trim() !== "") {
    const id = Number(author);
    if (!Number.isSafeInteger(id)) return bad("bad_author");
    const row = await db
      .prepare("SELECT telegram_id FROM users WHERE telegram_id = ?1")
      .bind(id)
      .first<{ telegram_id: number }>();
    if (row === null) return bad("unknown_author");
    filter.authorId = id;
  }

  const kind = c.req.query("kind");
  if (kind !== undefined && kind !== "") {
    if (!KINDS.includes(kind)) return bad("bad_kind");
    filter.kind = kind as TransactionKind;
  }

  for (const name of ["min", "max"] as const) {
    const raw = c.req.query(name);
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number(raw);
    // 0 допустим как нижняя граница; выше — те же (0, 1e11], что у транзакции.
    if (!(value === 0 || isValidAmount(value))) return bad(`bad_${name}`);
    filter[name] = value;
  }
  if (filter.min !== undefined && filter.max !== undefined && filter.min > filter.max) {
    return bad("bad_amount_range");
  }

  return { ok: true, value: filter };
}
