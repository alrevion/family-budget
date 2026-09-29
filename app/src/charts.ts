// Графики отчёта — inline SVG, без сторонней библиотеки: план требует
// "бандл инлайнится, внешних CDN нет", а объём приложения не оправдывает вес
// любой библиотеки графиков.
//
// Общее правило всех графиков здесь: данные читаются БЕЗ цвета. У круговой
// каждый сектор получает собственную штриховку (тот же паттерн в легенде),
// у линии ряды различаются формой маркера и подписью у последней точки,
// у столбцов и таблицы значение подписано прямо на данных. Цвет — усиление,
// не носитель смысла: дальтонизм, ч/б скриншот и тёмная тема не должны
// превращать отчёт в загадку.
import { el } from "./dom.js";
import { formatMoney, formatSigned } from "./format.js";
import type { ReportBucketTotals, ReportCategorySlice } from "./api-types.js";

const NS = "http://www.w3.org/2000/svg";

/** Срез отчёта как есть с сервера — отдельного «графического» типа не заводим,
 *  единственный источник данных у графиков один. */
type Slice = ReportCategorySlice;

const CATEGORY_PALETTE = [
  "#0F7A5C",
  "#C77D22",
  "#3A6B8A",
  "#B23A3A",
  "#6E7DBE",
  "#B08A2E",
  "#2FA36B",
  "#8D6E9C",
  "#4E8FA6",
  "#7A8570",
  "#5FBF8F",
];

function colorForIndex(i: number): string {
  return CATEGORY_PALETTE[i % CATEGORY_PALETTE.length] ?? "#7A8570";
}

// Шесть штриховок под шесть секторов круговой (больше и не бывает — хвост
// схлопывается в «Прочее»). Ключ к чтению без цвета: та же штриховка стоит
// в легенде, поэтому сектор находится по рисунку, а не по оттенку.
const PATTERNS = [
  "", // сплошная
  "M0 0 L0 8", // вертикальные штрихи (после rotate(45) — диагональ)
  "M0 0 L8 0", // горизонтальные
  "M0 0 L0 8 M4 0 L4 8", // частые
  "M0 0 L0 8 M0 0 L8 0", // клетка
  "M0 4 L8 4 M4 0 L4 8", // крест
];

let patternSeq = 0;

/** <defs> со штриховками для набора секторов. Идентификаторы уникальны на
 *  документ: на экране одновременно живут несколько SVG. */
function patternDefs(count: number, colors: string[], uid: string): string {
  const defs: string[] = [];
  for (let i = 0; i < count; i++) {
    const color = colors[i] ?? "#7A8570";
    const path = PATTERNS[i % PATTERNS.length] ?? "";
    if (path === "") {
      defs.push(`<pattern id="${uid}-${i}" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="${color}"/></pattern>`);
    } else {
      defs.push(
        `<pattern id="${uid}-${i}" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
          `<rect width="8" height="8" fill="${color}"/>` +
          `<path d="${path}" stroke="rgba(255,255,255,0.62)" stroke-width="2.4"/></pattern>`,
      );
    }
  }
  return `<defs>${defs.join("")}</defs>`;
}

/** Квадратик легенды с той же штриховкой, что у сектора. */
function swatch(index: number, color: string): SVGSVGElement {
  const uid = `sw${patternSeq++}`;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "legend-swatch");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = `${patternDefs(index + 1, Array.from({ length: index + 1 }, () => color), uid)}<rect x="0" y="0" width="16" height="16" rx="4" fill="url(#${uid}-${index})"/>`;
  return svg;
}

/** Свыше шести секторов круговая нечитаема — хвост уходит в «Прочее». */
const MAX_PIE_SLICES = 6;

function collapseTail(slices: Slice[], max = MAX_PIE_SLICES): Slice[] {
  if (slices.length <= max) return slices;
  const head = slices.slice(0, max - 1);
  const tail = slices.slice(max - 1);
  return [
    ...head,
    {
      categoryId: null,
      name: `Прочее (${tail.length})`,
      amount: tail.reduce((s, x) => s + x.amount, 0),
      count: tail.reduce((s, x) => s + x.count, 0),
      share: tail.reduce((s, x) => s + x.share, 0),
    },
  ];
}

export interface LegendState {
  /** Ключи скрытых рядов (categoryId или имя ряда). */
  hidden: Set<string>;
  onToggle: (key: string) => void;
}

const sliceKey = (s: Slice): string => (s.categoryId === null ? `hidden:${s.name}` : String(s.categoryId));

/** Круговая (AC-19). Легенда кликабельна: тап скрывает ряд и пересчитывает доли. */
export function categoryPie(all: Slice[], legend: LegendState): HTMLElement {
  // Цвет и штриховка закреплены за категорией ОДИН раз, по полному списку:
  // иначе скрытие ряда перекрасило бы остальные и легенда разошлась бы с
  // диаграммой.
  const base = collapseTail(all.filter((s) => s.amount > 0));
  const visible = base.filter((s) => !legend.hidden.has(sliceKey(s)));
  const total = visible.reduce((s, x) => s + x.amount, 0);

  const size = 220;
  const r = 92;
  const c = size / 2;
  const uid = `pie${patternSeq++}`;
  const colors = base.map((_, i) => colorForIndex(i));

  const paths: string[] = [];
  let angle = -Math.PI / 2;
  base.forEach((slice, i) => {
    if (legend.hidden.has(sliceKey(slice))) return;
    const frac = total > 0 ? slice.amount / total : 0;
    if (frac <= 0) return;
    const fill = `url(#${uid}-${i})`;
    if (frac >= 0.999) {
      paths.push(`<circle cx="${c}" cy="${c}" r="${r}" fill="${fill}"/>`);
    } else {
      const next = angle + frac * Math.PI * 2;
      const large = frac > 0.5 ? 1 : 0;
      const p = (a: number): string => `${(c + r * Math.cos(a)).toFixed(2)},${(c + r * Math.sin(a)).toFixed(2)}`;
      paths.push(`<path d="M${c},${c} L${p(angle)} A${r},${r} 0 ${large} 1 ${p(next)} Z" fill="${fill}"/>`);
      // Доля прямо на секторе: с 7% места уже хватает, ниже подпись съезжает
      // на соседний сектор и мешает больше, чем помогает — там читают легенду.
      if (frac >= 0.07) {
        const mid = angle + (next - angle) / 2;
        const lx = c + r * 0.81 * Math.cos(mid);
        const ly = c + r * 0.81 * Math.sin(mid);
        paths.push(
          `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" class="pie-slice-label" text-anchor="middle" dominant-baseline="middle">${Math.round(frac * 100)}%</text>`,
        );
      }
      angle = next;
    }
  });

  const svg =
    total > 0
      ? `<svg viewBox="0 0 ${size} ${size}" class="pie-svg" role="img" aria-label="Круговая диаграмма расходов по категориям">
        ${patternDefs(base.length, colors, uid)}
        ${paths.join("")}
        <circle cx="${c}" cy="${c}" r="${r * 0.62}" class="pie-hole"/>
      </svg>`
      : "";

  const rows = base.map((s, i) => ({ slice: s, color: colorForIndex(i), index: i }));

  return el("div", { class: "pie-wrap" }, [
    total > 0
      ? el("div", { class: "pie-svg-holder" }, [
          el("div", { class: "pie-svg-box", html: svg }),
          el("div", { class: "pie-center" }, [
            el("span", { class: "pie-center-label", text: "Всего" }),
            el("span", { class: "pie-center-value", text: formatMoney(total) }),
          ]),
        ])
      : el("p", { class: "chart-empty", text: "Все категории скрыты — верните хотя бы одну в легенде." }),
    chartLegend(
      rows.map((r) => ({
        key: sliceKey(r.slice),
        index: r.index,
        color: r.color,
        label: r.slice.name,
        value: `${Math.round((total > 0 ? r.slice.amount / total : 0) * 100)}%`,
      })),
      legend,
    ),
  ]);
}

interface LegendRow {
  key: string;
  index: number;
  color: string;
  label: string;
  value: string;
}

function chartLegend(rows: LegendRow[], legend: LegendState): HTMLElement {
  return el(
    "ul",
    { class: "chart-legend" },
    rows.map((row) => {
      const off = legend.hidden.has(row.key);
      return el("li", {}, [
        el(
          "button",
          {
            class: `legend-btn${off ? " legend-btn-off" : ""}`,
            type: "button",
            "aria-pressed": String(!off),
            "aria-label": `${row.label}, ${off ? "показать" : "скрыть"} на графике`,
            onclick: () => legend.onToggle(row.key),
          },
          [
            swatch(row.index, row.color),
            el("span", { class: "legend-label", text: row.label }),
            el("span", { class: "legend-value", text: off ? "скрыто" : row.value }),
          ],
        ),
      ]);
    }),
  );
}

/** Горизонтальные столбцы. Подпись и сумма стоят на самой строке — цвет не нужен. */
export function categoryBars(slices: Slice[]): HTMLElement {
  const shown = slices.filter((s) => s.amount > 0);
  if (shown.length === 0) return el("p", { class: "chart-empty", text: "Нет данных за период." });
  const max = Math.max(...shown.map((s) => s.amount));
  return el(
    "div",
    { class: "bar-chart" },
    shown.map((s, i) =>
      el("div", { class: "bar-row" }, [
        el("div", { class: "bar-row-head" }, [
          el("span", { class: "bar-row-label", text: s.name }),
          el("span", { class: "bar-row-value", text: formatMoney(s.amount) }),
        ]),
        el("div", { class: "bar-track" }, [
          el("div", {
            class: "bar-fill",
            style: `width:${Math.max(2, (s.amount / max) * 100)}%;background:${colorForIndex(i)}`,
          }),
        ]),
        el("div", {
          class: "bar-row-sub",
          text: `${Math.round(s.share * 100)}% · ${s.count} ${plural(s.count, "операция", "операции", "операций")}`,
        }),
      ]),
    ),
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

// --- Линия: динамика по времени ------------------------------------------

const SERIES = [
  { key: "income", label: "Доход", color: "var(--income)" },
  { key: "expense", label: "Расход", color: "var(--expense)" },
] as const;

/** Подпись деления оси X: 'YYYY-MM-DD' -> '12.08', 'YYYY-MM' -> '08.26'. */
function bucketLabel(bucket: string): string {
  return bucket.length === 10 ? `${bucket.slice(8, 10)}.${bucket.slice(5, 7)}` : `${bucket.slice(5, 7)}.${bucket.slice(2, 4)}`;
}

/**
 * Линия дохода и расхода по периодам. Ряды различаются формой маркера
 * (круг/квадрат) и подписаны у последней точки — на ч/б экране и при
 * дальтонизме это единственное, что отличает линии друг от друга.
 */
export function dynamicsLine(rows: ReportBucketTotals[], legend: LegendState): HTMLElement {
  if (rows.length === 0) return el("p", { class: "chart-empty", text: "Нет данных за период." });

  const w = 320;
  const h = 180;
  const padL = 8;
  const padR = 52; // место под подпись ряда у последней точки
  const padT = 14;
  const padB = 26;
  const shown = SERIES.filter((s) => !legend.hidden.has(s.key));
  const max = Math.max(1, ...rows.flatMap((r) => shown.map((s) => r[s.key])));
  const x = (i: number): number =>
    rows.length === 1 ? padL + (w - padL - padR) / 2 : padL + (i * (w - padL - padR)) / (rows.length - 1);
  const y = (v: number): number => padT + (1 - v / max) * (h - padT - padB);

  const parts: string[] = [
    `<line x1="${padL}" y1="${h - padB}" x2="${w - padR + 6}" y2="${h - padB}" class="axis-line"/>`,
    `<text x="${padL}" y="${padT - 3}" class="axis-label">${formatMoney(max)}</text>`,
  ];

  for (const s of shown) {
    const pts = rows.map((r, i) => [x(i), y(r[s.key])] as const);
    if (pts.length > 1) {
      parts.push(
        `<polyline points="${pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round"/>`,
      );
    }
    for (const [px, py] of pts) {
      parts.push(
        s.key === "income"
          ? `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3.4" fill="${s.color}"/>`
          : `<rect x="${(px - 3.2).toFixed(1)}" y="${(py - 3.2).toFixed(1)}" width="6.4" height="6.4" fill="${s.color}"/>`,
      );
    }
    const last = pts[pts.length - 1];
    if (last) {
      parts.push(
        `<text x="${(last[0] + 7).toFixed(1)}" y="${(last[1] + 4).toFixed(1)}" class="series-label" fill="${s.color}">${s.label}</text>`,
      );
    }
  }

  // Подписи оси X: первая, средняя и последняя. Все — на 375px не помещаются.
  const ticks = [...new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])];
  for (const i of ticks) {
    const row = rows[i];
    if (!row) continue;
    const anchor = i === 0 ? "start" : i === rows.length - 1 ? "end" : "middle";
    parts.push(
      `<text x="${x(i).toFixed(1)}" y="${h - padB + 15}" class="axis-label" text-anchor="${anchor}">${bucketLabel(row.bucket)}</text>`,
    );
  }

  const svg = `<svg viewBox="0 0 ${w} ${h}" class="line-svg" role="img" aria-label="Динамика доходов и расходов по периодам">${parts.join("")}</svg>`;

  return el("div", { class: "line-wrap" }, [
    el("div", { html: svg }),
    el(
      "ul",
      { class: "chart-legend chart-legend-inline" },
      SERIES.map((s) => {
        const off = legend.hidden.has(s.key);
        return el("li", {}, [
          el(
            "button",
            {
              class: `legend-btn${off ? " legend-btn-off" : ""}`,
              type: "button",
              "aria-pressed": String(!off),
              "aria-label": `${s.label}, ${off ? "показать" : "скрыть"} на графике`,
              onclick: () => legend.onToggle(s.key),
            },
            [
              seriesMarker(s.key, s.color),
              el("span", { class: "legend-label", text: s.label }),
              el("span", { class: "legend-value", text: off ? "скрыто" : "" }),
            ],
          ),
        ]);
      }),
    ),
  ]);
}

function seriesMarker(key: "income" | "expense", color: string): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "legend-swatch");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML =
    `<line x1="0" y1="8" x2="16" y2="8" stroke="${color}" stroke-width="2.2"/>` +
    (key === "income"
      ? `<circle cx="8" cy="8" r="4" fill="${color}"/>`
      : `<rect x="4.5" y="4.5" width="7" height="7" fill="${color}"/>`);
  return svg;
}

// --- Таблица --------------------------------------------------------------

export type SortKey = "amount" | "count" | "share";

export interface TableSort {
  key: SortKey;
  desc: boolean;
}

const COLUMNS: { key: SortKey; label: string; title: string }[] = [
  { key: "amount", label: "Сумма", title: "Сортировать по сумме" },
  { key: "count", label: "Оп.", title: "Сортировать по числу операций" },
  { key: "share", label: "Доля", title: "Сортировать по доле" },
];

const money = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

/** Таблица тех же данных: сортировка по сумме, количеству и доле. */
export function categoryTable(
  slices: Slice[],
  sort: TableSort,
  onSort: (next: TableSort) => void,
): HTMLElement {
  const rows = [...slices].sort((a, b) => (sort.desc ? b[sort.key] - a[sort.key] : a[sort.key] - b[sort.key]));
  const total = slices.reduce((s, x) => s + x.amount, 0);
  const totalCount = slices.reduce((s, x) => s + x.count, 0);

  const head = el("tr", {}, [
    el("th", { scope: "col", text: "Категория" }),
    ...COLUMNS.map((col) =>
      el(
        "th",
        {
          scope: "col",
          class: "num",
          "aria-sort": sort.key === col.key ? (sort.desc ? "descending" : "ascending") : "none",
        },
        [
          el("button", {
            class: `table-sort${sort.key === col.key ? " table-sort-active" : ""}`,
            type: "button",
            "aria-label": col.title,
            // Направление сортировки показано знаком, а не только подсветкой.
            text: sort.key === col.key ? `${col.label} ${sort.desc ? "↓" : "↑"}` : col.label,
            onclick: () => onSort({ key: col.key, desc: sort.key === col.key ? !sort.desc : true }),
          }),
        ],
      ),
    ),
  ]);

  return el("div", { class: "table-wrap" }, [
    el("table", { class: "data-table" }, [
      el("thead", {}, [head]),
      el(
        "tbody",
        {},
        rows.map((s) =>
          el("tr", {}, [
            el("td", { text: s.name }),
            el("td", { class: "num", text: money.format(s.amount) }),
            el("td", { class: "num", text: String(s.count) }),
            el("td", { class: "num", text: `${Math.round(s.share * 100)}%` }),
          ]),
        ),
      ),
      el("tfoot", {}, [
        el("tr", {}, [
          el("td", { text: "Итого" }),
          el("td", { class: "num", text: money.format(total) }),
          el("td", { class: "num", text: String(totalCount) }),
          el("td", { class: "num", text: "100%" }),
        ]),
      ]),
    ]),
  ]);
}

// --- Дельта ----------------------------------------------------------------

/**
 * Знак изменения. Стрелка рисуется, а не берётся цветом: «стало больше» и
 * «стало меньше» обязаны различаться на ч/б экране и при дальтонизме.
 */
export function deltaBadge(delta: number, previous: number): HTMLElement {
  const dir = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const percent = previous > 0 ? Math.round((delta / previous) * 100) : null;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "delta-arrow");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML =
    dir === "flat"
      ? '<path d="M2 6h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>'
      : dir === "up"
        ? '<path d="M6 1 L11 8 H1 Z" fill="currentColor"/>'
        : '<path d="M6 11 L1 4 H11 Z" fill="currentColor"/>';

  return el("span", { class: `delta delta-${dir}` }, [
    svg,
    el("span", {
      class: "delta-text",
      // Знак процента тем же символом «−», что и у суммы: дефис рядом с
      // минусом читается как разнобой.
      text:
        previous === 0
          ? "новая"
          : `${formatSigned(delta)}${percent != null ? ` · ${percent >= 0 ? "+" : "−"}${Math.abs(percent)}%` : ""}`,
    }),
  ]);
}
