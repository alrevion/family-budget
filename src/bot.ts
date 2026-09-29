// Telegram-бот: только /start и подсказка открыть Mini App. Никакого
// свободного текстового ввода трат/сумм — заказчик отверг его, потому что
// "340" в сумах неоднозначно (см. план, шаг 14 и раздел "Deploy unit").
//
// Webhook ВСЕГДА отвечает 200: Telegram повторяет доставку на не-2xx,
// а повтор здесь не нужен — обработка update'а не пишет в D1, повторная
// доставка максимум пришлёт то же сообщение дважды при сетевом сбое
// отправки, что не создаёт дубль записи (в отличие от API-слоя).

import type { Env } from "./types";

interface TelegramChat {
  id: number;
}

interface TelegramMessage {
  chat: TelegramChat;
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramInlineButton {
  text: string;
  web_app?: { url: string };
  url?: string;
}

export interface TelegramReplyMarkup {
  inline_keyboard: TelegramInlineButton[][];
}

/**
 * Тонкий хелпер отправки сообщений — им же пользуется cron.ts. Ошибки
 * не глотает: бросает исключение, чтобы вызывающий код мог залогировать
 * и (в cron) не отменять рассылку второму получателю.
 */
export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  replyMarkup?: TelegramReplyMarkup,
): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`sendMessage(${chatId}) failed: ${res.status} ${body}`);
  }
}

function openAppKeyboard(env: Env, month?: string): TelegramReplyMarkup {
  const url = month ? `${env.MINI_APP_URL}?month=${month}` : env.MINI_APP_URL;
  return { inline_keyboard: [[{ text: "Открыть приложение", web_app: { url } }]] };
}

function openAppFallbackKeyboard(env: Env, month?: string): TelegramReplyMarkup {
  // Фолбэк по плану (шаг 15): если web_app-кнопка недоступна — обычная
  // ссылка на прямой запуск Mini App. startapp допускает только
  // [A-Za-z0-9_-], "YYYY-MM" укладывается.
  const startapp = month ?? "home";
  const url = `https://t.me/${env.BOT_USERNAME}/${env.MINI_APP_SHORT_NAME}?startapp=${startapp}`;
  return { inline_keyboard: [[{ text: "Открыть приложение", url }]] };
}

/**
 * Отправляет сообщение с кнопкой открытия Mini App. При сбое отправки с
 * web_app-кнопкой (не везде поддерживается) один раз повторяет с
 * обычной t.me-ссылкой.
 */
export async function sendWithAppButton(
  env: Env,
  chatId: number,
  text: string,
  month?: string,
): Promise<void> {
  try {
    await sendMessage(env, chatId, text, openAppKeyboard(env, month));
  } catch (err) {
    console.error(`bot: web_app button failed for ${chatId}, falling back to t.me link`, err);
    await sendMessage(env, chatId, text, openAppFallbackKeyboard(env, month));
  }
}

async function processUpdate(env: Env, update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message || typeof message.text !== "string") return;

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === "/start" || text.startsWith("/start ") || text.startsWith("/start@")) {
    await sendWithAppButton(env, chatId, "Привет! Открой приложение, чтобы вносить доходы и расходы.");
    return;
  }

  // Онбординг (ввод стартового остатка) и любой ввод сумм живут в Mini App,
  // не в боте. Любой другой текст — подсказка открыть приложение.
  await sendWithAppButton(
    env,
    chatId,
    "Я не понимаю текст с суммами — вносить доходы и траты нужно через приложение.",
  );
}

/**
 * POST /tg/webhook. Проверяет секретный заголовок, обрабатывает update,
 * но ВСЕГДА отвечает 200 — включая случай неверного секрета и любую
 * ошибку обработки, чтобы Telegram не повторял доставку.
 */
export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== env.WEBHOOK_SECRET) {
    console.error("bot: webhook secret mismatch");
    return new Response("ok", { status: 200 });
  }

  try {
    const update = await request.json<TelegramUpdate>();
    await processUpdate(env, update);
  } catch (err) {
    console.error("bot: failed to process update", err);
  }

  return new Response("ok", { status: 200 });
}
