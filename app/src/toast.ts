// Единая точка показа неблокирующих сообщений: 409 ("Свободных денег
// недостаточно"), сетевые ошибки, подтверждения. Не alert() — перекрывает
// весь экран и плохо смотрится в Telegram Mini App.
let container: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function ensureContainer(): HTMLElement {
  if (!container) {
    container = document.createElement("div");
    container.className = "toast";
    document.body.append(container);
  }
  return container;
}

export function showToast(message: string, kind: "error" | "info" = "error"): void {
  const node = ensureContainer();
  node.textContent = message;
  node.className = `toast toast-visible toast-${kind}`;
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    node.className = "toast";
  }, 3500);
}
