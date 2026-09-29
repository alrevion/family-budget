// scheduled() — два расписания, см. план, раздел "Cron" и шаг 15.
//
// "0 5 1 * *"  = 10:00 Asia/Tashkent 1-го числа — месячный отчёт обоим.
// "0 5 * * *"  = 10:00 Asia/Tashkent ежедневно — проверка удержания.

import { getAppState, lastEntryDate, monthlyReport, setAppState } from "./queries";
import type { MonthlyReport } from "./queries";
import { sendWithAppButton, sendMessage } from "./bot";
import type { TelegramInlineButton, TelegramReplyMarkup } from "./bot";
import type { Env } from "./types";
import { addDays, prevMonth, todayInTashkent } from "./time";
import { formatMoney } from "./money";

const MONTHLY_CRON = "0 5 1 * *";
const DAILY_CRON = "0 5 * * *";

/** Пауза между напоминаниями и порог «давно не заходили» — один и тот же. */
const NAG_COOLDOWN_DAYS = 3;

/** Сколько последних дней предлагается догнать — столько же кнопок-дней. */
const CATCH_UP_DAYS = 3;

/** «Ничего не тратили»: тишина на неделю вместо обычных трёх дней. */
const QUIET_DAYS = 7;

/**
 * Текст ежедневного напоминания. Сознательно НЕ содержит счётчика
 * пропущенных дней и упрёка: исследование по забрасыванию самотрекинга
 * (Epstein et al., CHI 2016) относит «nagging notifications pointing out a
 * lack of tracking» к антипаттернам — они ускоряют полный отказ, а не
 * возвращают к учёту. Сообщение уходит ОБОИМ супругам, поэтому формулировка
 * безличная: про состояние бюджета, а не про поведение одного из них.
 * Возврат обеспечивают кнопки догона, а не текст.
 */
export const NAG_TEXT =
  "Пока нет записей за последние дни. Если траты были — добавьте задним числом.";

/** Подпись кнопки «всё в порядке»: явный способ продлить тишину. */
export const NO_SPEND_BUTTON = "Ничего не тратили";

const MONTH_NAMES_RU = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

const WEEKDAYS_RU = [
  "Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота",
];

// Родительный падеж: «21 мая», не «21 май».
const MONTHS_SHORT_RU = [
  "янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек",
];

function recipients(env: Env): number[] {
  return env.ALLOWED_IDS.split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isSafeInteger(n));
}

function monthLabel(ym: string): string {
  const m = Number(ym.slice(5, 7));
  return MONTH_NAMES_RU[m - 1] ?? ym;
}

/**
 * Экспортируется для теста: чистая функция форматирования, без D1/сети.
 * Топ-категория берётся из report.expensesByCategory (AC-19, уже
 * отсортирован по amount DESC в queries.ts, маскирование R3 уже
 * применено — замаскированные траты слиты в псевдокатегорию «Скрытое»).
 */
export function formatMonthlyReportText(month: string, report: MonthlyReport): string {
  const top = report.expensesByCategory[0];
  let topPart = "";
  if (top && report.expense > 0) {
    const share = Math.round((top.amount / report.expense) * 100);
    topPart = `, топ — ${top.name} ${formatMoney(top.amount)} (${share}%)`;
  }
  return `${monthLabel(month)}: расходы ${formatMoney(report.expense)}${topPart}`;
}

/**
 * 1-го числа оба cron-триггера срабатывают в одну и ту же минуту
 * (план, раздел "Cron"): месячный отчёт отправляется, ежедневное
 * напоминание в этот день не шлётся отдельно.
 */
export function isFirstOfMonth(today: string): boolean {
  return today.slice(8, 10) === "01";
}

/**
 * Экспортируется для теста. Условие срабатывания: последняя запись
 * (по created_at, НЕ occurred_on — см. план) старше 3 дней, и cooldown
 * (last_nag_on) тоже старше 3 дней. null в любом из двух — считаем
 * условие выполненным (нет записей вовсе / никогда не напоминали).
 */
export function shouldSendReminder(
  today: string,
  lastEntry: string | null,
  lastNagOn: string | null,
): boolean {
  const threshold = addDays(today, -NAG_COOLDOWN_DAYS);
  const stale = lastEntry === null || lastEntry < threshold;
  const cooldownExpired = lastNagOn === null || lastNagOn < threshold;
  return stale && cooldownExpired;
}

/**
 * Дни для кнопок догона: CATCH_UP_DAYS предыдущих дней, самый свежий первым.
 * Сегодняшний день не предлагается — он ещё не «пропущен».
 *
 * Проверять по базе, за какие из них записи всё-таки есть, не нужно: API не
 * принимает occurred_on в будущем (src/api/transactions.ts, future_date),
 * поэтому occurred_on никогда не опережает дату создания записи. Раз
 * напоминание сработало — записей не создавали больше трёх дней, значит ни
 * один из этих дней записями не закрыт.
 */
export function catchUpDays(today: string): string[] {
  return Array.from({ length: CATCH_UP_DAYS }, (_, i) => addDays(today, -(i + 1)));
}

/** Дата, до которой молчим после «Ничего не тратили» (записывается в last_nag_on). */
export function quietUntil(today: string): string {
  // last_nag_on сравнивается с today - NAG_COOLDOWN_DAYS, поэтому «тишина на
  // QUIET_DAYS» — это отметка в будущем на разницу между ними.
  return addDays(today, QUIET_DAYS - NAG_COOLDOWN_DAYS);
}

/** 'YYYY-MM-DD' -> "Пятница, 21 авг". Свой словарь, а не Intl: ru-RU даёт «авг.» с точкой. */
export function dayLabel(ymd: string): string {
  const weekday = WEEKDAYS_RU[new Date(`${ymd}T00:00:00Z`).getUTCDay()] ?? "";
  const month = MONTHS_SHORT_RU[Number(ymd.slice(5, 7)) - 1] ?? "";
  return `${weekday}, ${Number(ymd.slice(8, 10))} ${month}`;
}

/**
 * Клавиатура напоминания: по кнопке на каждый пропущенный день плюс
 * «Ничего не тратили».
 *
 * ТОЛЬКО web_app-кнопки. callback_query потребовал бы рабочий /tg/webhook, а
 * крон обязан работать независимо от него; web_app открывает Mini App напрямую,
 * минуя бота. Дату день-кнопка передаёт в ?add=, «ничего не тратили» — ?nospend=1.
 */
export function catchUpKeyboard(env: Env, days: readonly string[]): TelegramReplyMarkup {
  const rows: TelegramInlineButton[][] = days.map((d) => [
    { text: dayLabel(d), web_app: { url: `${env.MINI_APP_URL}?add=${d}` } },
  ]);
  rows.push([{ text: NO_SPEND_BUTTON, web_app: { url: `${env.MINI_APP_URL}?nospend=1` } }]);
  return { inline_keyboard: rows };
}

async function runMonthlyReport(env: Env): Promise<void> {
  const today = todayInTashkent();
  const month = prevMonth(today.slice(0, 7));
  for (const chatId of recipients(env)) {
    try {
      const report = await monthlyReport(env.DB, chatId, month, today);
      const text = formatMonthlyReportText(month, report);
      await sendWithAppButton(env, chatId, text, month);
    } catch (err) {
      console.error(`cron: monthly report failed for ${chatId}`, err);
    }
  }
}

async function runDailyCheck(env: Env): Promise<void> {
  const today = todayInTashkent();
  if (isFirstOfMonth(today)) return;

  const lastEntry = await lastEntryDate(env.DB);
  const lastNagOn = await getAppState(env.DB, "last_nag_on");

  if (!shouldSendReminder(today, lastEntry, lastNagOn)) return;

  const markup = catchUpKeyboard(env, catchUpDays(today));
  for (const chatId of recipients(env)) {
    try {
      await sendMessage(env, chatId, NAG_TEXT, markup);
    } catch (err) {
      console.error(`cron: reminder failed for ${chatId}`, err);
    }
  }
  await setAppState(env.DB, "last_nag_on", today);
}

export async function runScheduled(controller: ScheduledController, env: Env): Promise<void> {
  if (controller.cron === MONTHLY_CRON) {
    await runMonthlyReport(env);
    return;
  }
  if (controller.cron === DAILY_CRON) {
    await runDailyCheck(env);
  }
}
