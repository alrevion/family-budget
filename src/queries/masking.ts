// R3 — маскирование скрытых трат. ЕДИНСТВЕННОЕ место в кодовой базе, где оно
// живёт: проекция maskedSource + фильтры whereSql. Все пути чтения транзакций
// (src/queries/transactions.ts, src/queries/reports.ts) обязаны идти через них.
//
// Правило файла: маскирование НЕ размазывается по доменным модулям. Если
// понадобился новый путь чтения транзакций — он импортирует maskedSource
// отсюда, а не пишет свой SELECT по таблице transactions.
//
// Шаг 5 плана (.omc/plans/family-budget-v1-consensus.md, rev.4).

import type { MaskedTransaction, TransactionKind } from "../types";

/** Аккумулятор позиционных параметров: b.p(v) возвращает '?N' и запоминает значение. */
export interface Binder {
  values: Array<string | number | null>;
  p(value: string | number | null): string;
}

export function binder(): Binder {
  const values: Array<string | number | null> = [];
  return { values, p: (value) => `?${values.push(value)}` };
}

/**
 * Колонки проекции R3 — единственный список, который уходит наружу.
 * real_author_id в него НЕ входит: он существует в maskedSource только ради
 * разбивки по авторам (compareAuthors), где сумма скрытой траты обязана
 * попасть в итог её настоящего автора. Любая выборка «наружу» обязана
 * перечислять MASKED_COLUMNS, а не SELECT * — иначе real_author_id утечёт.
 */
export const MASKED_COLUMNS =
  "id, amount, kind, occurred_on, category_id, comment, author_id, edited_by, edited_at," +
  " is_masked, reveals_on";

/**
 * Проекция R3 как подзапрос. Для не-автора активно скрытой записи
 * category_id / comment / author_id / edited_by / edited_at обнуляются в SQL —
 * Mini App не получает их даже в сыром JSON. viewer биндится как JS number.
 *
 * edited_by живёт в ТОМ ЖЕ CASE WHEN masked, а не в отдельном условии: иначе
 * у скрытой траты появился бы новый канал. Открыть её на правку не-автор не
 * может, но видимый edited_by выдавал бы, кто и что с ней делал. Одно правило —
 * одно место.
 */
export function maskedSource(b: Binder, viewer: number, today: string): string {
  const today_p = b.p(today);
  const viewer_p = b.p(viewer);
  return `(SELECT id, amount, kind, occurred_on,
                  CASE WHEN masked THEN NULL ELSE category_id END AS category_id,
                  CASE WHEN masked THEN NULL ELSE comment     END AS comment,
                  CASE WHEN masked THEN NULL ELSE author_id   END AS author_id,
                  CASE WHEN masked THEN NULL ELSE edited_by   END AS edited_by,
                  CASE WHEN masked THEN NULL ELSE edited_at   END AS edited_at,
                  author_id AS real_author_id,
                  masked AS is_masked,
                  CASE WHEN masked THEN hidden_until ELSE NULL END AS reveals_on
             FROM (SELECT *, (hidden_until IS NOT NULL
                              AND hidden_until > ${today_p}
                              AND author_id != ${viewer_p}) AS masked
                     FROM transactions))`;
}

/** Необязательные фильтры выборки. Комбинируются по И. */
export interface TxFilter {
  /** id категорий. Замаскированная запись не матчится НИ ПО КАКОМУ id. */
  categoryIds?: number[];
  authorId?: number;
  kind?: TransactionKind;
  /** Границы суммы, включительно. */
  min?: number;
  max?: number;
}

/**
 * WHERE поверх maskedSource.
 *
 * КРИТИЧНО (R3): все условия ссылаются на колонки ПОСЛЕ маскирования.
 * У замаскированной записи category_id и author_id равны NULL, поэтому
 * `category_id IN (...)` и `author_id = ?` для неё дают NULL → строка не
 * попадает в выборку. Без этого фильтр по категории стал бы оракулом:
 * перебрал категории, нашёл ту, где сумма подскочила — узнал категорию
 * подарка. Фильтры по kind и amount видят скрытые записи: ни сумма, ни знак
 * операции не маскируются (AC-6 требует учитывать сумму в балансе).
 */
export function whereSql(
  b: Binder,
  range: [string, string] | null,
  f: TxFilter,
  extra: readonly string[] = [],
): string {
  const parts: string[] = [...extra];
  if (range !== null) {
    parts.push(`occurred_on >= ${b.p(range[0])}`, `occurred_on < ${b.p(range[1])}`);
  }
  if (f.kind !== undefined) parts.push(`kind = ${b.p(f.kind)}`);
  if (f.authorId !== undefined) parts.push(`author_id = ${b.p(f.authorId)}`);
  if (f.categoryIds !== undefined && f.categoryIds.length > 0) {
    parts.push(`category_id IN (${f.categoryIds.map((id) => b.p(id)).join(", ")})`);
  }
  if (f.min !== undefined) parts.push(`amount >= ${b.p(f.min)}`);
  if (f.max !== undefined) parts.push(`amount <= ${b.p(f.max)}`);
  return parts.length === 0 ? "" : `WHERE ${parts.join(" AND ")}`;
}

export interface MaskedRow {
  id: number;
  amount: number;
  kind: string;
  occurred_on: string;
  category_id: number | null;
  comment: string | null;
  author_id: number | null;
  edited_by: number | null;
  edited_at: string | null;
  is_masked: number;
  reveals_on: string | null;
}

export function toMasked(row: MaskedRow): MaskedTransaction {
  return {
    id: row.id,
    amount: row.amount,
    kind: row.kind as TransactionKind,
    occurredOn: row.occurred_on,
    categoryId: row.category_id,
    comment: row.comment,
    authorId: row.author_id,
    editedBy: row.edited_by,
    editedAt: row.edited_at,
    isMasked: row.is_masked === 1,
    revealsOn: row.reveals_on,
  };
}
