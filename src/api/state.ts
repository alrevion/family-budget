// Баланс, пользователи и app_state (onboarding_done, last_nag_on).

import type { Hono } from "hono";
import * as q from "../queries";
import { quietUntil } from "../cron";
import { todayInTashkent } from "../time";
import type { AppEnv } from "./validate";
import { readBody } from "./validate";

export function mount(api: Hono<AppEnv>): void {
  api.get("/api/balance", async (c) => c.json(await q.getBalance(c.env.DB)));

  // Кто есть кто — для подписи авторства в ленте. Отдельный лёгкий маршрут:
  // имена раньше приезжали только с /api/compare?mode=authors, который ради
  // двух строк считает агрегаты за период.
  api.get("/api/users", async (c) => c.json({ users: await q.listUsers(c.env.DB) }));

  api.get("/api/state/:key", async (c) => {
    const key = c.req.param("key");
    return c.json({ key, value: await q.getAppState(c.env.DB, key) });
  });

  // Кнопка «Ничего не тратили» из ежедневного напоминания (src/cron.ts).
  // Отдельный маршрут, а не PUT /api/state/last_nag_on: срок тишины —
  // политика напоминаний, ей место рядом с ней, а не в клиенте.
  api.post("/api/state/quiet", async (c) => {
    const until = quietUntil(todayInTashkent());
    await q.setAppState(c.env.DB, "last_nag_on", until);
    return c.json({ ok: true, until });
  });

  api.put("/api/state/:key", async (c) => {
    const body = await readBody(c);
    if (body === null || typeof body.value !== "string" || body.value.length > 256) {
      return c.json({ error: "bad_value" }, 400);
    }
    await q.setAppState(c.env.DB, c.req.param("key"), body.value);
    return c.json({ ok: true });
  });
}
