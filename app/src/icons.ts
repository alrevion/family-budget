// Инлайновые SVG. Эмодзи и типографские глифы (⌂ ≡ ◎ ▤ ✕) как иконки не
// годятся: рисуются шрифтом системы, разъезжаются по весу и базовой линии
// между iOS и Android и не берут currentColor предсказуемо.
const NS = "http://www.w3.org/2000/svg";

function icon(paths: string, size = 24): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.9");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = paths;
  return svg;
}

export const iconHome = (): SVGSVGElement => icon('<path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>');

export const iconFeed = (): SVGSVGElement =>
  icon('<path d="M4 7h16M4 12h16M4 17h10"/>');

export const iconGoals = (): SVGSVGElement =>
  icon('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.2"/>');

export const iconReport = (): SVGSVGElement =>
  icon('<path d="M5 20V10M12 20V4M19 20v-7"/>');

export const iconClose = (size = 20): SVGSVGElement => icon('<path d="M6 6l12 12M18 6 6 18"/>', size);

export const iconPlus = (size = 26): SVGSVGElement => icon('<path d="M12 5v14M5 12h14"/>', size);

export const iconBackspace = (): SVGSVGElement =>
  icon('<path d="M9 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6-7z"/><path d="M14 10l-4 4M10 10l4 4"/>', 22);

/** Предупреждение. Нужно там, где смысл иначе передаётся ТОЛЬКО цветом. */
export const iconWarning = (size = 18): SVGSVGElement =>
  icon('<path d="M12 4.5 21 19.5H3z"/><path d="M12 10v4M12 17.2v.1"/>', size);

export const iconArrowLeft = (): SVGSVGElement => icon('<path d="M15 5l-7 7 7 7"/>', 22);
export const iconArrowRight = (): SVGSVGElement => icon('<path d="M9 5l7 7-7 7"/>', 22);

/** QR-рамка: вход в сканирование чека. */
export const iconQr = (size = 20): SVGSVGElement =>
  icon(
    '<rect x="4" y="4" width="6" height="6" rx="1"/>' +
      '<rect x="14" y="4" width="6" height="6" rx="1"/>' +
      '<rect x="4" y="14" width="6" height="6" rx="1"/>' +
      '<path d="M14 14h3M20 14v3M14 18v3M17 20h3"/>',
    size,
  );

/** Магазин — вкладка «Магазины» и карточка чека. */
export const iconShop = (size = 22): SVGSVGElement =>
  icon(
    '<path d="M3.5 10 5.5 5h13l2 5"/>' +
      '<path d="M3.5 10a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0"/>' +
      '<path d="M5 11.5V20h14v-8.5M9.5 20v-5h5v5"/>',
    size,
  );

/** Ползунки — вход в управление категориями. Шестерёнка (12 зубцов) в 24px
 *  сетке при stroke-width 1.9 превращается в кашу; ползунки читаются. */
export const iconSliders = (size = 20): SVGSVGElement =>
  icon(
    '<path d="M4 7h8M16 7h4M4 12h4M12 12h8M4 17h10M18 17h2"/>' +
      '<circle cx="14" cy="7" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="16" cy="17" r="2"/>',
    size,
  );

export const iconPencil = (size = 20): SVGSVGElement =>
  icon('<path d="M4 20h4L18.5 9.5a2.47 2.47 0 0 0-3.5-3.5L4 16.5z"/><path d="M13.5 7.5l3 3"/>', size);

/** Корзина, а не крестик: крестик в строке списка читается как «закрыть». */
export const iconTrash = (size = 20): SVGSVGElement =>
  icon(
    '<path d="M4 7h16"/><path d="M9.5 7V5.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7"/>' +
      '<path d="M6.5 7l.9 11.1a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/>' +
      '<path d="M10.5 11v5M13.5 11v5"/>',
    size,
  );
