// Раздел «Магазины»: список запомненных магазинов и правка их категории.
//
// Магазин попадает в список только после сохранённой траты по чеку
// (receipts.transaction_id IS NOT NULL), поэтому брошенный скан не создаёт
// пустую строку.

import type { Hono } from "hono";
import * as q from "../queries";
import type { AppEnv } from "./validate";
import { parseId, readBody } from "./validate";

export function mount(api: Hono<AppEnv>): void {
  api.get("/api/shops", async (c) => c.json({ shops: await q.listShops(c.env.DB) }));

  api.patch("/api/shops/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "bad_id" }, 400);

    const body = await readBody(c);
    if (body === null) return c.json({ error: "bad_body" }, 400);
    if (!("defaultCategoryId" in body)) return c.json({ error: "bad_default_category" }, 400);

    const raw = body.defaultCategoryId;
    const categoryId = raw === null ? null : typeof raw === "number" ? raw : Number.NaN;

    if (categoryId !== null) {
      if (!Number.isInteger(categoryId) || categoryId <= 0) {
        return c.json({ error: "bad_default_category" }, 400);
      }
      const category = await q.getCategory(c.env.DB, categoryId);
      // Доходную категорию в память чека не пускаем: чек — это всегда расход.
      if (category === null || category.isArchived || category.appliesTo === "income") {
        return c.json({ error: "bad_default_category" }, 400);
      }
    }

    const shop = await q.getShop(c.env.DB, id);
    if (shop === null) return c.json({ error: "shop_not_found" }, 404);

    if (categoryId !== null) {
      await q.setShopDefaultCategory(c.env.DB, id, categoryId, new Date().toISOString());
    } else {
      await q.clearShopDefaultCategory(c.env.DB, id, new Date().toISOString());
    }

    return c.json({ ok: true });
  });
}
