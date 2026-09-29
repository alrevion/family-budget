// Типы, существующие только под vitest. Живут здесь, а не в tsconfig.json:
// каталог tests уже входит в include, а прод-конфигурацию тесты не трогают.
//
// Файл намеренно БЕЗ import/export на верхнем уровне: иначе он становится
// модулем, и `declare namespace Cloudflare` перестаёт сливаться с объявлением
// из @cloudflare/workers-types.

/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Псевдоним заведён отдельной строкой намеренно: инлайновый import(...)
// прямо в extends внутри ambient-namespace TypeScript 7.0.2 молча не
// раскрывает, и Cloudflare.Env остаётся пустым (проверено прогоном tsc).
type WorkerEnv = import("../src/types").Env;

declare namespace Cloudflare {
  // Пул объявляет `env: Cloudflare.Env`. Здесь этот интерфейс наполняется
  // биндингами воркера — теми же, что в src/types.ts, включая тестовые
  // значения секретов из vitest.config.ts.
  interface Env extends WorkerEnv {}
}

// Схема и rollback подтягиваются как текст (vite ?raw) и накатываются
// вручную в tests/helpers.ts: D1 exec() требует по оператору на строку и
// многострочные CREATE TABLE через него не проходят.
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
