// AC-P11 — ночная трата не уезжает в чужой месяц.
//
// Тест ОБЯЗАН гоняться в workerd: он проверяет, что рантайм несёт полный ICU
// и действительно знает Asia/Tashkent. В node он прошёл бы на системной ICU
// и не доказывал бы ничего про прод. См. vitest.config.ts.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { todayInTashkent } from "../src/time";
import {
  ALISHER_INIT_DATA_TASHKENT_SEP1,
  AUTH_DATE_2026_09_01_TASHKENT,
} from "./fixtures/init-data";
import { apiJson, CATEGORY, categoryId, freezeTime, resetDb, unfreezeTime } from "./helpers";

interface ReportBody {
  month: string;
  expense: number;
  topExpenses: Array<{ occurredOn: string }>;
}

beforeEach(async () => {
  // 2026-08-31T21:00:00Z = 02:00 1 сентября в Asia/Tashkent (UTC+5).
  freezeTime(AUTH_DATE_2026_09_01_TASHKENT, 0);
  await resetDb();
});

afterEach(() => {
  unfreezeTime();
});

describe("AC-P11: 02:00 Asia/Tashkent 1 сентября", () => {
  it("workerd знает Asia/Tashkent: полный ICU на месте", async () => {
    // Без полного ICU Intl молча свалился бы на UTC и вернул 2026-08-31.
    expect(new Date().toISOString()).toBe("2026-08-31T21:00:00.000Z");
    expect(todayInTashkent()).toBe("2026-09-01");
    expect(
      new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent" }).resolvedOptions().timeZone,
    ).toBe("Asia/Tashkent");
  });

  it("транзакция без явной даты попадает в СЕНТЯБРЬСКИЙ отчёт", async () => {
    const { status } = await apiJson(ALISHER_INIT_DATA_TASHKENT_SEP1, "/api/transactions", {
      method: "POST",
      body: {
        amount: 340_000,
        kind: "expense",
        categoryId: await categoryId(CATEGORY.groceries),
      },
    });
    expect(status).toBe(201);

    const september = await apiJson<ReportBody>(
      ALISHER_INIT_DATA_TASHKENT_SEP1,
      "/api/report?month=2026-09",
    );
    expect(september.body.expense).toBe(340_000);
    expect(september.body.topExpenses[0]?.occurredOn).toBe("2026-09-01");

    const august = await apiJson<ReportBody>(
      ALISHER_INIT_DATA_TASHKENT_SEP1,
      "/api/report?month=2026-08",
    );
    // Без todayInTashkent() трата уехала бы сюда и тихо испортила оба отчёта.
    expect(august.body.expense).toBe(0);
  });

  it("отчёт и лента по умолчанию открываются на сентябре, а не на августе", async () => {
    const report = await apiJson<ReportBody>(ALISHER_INIT_DATA_TASHKENT_SEP1, "/api/report");
    expect(report.body.month).toBe("2026-09");

    await apiJson(ALISHER_INIT_DATA_TASHKENT_SEP1, "/api/transactions", {
      method: "POST",
      body: {
        amount: 100_000,
        kind: "expense",
        categoryId: await categoryId(CATEGORY.groceries),
      },
    });
    const feed = await apiJson<{ transactions: unknown[] }>(
      ALISHER_INIT_DATA_TASHKENT_SEP1,
      "/api/transactions",
    );
    expect(feed.body.transactions).toHaveLength(1);
  });

  it("дата 2026-09-01 не считается будущей: «сегодня» тоже по Ташкенту", async () => {
    const { status } = await apiJson(ALISHER_INIT_DATA_TASHKENT_SEP1, "/api/transactions", {
      method: "POST",
      body: {
        amount: 100_000,
        kind: "expense",
        categoryId: await categoryId(CATEGORY.groceries),
        occurredOn: "2026-09-01",
      },
    });
    expect(status).toBe(201);
  });
});
