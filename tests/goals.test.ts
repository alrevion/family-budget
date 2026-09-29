// AC-P6 (guard'ы аллокации и возврата) и AC-P8 (архивация цели, R2).
//
// Проверяются ОБА уровня: граница API (src/api.ts) и условный INSERT в
// src/queries.ts. План требует этого явно — «дублируется валидацией на
// границе API», и отдельно: «форму INSERT ... SELECT ... WHERE без FROM
// проверить первым же тестом AC-P6, а не на проде».

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allocateToGoal, archiveGoal, deallocateFromGoal, getBalance, listGoals } from "../src/queries";
import { ALISHER_ID, ALISHER_INIT_DATA, AUTH_DATE_2026_08_24 } from "./fixtures/init-data";
import {
  allocationCount,
  allocationSumForGoal,
  apiJson,
  CATEGORY,
  freezeTime,
  insertGoal,
  insertTx,
  resetDb,
  unfreezeTime,
} from "./helpers";

const NOW = "2026-08-24T12:01:00.000Z";

async function seedIncome(amount: number): Promise<void> {
  await insertTx({
    amount,
    kind: "income",
    category: CATEGORY.salary,
    authorId: ALISHER_ID,
    occurredOn: "2026-08-01",
  });
}

beforeEach(async () => {
  freezeTime(AUTH_DATE_2026_08_24);
  await resetDb();
});

afterEach(() => {
  unfreezeTime();
});

describe("AC-P6: аллокация", () => {
  it("проходит, когда свободных денег хватает", async () => {
    await seedIncome(5_000_000);
    const goal = await insertGoal("Отпуск", 10_000_000);
    const { status } = await apiJson(ALISHER_INIT_DATA, `/api/goals/${goal}/allocate`, {
      method: "POST",
      body: { amount: 1_000_000 },
    });
    expect(status).toBe(200);
    const balance = await getBalance(env.DB);
    expect(balance).toEqual({ total: 5_000_000, inGoals: 1_000_000, free: 4_000_000 });
  });

  it("отдаёт 409 и НЕ создаёт запись при free < amount", async () => {
    await seedIncome(1_000_000);
    const goal = await insertGoal("Отпуск", 10_000_000);
    const { status, body } = await apiJson(ALISHER_INIT_DATA, `/api/goals/${goal}/allocate`, {
      method: "POST",
      body: { amount: 1_000_001 },
    });
    expect(status).toBe(409);
    expect(body).toEqual({ error: "allocation_rejected" });
    expect(await allocationCount()).toBe(0);
  });

  it("пропускает аллокацию ровно на всю сумму free (граница >=)", async () => {
    await seedIncome(1_000_000);
    const goal = await insertGoal("Отпуск", 10_000_000);
    expect(await allocateToGoal(env.DB, goal, 1_000_000, ALISHER_ID, NOW)).toBe(true);
    expect((await getBalance(env.DB)).free).toBe(0);
  });

  it("отдаёт 409 при аллокации в архивную цель", async () => {
    await seedIncome(5_000_000);
    const goal = await insertGoal("Отпуск", 10_000_000);
    await env.DB.prepare("UPDATE goals SET is_archived = 1 WHERE id = ?1").bind(goal).run();
    const { status } = await apiJson(ALISHER_INIT_DATA, `/api/goals/${goal}/allocate`, {
      method: "POST",
      body: { amount: 1_000_000 },
    });
    expect(status).toBe(409);
    // Иначе деньги ушли бы из «Свободно» в невидимый карман.
    expect(await allocationCount()).toBe(0);
  });

  it("отдаёт 409 при аллокации в несуществующую цель", async () => {
    await seedIncome(5_000_000);
    const { status } = await apiJson(ALISHER_INIT_DATA, "/api/goals/424242/allocate", {
      method: "POST",
      body: { amount: 1_000 },
    });
    expect(status).toBe(409);
    expect(await allocationCount()).toBe(0);
  });

  it("отдаёт 400 на отрицательную и нулевую сумму (граница API)", async () => {
    await seedIncome(5_000_000);
    const goal = await insertGoal("Отпуск", 10_000_000);
    for (const amount of [-50_000_000, 0, -1]) {
      const { status, body } = await apiJson(ALISHER_INIT_DATA, `/api/goals/${goal}/allocate`, {
        method: "POST",
        body: { amount },
      });
      expect(status, `amount=${amount}`).toBe(400);
      expect(body).toEqual({ error: "bad_amount" });
    }
    expect(await allocationCount()).toBe(0);
  });

  it("отвергает отрицательную сумму и в SQL-guard, не только на границе API", async () => {
    // Без `?2 > 0` в WHERE проверка free >= -50000000 тождественно истинна,
    // SUM по цели уходит в минус, и деньги появляются в «Свободно» из ниоткуда.
    await seedIncome(5_000_000);
    const goal = await insertGoal("Отпуск", 10_000_000);
    expect(await allocateToGoal(env.DB, goal, -50_000_000, ALISHER_ID, NOW)).toBe(false);
    expect(await allocateToGoal(env.DB, goal, 0, ALISHER_ID, NOW)).toBe(false);
    expect(await allocationCount()).toBe(0);
    expect((await getBalance(env.DB)).free).toBe(5_000_000);
  });
});

describe("AC-P6: возврат из цели (AC-15)", () => {
  it("возвращает деньги в свободные при корректной сумме", async () => {
    await seedIncome(5_000_000);
    const goal = await insertGoal("Отпуск", 10_000_000);
    await allocateToGoal(env.DB, goal, 1_000_000, ALISHER_ID, NOW);

    const { status } = await apiJson(ALISHER_INIT_DATA, `/api/goals/${goal}/deallocate`, {
      method: "POST",
      body: { amount: 400_000 },
    });
    expect(status).toBe(200);
    expect(await allocationSumForGoal(goal)).toBe(600_000);
    expect((await getBalance(env.DB)).free).toBe(4_400_000);
  });

  it("отдаёт 409 на возврат больше отложенного по цели", async () => {
    await seedIncome(5_000_000);
    const goal = await insertGoal("Отпуск", 10_000_000);
    await allocateToGoal(env.DB, goal, 1_000_000, ALISHER_ID, NOW);

    const { status, body } = await apiJson(ALISHER_INIT_DATA, `/api/goals/${goal}/deallocate`, {
      method: "POST",
      body: { amount: 1_000_001 },
    });
    expect(status).toBe(409);
    expect(body).toEqual({ error: "deallocation_rejected" });
    expect(await allocationSumForGoal(goal)).toBe(1_000_000);
  });

  it("считает лимит по ЭТОЙ цели, а не по всем сразу", async () => {
    await seedIncome(5_000_000);
    const a = await insertGoal("Отпуск", 10_000_000);
    const b = await insertGoal("Машина", 10_000_000);
    await allocateToGoal(env.DB, a, 1_000_000, ALISHER_ID, NOW);
    await allocateToGoal(env.DB, b, 1_000_000, ALISHER_ID, NOW);

    expect(await deallocateFromGoal(env.DB, a, 1_500_000, ALISHER_ID, NOW)).toBe(false);
    expect(await allocationSumForGoal(a)).toBe(1_000_000);
  });

  it("отдаёт 400 на отрицательную и нулевую сумму возврата (граница API)", async () => {
    await seedIncome(5_000_000);
    const goal = await insertGoal("Отпуск", 10_000_000);
    await allocateToGoal(env.DB, goal, 1_000_000, ALISHER_ID, NOW);

    for (const amount of [-500_000, 0]) {
      const { status } = await apiJson(ALISHER_INIT_DATA, `/api/goals/${goal}/deallocate`, {
        method: "POST",
        body: { amount },
      });
      expect(status, `amount=${amount}`).toBe(400);
    }
    expect(await allocationSumForGoal(goal)).toBe(1_000_000);
  });

  it("отвергает отрицательную сумму и в SQL-guard: возврат не превращается в пополнение", async () => {
    await seedIncome(5_000_000);
    const goal = await insertGoal("Отпуск", 10_000_000);
    await allocateToGoal(env.DB, goal, 1_000_000, ALISHER_ID, NOW);

    expect(await deallocateFromGoal(env.DB, goal, -500_000, ALISHER_ID, NOW)).toBe(false);
    expect(await deallocateFromGoal(env.DB, goal, 0, ALISHER_ID, NOW)).toBe(false);
    expect(await allocationSumForGoal(goal)).toBe(1_000_000);
    expect(await allocationCount()).toBe(1);
  });
});

describe("AC-P8: архивация цели (R2)", () => {
  it("возвращает деньги в свободные: SUM по цели становится 0", async () => {
    await seedIncome(5_000_000);
    const goal = await insertGoal("Отпуск", 10_000_000);
    await allocateToGoal(env.DB, goal, 1_000_000, ALISHER_ID, NOW);
    expect((await getBalance(env.DB)).free).toBe(4_000_000);

    const { status } = await apiJson(ALISHER_INIT_DATA, `/api/goals/${goal}`, { method: "DELETE" });
    expect(status).toBe(200);

    expect(await allocationSumForGoal(goal)).toBe(0);
    expect((await getBalance(env.DB)).free).toBe(5_000_000);
    expect((await getBalance(env.DB)).inGoals).toBe(0);
    // Деньги возвращены ЯВНОЙ компенсирующей записью, а не пересчётом.
    expect(await allocationCount()).toBe(2);
    expect(await listGoals(env.DB)).toEqual([]);
  });

  it("для цели БЕЗ аллокаций отвечает 200 и не создаёт ни одной записи", async () => {
    // Самый частый сценарий «создал цель, передумал». Без условия в шаге 1
    // COALESCE(SUM,0) дал бы amount = 0 и нарушение CHECK (amount != 0) → 500.
    const goal = await insertGoal("Передумал", 1_000_000);
    const { status } = await apiJson(ALISHER_INIT_DATA, `/api/goals/${goal}`, { method: "DELETE" });
    expect(status).toBe(200);
    expect(await allocationCount()).toBe(0);
    expect(await listGoals(env.DB)).toEqual([]);
  });

  it("для цели, из которой всё уже вернули, тоже не создаёт лишней записи", async () => {
    // SUM по цели == 0 при двух существующих строках — то же условие != 0.
    await seedIncome(5_000_000);
    const goal = await insertGoal("Отпуск", 10_000_000);
    await allocateToGoal(env.DB, goal, 1_000_000, ALISHER_ID, NOW);
    await deallocateFromGoal(env.DB, goal, 1_000_000, ALISHER_ID, NOW);

    await archiveGoal(env.DB, goal, ALISHER_ID, NOW);
    expect(await allocationCount()).toBe(2);
    expect(await allocationSumForGoal(goal)).toBe(0);
  });

  it("исключает архивную цель из listGoals, но сохраняет её строки аллокаций", async () => {
    await seedIncome(5_000_000);
    const goal = await insertGoal("Отпуск", 10_000_000);
    await allocateToGoal(env.DB, goal, 1_000_000, ALISHER_ID, NOW);
    await archiveGoal(env.DB, goal, ALISHER_ID, NOW);

    const { body } = await apiJson<{ goals: unknown[] }>(ALISHER_INIT_DATA, "/api/goals");
    expect(body.goals).toEqual([]);
    expect(await allocationCount()).toBe(2);
  });
});

describe("прогресс цели", () => {
  it("считает saved как сумму аллокаций минус возвраты", async () => {
    await seedIncome(5_000_000);
    const goal = await insertGoal("Отпуск", 10_000_000);
    await allocateToGoal(env.DB, goal, 1_000_000, ALISHER_ID, NOW);
    await deallocateFromGoal(env.DB, goal, 250_000, ALISHER_ID, NOW);

    const goals = await listGoals(env.DB);
    expect(goals).toEqual([
      { id: goal, name: "Отпуск", targetAmount: 10_000_000, isArchived: false, saved: 750_000 },
    ]);
  });
});
