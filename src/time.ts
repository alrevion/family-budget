// Часовой пояс Asia/Tashkent используется везде, где встречается "сегодня":
// дата по умолчанию при вводе, сравнение hidden_until, вычисление прошлого
// месяца в cron, проверка удержания. См. план, раздел "Часовой пояс".
//
// Все функции ниже работают с чистыми календарными строками 'YYYY-MM-DD' /
// 'YYYY-MM' и считают в UTC-эпохе (Date.UTC), поэтому сами по себе не зависят
// от часового пояса окружения — единственное место, реально завязанное на
// Asia/Tashkent, это todayInTashkent().

const TASHKENT_TZ = "Asia/Tashkent";

const todayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TASHKENT_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Текущая дата в Asia/Tashkent как 'YYYY-MM-DD'. */
export function todayInTashkent(): string {
  // en-CA форматирует как YYYY-MM-DD.
  return todayFormatter.format(new Date());
}

function parseYmd(ymd: string): { y: number; m: number; d: number } {
  // Фиксированный формат 'YYYY-MM-DD' — разбор по срезам, а не split+map,
  // чтобы не зависеть от noUncheckedIndexedAccess при доступе к элементам.
  return {
    y: Number(ymd.slice(0, 4)),
    m: Number(ymd.slice(5, 7)),
    d: Number(ymd.slice(8, 10)),
  };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function formatYmd(y: number, m: number, d: number): string {
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

/** Последний день месяца m (1-12) года y. */
function daysInMonth(y: number, m: number): number {
  // День 0 месяца (m+1) в UTC — последний день месяца m.
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Прибавляет n календарных дней к 'YYYY-MM-DD'. n может быть отрицательным. */
export function addDays(ymd: string, n: number): string {
  const { y, m, d } = parseYmd(ymd);
  const ms = Date.UTC(y, m - 1, d) + n * 86_400_000;
  const dt = new Date(ms);
  return formatYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/**
 * Прибавляет n календарных месяцев к 'YYYY-MM-DD' с клампингом переполнения:
 * если в целевом месяце меньше дней, чем исходное число, берётся последний
 * день целевого месяца. Например, addMonths('2026-08-31', 6) === '2027-02-28',
 * а не '2027-03-03', как дал бы наивный Date#setMonth. n может быть
 * отрицательным.
 */
export function addMonths(ymd: string, n: number): string {
  const { y, m, d } = parseYmd(ymd);
  const totalMonths = (m - 1) + n;
  const newYear = y + Math.floor(totalMonths / 12);
  const newMonth = ((totalMonths % 12) + 12) % 12 + 1;
  const newDay = Math.min(d, daysInMonth(newYear, newMonth));
  return formatYmd(newYear, newMonth, newDay);
}

function parseYm(ym: string): { y: number; m: number } {
  return { y: Number(ym.slice(0, 4)), m: Number(ym.slice(5, 7)) };
}

/** Полуоткрытый диапазон дат месяца ym='YYYY-MM': [from, toExclusive). */
export function monthRange(ym: string): [string, string] {
  const { y, m } = parseYm(ym);
  const from = formatYmd(y, m, 1);
  const nextMonth = m + 1 > 12 ? 1 : m + 1;
  const nextYear = m + 1 > 12 ? y + 1 : y;
  const to = formatYmd(nextYear, nextMonth, 1);
  return [from, to];
}

/** Предыдущий месяц для ym='YYYY-MM', корректно на границе года (2027-01 -> 2026-12). */
export function prevMonth(ym: string): string {
  const { y, m } = parseYm(ym);
  const prevM = m - 1 < 1 ? 12 : m - 1;
  const prevY = m - 1 < 1 ? y - 1 : y;
  return `${pad(prevY, 4)}-${pad(prevM, 2)}`;
}

// ---------------------------------------------------------------------------
// Периоды: месяц / квартал / год / произвольный диапазон
// ---------------------------------------------------------------------------

export type PeriodKind = "month" | "quarter" | "year" | "range";

/** Гранулярность блока «динамика» (AC-21). */
export type Granularity = "day" | "month";

/**
 * Период отчёта. `to` — ПОЛУОТКРЫТАЯ верхняя граница (эксклюзивная), как в
 * monthRange: сравнение occurred_on < to не требует знания длины месяца.
 * Наружу, в JSON API, отдаётся `to` включительно — см. src/api.ts.
 */
export interface Period {
  kind: PeriodKind;
  /** Человекочитаемая метка: '2026-08' | '2026-Q3' | '2026' | '2026-01-01..2026-03-31'. */
  label: string;
  from: string;
  to: string;
  granularity: Granularity;
}

/** Порог «дневной» гранулярности динамики: до 62 дней включительно — по дням. */
const DAY_GRANULARITY_MAX_DAYS = 62;

/** Число календарных дней в полуоткрытом диапазоне [from, toExclusive). */
export function daysBetween(from: string, toExclusive: string): number {
  const a = parseYmd(from);
  const b = parseYmd(toExclusive);
  return (Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000;
}

/**
 * Гранулярность динамики для диапазона. До 62 дней (два месяца) — по дням:
 * столбиков ещё читаемое количество. Дальше — по месяцам, иначе годовой
 * период дал бы 365 столбцов.
 */
export function granularityFor(from: string, toExclusive: string): Granularity {
  return daysBetween(from, toExclusive) <= DAY_GRANULARITY_MAX_DAYS ? "day" : "month";
}

/**
 * Полуоткрытый диапазон календарного периода. anchor — любой месяц 'YYYY-MM'
 * внутри периода: для квартала берётся квартал, содержащий этот месяц, для
 * года — год этого месяца.
 */
export function periodRange(
  kind: "month" | "quarter" | "year",
  anchor: string,
): [string, string] {
  if (kind === "month") return monthRange(anchor);
  const { y, m } = parseYm(anchor);
  if (kind === "year") return [formatYmd(y, 1, 1), formatYmd(y + 1, 1, 1)];
  const startM = Math.floor((m - 1) / 3) * 3 + 1; // 1, 4, 7 или 10
  const endM = startM + 3;
  return [
    formatYmd(y, startM, 1),
    endM > 12 ? formatYmd(y + 1, endM - 12, 1) : formatYmd(y, endM, 1),
  ];
}

/** Календарный период (месяц/квартал/год) вокруг anchor='YYYY-MM'. */
export function calendarPeriod(kind: "month" | "quarter" | "year", anchor: string): Period {
  const [from, to] = periodRange(kind, anchor);
  const { y, m } = parseYm(anchor);
  const label =
    kind === "month"
      ? `${pad(y, 4)}-${pad(m, 2)}`
      : kind === "year"
        ? pad(y, 4)
        : `${pad(y, 4)}-Q${Math.floor((m - 1) / 3) + 1}`;
  // Гранулярность календарных периодов фиксирована требованием: квартал и год
  // группируются по месяцам. У месяца динамика историческая (все месяцы базы,
  // AC-21) и тоже месячная — см. periodReport.
  return { kind, label, from, to, granularity: "month" };
}

/** Произвольный диапазон дат, обе границы ВКЛЮЧИТЕЛЬНО. */
export function rangePeriod(from: string, toInclusive: string): Period {
  const to = addDays(toInclusive, 1);
  return {
    kind: "range",
    label: `${from}..${toInclusive}`,
    from,
    to,
    granularity: granularityFor(from, to),
  };
}

/**
 * Предыдущий период той же длины — база для блока сравнения (AC-20).
 * Календарные периоды сдвигаются по календарю (месяц назад, квартал назад,
 * год назад), произвольный диапазон — на своё же число дней.
 */
export function previousPeriod(p: Period): [string, string] {
  if (p.kind === "range") {
    const len = daysBetween(p.from, p.to);
    return [addDays(p.from, -len), p.from];
  }
  const monthsBack = p.kind === "month" ? 1 : p.kind === "quarter" ? 3 : 12;
  return periodRange(p.kind, addMonths(p.from, -monthsBack).slice(0, 7));
}
