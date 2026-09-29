// Полноэкранный оверлей для форм (создание/правка транзакции, цели).
// Один механизм на всё приложение вместо отдельного роутинга под каждую форму.
import { el } from "./dom.js";
import { iconClose } from "./icons.js";

export function openSheet(title: string, content: HTMLElement): { close: () => void } {
  const overlay = el("div", { class: "sheet-overlay", role: "dialog", "aria-modal": "true" });
  const close = (): void => overlay.remove();

  const sheet = el("div", { class: "sheet" }, [
    el("div", { class: "sheet-header" }, [
      el("h2", { class: "sheet-title", text: title }),
      el(
        "button",
        { class: "sheet-close", type: "button", "aria-label": "Закрыть", onclick: close },
        [iconClose()],
      ),
    ]),
    el("div", { class: "sheet-body" }, [content]),
  ]);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.append(sheet);
  document.body.append(overlay);
  return { close };
}

export function confirmDialog(message: string, confirmLabel = "Подтвердить"): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = el("div", { class: "confirm-overlay" });
    const finish = (result: boolean): void => {
      overlay.remove();
      resolve(result);
    };
    overlay.append(
      el("div", { class: "confirm-box" }, [
        el("p", { class: "confirm-message", text: message }),
        el("div", { class: "confirm-actions" }, [
          el("button", {
            class: "btn btn-ghost",
            type: "button",
            text: "Отмена",
            onclick: () => finish(false),
          }),
          el("button", {
            class: "btn btn-primary",
            type: "button",
            text: confirmLabel,
            onclick: () => finish(true),
          }),
        ]),
      ]),
    );
    document.body.append(overlay);
  });
}
