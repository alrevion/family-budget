// AC-P15 — ежедневный cron поверх настоящей D1 и настоящего runScheduled().
//
// tests/cron.test.ts проверяет чистую shouldSendReminder(); здесь проверяется
// вся цепочка: lastEntryDate() по MAX(created_at) → cooldown из app_state →
// диспетчеризация по controller.cron → фактическая отправка.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NAG_TEXT,
  NO_SPEND_BUTTON,
  catchUpDays,
  runScheduled,
  shouldSendReminder,
} from "../src/cron";
import { getAppState, lastEntryDate, setAppState } from "../src/queries";
import { formatMoney } from "../src/money";
import { prevMonth, todayInTashkent } from "../src/time";
import { ALISHER_ID, ALISHER_INIT_DATA, AUTH_DATE_2026_08_24 } from "./fixtures/init-data";
import { CATEGORY, apiJson, freezeTime, insertTx, resetDb, unfreezeTime } from "./helpers";

const DAILY_CRON = "0 5 * * *";
const MONTHLY_CRON = "0 5 1 * *";

interface SentButton {
  text: string;
  url: string;
}

interface SentMessage {
  chatId: number;
  text: string;
  /** inline_keyboard, разложенная в плоский список: одна кнопка — одна строка. */
  buttons: SentButton[];
}

interface RawButton {
  text: string;
  web_app?: { url: string };
  url?: string;
}

function flattenKeyboard(markup: { inline_keyboard?: RawButton[][] } | undefined): SentButton[] {
  return (markup?.inline_keyboard ?? []).flat().map((b) => ({
    text: b.text,
    // Кнопка обязана быть web_app: обычный url и callback_data здесь ошибка,
    // и пустая строка ниже провалит проверку домена/параметра.
    url: b.web_app?.url ?? "",
  }));
}

/** Перехватывает исходящие sendMessage: src/bot.ts зовёт глобальный fetch. */
function captureTelegram(): SentMessage[] {
  const sent: SentMessage[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (!url.includes("api.telegram.org")) throw new Error(`unexpected outbound fetch: ${url}`);
    const payload = JSON.parse(String(init?.body ?? "{}"));
    sent.push({
      chatId: payload.chat_id,
      text: payload.text,
      buttons: flattenKeyboard(payload.reply_markup),
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return sent;
}

function daily(): ScheduledController {
  return { cron: DAILY_CRON, scheduledTime: Date.now(), noRetry: () => {} } as ScheduledController;
}

beforeEach(async () => {
  freezeTime(AUTH_DATE_2026_08_24); // Ташкент: 2026-08-24
  await resetDb();
});

afterEach(() => {
  vi.unstubAllGlobals();
  unfreezeTime();
});

describe("AC-P15: ежедневный cron молчит, когда должен", () => {
  it("молчит, если запись внесена сегодня задним числом за прошлую неделю", async () => {
    // MAX(occurred_on) неделю назад, MAX(created_at) сегодня. Метрика — по
    // created_at: пользователь приложением воспользовался.
    await insertTx({
      amount: 100_000,
      kind: "expense",
      category: CATEGORY.groceries,
      authorId: ALISHER_ID,
      occurredOn: "2026-08-17",
      createdAt: "2026-08-24T09:00:00.000Z",
    });

    const sent = captureTelegram();
    await runScheduled(daily(), env);
    expect(sent).toEqual([]);
    // Именно created_at, а не occurred_on: по occurred_on напоминание пришло бы.
    // Значение приходит сдвинутым в Ташкент: 09:00Z → 14:00 того же дня.
    expect(await lastEntryDate(env.DB)).toBe("2026-08-24 14:00:00");
    expect(shouldSendReminder("2026-08-24", "2026-08-17", null)).toBe(true);
  });

  it("молчит, если last_nag_on моложе 3 дней", async () => {
    await insertTx({
      amount: 100_000,
      kind: "expense",
      category: CATEGORY.groceries,
      authorId: ALISHER_ID,
      occurredOn: "2026-08-01",
      createdAt: "2026-08-01T09:00:00.000Z",
    });
    await setAppState(env.DB, "last_nag_on", "2026-08-23");

    const sent = captureTelegram();
    await runScheduled(daily(), env);
    expect(sent).toEqual([]);
    // Cooldown не переписан — иначе отъезд на две недели дал бы 11 напоминаний.
    expect(await getAppState(env.DB, "last_nag_on")).toBe("2026-08-23");
  });

  it("молчит 1-го числа: в этот день уходит месячный отчёт", async () => {
    const first = { cron: DAILY_CRON, scheduledTime: Date.now(), noRetry: () => {} };
    freezeTime(Date.parse("2026-09-01T06:00:00Z") / 1000, 0);
    const sent = captureTelegram();
    await runScheduled(first as ScheduledController, env);
    expect(sent).toEqual([]);
  });

  it("шлёт обоим и ставит cooldown, когда записей нет дольше трёх дней", async () => {
    await insertTx({
      amount: 100_000,
      kind: "expense",
      category: CATEGORY.groceries,
      authorId: ALISHER_ID,
      occurredOn: "2026-08-10",
      createdAt: "2026-08-10T09:00:00.000Z",
    });
    await setAppState(env.DB, "last_nag_on", "2026-08-10");

    const sent = captureTelegram();
    await runScheduled(daily(), env);
    expect(sent.map((m) => m.chatId)).toEqual([111111111, 222222222]);
    expect(sent[0]?.text).toBe(NAG_TEXT);
    expect(await getAppState(env.DB, "last_nag_on")).toBe("2026-08-24");
  });

  it("падение доставки одному не отменяет отправку второму", async () => {
    await setAppState(env.DB, "last_nag_on", "2026-08-01");
    const seen: number[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? "{}"));
      seen.push(payload.chat_id);
      if (payload.chat_id === 111111111) return new Response("blocked", { status: 403 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await runScheduled(daily(), env);
    expect(seen).toContain(222222222);
    expect(await getAppState(env.DB, "last_nag_on")).toBe("2026-08-24");
  });

  it("не реагирует на чужой cron-выражение", async () => {
    const sent = captureTelegram();
    await runScheduled(
      { cron: "*/5 * * * *", scheduledTime: Date.now(), noRetry: () => {} } as ScheduledController,
      env,
    );
    expect(sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Формулировка и кнопки догона
// ---------------------------------------------------------------------------
// Напоминание переписано с «укажи на пропуск» на «помоги вернуться»:
// Epstein et al. (CHI 2016) относят «nagging notifications pointing out a lack
// of tracking» к антипаттернам — упрёк ускоряет полный отказ от учёта.
// Тесты ниже держат обе половины: текст без счётчика пропусков и кнопки,
// которые ведут прямо в форму нужного дня.

/** Ставит состояние, при котором ежедневный крон гарантированно шлёт напоминание. */
async function staleState(): Promise<void> {
  await insertTx({
    amount: 100_000,
    kind: "expense",
    category: CATEGORY.groceries,
    authorId: ALISHER_ID,
    occurredOn: "2026-08-10",
    createdAt: "2026-08-10T09:00:00.000Z",
  });
}

describe("напоминание: формулировка", () => {
  it("не упрекает и не считает пропущенные дни", async () => {
    await staleState();
    const sent = captureTelegram();
    await runScheduled(daily(), env);

    const text = sent[0]?.text ?? "";
    expect(text).toBe("Пока нет записей за последние дни. Если траты были — добавьте задним числом.");
    // Пин против возврата старой формулировки при следующей правке.
    expect(text).not.toMatch(/не вносил|не вносили|пропущ|\d+\s*дн/i);
    // Сообщение уходит обоим — оба получают один и тот же безличный текст.
    expect(sent.map((m) => m.text)).toEqual([text, text]);
  });
});

describe("напоминание: кнопки догона", () => {
  it("предлагает три последних дня, свежий первым, плюс «Ничего не тратили»", async () => {
    await staleState();
    const sent = captureTelegram();
    await runScheduled(daily(), env);

    expect(sent[0]?.buttons.map((b) => b.text)).toEqual([
      "Воскресенье, 23 авг",
      "Суббота, 22 авг",
      "Пятница, 21 авг",
      NO_SPEND_BUTTON,
    ]);
  });

  it("кнопок-дней ровно три, не больше", async () => {
    await staleState();
    const sent = captureTelegram();
    await runScheduled(daily(), env);

    const dayButtons = sent[0]?.buttons.filter((b) => b.url.includes("?add=")) ?? [];
    expect(dayButtons).toHaveLength(3);
    expect(catchUpDays("2026-08-24")).toHaveLength(3);
  });

  it("все кнопки — web_app на Mini App, без callback_data (вебхук не настроен)", async () => {
    await staleState();
    const sent = captureTelegram();
    await runScheduled(daily(), env);

    for (const b of sent[0]?.buttons ?? []) {
      // Пустая строка означала бы кнопку не-web_app типа — см. flattenKeyboard.
      expect(b.url).toMatch(/^https:\/\/[^?]+\?(add=\d{4}-\d{2}-\d{2}|nospend=1)$/);
    }
  });

  it("в ?add= не проходят ни сегодня, ни будущее, ни даты старше окна догона", async () => {
    await staleState();
    const sent = captureTelegram();
    await runScheduled(daily(), env);

    const dates = (sent[0]?.buttons ?? [])
      .map((b) => new URL(b.url).searchParams.get("add"))
      .filter((d): d is string => d !== null);
    expect(dates).toEqual(["2026-08-23", "2026-08-22", "2026-08-21"]);
    for (const d of dates) {
      expect(d < "2026-08-24").toBe(true); // ни сегодня, ни завтра
      expect(d >= "2026-08-21").toBe(true); // не старше трёх дней, и тем более не старше 90
    }
  });
});

describe("«Ничего не тратили» продлевает тишину", () => {
  it("POST /api/state/quiet сдвигает cooldown за пределы обычных трёх дней", async () => {
    const { status, body } = await apiJson<{ ok: boolean; until: string }>(
      ALISHER_INIT_DATA,
      "/api/state/quiet",
      { method: "POST" },
    );
    expect(status).toBe(200);
    // Тишина считается на неделю: cooldown в 3 дня отмеряется от этой отметки.
    expect(body.until).toBe("2026-08-28");
    expect(await getAppState(env.DB, "last_nag_on")).toBe("2026-08-28");
  });

  it("после нажатия крон молчит и сегодня, и через три дня", async () => {
    await staleState();
    await apiJson(ALISHER_INIT_DATA, "/api/state/quiet", { method: "POST" });

    const sent = captureTelegram();
    await runScheduled(daily(), env);
    expect(sent).toEqual([]);

    // Обычное напоминание вернулось бы 27-го; с продлённой тишиной — нет.
    expect(shouldSendReminder("2026-08-27", null, "2026-08-28")).toBe(false);
    expect(shouldSendReminder("2026-09-01", null, "2026-08-28")).toBe(true);
  });
});

describe("месячный cron", () => {
  it("шлёт обоим отчёт за ПРОШЛЫЙ месяц с ключевыми числами в тексте", async () => {
    await insertTx({
      amount: 1_300_000,
      kind: "expense",
      category: CATEGORY.groceries,
      authorId: ALISHER_ID,
      occurredOn: "2026-08-05",
    });
    freezeTime(Date.parse("2026-09-01T06:00:00Z") / 1000, 0);

    const sent = captureTelegram();
    await runScheduled(
      { cron: MONTHLY_CRON, scheduledTime: Date.now(), noRetry: () => {} } as ScheduledController,
      env,
    );
    expect(sent).toHaveLength(2);
    expect(sent[0]?.text).toContain("Август");
    // formatMoney разделяет разряды неразрывным пробелом Intl(ru-RU) —
    // сравнение с обычным пробелом дало бы ложный провал.
    expect(sent[0]?.text).toContain(formatMoney(1_300_000));
  });

  it("AC-P14: январский запуск отчитывается за ДЕКАБРЬ предыдущего года", async () => {
    // Граница года — единственное место, где «прошлый месяц» ошибиться может
    // молча: отчёт придёт, просто не за тот месяц.
    await insertTx({
      amount: 777_000,
      kind: "expense",
      category: CATEGORY.groceries,
      authorId: ALISHER_ID,
      occurredOn: "2026-12-15",
    });
    freezeTime(Date.parse("2027-01-01T05:00:00Z") / 1000, 0);
    expect(todayInTashkent()).toBe("2027-01-01");
    expect(prevMonth("2027-01")).toBe("2026-12");

    const sent = captureTelegram();
    await runScheduled(
      { cron: MONTHLY_CRON, scheduledTime: Date.now(), noRetry: () => {} } as ScheduledController,
      env,
    );
    expect(sent).toHaveLength(2);
    expect(sent[0]?.text).toContain("Декабрь");
    expect(sent[0]?.text).toContain(formatMoney(777_000));
  });
});

// ---------------------------------------------------------------------------
// Регрессия: created_at в UTC против порога по Ташкенту
// ---------------------------------------------------------------------------
// created_at пишется полным ISO в UTC (src/api.ts: new Date().toISOString()),
// а порог считается от даты по Ташкенту (UTC+5). Без сдвига граница суток
// разъезжалась на 5 часов: запись, сделанная между 00:00 и 05:00 по Ташкенту,
// получала created_at с ВЧЕРАШНЕЙ датой UTC, выглядела на день старше и
// вызывала напоминание на сутки раньше срока. Закрыто сдвигом '+5 hours'
// в lastEntryDate() — тесты ниже держат границу с обеих сторон.
describe("ночная запись: created_at сдвигается в Ташкент до сравнения", () => {
  it("трата в 02:00 по Ташкенту ровно три дня назад НЕ даёт напоминания", async () => {
    // Внесена 21 августа в 02:00 по Ташкенту → created_at 2026-08-20T21:00Z.
    // Cron 24 августа, порог 2026-08-21: ровно три дня, правило «старше трёх»
    // её не покрывает.
    await insertTx({
      amount: 100_000,
      kind: "expense",
      category: CATEGORY.groceries,
      authorId: ALISHER_ID,
      occurredOn: "2026-08-21",
      createdAt: "2026-08-20T21:00:00.000Z",
    });

    const shifted = await lastEntryDate(env.DB);
    expect(shifted?.slice(0, 10)).toBe("2026-08-21");
    expect(shouldSendReminder("2026-08-24", shifted, null)).toBe(false);

    const sent = captureTelegram();
    await runScheduled(daily(), env);
    expect(sent).toEqual([]);
  });

  it("на сутки раньше — трата в 02:00 по Ташкенту 20 августа — напоминание даёт", async () => {
    // Контрольный прогон: сдвиг не «глушит» напоминания вообще, граница
    // просто встала на своё место.
    await insertTx({
      amount: 100_000,
      kind: "expense",
      category: CATEGORY.groceries,
      authorId: ALISHER_ID,
      occurredOn: "2026-08-20",
      createdAt: "2026-08-19T21:00:00.000Z",
    });

    const sent = captureTelegram();
    await runScheduled(daily(), env);
    expect(sent.map((m) => m.chatId)).toEqual([111111111, 222222222]);
  });

  it("дневная запись того же дня границу не пересекает ни до, ни после фикса", async () => {
    await insertTx({
      amount: 100_000,
      kind: "expense",
      category: CATEGORY.groceries,
      authorId: ALISHER_ID,
      occurredOn: "2026-08-21",
      createdAt: "2026-08-21T09:00:00.000Z",
    });
    expect(shouldSendReminder("2026-08-24", await lastEntryDate(env.DB), null)).toBe(false);
  });
});
