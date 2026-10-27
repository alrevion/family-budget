// Общая обвязка тестов: чистая схема на каждый тест, сид пользователей,
// HTTP-обёртка над src/api.ts.
//
// Изоляция хранилища между тестами в @cloudflare/vitest-pool-workers 0.22 по
// умолчанию НЕ откатывает записи (проверено прогоном: запись из первого it
// видна во втором). Поэтому схема пересоздаётся явно в beforeEach — тест не
// должен зависеть от того, что оставил после себя предыдущий.

import { env } from "cloudflare:test";
import { vi } from "vitest";
import { api } from "../src/api";
import schemaSql from "../migrations/0001_init.sql?raw";
import editedBySql from "../migrations/0002_edited_by.sql?raw";
import shopsReceiptsSql from "../migrations/0003_shops_receipts.sql?raw";
import dropSql from "../migrations/drop.sql?raw";
import { ALISHER_ID, DILNOZA_ID } from "./fixtures/init-data";

/**
 * Разбивает .sql-файл на отдельные операторы. D1 exec() требует по одному
 * оператору в строке, поэтому многострочные CREATE TABLE через него не
 * прогнать — режем по ';' сами, предварительно выкинув строчные комментарии.
 * Строковых литералов с ';' в обоих файлах нет.
 */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .map((line) => (line.trimStart().startsWith("--") ? "" : line))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const DROP_STATEMENTS = statements(dropSql).filter(
  // Служебной таблицы d1_migrations в тестовой БД нет: её заводит wrangler
  // при `d1 migrations apply`, а здесь схема накатывается напрямую.
  (s) => !s.includes("d1_migrations"),
);
/**
 * Все миграции по порядку, а не только первая: иначе тест зелёный на схеме,
 * которой в проде уже нет. Индекс в массиве = порядковый номер миграции.
 */
export const MIGRATIONS: string[][] = [
  statements(schemaSql),
  statements(editedBySql),
  statements(shopsReceiptsSql),
];

/** Категории из сида 0001_init.sql — по именам, чтобы тесты не зависели от порядка INSERT. */
export const CATEGORY = {
  groceries: "Продукты",
  transport: "Транспорт",
  gifts: "Подарки",
  salary: "Зарплата",
  openingBalance: "Стартовый остаток",
} as const;

export async function dropSchema(): Promise<void> {
  for (const s of DROP_STATEMENTS) await env.DB.prepare(s).run();
}

/** Накатывает миграции [from, to) — по умолчанию все. */
export async function applyMigrations(from = 0, to = MIGRATIONS.length): Promise<void> {
  for (const migration of MIGRATIONS.slice(from, to)) {
    for (const s of migration) await env.DB.prepare(s).run();
  }
}

/** Пересоздаёт схему и сидирует обоих пользователей (FK на users). */
export async function resetDb(): Promise<void> {
  await dropSchema();
  await applyMigrations();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (telegram_id, name) VALUES (?1, 'Алишер')").bind(ALISHER_ID),
    env.DB.prepare("INSERT INTO users (telegram_id, name) VALUES (?1, 'Дилноза')").bind(DILNOZA_ID),
  ]);
}

export async function categoryId(name: string): Promise<number> {
  const row = await env.DB.prepare("SELECT id FROM categories WHERE name = ?1")
    .bind(name)
    .first<{ id: number }>();
  if (row === null) throw new Error(`no seeded category ${name}`);
  return row.id;
}

export interface SeedTx {
  amount: number;
  kind: "income" | "expense";
  category: string;
  authorId: number;
  occurredOn: string;
  comment?: string | null;
  hiddenUntil?: string | null;
  createdAt?: string;
}

/** Прямая вставка транзакции мимо API — для подготовки состояния. */
export async function insertTx(tx: SeedTx): Promise<number> {
  const res = await env.DB.prepare(
    "INSERT INTO transactions (amount, kind, category_id, author_id, occurred_on, comment, hidden_until, created_at)" +
      " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  )
    .bind(
      tx.amount,
      tx.kind,
      await categoryId(tx.category),
      tx.authorId,
      tx.occurredOn,
      tx.comment ?? null,
      tx.hiddenUntil ?? null,
      tx.createdAt ?? `${tx.occurredOn}T09:00:00.000Z`,
    )
    .run();
  return Number(res.meta.last_row_id);
}

export async function insertGoal(name: string, targetAmount: number): Promise<number> {
  const res = await env.DB.prepare(
    "INSERT INTO goals (name, target_amount, is_archived) VALUES (?1, ?2, 0)",
  )
    .bind(name, targetAmount)
    .run();
  return Number(res.meta.last_row_id);
}

/**
 * НЕЗАВИСИМЫЙ пересчёт баланса для AC-P1: считается прямым SUM по
 * transactions, а не через v_balance и не через getBalance(). Сравнение
 * getBalance() с самим собой ничего бы не доказало.
 */
export async function recomputeTotalIndependently(): Promise<number> {
  const income = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE kind = 'income'",
  ).first<{ s: number }>();
  const expense = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE kind = 'expense'",
  ).first<{ s: number }>();
  return (income?.s ?? 0) - (expense?.s ?? 0);
}

export async function allocationSumForGoal(goalId: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS s FROM goal_allocations WHERE goal_id = ?1",
  )
    .bind(goalId)
    .first<{ s: number }>();
  return row?.s ?? 0;
}

export async function allocationCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM goal_allocations").first<{
    c: number;
  }>();
  return row?.c ?? 0;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface ApiOptions {
  method?: string;
  body?: unknown;
  /** Переопределение биндингов (например ALLOWED_IDS в AC-P2). */
  envOverride?: Partial<typeof env>;
}

/**
 * Запрос к src/api.ts с транспортом из R4.4 — Authorization: tma <initData>,
 * не query-параметр.
 */
export async function apiFetch(
  initData: string | null,
  path: string,
  options: ApiOptions = {},
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (initData !== null) headers.set("Authorization", `tma ${initData}`);
  const request = new Request(`https://example.test${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return api.fetch(request, { ...env, ...options.envOverride } as typeof env);
}

export async function apiJson<T = Record<string, unknown>>(
  initData: string | null,
  path: string,
  options: ApiOptions = {},
): Promise<{ status: number; body: T }> {
  const res = await apiFetch(initData, path, options);
  return { status: res.status, body: (await res.json()) as T };
}

// ---------------------------------------------------------------------------
// Время
// ---------------------------------------------------------------------------

/**
 * Фиксирует ТОЛЬКО Date. Подменять setTimeout/queueMicrotask нельзя: на них
 * стоит асинхронный ввод-вывод D1 внутри workerd, и тест повис бы.
 */
export function freezeTime(epochSeconds: number, offsetSeconds = 60): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date((epochSeconds + offsetSeconds) * 1000));
}

export function unfreezeTime(): void {
  vi.useRealTimers();
}
