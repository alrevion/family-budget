#!/usr/bin/env node
// Установка «под ключ»: база D1, миграции, секреты, деплой и webhook.
//
//   npm run setup                 # интерактивно
//   npm run setup -- --dry-run    # показать шаги, ничего не меняя
//
// Скрипт идемпотентен: повторный запуск обновляет секреты, переменные и
// webhook, но не создаёт вторую базу и не затирает данные.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const DRY = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";
const YES = process.argv.includes("--yes") || process.env.YES === "1";
const DB_NAME = "family-budget-db";
const WORKER_NAME = "family-budget";
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const TOML = "wrangler.toml";

const say = (msg = "") => console.log(msg);
const step = (msg) => say(`\n▶ ${msg}`);
const ok = (msg) => say(`  ✓ ${msg}`);
const dry = (msg) => say(`  · [dry-run] ${msg}`);

function fail(message) {
  say(`\n✗ ${message}`);
  process.exit(1);
}

function run(cmd, args, { input, inherit = false } = {}) {
  const res = spawnSync(cmd, args, {
    stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"],
    input,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const details = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
    const error = new Error(`${cmd} ${args.join(" ")} завершился с кодом ${res.status}`);
    error.details = details;
    throw error;
  }
  return `${res.stdout ?? ""}${res.stderr ?? ""}`;
}

function runWrangler(args, options) {
  return run(NPX, ["wrangler", ...args], options);
}

async function ask(question, { fallback = "", validate } = {}) {
  if (!stdin.isTTY || YES) {
    if (fallback !== "") return fallback;
    return "";
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const answer = (await rl.question(question)).trim();
      const value = answer === "" ? fallback : answer;
      if (value === "" || validate === undefined || validate(value)) return value;
      say("  Похоже, значение неверное — попробуйте ещё раз.");
    }
  } finally {
    rl.close();
  }
}

const isBotToken = (value) => /^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(value);
const isIdList = (value) => /^\d+(\s*,\s*\d+)*$/.test(value);

function setTomlValues(text, values) {
  let out = text;
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^${key}\\s*=\\s*"[^"]*"`, "m");
    if (!re.test(out)) throw new Error(`в ${TOML} не найдена строка ${key} = "…"`);
    out = out.replace(re, `${key} = "${value}"`);
  }
  return out;
}

async function readToml() {
  return readFile(TOML, "utf8");
}

async function saveToml(before, after) {
  if (before === after) return false;
  if (DRY) {
    dry(`${TOML} обновился бы (${after.length - before.length >= 0 ? "+" : ""}${after.length - before.length} байт)`);
    return true;
  }
  await writeFile(TOML, after, "utf8");
  ok(`${TOML} обновлён`);
  return true;
}

async function telegram(token, method, params) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params ?? {}),
  });
  const body = await res.json().catch(() => null);
  if (!body || body.ok !== true) {
    throw new Error(`${method}: ${body?.description ?? `HTTP ${res.status}`}`);
  }
  return body.result;
}

function parseDeployUrl(output, workerName) {
  const re = new RegExp(`https://${workerName}\\.[a-z0-9-]+\\.workers\\.dev`, "i");
  return re.exec(output)?.[0] ?? null;
}

async function main() {
  say("Семейный бюджет — установка\n==========================");
  if (DRY) say("Режим dry-run: ничего не создаётся и не деплоится.\n");

  // --- 0. Node и зависимости -------------------------------------------
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) fail(`Нужен Node.js 20 или новее (сейчас ${process.versions.node}).`);

  if (!existsSync("node_modules/wrangler")) {
    if (DRY) {
      dry("npm install");
    } else {
      step("Ставлю зависимости (npm install)");
      run(NPM, ["install"], { inherit: true });
    }
  }

  // --- 1. Секреты из окружения или вопросы -----------------------------
  let token = process.env.BOT_TOKEN?.trim() ?? "";
  if (token === "") {
    say("\nТокен бота: BotFather → /newbot → строка вида 123456789:AA…");
    token = await ask("BOT_TOKEN: ", { validate: isBotToken });
  }
  if (!isBotToken(token) && !DRY) fail("Токен не похож на токен Telegram-бота.");

  let allowedIds = process.env.ALLOWED_IDS?.trim() ?? "";
  if (allowedIds === "") {
    say("\nКому можно пользоваться приложением? Telegram ID через запятую.");
    say("Свой ID можно узнать у @userinfobot.");
    allowedIds = await ask("ALLOWED_IDS: ", { validate: isIdList });
  }
  if (!isIdList(allowedIds) && !DRY) fail("ALLOWED_IDS — числа через запятую, без пробелов внутри числа.");

  let shortName = process.env.MINI_APP_SHORT_NAME?.trim() ?? "";
  if (shortName === "" && !YES && !DRY && stdin.isTTY) {
    say("\nShort name Mini App из BotFather (/newapp) — можно пропустить и нажать Enter.");
    shortName = await ask("MINI_APP_SHORT_NAME (необязательно): ");
  }

  const ids = allowedIds.replace(/\s+/g, "");
  shortName = shortName.toLowerCase().replace(/[^a-z0-9_]/g, "");
  const webhookSecret = (process.env.WEBHOOK_SECRET?.trim() || randomBytes(32).toString("hex"))
    .replace(/[^A-Za-z0-9_-]/g, "");

  // --- 2. Telegram: кто наш бот ----------------------------------------
  let botUsername = process.env.BOT_USERNAME?.trim() ?? "";
  if (!botUsername) {
    if (DRY) {
      botUsername = "dry_run_bot";
      dry("getMe → username бота");
    } else {
      step("Проверяю токен бота (getMe)");
      const me = await telegram(token, "getMe");
      botUsername = String(me.username ?? "");
      if (!botUsername) fail("Telegram не вернул username бота.");
      ok(`бот @${botUsername}`);
    }
  }

  // --- 3. Cloudflare: логин и база -------------------------------------
  let accountId = "";
  if (DRY) {
    dry("wrangler whoami / login");
  } else {
    step("Проверяю вход в Cloudflare");
    let info = null;
    try {
      info = JSON.parse(runWrangler(["whoami", "--json"]));
    } catch {
      info = null;
    }
    if (!info || info.loggedIn !== true) {
      say("  Нужно войти в Cloudflare — откроется браузер.");
      runWrangler(["login"], { inherit: true });
      info = JSON.parse(runWrangler(["whoami", "--json"]));
      if (info?.loggedIn !== true) fail("Вход в Cloudflare не выполнен.");
    }
    accountId = String(info.accounts?.[0]?.id ?? "");
    ok(`аккаунт ${info.email ?? accountId}`);
  }

  let databaseId = "";
  if (DRY) {
    dry(`wrangler d1 list → ищу «${DB_NAME}», иначе d1 create`);
  } else {
    step(`База D1 «${DB_NAME}»`);
    let databases = [];
    try {
      databases = JSON.parse(runWrangler(["d1", "list", "--json"]));
    } catch {
      databases = [];
    }
    const existing = databases.find((db) => db.name === DB_NAME);
    if (existing) {
      databaseId = existing.uuid;
      ok(`уже есть (${databaseId})`);
    } else {
      const output = runWrangler(["d1", "create", DB_NAME]);
      const fromOutput = /database_id\s*=\s*"([0-9a-f-]{36})"/i.exec(output)?.[1];
      if (fromOutput) {
        databaseId = fromOutput;
      } else {
        const again = JSON.parse(runWrangler(["d1", "list", "--json"]));
        databaseId = again.find((db) => db.name === DB_NAME)?.uuid ?? "";
      }
      if (!databaseId) fail("Не удалось определить database_id созданной базы.");
      ok(`создана (${databaseId})`);
    }
  }

  // --- 4. wrangler.toml -------------------------------------------------
  step(`Настройки в ${TOML}`);
  const before = await readToml();
  const workerName = /^name\s*=\s*"([^"]+)"/m.exec(before)?.[1] ?? WORKER_NAME;
  const databasePlaceholder = "00000000-0000-0000-0000-000000000000";
  let after = setTomlValues(before, {
    database_id: databaseId || databasePlaceholder,
    BOT_USERNAME: botUsername,
    MINI_APP_SHORT_NAME: shortName || "REPLACE_ME_app_short_name",
  });
  await saveToml(before, after);

  // --- 5. Миграции ------------------------------------------------------
  step("Миграции боевой базы");
  if (DRY) {
    dry(`wrangler d1 migrations apply ${DB_NAME} --remote`);
  } else {
    runWrangler(["d1", "migrations", "apply", DB_NAME, "--remote"], { inherit: true });
    ok("схема применена");
  }

  // --- 6. Сборка и первый деплой ---------------------------------------
  step("Сборка фронтенда");
  if (DRY) dry("npm run build");
  else run(NPM, ["run", "build"], { inherit: true });

  step("Деплой Worker'а");
  let baseUrl = normalizeUrl(process.env.MINI_APP_URL ?? "");
  if (DRY) {
    baseUrl = baseUrl || "https://family-budget.example.workers.dev";
    dry("wrangler deploy → публичный URL");
  } else {
    const output = runWrangler(["deploy"]);
    ok(output.trim().split("\n").slice(-6).join("\n  "));
    baseUrl = parseDeployUrl(output, workerName) ?? baseUrl;
    if (!baseUrl) fail("Не удалось найти URL Worker'а в выводе wrangler deploy.");
    ok(baseUrl);
  }

  // --- 7. MINI_APP_URL и повторный деплой ------------------------------
  const withUrl = setTomlValues(after, { MINI_APP_URL: baseUrl });
  if (await saveToml(after, withUrl)) {
    step("Применяю MINI_APP_URL");
    after = withUrl;
    if (DRY) dry("wrangler deploy (повторно)");
    else {
      runWrangler(["deploy"], { inherit: true });
      ok("передеплоено");
    }
  }

  // --- 8. Секреты -------------------------------------------------------
  step("Секреты Worker'а");
  const secrets = {
    BOT_TOKEN: token,
    WEBHOOK_SECRET: webhookSecret,
    ALLOWED_IDS: ids,
  };
  for (const [name, value] of Object.entries(secrets)) {
    if (DRY) {
      dry(`wrangler secret put ${name}`);
      continue;
    }
    runWrangler(["secret", "put", name], { input: `${value}\n` });
    ok(name);
  }

  // --- 9. Webhook и кнопка меню ----------------------------------------
  step("Webhook и кнопка меню в Telegram");
  if (DRY) {
    dry(`setWebhook → ${baseUrl}/tg/webhook`);
    dry(`setChatMenuButton → ${baseUrl}`);
  } else {
    await telegram(token, "setWebhook", {
      url: `${baseUrl}/tg/webhook`,
      secret_token: webhookSecret,
      allowed_updates: ["message"],
    });
    ok("webhook установлен");
    try {
      await telegram(token, "setChatMenuButton", {
        menu_button: { type: "web_app", text: "Бюджет", web_app: { url: baseUrl } },
      });
      ok("кнопка меню ведёт в приложение");
    } catch (e) {
      say(`  ! кнопку меню поставить не удалось: ${e.message}`);
    }
  }

  // --- 10. Итог ---------------------------------------------------------
  say("\nГотово.");
  if (DRY) {
    say("Это был dry-run: изменений нет. Запустите `npm run setup` без флага.");
    return;
  }
  say(`\nПриложение: ${baseUrl}`);
  say(`Бот:        @${botUsername}`);
  say(`Доступ:     ${ids}`);
  if (!shortName) {
    say("\nОпционально: BotFather → /newapp → выберите бота, укажите URL выше.");
    say("Затем пропишите MINI_APP_SHORT_NAME в wrangler.toml и выполните npm run deploy.");
  }
  say("\nОткройте бота в Telegram и напишите /start.");
  if (accountId) say(`\nЛоги: npx wrangler tail`);
}

function normalizeUrl(value) {
  const trimmed = value.trim().replace(/\/+$/, "");
  return /^https:\/\//.test(trimmed) && !trimmed.includes("example") ? trimmed : "";
}

main().catch((error) => {
  fail(`${error.message}${error.details ? `\n\n${error.details}` : ""}`);
});
