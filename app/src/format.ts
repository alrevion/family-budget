// Дублирует src/money.ts#formatMoney намеренно (несколько строк): app/
// не завязывается на билд-граф воркера, а логика тривиальна для
// расхождения. Единственный источник CHECK-границы суммы остаётся в БД.
const moneyFormatter = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

export function formatMoney(amount: number): string {
  return `${moneyFormatter.format(Math.round(amount))} сум`;
}

export function formatSigned(amount: number): string {
  const sign = amount > 0 ? "+" : amount < 0 ? "−" : "";
  return `${sign}${moneyFormatter.format(Math.abs(Math.round(amount)))} сум`;
}

const dateFormatter = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
const dateFormatterYear = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
});
const monthFormatter = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" });

/** 'YYYY-MM-DD' -> "20 августа" (текущий год) / "20 августа 2025" (иначе). */
export function formatDateHuman(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  const nowYear = new Date().getUTCFullYear();
  const f = d.getUTCFullYear() === nowYear ? dateFormatter : dateFormatterYear;
  // toLocaleDateString с явным TZ=UTC, чтобы день не сдвинулся от локали браузера.
  return f.format(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12)));
}

/** 'YYYY-MM' -> "август 2026". */
export function formatMonthHuman(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return monthFormatter.format(new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, 1)));
}

// Тот же приём, что и src/time.ts#todayInTashkent: "сегодня" по умолчанию
// в форме ввода обязано совпадать с сервером (план, раздел "Часовой пояс"),
// иначе трата в 23:50 по Ташкенту получит клиентскую дату "завтра".
const todayFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tashkent" });

export function todayYmd(): string {
  return todayFormatter.format(new Date());
}

export function currentYm(): string {
  return todayYmd().slice(0, 7);
}
