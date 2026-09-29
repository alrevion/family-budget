// Транзакции: CRUD, список за период, месяцы, дата последней записи.
//
// Чтение «наружу» идёт ТОЛЬКО через проекцию R3 из ./masking — см. там же
// запрет на SELECT * (колонка real_author_id).

import type { MaskedTransaction, Transaction, TransactionKind } from "../types";
import type { Period } from "../time";
import type { MaskedRow, TxFilter } from "./masking";
import { MASKED_COLUMNS, binder, maskedSource, toMasked, whereSql } from "./masking";

export interface NewTransaction {
  amount: number;
  kind: TransactionKind;
  categoryId: number;
  authorId: number;
  occurredOn: string;
  comment: string | null;
  hiddenUntil: string | null;
  createdAt: string;
}

export interface TransactionPatch {
  amount?: number;
  kind?: TransactionKind;
  categoryId?: number;
  occurredOn?: string;
  comment?: string | null;
}

/** Список транзакций периода глазами viewer. Фильтры — после маскирования. */
export async function listTransactions(
  db: D1Database,
  viewer: number,
  period: Period,
  today: string,
  filter: TxFilter = {},
): Promise<MaskedTransaction[]> {
  const b = binder();
  const src = maskedSource(b, viewer, today);
  const where = whereSql(b, [period.from, period.to], filter);
  const { results } = await db
    .prepare(
      `SELECT ${MASKED_COLUMNS} FROM ${src} ${where} ORDER BY occurred_on DESC, id DESC`,
    )
    .bind(...b.values)
    .all<MaskedRow>();
  return results.map(toMasked);
}

/** Одиночная выборка — тоже через проекцию R3 (ответы PATCH/DELETE, GET /:id). */
export async function getTransaction(
  db: D1Database,
  viewer: number,
  id: number,
  today: string,
): Promise<MaskedTransaction | null> {
  const b = binder();
  const src = maskedSource(b, viewer, today);
  const row = await db
    .prepare(`SELECT ${MASKED_COLUMNS} FROM ${src} WHERE id = ${b.p(id)}`)
    .bind(...b.values)
    .first<MaskedRow>();
  return row === null ? null : toMasked(row);
}

interface TxRow {
  id: number;
  amount: number;
  kind: string;
  category_id: number;
  author_id: number;
  occurred_on: string;
  comment: string | null;
  hidden_until: string | null;
  created_at: string;
  edited_by: number | null;
  edited_at: string | null;
}

/**
 * Сырая запись — только для внутренних проверок доступа в src/api.ts
 * (авторство, hidden_until). НАРУЖУ не отдаётся: наружу идёт проекция R3.
 */
export async function getTransactionRaw(db: D1Database, id: number): Promise<Transaction | null> {
  const row = await db
    .prepare("SELECT * FROM transactions WHERE id = ?1")
    .bind(id)
    .first<TxRow>();
  if (row === null) return null;
  return {
    id: row.id,
    amount: row.amount,
    kind: row.kind as TransactionKind,
    categoryId: row.category_id,
    authorId: row.author_id,
    occurredOn: row.occurred_on,
    comment: row.comment,
    hiddenUntil: row.hidden_until,
    createdAt: row.created_at,
    editedBy: row.edited_by,
    editedAt: row.edited_at,
  };
}

export async function createTransaction(db: D1Database, input: NewTransaction): Promise<number> {
  const res = await db
    .prepare(
      "INSERT INTO transactions" +
        " (amount, kind, category_id, author_id, occurred_on, comment, hidden_until, created_at)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(
      input.amount,
      input.kind,
      input.categoryId,
      input.authorId,
      input.occurredOn,
      input.comment,
      input.hiddenUntil,
      input.createdAt,
    )
    .run();
  return Number(res.meta.last_row_id);
}

/**
 * Правка транзакции. hidden_until и author_id не меняются никогда:
 * первое — R3, второе — сохранение авторства при правке. Кто правил, пишется
 * рядом, в edited_by/edited_at: «кто внёс» и «кто последним трогал» — разные
 * вопросы, и спор «я записывал не так» решает именно второй.
 *
 * Пустой patch не считается правкой: ничего не изменилось — некому и нечего
 * приписывать.
 */
export async function updateTransaction(
  db: D1Database,
  id: number,
  patch: TransactionPatch,
  editor: number,
  editedAt: string,
): Promise<boolean> {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.amount !== undefined) {
    sets.push(`amount = ?${values.push(patch.amount)}`);
  }
  if (patch.kind !== undefined) {
    sets.push(`kind = ?${values.push(patch.kind)}`);
  }
  if (patch.categoryId !== undefined) {
    sets.push(`category_id = ?${values.push(patch.categoryId)}`);
  }
  if (patch.occurredOn !== undefined) {
    sets.push(`occurred_on = ?${values.push(patch.occurredOn)}`);
  }
  if (patch.comment !== undefined) {
    sets.push(`comment = ?${values.push(patch.comment)}`);
  }
  if (sets.length === 0) return true;
  sets.push(`edited_by = ?${values.push(editor)}`, `edited_at = ?${values.push(editedAt)}`);
  const res = await db
    .prepare(`UPDATE transactions SET ${sets.join(", ")} WHERE id = ?${values.push(id)}`)
    .bind(...values)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function deleteTransaction(db: D1Database, id: number): Promise<boolean> {
  const res = await db.prepare("DELETE FROM transactions WHERE id = ?1").bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Месяцы, за которые есть записи — для переключателя месяцев в отчёте (AC-24).
 * substr здесь допустим: это не фильтр по диапазону, индекс всё равно не нужен.
 */
export async function listMonths(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT DISTINCT substr(occurred_on, 1, 7) AS ym FROM transactions ORDER BY ym DESC")
    .all<{ ym: string }>();
  return results.map((r) => r.ym);
}

/** Удержание (ежедневный cron): считается по MAX(created_at), не по occurred_on. */
export async function lastEntryDate(db: D1Database): Promise<string | null> {
  // created_at пишется в UTC, а порог в ежедневном cron — дата по Ташкенту
  // (UTC+5). Без сдвига запись, сделанная с 00:00 до 05:00 по Ташкенту, имеет
  // вчерашнюю дату UTC и выглядит на сутки старше — напоминание «3 дня без
  // записей» уходило на день раньше срока.
  const row = await db
    .prepare("SELECT MAX(datetime(created_at, '+5 hours')) AS last FROM transactions")
    .first<{ last: string | null }>();
  return row?.last ?? null;
}
