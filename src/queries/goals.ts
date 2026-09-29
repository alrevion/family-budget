// Цели и аллокации (R1: атомарные условные INSERT, R2: архивация одним batch).

import type { Goal } from "../types";

export interface GoalWithProgress extends Goal {
  /** Сумма аллокаций по цели: положительные пополнения минус возвраты. */
  saved: number;
}

interface GoalRow {
  id: number;
  name: string;
  target_amount: number;
  is_archived: number;
  saved: number;
}

/** Архивные цели исключены. */
export async function listGoals(db: D1Database): Promise<GoalWithProgress[]> {
  const { results } = await db
    .prepare(
      "SELECT g.id, g.name, g.target_amount, g.is_archived," +
        " COALESCE((SELECT SUM(amount) FROM goal_allocations WHERE goal_id = g.id), 0) AS saved" +
        " FROM goals g WHERE g.is_archived = 0 ORDER BY g.id",
    )
    .all<GoalRow>();
  return results.map((row) => ({
    id: row.id,
    name: row.name,
    targetAmount: row.target_amount,
    isArchived: row.is_archived === 1,
    saved: row.saved,
  }));
}

export async function createGoal(
  db: D1Database,
  name: string,
  targetAmount: number,
): Promise<number> {
  const res = await db
    .prepare("INSERT INTO goals (name, target_amount, is_archived) VALUES (?1, ?2, 0)")
    .bind(name, targetAmount)
    .run();
  return Number(res.meta.last_row_id);
}

/**
 * R1 — атомарный условный INSERT, не read-then-write.
 * `?2 > 0` в WHERE обязателен: без него отрицательная сумма проходит guard
 * тривиально (free >= -50000000 всегда истинно) и деньги появляются из ниоткуда.
 * Результат читается из meta.changes ТОГО ЖЕ .run() — не отдельным SELECT changes().
 *
 * @returns false → 409 (не хватило свободных, либо цель архивная, либо amount <= 0).
 */
export async function allocateToGoal(
  db: D1Database,
  goalId: number,
  amount: number,
  authorId: number,
  now: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      "INSERT INTO goal_allocations (goal_id, amount, author_id, created_at)" +
        " SELECT ?1, ?2, ?3, ?4" +
        " WHERE ?2 > 0" +
        "   AND (SELECT free FROM v_balance) >= ?2" +
        "   AND (SELECT is_archived FROM goals WHERE id = ?1) = 0",
    )
    .bind(goalId, amount, authorId, now)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

/**
 * Возврат из цели (AC-15): amount передаётся ПОЛОЖИТЕЛЬНЫМ, в таблицу пишется -?2.
 * При отрицательном amount проверка стала бы тождественно истинной и возврат
 * молча превратился бы в пополнение — отсюда `?2 > 0`.
 */
export async function deallocateFromGoal(
  db: D1Database,
  goalId: number,
  amount: number,
  authorId: number,
  now: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      "INSERT INTO goal_allocations (goal_id, amount, author_id, created_at)" +
        " SELECT ?1, -?2, ?3, ?4" +
        " WHERE ?2 > 0" +
        "   AND (SELECT COALESCE(SUM(amount), 0) FROM goal_allocations WHERE goal_id = ?1) >= ?2",
    )
    .bind(goalId, amount, authorId, now)
    .run();
  return (res.meta.changes ?? 0) === 1;
}

/**
 * R2 — архивация цели одним batch(). Компенсация вставляется УСЛОВНО:
 * для цели без аллокаций SUM вернёт NULL, COALESCE дал бы amount = 0 и
 * нарушение CHECK (amount != 0) → 500 на самом частом сценарии
 * «создал цель, передумал».
 */
export async function archiveGoal(
  db: D1Database,
  goalId: number,
  authorId: number,
  now: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "INSERT INTO goal_allocations (goal_id, amount, author_id, created_at)" +
          " SELECT ?1, -(SELECT SUM(amount) FROM goal_allocations WHERE goal_id = ?1), ?2, ?3" +
          " WHERE (SELECT COALESCE(SUM(amount), 0) FROM goal_allocations WHERE goal_id = ?1) != 0",
      )
      .bind(goalId, authorId, now),
    db.prepare("UPDATE goals SET is_archived = 1 WHERE id = ?1").bind(goalId),
  ]);
}
