// Блок «Чек из магазина» в форме новой записи.
//
// Сканирование — нативное Telegram.showScanQrPopup (Bot API 6.4+): это
// единственный способ открыть камеру внутри Mini App без своих разрешений
// и getUserMedia. На Desktop/в вебе камеры нет — там остаётся вставка
// ссылки из QR, а весь разбор всё равно делает сервер.
import { el } from "./dom.js";
import { formatDateHuman, formatMoney } from "./format.js";
import { iconQr } from "./icons.js";
import * as api from "./api.js";
import type { ReceiptLookup } from "./api-types.js";

export interface ReceiptScannerOptions {
  /** Чек распознан: форма подставляет сумму, дату и категорию. */
  onReceipt: (lookup: ReceiptLookup) => void;
  /** «Сохранить в <запомненная категория>» — один тап вместо сетки. */
  onQuickSave: (categoryId: number) => void;
  /** «Другой чек» / ошибка: родитель забывает предыдущий чек. */
  onClear: () => void;
}

export interface ReceiptScanner {
  root: HTMLElement;
  /** Открыть камеру сразу, без отдельного тапа по кнопке (форма «+»). */
  start: () => void;
  /** Сбросить в исходное состояние (например, при переключении на доход). */
  reset: () => void;
}

function plural(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

const NO_CAMERA_PLATFORMS = new Set(["tdesktop", "web", "weba", "macos", "linux"]);

/** Нативное сканирование появилось в Bot API 6.4; в вебе/Desktop камеры нет. */
function canScanQr(): boolean {
  const tg = window.Telegram?.WebApp;
  if (tg?.platform !== undefined && NO_CAMERA_PLATFORMS.has(tg.platform)) return false;
  return (
    typeof tg?.showScanQrPopup === "function" &&
    (typeof tg.isVersionAtLeast !== "function" || tg.isVersionAtLeast("6.4"))
  );
}

type ScannerMode = "idle" | "loading" | "receipt";

export function receiptScanner(opts: ReceiptScannerOptions): ReceiptScanner {
  let busy = false;
  let mode: ScannerMode = "idle";

  const subtitle = el("span", {
    class: "receipt-scan-sub",
    text: "Сканируйте QR — сумма, дата и магазин подставятся сами",
  });
  const body = el("div", { class: "receipt-scan-body" });
  const error = el("p", { class: "receipt-scan-error", role: "alert", hidden: true });

  const root = el("section", { class: "receipt-scanner", "aria-label": "Чек из магазина" }, [
    el("div", { class: "receipt-scan-head" }, [
      el("span", { class: "receipt-scan-icon" }, [iconQr(22)]),
      el("div", { class: "receipt-scan-titles" }, [
        el("span", { class: "receipt-scan-title", text: "Чек из магазина" }),
        subtitle,
      ]),
    ]),
    body,
    error,
  ]);

  function showError(message: string): void {
    error.textContent = message;
    error.hidden = false;
  }

  function clearError(): void {
    error.textContent = "";
    error.hidden = true;
  }

  function renderLoading(): void {
    mode = "loading";
    body.replaceChildren(
      el("div", { class: "receipt-scan-loading" }, [
        el("span", { class: "receipt-scan-dot" }),
        el("span", { text: "Читаю чек…" }),
      ]),
    );
  }

  function renderIdle(): void {
    mode = "idle";
    const camera = canScanQr();
    subtitle.textContent = camera
      ? "Сканируйте QR — сумма, дата и магазин подставятся сами"
      : "Вставьте ссылку из QR-кода — сумма, дата и магазин подставятся сами";
    const linkInput = el("input", {
      class: "text-input",
      type: "url",
      inputmode: "url",
      autocapitalize: "off",
      autocomplete: "off",
      placeholder: "https://ofd.soliq.uz/check?…",
      "aria-label": "Ссылка из QR-кода чека",
    }) as HTMLInputElement;

    const pasteBtn = el("button", {
      class: "btn btn-secondary btn-block",
      type: "button",
      text: "Найти чек",
      onclick: () => {
        const text = linkInput.value.trim();
        if (text === "") {
          showError("Вставьте ссылку из QR-кода чека.");
          linkInput.focus();
          return;
        }
        void processText(text);
      },
    });

    // Без камеры сразу раскрываем поле ссылки: иначе единственный рабочий
    // способ остаётся спрятан под свёрнутым summary.
    const linkDetails = el("details", { class: "receipt-link", open: !camera }, [
      el("summary", { text: "Вставить ссылку из QR" }),
      el("div", { class: "form-stack receipt-link-form" }, [linkInput, pasteBtn]),
    ]);

    const scanBtn = el(
      "button",
      {
        class: "btn btn-primary btn-block receipt-scan-btn",
        type: "button",
        onclick: () => startScan(),
      },
      [iconQr(18), el("span", { text: "Сканировать QR-код" })],
    );

    // Без камеры не показываем заведомо нерабочую кнопку — сразу поле ссылки.
    body.replaceChildren(...(camera ? [scanBtn, linkDetails] : [linkDetails]));
  }

  function renderReceipt(lookup: ReceiptLookup): void {
    mode = "receipt";
    const receipt = lookup.receipt;
    subtitle.textContent = lookup.cached ? "Чек уже читали раньше" : "Чек распознан";
    const itemCount = receipt.items.length;
    const meta =
      `${formatDateHuman(receipt.occurredOn)} · ` +
      `${itemCount} ${plural(itemCount, ["позиция", "позиции", "позиций"])}`;

    const details: (Node | null)[] = [
      el("div", { class: "receipt-card-top" }, [
        el("span", { class: "receipt-kicker", text: "Чек" }),
        el("button", {
          class: "receipt-card-change",
          type: "button",
          text: "Другой чек",
          onclick: () => {
            opts.onClear();
            clearError();
            renderIdle();
          },
        }),
      ]),
      el("div", { class: "receipt-shop", text: lookup.shop.name }),
      el("div", { class: "receipt-meta", text: meta }),
      el("div", { class: "receipt-total", text: formatMoney(receipt.total) }),
      el("p", { class: "receipt-hint", text: "Сумма и дата подставлены. Выберите категорию ниже." }),
    ];

    if (lookup.suggestedCategoryId !== null && lookup.suggestedCategoryName !== null) {
      details.push(
        el("div", {
          class: "receipt-memory",
          text: `Обычно здесь: «${lookup.suggestedCategoryName}»`,
        }),
        el(
          "button",
          {
            class: "btn btn-primary btn-block",
            type: "button",
            text: `Сохранить в «${lookup.suggestedCategoryName}»`,
            onclick: () => opts.onQuickSave(lookup.suggestedCategoryId!),
          },
          [],
        ),
      );
    }

    body.replaceChildren(el("div", { class: "receipt-card" }, details));
  }

  async function processText(raw: string): Promise<void> {
    if (busy) return;
    busy = true;
    clearError();
    renderLoading();
    try {
      const lookup = await api.lookupReceipt(raw);
      if (lookup.receipt.transactionId !== null) {
        showError("Этот чек уже записан в ленте. Удалите ту запись, если хотите внести заново.");
        renderIdle();
        return;
      }
      opts.onReceipt(lookup);
      renderReceipt(lookup);
    } catch (e) {
      showError(e instanceof Error ? e.message : "Не удалось прочитать чек");
      renderIdle();
    } finally {
      busy = false;
    }
  }

  /** Фолбэк без камеры: раскрыть поле ссылки и поставить в него фокус. */
  function openLinkFallback(message?: string): void {
    const linkDetails = body.querySelector<HTMLDetailsElement>(".receipt-link");
    const linkInput = body.querySelector<HTMLInputElement>(".receipt-link input");
    if (linkDetails !== null) linkDetails.open = true;
    linkInput?.focus();
    if (message !== undefined) showError(message);
  }

  function startScan(): void {
    clearError();
    const tg = window.Telegram?.WebApp;

    if (!canScanQr()) {
      openLinkFallback("Камера в этом клиенте недоступна — вставьте ссылку из QR-кода.");
      return;
    }

    tg!.showScanQrPopup!({ text: "Наведите камеру на QR-код чека" }, (text) => {
      if (typeof text === "string" && text.trim() !== "") void processText(text);
      return true;
    });
  }

  renderIdle();
  return {
    root,
    start: () => {
      // Автозапуск имеет смысл только из исходного состояния: если чек уже
      // распознан, камера поверх него только мешает.
      if (mode === "idle") startScan();
    },
    reset: () => {
      clearError();
      renderIdle();
    },
  };
}
