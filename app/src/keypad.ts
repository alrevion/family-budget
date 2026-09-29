// Числовая клавиатура — единственный способ ввода сумм (никакого текстового
// парсинга, заказчик его отклонил). Переиспользуется онбордингом, формой
// транзакции и целями.
import { el } from "./dom.js";
import { formatMoney } from "./format.js";
import { iconBackspace } from "./icons.js";

const MAX_DIGITS = 12; // >= 1e11 (CHECK-граница amount в БД)

export interface KeypadOptions {
  confirmLabel: string;
  initialAmount?: number;
  onConfirm: (amount: number) => void;
  onDigitsChange?: (amount: number) => void;
}

export function keypad(opts: KeypadOptions): HTMLElement {
  let digits = opts.initialAmount && opts.initialAmount > 0 ? String(opts.initialAmount) : "";

  const display = el("div", { class: "keypad-display keypad-display-empty", text: "0 сум" });
  const confirmBtn = el("button", {
    class: "btn btn-primary btn-block",
    text: opts.confirmLabel,
    disabled: true,
    type: "button",
  }) as HTMLButtonElement;

  function currentAmount(): number {
    return digits === "" ? 0 : Number(digits);
  }

  function render(): void {
    const amount = currentAmount();
    display.textContent = amount === 0 ? "0 сум" : formatMoney(amount);
    display.classList.toggle("keypad-display-empty", amount === 0);
    confirmBtn.disabled = amount <= 0;
    opts.onDigitsChange?.(amount);
  }

  function pressDigits(d: string): void {
    if (d !== "0" && digits === "" && d.startsWith("0")) return;
    if (digits === "" && d === "0") return; // без ведущих нулей
    if (digits === "" && d === "000") return;
    if (digits.length + d.length > MAX_DIGITS) return;
    digits += d;
    render();
  }

  function backspace(): void {
    digits = digits.slice(0, -1);
    render();
  }

  const BACKSPACE = "\u232B";
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "000", "0", BACKSPACE];
  const grid = el(
    "div",
    { class: "keypad-grid" },
    keys.map((k) =>
      el(
        "button",
        {
          class: "keypad-key",
          type: "button",
          "aria-label": k === BACKSPACE ? "Удалить цифру" : `Цифра ${k}`,
          // pointerdown, а не click: тактильный отклик обязан прийти в момент
          // касания. click на тач-экране приходит на 100-300мс позже — для
          // клавиатуры, по которой бьют быстро, это уже ощутимая задержка.
          onpointerdown: () => window.Telegram?.WebApp.HapticFeedback?.impactOccurred("light"),
          onclick: () => (k === BACKSPACE ? backspace() : pressDigits(k)),
        },
        [k === BACKSPACE ? iconBackspace() : k],
      ),
    ),
  );

  confirmBtn.addEventListener("click", () => {
    const amount = currentAmount();
    if (amount > 0) opts.onConfirm(amount);
  });

  render();
  return el("div", { class: "keypad" }, [display, grid, confirmBtn]);
}
