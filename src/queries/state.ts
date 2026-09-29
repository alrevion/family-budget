// Баланс (R1), пользователи и app_state — onboarding_done, last_nag_on.

import type { Balance, User } from "../types";

interface BalanceRow {
  total: number;
  in_goals: number;
  free: number;
}

/** R1: единственный источник «Свободно» — вью v_balance, без параллельных подсчётов. */
export async function getBalance(db: D1Database): Promise<Balance> {
  const row = await db.prepare("SELECT total, in_goals, free FROM v_balance").first<BalanceRow>();
  if (row === null) return { total: 0, inGoals: 0, free: 0 };
  return { total: row.total, inGoals: row.in_goals, free: row.free };
}

/**
 * Оба пользователя семьи. Имена пишет auth-слой (src/auth.ts, R4.7) из
 * проверенного initData, поэтому таблица всегда актуальна.
 *
 * Единственный источник имён: до этого их отдавал только compareAuthors,
 * который ради двух строк считал агрегаты за период.
 */
export async function listUsers(db: D1Database): Promise<User[]> {
  const { results } = await db
    .prepare("SELECT telegram_id, name FROM users ORDER BY telegram_id")
    .all<{ telegram_id: number; name: string }>();
  return results.map((r) => ({ telegramId: r.telegram_id, name: r.name }));
}

// ---------------------------------------------------------------------------
// app_state — onboarding_done и last_nag_on
// ---------------------------------------------------------------------------

export async function getAppState(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT value FROM app_state WHERE key = ?1")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setAppState(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO app_state (key, value) VALUES (?1, ?2)" +
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key, value)
    .run();
}
