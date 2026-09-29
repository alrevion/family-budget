// Шаг 9 плана: онбординг живёт в Mini App, не в боте (бот принимает суммы
// только текстом, что заказчик отклонил). Показывается, пока
// app_state.onboarding_done не выставлен.
import { mount, el } from "../dom.js";
import { keypad } from "../keypad.js";
import * as api from "../api.js";
import { showToast } from "../toast.js";

export function renderOnboarding(container: HTMLElement, onDone: () => void): void {
  let busy = false;

  const pad = keypad({
    confirmLabel: "Продолжить",
    onConfirm: async (amount) => {
      if (busy) return;
      busy = true;
      confirmBtnDisable(true);
      try {
        await api.completeOnboarding(amount);
        onDone();
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Не удалось сохранить");
        busy = false;
        confirmBtnDisable(false);
      }
    },
  });

  function confirmBtnDisable(v: boolean): void {
    const btn = pad.querySelector<HTMLButtonElement>(".btn-primary");
    if (btn) btn.disabled = v;
  }

  mount(
    container,
    el("div", { class: "screen onboarding-screen" }, [
      el("h1", { class: "onboarding-title", text: "Сколько у вас сейчас денег?" }),
      el("p", { class: "onboarding-sub", text: "Это стартовый остаток — общая сумма на руках и счетах сейчас. Дальше будете вносить только траты и доходы." }),
      pad,
    ]),
  );
}
