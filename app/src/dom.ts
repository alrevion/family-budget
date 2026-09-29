// Минимальный DOM-хелпер. Полного перерендера контейнера экрана достаточно
// для размера этого приложения — vdom/диффинг был бы неоправданной
// абстракцией ради одного клиента.
type Props = Record<string, unknown> & { class?: string; text?: string; html?: string };

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (typeof value === "boolean") {
      // ARIA-состояния требуют явных "true"/"false": presence-семантика
      // (setAttribute(key, "")) даёт aria-selected="" у активного элемента
      // и полное отсутствие атрибута у остальных — скринридер не объявит
      // ни выбранный, ни невыбранный. Presence остаётся только для настоящих
      // HTML-булевых атрибутов (disabled, checked, hidden, required).
      if (key.startsWith("aria-")) node.setAttribute(key, String(value));
      else if (value) node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: Element): void {
  node.replaceChildren();
}

export function mount(container: Element, ...children: (Node | string)[]): void {
  clear(container);
  container.append(...children);
}
