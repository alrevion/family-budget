# Семейный бюджет — Telegram Mini App

Общий бюджет на двоих: доходы и расходы, цели накоплений, скрытые траты (сюрпризы), отчёты и сравнения периодов. Работает как Telegram-бот + Mini App.

**Стек:** Cloudflare Workers + D1 (SQLite) + [Hono](https://hono.dev) на бэкенде, TypeScript без фреймворков во фронтенде, Vitest в рантайме `workerd` для тестов.

---

## Содержание

1. [Как пользоваться](#как-пользоваться)
2. [Структура проекта](#структура-проекта)
3. [Локальный запуск](#локальный-запуск)
4. [Деплой с нуля](#деплой-с-нуля)
5. [Обновление уже задеплоенного](#обновление-уже-задеплоенного)
6. [Как дописать новый модуль](#как-дописать-новый-модуль)
7. [Тесты](#тесты)
8. [Возможные ошибки и решения](#возможные-ошибки-и-решения)

---

## Как пользоваться

1. Напишите боту `/start` — придёт кнопка **«Открыть приложение»**.
2. При первом запуске приложение попросит ввести **стартовый остаток** — сколько денег у семьи сейчас.
3. Вкладки внизу:
   - **Главная** — «Свободно», «В целях», сколько потрачено в этом месяце, кнопка **+** для новой записи.
   - **Лента** — все записи месяца; тап по записи — редактирование/удаление.
   - **Цели** — создать цель, отложить в неё деньги из «Свободно», вернуть обратно, архивировать.
   - **Отчёт** — расходы/доходы по категориям, фильтры, сравнение периодов и авторов.
4. **Скрытая трата** — при создании можно скрыть запись на 1 день / неделю / месяц / полгода. Второй человек видит только сумму под меткой «Скрытое», без категории и комментария, пока срок не выйдет. Удобно для подарков.
5. Бот сам пишет:
   - **1-го числа в 10:00 (Ташкент)** — отчёт за прошлый месяц;
   - **ежедневно в 10:00**, если 3 дня не было записей — напоминание с кнопками «добавить за день X» и «Ничего не тратили» (тишина на 7 дней).

Суммы вводятся только в приложении — текст с цифрами бот не принимает (сознательно, чтобы не гадать, что значит «340»).

Доступ есть **только** у Telegram ID из секрета `ALLOWED_IDS`. Все остальные получат 403.

---

## Структура проекта

```
├── src/                   # Бэкенд (Cloudflare Worker)
│   ├── index.ts           # Точка входа: /api/health, /tg/webhook, /api/*, cron
│   ├── auth.ts            # Проверка подписи Telegram initData + whitelist
│   ├── bot.ts             # Webhook бота (/start), отправка сообщений
│   ├── cron.ts            # Месячный отчёт и ежедневные напоминания
│   ├── time.ts, money.ts  # Даты в Asia/Tashkent, форматирование сумм
│   ├── types.ts           # Env (биндинги/секреты) и доменные типы
│   ├── api/               # HTTP-маршруты по доменам (валидация на входе)
│   │   ├── index.ts       # auth-middleware + подключение всех групп
│   │   ├── validate.ts    # Общие валидаторы (readBody, parseId, isName…)
│   │   └── goals.ts, transactions.ts, categories.ts, reports.ts, …
│   └── queries/           # Вся работа с D1 (SQL живёт только здесь)
│       ├── index.ts       # Реэкспорт — снаружи это один модуль "queries"
│       └── masking.ts     # Маскирование скрытых трат (ТОЛЬКО здесь)
├── app/                   # Фронтенд Mini App
│   ├── index.html, styles.css
│   └── src/
│       ├── main.ts        # Запуск, deep-link'и, переключение вкладок
│       ├── nav.ts         # Нижняя навигация
│       ├── api.ts         # Единственная точка сетевых запросов + тексты ошибок
│       ├── api-types.ts   # Типы ответов API
│       └── screens/       # Экраны (home, feed, goals, report, …)
├── dist/                  # Собранный фронтенд (генерируется, в git не хранится)
├── migrations/            # SQL-миграции D1 (0001_*.sql, 0002_*.sql, …) + drop.sql
├── tests/                 # Vitest-тесты (запускаются в workerd)
├── wrangler.toml          # Конфиг Worker'а, D1, cron, публичные переменные
└── .omc/plans/            # Исходный план/спека проекта (на неё ссылаются комментарии)
```

Как устроен запрос: Telegram открывает Mini App → статика отдаётся из `dist/` напрямую (без Worker'а) → фронт шлёт запросы на `/api/*` с заголовком `Authorization: tma <initData>` → `src/api/index.ts` проверяет подпись и whitelist → маршрут в `src/api/*` валидирует вход → `src/queries/*` ходит в D1.

---

## Локальный запуск

Требования: **Node.js 20+**, аккаунт Cloudflare (для деплоя).

```bash
npm install
```

Создайте файл `.dev.vars` в корне (в git не попадает) с секретами для локального запуска:

```ini
BOT_TOKEN=123456:ваш_тестовый_токен
WEBHOOK_SECRET=любая_случайная_строка
ALLOWED_IDS=111111111,222222222
```

Накатите миграции на локальную базу, соберите фронт и запустите:

```bash
npm run migrate
```

```bash
npm run build
```

```bash
npm run dev
```

Worker поднимется на `http://localhost:8787`. Проверка: `curl http://localhost:8787/api/health` → `{"ok":true}`.

> Открыть Mini App в обычном браузере полноценно не получится: без Telegram нет `initData`, и API вернёт 401 → экран «Сессия устарела». Интерфейс проверяется либо тестами, либо в Telegram после деплоя (или через туннель, например `cloudflared tunnel --url http://localhost:8787`, и временный URL в BotFather).

---

## Деплой с нуля

### 1. Бот в BotFather

1. `/newbot` → получите **токен** и **username** бота.
2. `/newapp` → выберите бота, укажите URL Worker'а (появится после шага 4, можно вернуться позже) → получите **short name** Mini App.
3. (Опционально) `/setmenubutton` → кнопка меню, открывающая тот же URL.

### 2. Логин в Cloudflare

```bash
npx wrangler login
```

### 3. База D1

```bash
npx wrangler d1 create family-budget-db
```

Скопируйте выданный `database_id` в `wrangler.toml` → `[[d1_databases]]`. Имя базы должно совпадать с `database_name` и со скриптом `migrate` в `package.json`.

Накатите миграции **на боевую** базу:

```bash
npx wrangler d1 migrations apply family-budget-db --remote
```

> `npm run migrate` работает только с **локальной** базой (`--local`). Для прода всегда `--remote`.

### 4. Переменные и секреты

Публичные переменные — в `wrangler.toml`, секция `[vars]`:

| Переменная | Что это |
|---|---|
| `BOT_USERNAME` | username бота без `@` |
| `MINI_APP_SHORT_NAME` | short name из `/newapp` (сейчас стоит заглушка `REPLACE_ME_…` — **замените**) |
| `MINI_APP_URL` | `https://family-budget.<ваш-сабдомен>.workers.dev` |

Секреты — только через wrangler, **никогда** не в код:

```bash
npx wrangler secret put BOT_TOKEN
```

```bash
npx wrangler secret put WEBHOOK_SECRET
```

```bash
npx wrangler secret put ALLOWED_IDS
```

- `WEBHOOK_SECRET` — случайная строка (`openssl rand -hex 32`), только `A-Z a-z 0-9 _ -`.
- `ALLOWED_IDS` — Telegram ID через запятую без пробелов: `111111111,222222222`. Свой ID можно узнать у `@userinfobot`.

Секреты применяются сразу, redeploy не нужен.

### 5. Сборка и деплой

```bash
npm run build && npm run deploy
```

> `npm run deploy` **не собирает** фронт. Без `npm run build` задеплоится старый (или пустой) `dist/`.

### 6. Webhook

Подставьте токен, адрес и тот же `WEBHOOK_SECRET`:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" -d "url=https://family-budget.<сабдомен>.workers.dev/tg/webhook" -d "secret_token=<WEBHOOK_SECRET>" -d 'allowed_updates=["message"]'
```

### 7. Проверка

```bash
curl https://family-budget.<сабдомен>.workers.dev/api/health
```

Должно вернуться `{"ok":true}` (а **не** HTML). Затем `/start` боту → кнопка → приложение открывается.

Cron-триггеры (`[triggers]` в `wrangler.toml`) регистрируются автоматически при деплое. Время в cron — **UTC**: `0 5 * * *` = 10:00 по Ташкенту.

---

## Обновление уже задеплоенного

```bash
npm test && npm run build && npm run deploy
```

Если в изменении есть новая миграция — **сначала** миграция, потом код:

```bash
npx wrangler d1 migrations apply family-budget-db --remote
```

Посмотреть логи боевого Worker'а в реальном времени:

```bash
npx wrangler tail
```

---

## Как дописать новый модуль

Пример: модуль **«Регулярные платежи»** (`subscriptions`). Порядок всегда один: база → запросы → API → фронт → тесты.

### 1. Миграция

Новый файл `migrations/0003_subscriptions.sql`. Имя **обязано** быть `NNNN_название.sql`, иначе wrangler его не увидит (`migrations_pattern` в `wrangler.toml`).

```sql
CREATE TABLE subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  amount      INTEGER NOT NULL CHECK (amount > 0),
  day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
  author_id   INTEGER NOT NULL REFERENCES users(telegram_id)
);
```

Правила:
- Прод уже с живыми данными → только **аддитивные** изменения (`CREATE TABLE`, `ADD COLUMN`). Никаких `DROP`/`RENAME` существующего.
- Уже применённые миграции **не редактировать** — только новая.
- Добавьте таблицу в `migrations/drop.sql` (`DROP TABLE IF EXISTS subscriptions;`) и имя файла в последнюю строку `DELETE FROM d1_migrations WHERE name IN (...)`.
- Добавьте миграцию в `tests/helpers.ts` → импорт `?raw` и массив `MIGRATIONS`.

### 2. Запросы — `src/queries/subscriptions.ts`

Весь SQL живёт только в `src/queries`. Колонки snake_case → поля camelCase здесь же. Параметры — только через `.bind()`, никакой склейки строк.

```ts
export interface Subscription { id: number; name: string; amount: number; dayOfMonth: number }

export async function listSubscriptions(db: D1Database): Promise<Subscription[]> {
  const { results } = await db
    .prepare("SELECT id, name, amount, day_of_month FROM subscriptions ORDER BY day_of_month")
    .all<{ id: number; name: string; amount: number; day_of_month: number }>();
  return results.map((r) => ({ id: r.id, name: r.name, amount: r.amount, dayOfMonth: r.day_of_month }));
}
```

И одна строка в `src/queries/index.ts`:

```ts
export * from "./subscriptions";
```

### 3. API — `src/api/subscriptions.ts`

По образцу `src/api/goals.ts`: функция `mount(api)`, валидация входа через хелперы из `validate.ts`, ошибки в формате `{ error: "<code>" }`.

```ts
import type { Hono } from "hono";
import * as q from "../queries";
import type { AppEnv } from "./validate";

export function mount(api: Hono<AppEnv>): void {
  api.get("/api/subscriptions", async (c) =>
    c.json({ subscriptions: await q.listSubscriptions(c.env.DB) }));
}
```

Подключение в `src/api/index.ts` — **после** `api.use(...)` (auth-middleware):

```ts
import { mount as mountSubscriptions } from "./subscriptions";
// ...
mountSubscriptions(api);
```

Все пути должны начинаться с `/api/` — только так они попадают в Worker (`run_worker_first` в `wrangler.toml`) и под проверку авторизации. Текущий пользователь: `c.get("user").telegramId`.

### 4. Фронтенд

1. Типы ответа — в `app/src/api-types.ts`.
2. Функция запроса — в `app/src/api.ts` (экраны не делают `fetch` сами):
   ```ts
   export const listSubscriptions = async () =>
     (await request<{ subscriptions: Subscription[] }>("GET", "/api/subscriptions")).subscriptions;
   ```
   Новые коды ошибок — в `ERROR_MESSAGES` там же, человеческим текстом.
3. Экран — `app/src/screens/subscriptions.ts` с функцией `renderSubscriptions(container)`. Образец — `screens/goals.ts`: скелетон → загрузка → `errorState` при ошибке → `emptyState` если пусто → список.
4. Если нужна вкладка: добавьте id в тип `Tab` и в `TABS` (`app/src/nav.ts`, иконка в `icons.ts`) и ветку в `renderScreen()` (`app/src/main.ts`).
5. Импорты во фронте — с расширением `.js` (`"./api.js"`), это требование ES-модулей в браузере.

### 5. Если модулю нужен cron

Добавьте расписание в `[triggers] crons` (`wrangler.toml`) и ветку по `controller.cron` в `runScheduled()` (`src/cron.ts`). Время — в UTC.

### 6. Если нужен новый секрет/переменная

Поле в `Env` (`src/types.ts`) → `[vars]` в `wrangler.toml` или `wrangler secret put` → тестовое значение в `vitest.config.ts` (`miniflare.bindings`) и `.dev.vars`.

### 7. Тесты — `tests/subscriptions.test.ts`

Образец — `tests/goals.test.ts`. `resetDb()` из `tests/helpers.ts` в `beforeEach` пересоздаёт схему; запросы к API — через `apiFetch` / `apiJson` оттуда же, с подписанным тестовым `initData`.

---

## Тесты

```bash
npm test
```

Все тесты гоняются в настоящем рантайме Cloudflare (`workerd`) через `@cloudflare/vitest-pool-workers`, с локальной D1. Секреты для тестов подставлены в `vitest.config.ts` — это фейковые значения.

Тестовый `initData` в `tests/fixtures/init-data.ts` подписан сторонней библиотекой; руками не править. Пересоздать:

```bash
node tests/fixtures/generate-init-data.mjs
```

---

## Возможные ошибки и решения

### Приложение и API

| Симптом | Причина | Решение |
|---|---|---|
| Экран **«Сессия устарела»** сразу при открытии | Mini App открыт не из Telegram, либо `BOT_TOKEN` в секретах не совпадает с ботом | Открывайте через кнопку бота. Проверьте `npx wrangler secret list` и перезапишите `BOT_TOKEN` |
| «Сессия устарела» после долгого простоя | `initData` старше 24 часов (так задумано) | Закрыть и заново открыть приложение |
| **403 / «Недостаточно прав»** | Вашего Telegram ID нет в `ALLOWED_IDS` | `npx wrangler secret put ALLOWED_IDS` — ID через запятую, без пробелов и лишних символов |
| `/api/health` возвращает **HTML** вместо `{"ok":true}` | Путь не попал в `run_worker_first` или изменён `[assets]` | Проверьте `run_worker_first = ["/api/*", "/tg/webhook"]`. **Не** включайте `not_found_handling = "single-page-application"` |
| Приложение открывается пустым / старая версия | Задеплоили без сборки | `npm run build && npm run deploy`, в Telegram — закрыть Mini App полностью и открыть снова (кэш) |
| `500` на любом запросе, в `wrangler tail` — `no such table` | Миграции не накатаны на прод | `npx wrangler d1 migrations apply family-budget-db --remote` |
| «Свободных денег недостаточно» при откладывании в цель | Сумма больше, чем «Свободно» (409, так задумано) | Отложить меньше или сначала внести доход |

### Бот

| Симптом | Причина | Решение |
|---|---|---|
| Бот молчит на `/start` | Webhook не установлен / неверный URL | `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"` — смотрите `url` и `last_error_message` |
| Бот молчит, в `wrangler tail` — `webhook secret mismatch` | `secret_token` в `setWebhook` ≠ секрету `WEBHOOK_SECRET` | Заново `setWebhook` с тем же значением, что в секрете |
| `getWebhookInfo` показывает `pending_update_count` растёт | Worker падает или недоступен | `npx wrangler tail`, проверьте `/api/health` |
| Кнопка «Открыть приложение» ведёт в никуда | Неверный `MINI_APP_URL` / `MINI_APP_SHORT_NAME` / `BOT_USERNAME` в `[vars]` | Исправить в `wrangler.toml` и передеплоить |
| Нет месячного отчёта / напоминаний | Cron не зарегистрирован или ID получателей неверны | Dashboard Cloudflare → Worker → Triggers. Получатели = `ALLOWED_IDS`; каждый должен хотя бы раз написать боту `/start`, иначе Telegram вернёт `403 bot can't initiate conversation` |
| Напоминание приходит не в то время | Cron в UTC | Ташкент = UTC+5: 10:00 → `0 5 * * *` |

### Деплой и миграции

| Симптом | Причина | Решение |
|---|---|---|
| `Authentication error` / `not logged in` у wrangler | Нет логина | `npx wrangler login` |
| `database ... not found` | `database_id` в `wrangler.toml` от чужого аккаунта | `npx wrangler d1 list`, вписать свой ID |
| Новая миграция «не видна» wrangler'у | Имя не по шаблону `NNNN_*.sql` | Переименовать, напр. `0003_subscriptions.sql` |
| После `drop.sql` миграции «уже применены» и ничего не делают | Имя миграции не добавлено в `DELETE FROM d1_migrations` в `drop.sql` | Добавить имя в список и выполнить `drop.sql` снова |
| Миграция упала на полпути на проде | Ошибка в SQL | Исправить **тот же** файл нельзя, если он частично применился на живых данных — напишите новую миграцию-исправление. `drop.sql` на проде **стирает все данные** — только для пустой базы |
| `Error: Script startup exceeded CPU` / ошибки типов при деплое | Ошибка TypeScript в `src/` | `npx tsc --noEmit` — покажет место |

### Тесты и локальная разработка

| Симптом | Причина | Решение |
|---|---|---|
| Тесты падают на старте с `ERR_RUNTIME_FAILURE` / `compatibility date` | `workerd` в пуле тестов старее, чем `compatibility_date` | В `vitest.config.ts` `miniflare.compatibilityDate` держать не новее поддерживаемой даты; или обновить `@cloudflare/vitest-pool-workers` |
| Тест видит данные прошлого теста | Хранилище между тестами не откатывается | `beforeEach(resetDb)` в каждом файле |
| Тест зелёный, а на проде `no such column` | Новая миграция не добавлена в `MIGRATIONS` в `tests/helpers.ts` | Добавить импорт `?raw` и элемент массива |
| Тесты auth падают после смены токена в конфиге | `initData` в фикстурах подписан старым токеном | Токен в `vitest.config.ts` и `tests/fixtures` менять вместе, затем `node tests/fixtures/generate-init-data.mjs` |
| `npm run dev`: `BOT_TOKEN is undefined` | Нет `.dev.vars` | Создать по образцу из «Локального запуска» |
| Порт 8787 занят | Предыдущий `wrangler dev` не закрыт | `npx wrangler dev --port 8788` или завершить старый процесс |

---

## Безопасность

- Секреты (`BOT_TOKEN`, `WEBHOOK_SECRET`, `ALLOWED_IDS`) — только в `wrangler secret` и локальном `.dev.vars`. `.dev.vars` в `.gitignore`.
- Если токен бота утёк: BotFather → `/revoke` → `wrangler secret put BOT_TOKEN` → заново `setWebhook`.
- Логику скрытия трат менять только в `src/queries/masking.ts` — это единственное место, где данные маскируются для второго человека.
