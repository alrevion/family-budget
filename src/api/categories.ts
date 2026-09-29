// Маршруты категорий.

import type { Hono } from "hono";
import * as q from "../queries";
import type { CategoryAppliesTo, TransactionKind } from "../types";
import type { AppEnv } from "./validate";
import { APPLIES_TO, KINDS, isName, parseId, readBody } from "./validate";

export function mount(api: Hono<AppEnv>): void {
  api.get("/api/categories", async (c) => {
    const kind = c.req.query("kind");
    if (kind !== undefined && !KINDS.includes(kind)) return c.json({ error: "bad_kind" }, 400);
    const categories = await q.listCategories(c.env.DB, kind as TransactionKind | undefined);
    return c.json({ categories });
  });

  api.post("/api/categories", async (c) => {
    const body = await readBody(c);
    if (body === null) return c.json({ error: "bad_body" }, 400);
    if (!isName(body.name)) return c.json({ error: "bad_name" }, 400);
    const appliesTo = body.appliesTo;
    if (typeof appliesTo !== "string" || !APPLIES_TO.includes(appliesTo)) {
      return c.json({ error: "bad_applies_to" }, 400);
    }
    const res = await q.createCategory(c.env.DB, body.name.trim(), appliesTo as CategoryAppliesTo);
    if (!res.ok) return c.json({ error: "name_conflict" }, 409);
    return c.json({ id: res.value }, 201);
  });

  api.patch("/api/categories/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "bad_id" }, 400);
    const body = await readBody(c);
    if (body === null) return c.json({ error: "bad_body" }, 400);
    if (!isName(body.name)) return c.json({ error: "bad_name" }, 400);
    const res = await q.renameCategory(c.env.DB, id, body.name.trim());
    if (!res.ok) return c.json({ error: "name_conflict" }, 409);
    if (!res.value) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  api.delete("/api/categories/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "bad_id" }, 400);
    if (!(await q.archiveCategory(c.env.DB, id))) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });
}
