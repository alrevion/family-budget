// Минимальные типы для https://telegram.org/js/telegram-web-app.js —
// единственный разрешённый внешний скрипт (план, шаг 8). Официальных
// @types нет, описан только используемый нами срез API.
/** Палитра активной темы Telegram. Все поля опциональны: набор зависит от
 *  версии клиента и от того, какую тему поставил пользователь. */
export interface ThemeParams {
  bg_color?: string;
  secondary_bg_color?: string;
  section_bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  destructive_text_color?: string;
}

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe: { start_param?: string; user?: { id: number } };
  colorScheme: "light" | "dark";
  themeParams?: ThemeParams;
  ready(): void;
  expand(): void;
  close(): void;
  onEvent?(event: "themeChanged" | "viewportChanged", cb: () => void): void;
  offEvent?(event: "themeChanged" | "viewportChanged", cb: () => void): void;
  setBackgroundColor?(color: string): void;
  MainButton: {
    text: string;
    show(): void;
    hide(): void;
    onClick(cb: () => void): void;
    offClick(cb: () => void): void;
    setText(text: string): void;
  };
  BackButton: {
    show(): void;
    hide(): void;
    onClick(cb: () => void): void;
    offClick(cb: () => void): void;
  };
  HapticFeedback?: {
    impactOccurred(style: "light" | "medium" | "heavy"): void;
    notificationOccurred(type: "error" | "success" | "warning"): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}
