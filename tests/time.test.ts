import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  calendarPeriod,
  daysBetween,
  granularityFor,
  monthRange,
  periodRange,
  prevMonth,
  previousPeriod,
  rangePeriod,
} from "../src/time";

describe("addMonths", () => {
  it("clamps month-end overflow instead of rolling into the next month (AC-P16)", () => {
    // Naive Date#setMonth would give 2027-03-03; correct answer clamps to
    // the last day of the target month.
    expect(addMonths("2026-08-31", 6)).toBe("2027-02-28");
  });

  it("handles a leap-year February target", () => {
    expect(addMonths("2027-08-31", 6)).toBe("2028-02-29");
  });

  it("passes through unaffected day-of-month unchanged", () => {
    expect(addMonths("2026-01-15", 1)).toBe("2026-02-15");
  });

  it("supports negative n", () => {
    expect(addMonths("2026-03-01", -6)).toBe("2025-09-01");
  });
});

describe("prevMonth", () => {
  it("crosses the year boundary correctly", () => {
    expect(prevMonth("2027-01")).toBe("2026-12");
  });

  it("handles a plain mid-year case", () => {
    expect(prevMonth("2026-09")).toBe("2026-08");
  });
});

describe("monthRange", () => {
  it("returns a half-open [from, toExclusive) range", () => {
    expect(monthRange("2026-08")).toEqual(["2026-08-01", "2026-09-01"]);
  });

  it("crosses the year boundary correctly", () => {
    expect(monthRange("2026-12")).toEqual(["2026-12-01", "2027-01-01"]);
  });
});

describe("addDays", () => {
  it("crosses a month boundary", () => {
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
  });

  it("supports negative n", () => {
    expect(addDays("2026-09-01", -1)).toBe("2026-08-31");
  });
});

describe("periodRange", () => {
  it("groups a month into the quarter that contains it", () => {
    expect(periodRange("quarter", "2026-08")).toEqual(["2026-07-01", "2026-10-01"]);
    expect(periodRange("quarter", "2026-01")).toEqual(["2026-01-01", "2026-04-01"]);
  });

  it("crosses the year boundary on Q4", () => {
    expect(periodRange("quarter", "2026-11")).toEqual(["2026-10-01", "2027-01-01"]);
  });

  it("takes the whole year regardless of the anchor month", () => {
    expect(periodRange("year", "2026-03")).toEqual(["2026-01-01", "2027-01-01"]);
    expect(periodRange("year", "2026-12")).toEqual(["2026-01-01", "2027-01-01"]);
  });

  it("delegates month to monthRange", () => {
    expect(periodRange("month", "2026-02")).toEqual(monthRange("2026-02"));
  });
});

describe("daysBetween / granularityFor", () => {
  it("counts a non-leap February as 28 days and a leap one as 29", () => {
    const [f27, t27] = periodRange("month", "2027-02");
    const [f28, t28] = periodRange("month", "2028-02");
    expect(daysBetween(f27, t27)).toBe(28);
    expect(daysBetween(f28, t28)).toBe(29);
  });

  it("counts a leap year as 366 days", () => {
    const [from, to] = periodRange("year", "2028-06");
    expect(daysBetween(from, to)).toBe(366);
  });

  it("switches to monthly buckets past 62 days", () => {
    expect(granularityFor("2026-01-01", "2026-03-04")).toBe("day"); // 62 дня
    expect(granularityFor("2026-01-01", "2026-03-05")).toBe("month"); // 63 дня
  });
});

describe("calendarPeriod / rangePeriod", () => {
  it("labels month, quarter and year", () => {
    expect(calendarPeriod("month", "2026-08").label).toBe("2026-08");
    expect(calendarPeriod("quarter", "2026-08").label).toBe("2026-Q3");
    expect(calendarPeriod("year", "2026-08").label).toBe("2026");
  });

  it("treats both range bounds as inclusive", () => {
    const p = rangePeriod("2026-08-01", "2026-08-24");
    expect([p.from, p.to]).toEqual(["2026-08-01", "2026-08-25"]);
    expect(p.granularity).toBe("day");
    expect(p.label).toBe("2026-08-01..2026-08-24");
  });

  it("covers a leap February as a range", () => {
    const p = rangePeriod("2028-02-01", "2028-02-29");
    expect(daysBetween(p.from, p.to)).toBe(29);
  });
});

describe("previousPeriod", () => {
  it("steps a month back across the year boundary", () => {
    expect(previousPeriod(calendarPeriod("month", "2027-01"))).toEqual([
      "2026-12-01",
      "2027-01-01",
    ]);
  });

  it("steps a quarter back across the year boundary", () => {
    expect(previousPeriod(calendarPeriod("quarter", "2027-02"))).toEqual([
      "2026-10-01",
      "2027-01-01",
    ]);
  });

  it("steps a year back", () => {
    expect(previousPeriod(calendarPeriod("year", "2026-08"))).toEqual([
      "2025-01-01",
      "2026-01-01",
    ]);
  });

  it("shifts an arbitrary range by its own length", () => {
    // 24 дня: [2026-08-01, 2026-08-25) -> [2026-07-08, 2026-08-01)
    expect(previousPeriod(rangePeriod("2026-08-01", "2026-08-24"))).toEqual([
      "2026-07-08",
      "2026-08-01",
    ]);
  });
});
