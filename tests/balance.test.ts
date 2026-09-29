// AC-P1 (баланс — производная, правка задним числом корректна by construction)
// и AC-P7 (ретроактивный разрыв показывается, а не чинится).

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBalance, monthlyReport } from "../src/queries";
import { ALISHER_ID, ALISHER_INIT_DATA, AUTH_DATE_2026_08_24 } from "./fixtures/init-data";
import {
  allocationCount,
  allocationSumForGoal,
  apiJson,
  CATEGORY,
  freezeTime,
  insertGoal,
  insertTx,
  recomputeTotalIndependently,
  resetDb,
  unfreezeTime,
} from "./helpers";

const TODAY = "2026-08-24";
/** Три месяца назад относительно TODAY. */
const OLD_MONTH = "2026-05";

interface BalanceBody {
  total: number;
  inGoals: number;
  free: number;
}

beforeEach(async () => {
  freezeTime(AUTH_DATE_2026_08_24);
  await resetDb();
});

afterEach(() => {
  unfreezeTime();
});

describe("AC-P1: правка транзакции трёхмесячной давности", () => {
  it("оставляет total равным Σ(income)−Σ(expense) по независимому запросу", async () => {
    await insertTx({
      amount: 5_000_000,
      kind: "income",
      category: CATEGORY.salary,
      authorId: ALISHER_ID,
      occurredOn: "2026-05-10",
    });
    const oldExpense = await insertTx({
      amount: 340_000,
      kind: "expense",
      category: CATEGORY.groceries,
      authorId: ALISHER_ID,
      occurredOn: "2026-05-20",
    });
    // Запись из другого месяца — чтобы правка старой не была единственным слагаемым.
    await insertTx({
      amount: 120_000,
      kind: "expense",
      category: CATEGORY.transport,
      authorId: ALISHER_ID,
      occurredOn: "2026-08-02",
    });

    const before = await getBalance(env.DB);
    expect(before.total).toBe(await recomputeTotalIndependently());
    expect(before.total).toBe(4_540_000);

    const { status } = await apiJson(ALISHER_INIT_DATA, `/api/transactions/${oldExpense}`, {
      method: "PATCH",
      body: { amount: 900_000 },
    });
    expect(status).toBe(200);

    const after = await getBalance(env.DB);
    // Сравнение НЕ с константой, а с независимым пересчётом: агрегат нигде
    // не закеширован, значит эти два числа обязаны совпасть при любой правке.
    expect(after.total).toBe(await recomputeTotalIndependently());
    expect(after.total).toBe(3_980_000);
  });

  it("немедленно меняет отчёт за тот месяц", async () => {
    const oldExpense = await insertTx({
      amount: 340_000,
      kind: "expense",
      category: CATEGORY.groceries,
      authorId: ALISHER_ID,
      occurredOn: "2026-05-20",
    });

    const before = await monthlyReport(env.DB, ALISHER_ID, OLD_MONTH, TODAY);
    expect(before.expense).toBe(340_000);

    await apiJson(ALISHER_INIT_DATA, `/api/transactions/${oldExpense}`, {
      method: "PATCH",
      body: { amount: 900_000 },
    });

    const after = await monthlyReport(env.DB, ALISHER_ID, OLD_MONTH, TODAY);
    expect(after.expense).toBe(900_000);
    expect(after.expensesByCategory[0]?.amount).toBe(900_000);
    expect(after.topExpenses[0]?.amount).toBe(900_000);
    // AC-23 «Сэкономлено за месяц» = доходы − расходы, тоже без кеша.
    expect(after.saved).toBe(-900_000);
  });

  it("переносит запись в другой месяц при правке occurred_on", async () => {
    const tx = await insertTx({
      amount: 200_000,
      kind: "expense",
      category: CATEGORY.groceries,
      authorId: ALISHER_ID,
      occurredOn: "2026-05-20",
    });
    await apiJson(ALISHER_INIT_DATA, `/api/transactions/${tx}`, {
      method: "PATCH",
      body: { occurredOn: "2026-06-01" },
    });
    expect((await monthlyReport(env.DB, ALISHER_ID, "2026-05", TODAY)).expense).toBe(0);
    expect((await monthlyReport(env.DB, ALISHER_ID, "2026-06", TODAY)).expense).toBe(200_000);
  });

  it("правка kind (доход↔расход) двигает total на удвоенную сумму", async () => {
    const tx = await insertTx({
      amount: 5_000_000,
      kind: "income",
      category: CATEGORY.salary,
      authorId: ALISHER_ID,
      occurredOn: "2026-05-10",
    });
    const groceries = await env.DB.prepare("SELECT id FROM categories WHERE name = ?1")
      .bind(CATEGORY.groceries)
      .first<{ id: number }>();

    const { status } = await apiJson(ALISHER_INIT_DATA, `/api/transactions/${tx}`, {
      method: "PATCH",
      body: { kind: "expense", categoryId: groceries!.id },
    });
    expect(status).toBe(200);
    expect((await getBalance(env.DB)).total).toBe(-5_000_000);
    expect((await getBalance(env.DB)).total).toBe(await recomputeTotalIndependently());
  });

  it("отклоняет правку kind без смены категории на подходящую (400)", async () => {
    const tx = await insertTx({
      amount: 5_000_000,
      kind: "income",
      category: CATEGORY.salary,
      authorId: ALISHER_ID,
      occurredOn: "2026-05-10",
    });
    const { status, body } = await apiJson(ALISHER_INIT_DATA, `/api/transactions/${tx}`, {
      method: "PATCH",
      body: { kind: "expense" },
    });
    expect(status).toBe(400);
    expect(body).toEqual({ error: "kind_mismatch" });
    // Баланс не сдвинулся.
    expect((await getBalance(env.DB)).total).toBe(5_000_000);
  });
});

describe("AC-P7: ретроактивный разрыв показывается, а не чинится", () => {
  it("отдаёт отрицательное free и не трогает аллокации", async () => {
    const income = await insertTx({
      amount: 5_000_000,
      kind: "income",
      category: CATEGORY.salary,
      authorId: ALISHER_ID,
      occurredOn: "2026-08-01",
    });
    await insertTx({
      amount: 340_000,
      kind: "expense",
      category: CATEGORY.groceries,
      authorId: ALISHER_ID,
      occurredOn: "2026-08-02",
    });
    const goal = await insertGoal("Отпуск", 10_000_000);

    const allocated = await apiJson(ALISHER_INIT_DATA, `/api/goals/${goal}/allocate`, {
      method: "POST",
      body: { amount: 4_000_000 },
    });
    expect(allocated.status).toBe(200);

    // Задним числом уменьшаем доход — законная правка по AC-4.
    await apiJson(ALISHER_INIT_DATA, `/api/transactions/${income}`, {
      method: "PATCH",
      body: { amount: 3_000_000 },
    });

    const { body } = await apiJson<BalanceBody>(ALISHER_INIT_DATA, "/api/balance");
    expect(body.total).toBe(2_660_000);
    expect(body.inGoals).toBe(4_000_000);
    expect(body.free).toBe(-1_340_000);

    // Principle 1: никакого молчаливого урезания аллокации.
    expect(await allocationSumForGoal(goal)).toBe(4_000_000);
    expect(await allocationCount()).toBe(1);
  });

  it("отдаёт отрицательное total после удаления стартового остатка", async () => {
    const opening = await insertTx({
      amount: 5_000_000,
      kind: "income",
      category: CATEGORY.openingBalance,
      authorId: ALISHER_ID,
      occurredOn: "2026-08-01",
    });
    await insertTx({
      amount: 340_000,
      kind: "expense",
      category: CATEGORY.groceries,
      authorId: ALISHER_ID,
      occurredOn: "2026-08-02",
    });

    await apiJson(ALISHER_INIT_DATA, `/api/transactions/${opening}`, { method: "DELETE" });

    const { body } = await apiJson<BalanceBody>(ALISHER_INIT_DATA, "/api/balance");
    expect(body.total).toBe(-340_000);
    expect(body.free).toBe(-340_000);
    expect(body.total).toBe(await recomputeTotalIndependently());
  });

  it("при отрицательном free новая аллокация отвергается с 409", async () => {
    // Разрыв показан — но записывать поверх него guard не даёт.
    await insertTx({
      amount: 1_000_000,
      kind: "income",
      category: CATEGORY.salary,
      authorId: ALISHER_ID,
      occurredOn: "2026-08-01",
    });
    const goal = await insertGoal("Отпуск", 10_000_000);
    await apiJson(ALISHER_INIT_DATA, `/api/goals/${goal}/allocate`, {
      method: "POST",
      body: { amount: 1_000_000 },
    });
    await insertTx({
      amount: 500_000,
      kind: "expense",
      category: CATEGORY.groceries,
      authorId: ALISHER_ID,
      occurredOn: "2026-08-02",
    });

    const { status } = await apiJson(ALISHER_INIT_DATA, `/api/goals/${goal}/allocate`, {
      method: "POST",
      body: { amount: 1 },
    });
    expect(status).toBe(409);
    expect(await allocationCount()).toBe(1);
  });
});
