// Выбор периода отчёта: месяц / квартал / год / свой диапазон.
//
// Календарная арифметика продублирована с src/time.ts намеренно — app/ не
// завязывается на билд-граф воркера (то же решение, что и в format.ts).
// Здесь она нужна ровно для двух вещей: подписать выбранный период и понять,
// можно ли шагнуть вперёд, не упёршись в future_range.
import { el } from "./dom.js";
import { dateField } from "./date-field.js";
import { formatDateHuman, formatMonthHuman, todayYmd } from "./format.js";
import { iconArrowLeft, iconArrowRight, iconWarning } from "./icons.js";
import { openSheet } from "./sheet.js";
import type { PeriodSel } from "./api-types.js";

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

const parseYm = (ym: string): [number, number] => [Number(ym.slice(0, 4)), Number(ym.slice(5, 7))];

function addMonthsYm(ym: string, n: number): string {
  const [y, m] = parseYm(ym);
  const total = m - 1 + n;
  return `${pad(y + Math.floor(total / 12), 4)}-${pad(((total % 12) + 12) % 12 + 1, 2)}`;
}

function ymd(y: number, m: number, d: number): string {
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

export function addDays(date: string, n: number): string {
  const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))));
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function daysBetween(from: string, to: string): number {
  const ms = (s: string): number =>
    Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return (ms(to) - ms(from)) / 86_400_000;
}

/** Границы периода, ОБЕ включительно — та же форма, что отдаёт API в period.from/to. */
export function periodBounds(sel: PeriodSel): [string, string] {
  if (sel.kind === "range") return [sel.from, sel.to];
  const [y, m] = parseYm(sel.anchor);
  if (sel.kind === "year") return [ymd(y, 1, 1), ymd(y, 12, 31)];
  const startM = sel.kind === "month" ? m : Math.floor((m - 1) / 3) * 3 + 1;
  const months = sel.kind === "month" ? 1 : 3;
  const start = ymd(y, startM, 1);
  return [start, addDays(addMonthsYm(start.slice(0, 7), months) + "-01", -1)];
}

/** Сдвиг на период той же длины. Календарный — по календарю, диапазон — на своё число дней. */
export function shiftPeriod(sel: PeriodSel, delta: number): PeriodSel {
  if (sel.kind === "range") {
    const len = daysBetween(sel.from, sel.to) + 1;
    return { kind: "range", from: addDays(sel.from, len * delta), to: addDays(sel.to, len * delta) };
  }
  const step = sel.kind === "month" ? 1 : sel.kind === "quarter" ? 3 : 12;
  return { kind: sel.kind, anchor: addMonthsYm(sel.anchor, step * delta) };
}

/** Предыдущий период той же длины — база блока сравнения и значение B по умолчанию. */
export const previousPeriod = (sel: PeriodSel): PeriodSel => shiftPeriod(sel, -1);

/** Тот же период годом раньше — вторая база для сравнения периодов. */
export function yearAgo(sel: PeriodSel): PeriodSel {
  if (sel.kind === "range") return { kind: "range", from: addDays(sel.from, -365), to: addDays(sel.to, -365) };
  return shiftPeriod(sel, -(sel.kind === "month" ? 12 : sel.kind === "quarter" ? 4 : 1));
}

/**
 * Можно ли шагнуть вперёд. Календарный период, содержащий сегодня, законен
 * (на нём завязан cron), но дальше него смотреть нечего — там пусто.
 * Произвольный диапазон сервер к тому же отвергает с future_range, поэтому
 * для него проверяется именно верхняя граница будущего шага.
 */
export function canGoForward(sel: PeriodSel, today = todayYmd()): boolean {
  if (sel.kind === "range") return periodBounds(shiftPeriod(sel, 1))[1] <= today;
  return periodBounds(sel)[1] < today;
}

const ROMAN = ["I", "II", "III", "IV"];

/** Подпись периода в шапке. Первая буква поднимается через CSS ::first-letter. */
export function periodLabel(sel: PeriodSel): string {
  if (sel.kind === "range") return `${formatDateHuman(sel.from)} – ${formatDateHuman(sel.to)}`;
  const [y, m] = parseYm(sel.anchor);
  if (sel.kind === "year") return `${y} год`;
  if (sel.kind === "quarter") return `${ROMAN[Math.floor((m - 1) / 3)]} квартал ${y}`;
  return formatMonthHuman(sel.anchor);
}

// Свой список сокращений вместо Intl: ru-RU в short-форме добавляет " г."
// ("авг. 26 г."), и подпись перестаёт помещаться в колонку сравнения.
const SHORT_MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const shortDay = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" });

/** Короткая подпись для колонок сравнения, где места на полную не хватает. */
export function periodShortLabel(sel: PeriodSel): string {
  if (sel.kind === "range") {
    const d = (s: string): string => shortDay.format(new Date(`${s}T12:00:00Z`));
    return `${d(sel.from)}–${d(sel.to)}`;
  }
  const [y, m] = parseYm(sel.anchor);
  if (sel.kind === "year") return String(y);
  if (sel.kind === "quarter") return `${ROMAN[Math.floor((m - 1) / 3)]} кв. ${y}`;
  return `${SHORT_MONTHS[m - 1]} ${pad(y % 100, 2)}`;
}

const KINDS: { id: PeriodSel["kind"]; label: string }[] = [
  { id: "month", label: "Месяц" },
  { id: "quarter", label: "Квартал" },
  { id: "year", label: "Год" },
  { id: "range", label: "Свой" },
];

/** Переключение вида периода сохраняет точку во времени: месяц -> квартал
 *  берёт квартал, содержащий этот месяц, а не текущий. */
function switchKind(sel: PeriodSel, kind: PeriodSel["kind"]): PeriodSel {
  if (kind === sel.kind) return sel;
  if (kind === "range") {
    const [from, to] = periodBounds(sel);
    const today = todayYmd();
    return { kind: "range", from, to: to > today ? today : to };
  }
  const anchor = sel.kind === "range" ? sel.from.slice(0, 7) : sel.anchor;
  return { kind, anchor };
}

export interface PeriodControlOptions {
  value: PeriodSel;
  onChange: (next: PeriodSel) => void;
}

export function periodControl(opts: PeriodControlOptions): HTMLElement {
  const sel = opts.value;

  const kinds = el(
    "div",
    { class: "segmented", role: "group", "aria-label": "Вид периода" },
    KINDS.map((k) =>
      el("button", {
        class: `segmented-btn${k.id === sel.kind ? " segmented-btn-active" : ""}`,
        type: "button",
        text: k.label,
        "aria-pressed": String(k.id === sel.kind),
        onclick: () => {
          const next = switchKind(sel, k.id);
          // «Свой» без выбора дат бессмыслен — сразу открываем выбор,
          // предзаполненный границами текущего периода.
          if (next.kind === "range") openRangeSheet(next, opts.onChange);
          else opts.onChange(next);
        },
      }),
    ),
  );

  const forward = canGoForward(sel);
  const label =
    sel.kind === "range"
      ? el("button", {
          class: "month-switcher-label period-label-btn",
          type: "button",
          text: periodLabel(sel),
          "aria-label": `Период ${periodLabel(sel)}, изменить даты`,
          onclick: () => openRangeSheet(sel, opts.onChange),
        })
      : el("div", { class: "month-switcher-label", "aria-live": "polite", text: periodLabel(sel) });

  const nav = el("div", { class: "month-switcher" }, [
    el(
      "button",
      {
        class: "month-nav",
        type: "button",
        "aria-label": "Предыдущий период",
        onclick: () => opts.onChange(shiftPeriod(sel, -1)),
      },
      [iconArrowLeft()],
    ),
    label,
    el(
      "button",
      {
        class: "month-nav",
        type: "button",
        "aria-label": "Следующий период",
        disabled: !forward,
        onclick: () => forward && opts.onChange(shiftPeriod(sel, 1)),
      },
      [iconArrowRight()],
    ),
  ]);

  return el("div", { class: "period-control" }, [kinds, nav]);
}

type RangeSel = Extract<PeriodSel, { kind: "range" }>;

/** Свой диапазон. Обе даты — через date-field.ts: собственный input[type=date]
 *  воспроизвёл бы баг переполнения в iOS WebKit (см. комментарий там). */
function openRangeSheet(current: RangeSel, onChange: (next: PeriodSel) => void): void {
  const today = todayYmd();
  let from = current.from;
  let to = current.to > today ? today : current.to;

  const error = el("p", { class: "form-error", role: "alert" });
  const apply = el("button", { class: "btn btn-primary btn-block", type: "button", text: "Показать" });

  const validate = (): string | null => {
    if (from > to) return "Начало диапазона позже конца";
    if (to > today) return "Конец диапазона не может быть в будущем";
    // Тот же потолок, что и на сервере (range_too_long): 5 лет.
    if (daysBetween(from, to) > 1826) return "Диапазон длиннее пяти лет";
    return null;
  };

  const revalidate = (): void => {
    const message = validate();
    // Ошибка — с иконкой: один только красный цвет не сигнал (color-not-only).
    error.replaceChildren(...(message ? [iconWarning(16), el("span", { text: message })] : []));
    apply.toggleAttribute("disabled", message !== null);
  };

  const field = (caption: string, value: string, onPick: (v: string) => void): HTMLElement => {
    return dateField({
      value,
      max: today,
      caption,
      ariaLabel: caption,
      onChange: (v) => {
        onPick(v);
        revalidate();
      },
    });
  };

  const { close } = openSheet(
    "Свой диапазон",
    el("div", { class: "form-stack" }, [
      field("С", from, (v) => (from = v)),
      field("По", to, (v) => (to = v)),
      error,
      apply,
    ]),
  );

  apply.addEventListener("click", () => {
    if (validate() !== null) return;
    close();
    onChange({ kind: "range", from, to });
  });
}
