// Маршруты целей: список, создание, аллокация/возврат, архивация.

import type { Hono } from "hono";
import * as q from "../queries";
import { isValidAmount } from "../money";
import type { AppEnv } from "./validate";
import { isName, parseId, readBody } from "./validate";

export function mount(api: Hono<AppEnv>): void {
  api.get("/api/goals", async (c) => c.json({ goals: await q.listGoals(c.env.DB) }));

  api.post("/api/goals", async (c) => {
    const body = await readBody(c);
    if (body === null) return c.json({ error: "bad_body" }, 400);
    if (!isName(body.name)) return c.json({ error: "bad_name" }, 400);
    if (typeof body.targetAmount !== "number" || !isValidAmount(body.targetAmount)) {
      return c.json({ error: "bad_amount" }, 400);
    }
    const id = await q.createGoal(c.env.DB, body.name.trim(), body.targetAmount);
    return c.json({ id }, 201);
  });

  /** Сумма для аллокации и возврата — строго положительная и здесь, и в WHERE (R1). */
  async function readPositiveAmount(
    c: { req: { json: () => Promise<unknown> } },
  ): Promise<number | null> {
    const body = await readBody(c);
    if (body === null || typeof body.amount !== "number") return null;
    return isValidAmount(body.amount) && body.amount > 0 ? body.amount : null;
  }

  api.post("/api/goals/:id/allocate", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "bad_id" }, 400);
    const amount = await readPositiveAmount(c);
    if (amount === null) return c.json({ error: "bad_amount" }, 400);
    const ok = await q.allocateToGoal(
      c.env.DB,
      id,
      amount,
      c.get("user").telegramId,
      new Date().toISOString(),
    );
    // 409: не хватило свободных денег, либо цель архивная/несуществующая.
    return ok ? c.json({ ok: true }) : c.json({ error: "allocation_rejected" }, 409);
  });

  api.post("/api/goals/:id/deallocate", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "bad_id" }, 400);
    const amount = await readPositiveAmount(c);
    if (amount === null) return c.json({ error: "bad_amount" }, 400);
    const ok = await q.deallocateFromGoal(
      c.env.DB,
      id,
      amount,
      c.get("user").telegramId,
      new Date().toISOString(),
    );
    // 409: в цели отложено меньше запрошенного.
    return ok ? c.json({ ok: true }) : c.json({ error: "deallocation_rejected" }, 409);
  });

  api.delete("/api/goals/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "bad_id" }, 400);
    await q.archiveGoal(c.env.DB, id, c.get("user").telegramId, new Date().toISOString());
    return c.json({ ok: true });
  });
}
