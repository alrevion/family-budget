// Маршруты отчёта и сравнения.

import type { Hono } from "hono";
import * as q from "../queries";
import { todayInTashkent } from "../time";
import { parseFilter, parsePeriodQuery, parsePeriodSpec } from "./periods";
import type { AppEnv } from "./validate";

export function mount(api: Hono<AppEnv>): void {
  api.get("/api/report", async (c) => {
    const today = todayInTashkent();
    const period = parsePeriodQuery(c, today);
    if (!period.ok) return c.json({ error: period.error }, 400);
    const filter = await parseFilter(c.env.DB, c);
    if (!filter.ok) return c.json({ error: filter.error }, 400);
    const report = await q.periodReport(
      c.env.DB,
      c.get("user").telegramId,
      period.value,
      today,
      filter.value,
    );
    return c.json(report);
  });

  // --- Сравнение --------------------------------------------------------------

  api.get("/api/compare", async (c) => {
    const today = todayInTashkent();
    const viewer = c.get("user").telegramId;
    const mode = c.req.query("mode") ?? "authors";
    const filter = await parseFilter(c.env.DB, c);
    if (!filter.ok) return c.json({ error: filter.error }, 400);

    if (mode === "authors") {
      const period = parsePeriodQuery(c, today);
      if (!period.ok) return c.json({ error: period.error }, 400);
      const authors = await q.compareAuthors(c.env.DB, viewer, period.value, today, filter.value);
      return c.json({ mode: "authors", period: q.periodInfo(period.value), authors });
    }

    if (mode === "periods") {
      const rawA = c.req.query("a");
      const rawB = c.req.query("b");
      if (rawA === undefined || rawB === undefined) return c.json({ error: "missing_period" }, 400);
      const a = parsePeriodSpec(rawA, today);
      if (!a.ok) return c.json({ error: a.error }, 400);
      const b = parsePeriodSpec(rawB, today);
      if (!b.ok) return c.json({ error: b.error }, 400);
      const categories = await q.comparePeriods(
        c.env.DB,
        viewer,
        a.value,
        b.value,
        today,
        filter.value,
      );
      return c.json({
        mode: "periods",
        a: q.periodInfo(a.value),
        b: q.periodInfo(b.value),
        categories,
      });
    }

    return c.json({ error: "bad_mode" }, 400);
  });
}
