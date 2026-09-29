// R4.6: единственный ответ на 401 — сообщение + WebApp.close(). НЕ
// location.reload(): initData во фрагменте URL переживёт перезагрузку,
// auth_date останется тем же просроченным -> бесконечный цикл 401.
import { el, mount } from "../dom.js";

export function renderSessionExpired(container: HTMLElement): void {
  mount(
    container,
    el("div", { class: "screen session-expired-screen" }, [
      el("p", { class: "session-expired-text", text: "Сессия устарела, откройте приложение заново" }),
    ]),
  );
  window.Telegram?.WebApp.close();
}
