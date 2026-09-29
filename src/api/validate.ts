// Валидация на границе + общий тип окружения Hono. Ничего не знает о D1
// сверх q.getCategory: вся работа с базой — в src/queries (маскирование R3
// живёт там, в src/queries/masking.ts).

import * as q from "../queries";
import { addDays, addMonths } from "../time";
import type { Env, TransactionKind, User } from "../types";

export type AppEnv = { Bindings: Env; Variables: { user: User } };

export const KINDS: readonly string[] = ["income", "expense"];
export const APPLIES_TO: readonly string[] = ["expense", "income", "both"];

/** Варианты срока скрытия (R3/AC-5). Дату считает СЕРВЕР, клиент шлёт вариант. */
export const HIDE_OPTIONS: Record<string, (today: string) => string> = {
  "1d": (today) => addDays(today, 1),
  "1w": (today) => addDays(today, 7),
  "1m": (today) => addMonths(today, 1),
  // Через addMonths, не «183 дня»: 1 марта + 6 месяцев это 184 дня, и
  // фиксированная опция «полгода» отказывала бы примерно в трети месяцев года.
  "6m": (today) => addMonths(today, 6),
};

export function isValidDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d;
}

export function isValidMonth(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

export function isName(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 64;
}

export async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await c.req.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Категория обязана соответствовать kind по applies_to. Схема этой связи не
 * держит, поэтому проверка здесь: иначе доход остался бы в категории
 * «Продукты» и мигрировал бы между блоками отчёта с бессмысленной категорией.
 */
export async function categoryMismatch(
  db: D1Database,
  categoryId: number,
  kind: TransactionKind,
): Promise<"not_found" | "kind_mismatch" | null> {
  const category = await q.getCategory(db, categoryId);
  if (category === null || category.isArchived) return "not_found";
  return category.appliesTo === kind || category.appliesTo === "both" ? null : "kind_mismatch";
}
