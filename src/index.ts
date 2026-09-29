import { Hono } from "hono";
import { api } from "./api";
import type { Env } from "./types";
import { handleWebhook } from "./bot";
import { runScheduled } from "./cron";

// Точка монтирования: webhook (src/bot.ts), API (src/api.ts) и cron
// (src/cron.ts). См. план "Implementation Steps" (.omc/plans/
// family-budget-v1-consensus.md, rev.4) и раздел "Deploy unit".
//
// Статика Mini App НЕ обслуживается через Hono: [assets] в wrangler.toml
// с run_worker_first = ["/api/*", "/tg/webhook"] отдаёт все прочие пути
// напрямую из ./dist, минуя воркер.

const app = new Hono<{ Bindings: Env }>();

// GET /api/health — единственный маршрут в обход initData-проверки.
// Существует ради Verification 7: доказывает, что asset-роутер не
// проглотил /api/*. Реальную auth-проверку сюда НЕ добавлять.
app.get("/api/health", (c) => c.json({ ok: true }));

// POST /tg/webhook — Telegram webhook. Проверка секретного заголовка и
// ВСЕГДА-200 реализованы в src/bot.ts#handleWebhook (см. план, раздел
// "Cron" и риски: Telegram повторяет доставку на не-2xx).
app.post("/tg/webhook", (c) => handleWebhook(c.req.raw, c.env));

// /api/* — JSON API для Mini App: auth (R4) + queries (R3) + валидация
// на границе. Маршруты объявлены полными путями и монтируются как есть.
// Регистрация ИДЁТ ПОСЛЕ /api/health — health остаётся единственным
// маршрутом в обход initData-проверки.
app.route("/", api);

export default {
  fetch: app.fetch,

  // Диспетчеризация по controller.cron — реализована в src/cron.ts.
  // "0 5 1 * *" месячный отчёт, "0 5 * * *" ежедневная проверка удержания
  // с cooldown через app_state.last_nag_on. См. план, раздел "Cron".
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await runScheduled(controller, env);
  },
} satisfies ExportedHandler<Env>;
