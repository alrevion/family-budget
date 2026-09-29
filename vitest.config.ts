// Пул workerd (@cloudflare/vitest-pool-workers) для ВСЕХ тестов.
//
// Почему один пул, а не «чистые функции в node, остальное в workerd»:
// AC-P11 обязан гоняться в workerd — он проверяет, что рантайм несёт полный
// ICU и знает Asia/Tashkent; в node тест проходил бы на системной ICU и
// ничего бы не доказывал. Держать второй пул ради tests/time.test.ts и
// tests/cron.test.ts смысла нет: это чистые функции, в workerd они
// выполняются так же.
//
// API: в @cloudflare/vitest-pool-workers 0.22 (поддержка vitest 4) экспорта
// `defineWorkersConfig` из подпути `/config` больше НЕТ — он заменён
// vite-плагином `cloudflareTest()` поверх обычного `defineConfig` из
// vitest/config. Ровно эту замену выполняет их же кодмод
// `@cloudflare/vitest-pool-workers/codemods/vitest-v3-to-v4`.
//
// wrangler.toml переиспользуется целиком — оттуда приезжает [[d1_databases]]
// binding = "DB" (иначе env.DB в тестах не существует) и [vars].
// Секреты (BOT_TOKEN / WEBHOOK_SECRET / ALLOWED_IDS) в репозитории не лежат,
// поэтому подставляются здесь тестовыми значениями.

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        // ТОЛЬКО для тестов. wrangler.toml объявляет compatibility_date
        // "2026-08-24", а workerd, вшитый в @cloudflare/vitest-pool-workers
        // 0.22 (miniflare 5.20260815.0-alpha), знает даты не новее
        // "2026-08-22" и падает на старте с ERR_RUNTIME_FAILURE.
        // Продовый wrangler.toml НЕ трогаем — откат даты здесь.
        // Снять, когда пул подтянет свежий бинарь workerd.
        compatibilityDate: "2026-08-22",
        bindings: {
          // Тот же токен зашит во внешний вектор initData
          // (tests/fixtures/init-data.ts) — менять только вместе с ним.
          BOT_TOKEN: "7654321:TEST_ONLY_NOT_A_REAL_BOT_TOKEN",
          WEBHOOK_SECRET: "test-webhook-secret",
          // Алишер (автор внешнего вектора) и Дилноза — два пользователя,
          // на которых построены тесты приватности R3.
          ALLOWED_IDS: "111111111,222222222",
        },
      },
    }),
  ],
});
