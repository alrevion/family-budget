// Mini App обязан следовать теме Telegram, а не системе: пользователь может
// сидеть в тёмном Telegram на светлой iOS — prefers-color-scheme даст светлую
// и приложение будет выглядеть чужеродным. Источник правды — themeParams,
// prefers-color-scheme остаётся фолбэком для открытия вне Telegram.
//
// Пробрасываем ТОЛЬКО хром (фон/текст/акцент). Деньги (--income/--expense)
// намеренно наши: красный расход обязан быть красным независимо от того,
// какую тему юзер поставил в Telegram.

/** themeParams -> CSS-переменная. Отсутствующий ключ не трогаем: в styles.css
 *  у каждой переменной есть var(--tg-*, <наш фолбэк>). */
const VAR_BY_PARAM: Record<string, string> = {
  secondary_bg_color: "--tg-bg", // фон страницы (iOS grouped style)
  bg_color: "--tg-surface", // фон карточек
  section_bg_color: "--tg-surface-2",
  text_color: "--tg-text",
  hint_color: "--tg-text-muted",
  // link_color тоже НЕ мапим: --link питает ghost-кнопки, служебные плитки
  // и поля-ссылки. Взятый из Telegram синий соседствовал бы с изумрудной
  // заливкой сегментов и FAB — два акцента на одном экране. Акцент один.
  // button_color / button_text_color НАМЕРЕННО не мапим: акцент продукта —
  // изумруд, он несёт смысл (деньги, «включено») и обязан быть узнаваемым
  // независимо от того, какую тему пользователь выбрал в Telegram. Из
  // themeParams берём фон, текст и ссылки — то, что должно совпадать
  // с мессенджером, чтобы приложение не выглядело чужим.
  destructive_text_color: "--tg-danger",
};

function isHex(v: unknown): v is string {
  return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);
}

type Rgb = [number, number, number];

const toRgb = (hex: string): Rgb => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

const toHex = (c: Rgb): string => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

function luminance([r, g, b]: Rgb): number {
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Подтягивает `fg` к `toward`, пока контраст с худшим из фонов не достигнет
 *  `min`. Нужно, потому что hint_color самого Telegram даёт около 3.6:1 на
 *  своём же фоне — для мелкого текста (подписи карточек, вкладки, подписи полей)
 *  этого мало, а мелкого текста в приложении про деньги много. */
function ensureContrast(fg: string, toward: string, backgrounds: string[], min: number): string {
  const bgs = backgrounds.filter(isHex).map(toRgb);
  if (bgs.length === 0) return fg;
  const worst = (c: Rgb): number => Math.min(...bgs.map((b) => contrast(c, b)));

  const base = toRgb(fg);
  if (worst(base) >= min) return fg;

  const target = toRgb(toward);
  for (let t = 0.1; t <= 1.0001; t += 0.1) {
    const candidate = mix(base, target, t);
    if (worst(candidate) >= min) return toHex(candidate);
  }
  return toward;
}

function apply(): void {
  const tg = window.Telegram?.WebApp;
  const root = document.documentElement;
  const params = tg?.themeParams;

  // Пустой themeParams = telegram-web-app.js загружен, но хоста нет (открыли
  // в обычном браузере). В этом случае SDK всё равно рапортует
  // colorScheme:"light", и доверять ему нельзя — иначе тёмная система
  // получит светлое приложение. Схему берём только у настоящего Telegram.
  const insideTelegram = !!params && Object.keys(params).length > 0;

  const scheme = tg?.colorScheme;
  if (insideTelegram && (scheme === "dark" || scheme === "light")) {
    root.setAttribute("data-theme", scheme);
    root.style.colorScheme = scheme;
  } else {
    root.removeAttribute("data-theme");
    root.style.colorScheme = "";
  }

  if (!params) return;

  for (const [param, cssVar] of Object.entries(VAR_BY_PARAM)) {
    const value = (params as Record<string, unknown>)[param];
    // Мусорное значение (пустая строка, rgba, undefined) не должно затирать
    // рабочий фолбэк — тогда экран станет прозрачным/чёрным.
    if (isHex(value)) root.style.setProperty(cssVar, value);
    else root.style.removeProperty(cssVar);
  }

  // Telegram не даёт цвет границы — выводим из подсказки, чтобы рамки не
  // выпадали из чужой палитры.
  if (isHex(params.hint_color)) {
    root.style.setProperty("--tg-border", `color-mix(in srgb, ${params.hint_color} 34%, transparent)`);
  }

  // Приглушённый текст: hint_color как есть часто не дотягивает до 4.5:1.
  // Подтягиваем к основному тексту ровно настолько, чтобы дотянуть — оттенок
  // темы сохраняется, читаемость появляется.
  const surfaces = [params.bg_color, params.secondary_bg_color, params.section_bg_color].filter(isHex);
  if (isHex(params.hint_color) && isHex(params.text_color) && surfaces.length > 0) {
    root.style.setProperty(
      "--tg-text-muted",
      ensureContrast(params.hint_color, params.text_color, surfaces, 4.5),
    );
  }

  // Тот же барьер для акцентного ТЕКСТА (активная вкладка, ghost-кнопки,
  // раскрывающиеся секции): link_color тоже бывает бледным на своём фоне.
  if (isHex(params.link_color) && isHex(params.text_color) && surfaces.length > 0) {
    root.style.setProperty("--tg-link", ensureContrast(params.link_color, params.text_color, surfaces, 4.5));
  }

  // Красный "Удалить"/текст ошибки: destructive_text_color Telegram даёт
  // около 3.7:1 на белом. Затемняем/осветляем до 4.5:1 — остаётся красным.
  if (isHex(params.destructive_text_color) && isHex(params.text_color) && surfaces.length > 0) {
    root.style.setProperty(
      "--tg-danger",
      ensureContrast(params.destructive_text_color, params.text_color, surfaces, 4.5),
    );
  }

  // Подпись на кнопке. button_text_color иногда даёт < 4.5:1 на button_color
  // (белое на телеграмном синем — 3.7:1); тогда берём тот из чёрного/белого,
  // что читается лучше. Цвет самой кнопки остаётся телеграмным.
  // Гварда контраста для подписи кнопки больше нет: --tg-accent-text не
  // выставляется вовсе, акцент и его подпись — наша пара с проверенным
  // контрастом (#0f7a5c/#ffffff = 5.3:1, #2fbe8f/#06120d = 8.1:1).

  // Фон под шторкой Telegram (там, где ОС рисует свою полосу).
  if (isHex(params.secondary_bg_color)) tg?.setBackgroundColor?.(params.secondary_bg_color);
}

export function initTheme(): void {
  apply();
  window.Telegram?.WebApp.onEvent?.("themeChanged", apply);
}
