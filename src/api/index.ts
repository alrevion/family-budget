// REST API для Mini App — шаг 6 плана (.omc/plans/family-budget-v1-consensus.md,
// rev.4), разбитый по группам маршрутов. Валидация на границе; вся работа с D1 —
// через src/queries, маскирование скрытых трат живёт в src/queries/masking.ts и
// только там (R3).
//
// Формат JSON — camelCase, как в src/types.ts. Ошибки: { "error": "<code>" }.
//
// Порядок регистрации сохранён: auth-middleware ПЕРВЫМ, дальше группы в том же
// порядке, что были в одном файле. Hono подбирает обработчики в порядке
// объявления — middleware обязан быть объявлен раньше маршрутов.

import { Hono } from "hono";
import { authenticate } from "../auth";
import type { AppEnv } from "./validate";
import { mount as mountState } from "./state";
import { mount as mountTransactions } from "./transactions";
import { mount as mountCategories } from "./categories";
import { mount as mountGoals } from "./goals";
import { mount as mountReports } from "./reports";
import { mount as mountReceipts } from "./receipts";
import { mount as mountShops } from "./shops";

export const api = new Hono<AppEnv>();

// --- Auth (R4) --------------------------------------------------------------
// GET /api/health зарегистрирован в src/index.ts РАНЬШЕ этого middleware и
// потому его не задевает — единственный маршрут в обход initData-проверки.

api.use("/api/*", async (c, next) => {
  const result = await authenticate(c.req.raw, c.env);
  if (!result.ok) return c.json({ error: result.error }, result.status);
  c.set("user", result.user);
  await next();
});

mountState(api);
mountTransactions(api);
mountCategories(api);
mountGoals(api);
mountReports(api);
mountReceipts(api);
mountShops(api);
