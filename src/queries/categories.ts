// Категории: список, чтение, создание, переименование, архивация.

import type { Category, CategoryAppliesTo, TransactionKind } from "../types";

interface CategoryRow {
  id: number;
  name: string;
  applies_to: string;
  is_custom: number;
  is_archived: number;
}

function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    name: row.name,
    appliesTo: row.applies_to as CategoryAppliesTo,
    isCustom: row.is_custom === 1,
    isArchived: row.is_archived === 1,
  };
}

/**
 * Живые категории. При заданном kind фильтр — applies_to IN (:kind, 'both'),
 * именно так: без 'both' категории обоих типов исчезли бы из обеих сеток.
 */
export async function listCategories(
  db: D1Database,
  kind?: TransactionKind,
): Promise<Category[]> {
  const stmt =
    kind === undefined
      ? db.prepare("SELECT * FROM categories WHERE is_archived = 0 ORDER BY id")
      : db
          .prepare(
            "SELECT * FROM categories WHERE is_archived = 0" +
              " AND applies_to IN (?1, 'both') ORDER BY id",
          )
          .bind(kind);
  const { results } = await stmt.all<CategoryRow>();
  return results.map(toCategory);
}

export async function getCategory(db: D1Database, id: number): Promise<Category | null> {
  const row = await db
    .prepare("SELECT * FROM categories WHERE id = ?1")
    .bind(id)
    .first<CategoryRow>();
  return row === null ? null : toCategory(row);
}

export type WriteResult<T> = { ok: true; value: T } | { ok: false; reason: "conflict" };

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE|constraint/i.test(err.message);
}

export async function createCategory(
  db: D1Database,
  name: string,
  appliesTo: CategoryAppliesTo,
): Promise<WriteResult<number>> {
  try {
    const res = await db
      .prepare("INSERT INTO categories (name, applies_to, is_custom, is_archived) VALUES (?1, ?2, 1, 0)")
      .bind(name, appliesTo)
      .run();
    return { ok: true, value: Number(res.meta.last_row_id) };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "conflict" };
    throw err;
  }
}

/** Конфликт имени среди живых категорий того же applies_to → 409, не сырая ошибка SQLite. */
export async function renameCategory(
  db: D1Database,
  id: number,
  name: string,
): Promise<WriteResult<boolean>> {
  try {
    const res = await db
      .prepare("UPDATE categories SET name = ?1 WHERE id = ?2")
      .bind(name, id)
      .run();
    return { ok: true, value: (res.meta.changes ?? 0) > 0 };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "conflict" };
    throw err;
  }
}

export async function archiveCategory(db: D1Database, id: number): Promise<boolean> {
  const res = await db
    .prepare("UPDATE categories SET is_archived = 1 WHERE id = ?1")
    .bind(id)
    .run();
  return (res.meta.changes ?? 0) > 0;
}
