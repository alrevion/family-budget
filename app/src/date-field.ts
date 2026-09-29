// Поле даты для форм транзакции.
//
// Решает две проблемы разом, поэтому нативный input остаётся, но перестаёт
// быть блоком лейаута:
//
// 1) БАГ ПЕРЕПОЛНЕНИЯ (iOS). Замерено в iOS Safari 26 на реальном
//    симуляторе: input[type=date] с `width:100%` внутри контейнера 358px
//    получает border-box 388px (content-box 358 + padding 28 + border 2) —
//    WebKit не применяет к нему box-sizing:border-box. Из-за этих +30px
//    .sheet-body уезжал в горизонтальный скролл (scrollWidth 404 при
//    clientWidth 390), и первый столбец клавиатуры уходил за левый край.
//    В Chrome и в macOS WebKit переполнения нет — баг чисто iOS'ный.
//    Здесь input абсолютный (inset:0), из потока выключен, распирать нечего.
//
// 2) АНГЛИЙСКАЯ ДАТА. Нативный контрол рисует значение в локали устройства
//    ("Aug 25, 2026" при английской системе). Видимую подпись рисуем сами
//    через format.ts, нативный слой держим прозрачным — тап по нему
//    открывает штатный пикер iOS, что и требовалось.
import { el } from "./dom.js";
import { formatDateHuman } from "./format.js";

export interface DateFieldOptions {
  value: string; // YYYY-MM-DD
  max?: string;
  /** Видимая подпись поля. По умолчанию «Дата». */
  caption?: string;
  /** Подпись для скринридера. По умолчанию «Дата операции». */
  ariaLabel?: string;
  onChange: (ymd: string) => void;
}

export function dateField(opts: DateFieldOptions): HTMLElement {
  const label = el("span", { class: "date-field-value", text: formatDateHuman(opts.value) });

  const input = el("input", {
    class: "date-field-input",
    type: "date",
    value: opts.value,
    max: opts.max,
    "aria-label": opts.ariaLabel ?? "Дата операции",
    onchange: (e: Event) => {
      const next = (e.target as HTMLInputElement).value;
      if (!next) {
        // Очистка пикера — откатываемся на прежнюю дату, пустая дата
        // сервером не принимается.
        (e.target as HTMLInputElement).value = opts.value;
        return;
      }
      opts.value = next;
      label.textContent = formatDateHuman(next);
      opts.onChange(next);
    },
  });

  return el("div", { class: "date-field" }, [
    el("span", { class: "date-field-caption", text: opts.caption ?? "Дата" }),
    label,
    calendarIcon(),
    input,
  ]);
}

function calendarIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "date-field-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML =
    '<rect x="3" y="5" width="18" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/>' +
    '<path d="M3 10h18M8 3v4M16 3v4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
  return svg;
}
