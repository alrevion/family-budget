import { describe, expect, it } from "vitest";
import {
  catchUpDays,
  dayLabel,
  formatMonthlyReportText,
  isFirstOfMonth,
  quietUntil,
  shouldSendReminder,
} from "../src/cron";
import type { MonthlyReport } from "../src/queries";
import { formatMoney } from "../src/money";

function report(overrides: Partial<MonthlyReport>): MonthlyReport {
  return {
    month: "2026-08",
    period: {
      kind: "month",
      label: "2026-08",
      from: "2026-08-01",
      to: "2026-08-31",
      granularity: "month",
    },
    income: 0,
    expense: 0,
    expensesByCategory: [],
    comparison: [],
    dynamics: [],
    topExpenses: [],
    saved: 0,
    ...overrides,
  };
}

describe("shouldSendReminder", () => {
  const today = "2026-08-24";

  it("stays silent when the last entry is recent", () => {
    expect(shouldSendReminder(today, "2026-08-22", null)).toBe(false);
  });

  it("fires when stale and cooldown has never been set", () => {
    expect(shouldSendReminder(today, "2026-08-20", null)).toBe(true);
  });

  it("respects an active cooldown even if entries are stale (AC-P15)", () => {
    expect(shouldSendReminder(today, "2026-08-10", "2026-08-23")).toBe(false);
  });

  it("fires again once the cooldown itself has expired", () => {
    expect(shouldSendReminder(today, "2026-08-10", "2026-08-20")).toBe(true);
  });

  it("treats a full ISO timestamp for the last entry as its date prefix", () => {
    // created_at хранится как ISO-datetime — сравнение строками не должно
    // ломаться на суффиксе времени.
    expect(shouldSendReminder(today, "2026-08-22T23:59:00.000Z", null)).toBe(false);
  });

  it("fires when there are no entries at all", () => {
    expect(shouldSendReminder(today, null, null)).toBe(true);
  });
});

describe("isFirstOfMonth", () => {
  it("is true on the 1st", () => {
    expect(isFirstOfMonth("2026-09-01")).toBe(true);
  });

  it("is false on any other day", () => {
    expect(isFirstOfMonth("2026-09-02")).toBe(false);
  });
});

describe("formatMonthlyReportText", () => {
  it("renders total expenses and the top category with a rounded share", () => {
    const text = formatMonthlyReportText(
      "2026-08",
      report({
        income: 5_000_000,
        expense: 4_120_000,
        saved: 880_000,
        expensesByCategory: [
          { categoryId: 1, name: "Продукты", amount: 1_300_000, count: 4, share: 0.3155 },
        ],
      }),
    );
    expect(text).toBe(
      `Август: расходы ${formatMoney(4_120_000)}, топ — Продукты ${formatMoney(1_300_000)} (32%)`,
    );
  });

  it("omits the top line when there are no expenses", () => {
    const text = formatMonthlyReportText("2026-08", report({}));
    expect(text).toBe(`Август: расходы ${formatMoney(0)}`);
  });

  it("shows the masked pseudo-category as-is, never the real name (R3)", () => {
    // queries.ts уже слило замаскированные траты в псевдокатегорию
    // "Скрытое" (categoryId === null) до того, как отчёт попал сюда.
    const text = formatMonthlyReportText(
      "2026-08",
      report({
        expense: 1_000_000,
        saved: -1_000_000,
        expensesByCategory: [{ categoryId: null, name: "Скрытое", amount: 1_000_000, count: 1, share: 1 }],
      }),
    );
    expect(text).toBe(
      `Август: расходы ${formatMoney(1_000_000)}, топ — Скрытое ${formatMoney(1_000_000)} (100%)`,
    );
  });
});

describe("catchUpDays", () => {
  it("returns the three previous days, newest first, never today", () => {
    expect(catchUpDays("2026-08-24")).toEqual(["2026-08-23", "2026-08-22", "2026-08-21"]);
  });

  it("crosses the month boundary backwards", () => {
    expect(catchUpDays("2026-09-02")).toEqual(["2026-09-01", "2026-08-31", "2026-08-30"]);
  });
});

describe("dayLabel", () => {
  it("renders weekday and a short genitive month", () => {
    expect(dayLabel("2026-08-21")).toBe("Пятница, 21 авг");
    expect(dayLabel("2026-08-23")).toBe("Воскресенье, 23 авг");
  });

  it("uses «мая», not «май», so the date reads as Russian", () => {
    expect(dayLabel("2026-05-01")).toBe("Пятница, 1 мая");
  });
});

describe("quietUntil", () => {
  it("pushes the cooldown mark far enough for a week of silence", () => {
    // Порог cooldown — today - 3, поэтому неделя тишины = отметка на today + 4.
    const mark = quietUntil("2026-08-24");
    expect(mark).toBe("2026-08-28");
    // Обычный cooldown вернул бы напоминание 27-го; с отметкой — только 1 сентября.
    expect(shouldSendReminder("2026-08-27", null, mark)).toBe(false);
    expect(shouldSendReminder("2026-08-31", null, mark)).toBe(false);
    expect(shouldSendReminder("2026-09-01", null, mark)).toBe(true);
  });
});
