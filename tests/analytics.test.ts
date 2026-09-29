// Расширенная аналитика: периоды (месяц/квартал/год/диапазон), фильтры,
// сравнение и табличные поля count/share.
//
// Регрессия на НОВЫЙ канал утечки (фильтр по категории как оракул) живёт
// отдельно, в tests/privacy.test.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MaskedTransaction } from "../src/types";
import {
  ALISHER_ID,
  ALISHER_INIT_DATA,
  AUTH_DATE_2026_08_24,
  DILNOZA_ID,
  DILNOZA_INIT_DATA,
} from "./fixtures/init-data";
import { apiJson, CATEGORY, categoryId, freezeTime, insertTx, resetDb, unfreezeTime } from "./helpers";

interface PeriodInfoBody {
  kind: string;
  label: string;
  from: string;
  to: string;
  granularity: "day" | "month";
}

interface CategoryAmountBody {
  categoryId: number | null;
  name: string;
  amount: number;
  count: number;
  share: number;
}

interface ReportBody {
  month: string;
  period: PeriodInfoBody;
  income: number;
  expense: number;
  expensesByCategory: CategoryAmountBody[];
  comparison: Array<{
    categoryId: number | null;
    name: string;
    current: number;
    previous: number;
    delta: number;
  }>;
  dynamics: Array<{ bucket: string; month: string; income: number; expense: number }>;
  topExpenses: MaskedTransaction[];
  saved: number;
  error?: string;
}

interface ListBody {
  transactions: MaskedTransaction[];
  period: PeriodInfoBody;
  error?: string;
}

interface AuthorsBody {
  mode: string;
  period: PeriodInfoBody;
  authors: Array<{
    authorId: number;
    name: string;
    income: number;
    expense: number;
    topCategories: CategoryAmountBody[];
  }>;
  error?: string;
}

interface PeriodsBody {
  mode: string;
  a: PeriodInfoBody;
  b: PeriodInfoBody;
  categories: Array<{
    categoryId: number | null;
    name: string;
    current: number;
    previous: number;
    delta: number;
  }>;
  error?: string;
}

/**
 * Общий сид на 2026 год. Скрытая трата Алишера (подарок) — единственная
 * маскируемая запись, и только для Дилнозы.
 */
async function seed(): Promise<void> {
  await insertTx({
    amount: 100_000,
    kind: "expense",
    category: CATEGORY.groceries,
    authorId: ALISHER_ID,
    occurredOn: "2026-01-15",
  });
  await insertTx({
    amount: 200_000,
    kind: "expense",
    category: CATEGORY.transport,
    authorId: DILNOZA_ID,
    occurredOn: "2026-04-10",
  });
  await insertTx({
    amount: 300_000,
    kind: "expense",
    category: CATEGORY.groceries,
    authorId: DILNOZA_ID,
    occurredOn: "2026-07-05",
  });
  await insertTx({
    amount: 340_000,
    kind: "expense",
    category: CATEGORY.gifts,
    authorId: ALISHER_ID,
    occurredOn: "2026-08-20",
    comment: "серёжки",
    hiddenUntil: "2026-08-31",
  });
  await insertTx({
    amount: 120_000,
    kind: "expense",
    category: CATEGORY.groceries,
    authorId: DILNOZA_ID,
    occurredOn: "2026-08-21",
  });
  await insertTx({
    amount: 5_000_000,
    kind: "income",
    category: CATEGORY.salary,
    authorId: ALISHER_ID,
    occurredOn: "2026-08-01",
  });
}

function report(initData: string, query: string) {
  return apiJson<ReportBody>(initData, `/api/report${query}`);
}

beforeEach(async () => {
  freezeTime(AUTH_DATE_2026_08_24);
  await resetDb();
  await seed();
});

afterEach(() => {
  unfreezeTime();
});

describe("периоды", () => {
  it("?month= остаётся рабочим и не меняет форму (на нём завязан cron)", async () => {
    const { status, body } = await report(ALISHER_INIT_DATA, "?month=2026-08");
    expect(status).toBe(200);
    expect(body.month).toBe("2026-08");
    expect(body.period).toEqual({
      kind: "month",
      label: "2026-08",
      from: "2026-08-01",
      to: "2026-08-31",
      granularity: "month",
    });
    expect(body.expense).toBe(460_000);
    expect(body.income).toBe(5_000_000);
  });

  it("без параметров берёт текущий месяц по Ташкенту", async () => {
    const { body } = await report(ALISHER_INIT_DATA, "");
    expect(body.period.label).toBe("2026-08");
  });

  it("?period=quarter группирует динамику по месяцам квартала", async () => {
    const { body } = await report(ALISHER_INIT_DATA, "?period=quarter&anchor=2026-08");
    expect(body.period).toEqual({
      kind: "quarter",
      label: "2026-Q3",
      from: "2026-07-01",
      to: "2026-09-30",
      granularity: "month",
    });
    expect(body.expense).toBe(760_000);
    expect(body.dynamics.map((d) => d.bucket)).toEqual(["2026-07", "2026-08"]);
  });

  it("?period=year группирует динамику по месяцам года и не выходит за его границы", async () => {
    const { body } = await report(ALISHER_INIT_DATA, "?period=year&anchor=2026-03");
    expect(body.period).toEqual({
      kind: "year",
      label: "2026",
      from: "2026-01-01",
      to: "2026-12-31",
      granularity: "month",
    });
    expect(body.expense).toBe(1_060_000);
    expect(body.dynamics.map((d) => d.bucket)).toEqual([
      "2026-01",
      "2026-04",
      "2026-07",
      "2026-08",
    ]);
    // Совместимость: month дублирует bucket, на нём построен график v1.
    expect(body.dynamics.every((d) => d.month === d.bucket)).toBe(true);
  });

  it("?period=year&anchor=2025 отдаёт пустой, но валидный отчёт", async () => {
    const { status, body } = await report(ALISHER_INIT_DATA, "?period=year&anchor=2025-06");
    expect(status).toBe(200);
    expect(body.expense).toBe(0);
    expect(body.expensesByCategory).toEqual([]);
  });

  it("произвольный диапазон включает обе границы и группируется по дням", async () => {
    const { body } = await report(ALISHER_INIT_DATA, "?from=2026-08-01&to=2026-08-21");
    expect(body.period).toEqual({
      kind: "range",
      label: "2026-08-01..2026-08-21",
      from: "2026-08-01",
      to: "2026-08-21",
      granularity: "day",
    });
    expect(body.expense).toBe(460_000);
    expect(body.dynamics.map((d) => d.bucket)).toEqual(["2026-08-01", "2026-08-20", "2026-08-21"]);
  });

  it("граница диапазона включительна: to=2026-08-20 берёт трату 20-го, to=2026-08-19 — нет", async () => {
    const inclusive = await report(ALISHER_INIT_DATA, "?from=2026-08-20&to=2026-08-20");
    expect(inclusive.body.expense).toBe(340_000);
    const exclusive = await report(ALISHER_INIT_DATA, "?from=2026-08-18&to=2026-08-19");
    expect(exclusive.body.expense).toBe(0);
  });

  it("диапазон длиннее 62 дней переходит на месячные корзины", async () => {
    const { body } = await report(ALISHER_INIT_DATA, "?from=2026-01-01&to=2026-08-24");
    expect(body.period.granularity).toBe("month");
    expect(body.dynamics.map((d) => d.bucket)).toEqual([
      "2026-01",
      "2026-04",
      "2026-07",
      "2026-08",
    ]);
  });

  it("диапазон через границу года считает обе стороны", async () => {
    await insertTx({
      amount: 70_000,
      kind: "expense",
      category: CATEGORY.transport,
      authorId: ALISHER_ID,
      occurredOn: "2025-12-31",
    });
    const { body } = await report(ALISHER_INIT_DATA, "?from=2025-12-30&to=2026-01-15");
    expect(body.expense).toBe(170_000);
    expect(body.dynamics.map((d) => d.bucket)).toEqual(["2025-12-31", "2026-01-15"]);
  });

  it("високосный февраль как диапазон отдаёт 29 дневных корзин по календарю", async () => {
    await insertTx({
      amount: 42_000,
      kind: "expense",
      category: CATEGORY.transport,
      authorId: ALISHER_ID,
      occurredOn: "2024-02-29",
    });
    const { status, body } = await report(ALISHER_INIT_DATA, "?from=2024-02-01&to=2024-02-29");
    expect(status).toBe(200);
    expect(body.period.to).toBe("2024-02-29");
    expect(body.period.granularity).toBe("day");
    expect(body.expense).toBe(42_000);
  });

  it("сравнение квартала идёт с предыдущим кварталом, а не с прошлым месяцем", async () => {
    const { body } = await report(ALISHER_INIT_DATA, "?period=quarter&anchor=2026-08");
    const transport = body.comparison.find((r) => r.name === CATEGORY.transport);
    // Транспорт: 0 в Q3, 200 000 во Q2.
    expect(transport).toMatchObject({ current: 0, previous: 200_000, delta: -200_000 });
  });
});

describe("валидация периода", () => {
  const cases: Array<[string, string]> = [
    ["?month=2026-13", "bad_month"],
    ["?month=nope", "bad_month"],
    ["?period=week", "bad_period"],
    ["?period=quarter&anchor=2026-99", "bad_anchor"],
    ["?from=2026-08-10&to=2026-08-01", "bad_range"],
    ["?from=2026-08-01&to=2026-09-01", "future_range"],
    ["?from=2021-01-01&to=2026-01-01", "range_too_long"],
    ["?from=2026-08-01", "bad_date"],
    ["?to=2026-08-01", "bad_date"],
    ["?from=2026-08-32&to=2026-08-01", "bad_date"],
    ["?month=2026-08&period=year", "conflicting_period"],
    ["?month=2026-08&from=2026-08-01&to=2026-08-02", "conflicting_period"],
  ];

  for (const [query, error] of cases) {
    it(`${query} -> 400 ${error}`, async () => {
      const { status, body } = await report(ALISHER_INIT_DATA, query);
      expect(status).toBe(400);
      expect(body.error).toBe(error);
    });
  }

  it("ровно 5 лет минус день проходит", async () => {
    const { status } = await report(ALISHER_INIT_DATA, "?from=2021-01-02&to=2026-01-01");
    expect(status).toBe(200);
  });
});

describe("count и share в expensesByCategory", () => {
  it("считают число транзакций и долю от общего расхода", async () => {
    const { body } = await report(ALISHER_INIT_DATA, "?period=year&anchor=2026-08");
    const groceries = body.expensesByCategory.find((r) => r.name === CATEGORY.groceries);
    expect(groceries).toMatchObject({ amount: 520_000, count: 3 });
    // 520 000 / 1 060 000
    expect(groceries?.share).toBe(0.4906);
    const sum = body.expensesByCategory.reduce((acc, r) => acc + r.share, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(0.001);
  });

  it("на пустой выборке share = 0, а не NaN", async () => {
    const { body } = await report(ALISHER_INIT_DATA, "?period=year&anchor=2020-01");
    expect(body.expensesByCategory).toEqual([]);
  });
});

describe("фильтры", () => {
  it("categories: только выбранные категории", async () => {
    const groceries = await categoryId(CATEGORY.groceries);
    const { body } = await report(
      ALISHER_INIT_DATA,
      `?period=year&anchor=2026-08&categories=${groceries}`,
    );
    expect(body.expense).toBe(520_000);
    expect(body.expensesByCategory).toHaveLength(1);
  });

  it("categories: список из нескольких id объединяется по ИЛИ", async () => {
    const groceries = await categoryId(CATEGORY.groceries);
    const transport = await categoryId(CATEGORY.transport);
    const { body } = await report(
      ALISHER_INIT_DATA,
      `?period=year&anchor=2026-08&categories=${groceries},${transport}`,
    );
    expect(body.expense).toBe(720_000);
  });

  it("author: только записи одного автора", async () => {
    const { body } = await report(
      ALISHER_INIT_DATA,
      `?period=year&anchor=2026-08&author=${DILNOZA_ID}`,
    );
    expect(body.expense).toBe(620_000);
    expect(body.income).toBe(0);
  });

  it("kind=income обнуляет расходную часть отчёта", async () => {
    const { body } = await report(ALISHER_INIT_DATA, "?period=year&anchor=2026-08&kind=income");
    expect(body.income).toBe(5_000_000);
    expect(body.expense).toBe(0);
    expect(body.expensesByCategory).toEqual([]);
    expect(body.topExpenses).toEqual([]);
  });

  it("min/max задают диапазон сумм включительно", async () => {
    const { body } = await report(
      ALISHER_INIT_DATA,
      "?period=year&anchor=2026-08&kind=expense&min=120000&max=300000",
    );
    expect(body.expense).toBe(620_000); // 200 000 + 300 000 + 120 000
  });

  it("фильтры комбинируются по И", async () => {
    const groceries = await categoryId(CATEGORY.groceries);
    const { body } = await report(
      ALISHER_INIT_DATA,
      `?period=year&anchor=2026-08&categories=${groceries}&author=${DILNOZA_ID}&min=200000`,
    );
    expect(body.expense).toBe(300_000);
    expect(body.expensesByCategory).toEqual([
      { categoryId: groceries, name: CATEGORY.groceries, amount: 300_000, count: 1, share: 1 },
    ]);
  });

  it("фильтры действуют и на /api/transactions", async () => {
    const groceries = await categoryId(CATEGORY.groceries);
    const { body } = await apiJson<ListBody>(
      ALISHER_INIT_DATA,
      `/api/transactions?period=year&anchor=2026-08&categories=${groceries}`,
    );
    expect(body.transactions.map((t) => t.amount)).toEqual([120_000, 300_000, 100_000]);
    expect(body.period.label).toBe("2026");
  });

  it("фильтр сужает и блок динамики", async () => {
    const transport = await categoryId(CATEGORY.transport);
    const { body } = await report(
      ALISHER_INIT_DATA,
      `?period=year&anchor=2026-08&categories=${transport}`,
    );
    expect(body.dynamics.map((d) => d.bucket)).toEqual(["2026-04"]);
  });

  const badFilters: Array<[string, string]> = [
    ["categories=999999", "unknown_category"],
    ["categories=abc", "bad_category"],
    ["categories=0", "bad_category"],
    ["categories=-3", "bad_category"],
    ["author=999999999", "unknown_author"],
    ["author=abc", "bad_author"],
    ["kind=both", "bad_kind"],
    ["min=-1", "bad_min"],
    ["min=1.5", "bad_min"],
    ["max=abc", "bad_max"],
    ["min=500&max=100", "bad_amount_range"],
  ];

  for (const [query, error] of badFilters) {
    it(`${query} -> 400 ${error}`, async () => {
      const { status, body } = await report(ALISHER_INIT_DATA, `?month=2026-08&${query}`);
      expect(status).toBe(400);
      expect(body.error).toBe(error);
    });
  }

  it("пустое значение фильтра равносильно его отсутствию", async () => {
    const { status, body } = await report(
      ALISHER_INIT_DATA,
      "?month=2026-08&categories=&author=&kind=&min=&max=",
    );
    expect(status).toBe(200);
    expect(body.expense).toBe(460_000);
  });
});

describe("GET /api/compare?mode=authors", () => {
  it("разбивает суммы и топ категорий по каждому из двух пользователей", async () => {
    const { status, body } = await apiJson<AuthorsBody>(
      ALISHER_INIT_DATA,
      "/api/compare?mode=authors&period=year&anchor=2026-08",
    );
    expect(status).toBe(200);
    expect(body.period.label).toBe("2026");
    expect(body.authors).toHaveLength(2);

    const alisher = body.authors.find((a) => a.authorId === ALISHER_ID);
    expect(alisher).toMatchObject({ name: "Алишер", income: 5_000_000, expense: 440_000 });
    expect(alisher?.topCategories.map((c) => [c.name, c.amount])).toEqual([
      [CATEGORY.gifts, 340_000],
      [CATEGORY.groceries, 100_000],
    ]);

    const dilnoza = body.authors.find((a) => a.authorId === DILNOZA_ID);
    expect(dilnoza).toMatchObject({ name: "Дилноза", income: 0, expense: 620_000 });
    expect(dilnoza?.topCategories[0]).toMatchObject({
      name: CATEGORY.groceries,
      amount: 420_000,
      count: 2,
    });
  });

  it("mode по умолчанию — authors", async () => {
    const { body } = await apiJson<AuthorsBody>(ALISHER_INIT_DATA, "/api/compare?month=2026-08");
    expect(body.mode).toBe("authors");
  });

  it("доли внутри автора считаются от его собственного расхода", async () => {
    const { body } = await apiJson<AuthorsBody>(
      ALISHER_INIT_DATA,
      "/api/compare?mode=authors&period=year&anchor=2026-08",
    );
    const alisher = body.authors.find((a) => a.authorId === ALISHER_ID);
    const sum = (alisher?.topCategories ?? []).reduce((acc, c) => acc + c.share, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(0.001);
  });

  it("неизвестный mode -> 400", async () => {
    const { status, body } = await apiJson<AuthorsBody>(
      ALISHER_INIT_DATA,
      "/api/compare?mode=nope",
    );
    expect(status).toBe(400);
    expect(body.error).toBe("bad_mode");
  });
});

describe("GET /api/compare?mode=periods", () => {
  it("кладёт два периода рядом по категориям с дельтой", async () => {
    const groceries = await categoryId(CATEGORY.groceries);
    const { status, body } = await apiJson<PeriodsBody>(
      ALISHER_INIT_DATA,
      "/api/compare?mode=periods&a=2026-08&b=2026-07",
    );
    expect(status).toBe(200);
    expect(body.a.label).toBe("2026-08");
    expect(body.b.label).toBe("2026-07");
    const row = body.categories.find((r) => r.categoryId === groceries);
    expect(row).toMatchObject({ current: 120_000, previous: 300_000, delta: -180_000 });
  });

  it("категория, которой нет в первом периоде, приходит с current = 0", async () => {
    const transport = await categoryId(CATEGORY.transport);
    const { body } = await apiJson<PeriodsBody>(
      ALISHER_INIT_DATA,
      "/api/compare?mode=periods&a=2026-08&b=2026-04",
    );
    const row = body.categories.find((r) => r.categoryId === transport);
    expect(row).toMatchObject({ current: 0, previous: 200_000, delta: -200_000 });
  });

  it("принимает квартал, год и произвольный диапазон в a/b", async () => {
    const { status, body } = await apiJson<PeriodsBody>(
      ALISHER_INIT_DATA,
      "/api/compare?mode=periods&a=quarter:2026-08&b=year:2025-01",
    );
    expect(status).toBe(200);
    expect([body.a.label, body.b.label]).toEqual(["2026-Q3", "2025"]);

    const range = await apiJson<PeriodsBody>(
      ALISHER_INIT_DATA,
      "/api/compare?mode=periods&a=2026-08-01..2026-08-24&b=2026-07-01..2026-07-24",
    );
    expect(range.status).toBe(200);
    expect(range.body.a.label).toBe("2026-08-01..2026-08-24");
  });

  it("без a/b -> 400, с мусором в a -> 400", async () => {
    const missing = await apiJson<PeriodsBody>(
      ALISHER_INIT_DATA,
      "/api/compare?mode=periods&a=2026-08",
    );
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("missing_period");

    const broken = await apiJson<PeriodsBody>(
      ALISHER_INIT_DATA,
      "/api/compare?mode=periods&a=week:2026-08&b=2026-07",
    );
    expect(broken.status).toBe(400);
    expect(broken.body.error).toBe("bad_period");
  });

  it("фильтры применяются к обоим периодам", async () => {
    const groceries = await categoryId(CATEGORY.groceries);
    const { body } = await apiJson<PeriodsBody>(
      ALISHER_INIT_DATA,
      `/api/compare?mode=periods&a=2026-08&b=2026-07&categories=${groceries}`,
    );
    expect(body.categories).toHaveLength(1);
    expect(body.categories[0]).toMatchObject({ current: 120_000, previous: 300_000 });
  });
});

describe("скрытая трата глазами партнёра в новых путях", () => {
  it("в сравнении по авторам сумма учтена у автора, а категория схлопнута в «Скрытое»", async () => {
    const { body } = await apiJson<AuthorsBody>(
      DILNOZA_INIT_DATA,
      "/api/compare?mode=authors&period=year&anchor=2026-08",
    );
    const alisher = body.authors.find((a) => a.authorId === ALISHER_ID);
    expect(alisher?.expense).toBe(440_000); // скрытые 340 000 учтены — это реальные деньги
    expect(alisher?.topCategories.map((c) => c.name)).toEqual(["Скрытое", CATEGORY.groceries]);
    expect(JSON.stringify(body)).not.toContain(CATEGORY.gifts);
  });

  it("автор той же скрытой траты видит её настоящую категорию", async () => {
    const { body } = await apiJson<AuthorsBody>(
      ALISHER_INIT_DATA,
      "/api/compare?mode=authors&period=year&anchor=2026-08",
    );
    const alisher = body.authors.find((a) => a.authorId === ALISHER_ID);
    expect(alisher?.topCategories.map((c) => c.name)).toContain(CATEGORY.gifts);
  });
});
