// Шаг 10 плана: "Свободно", "В целях", ЧИСЛО "Потрачено в этом месяце"
// (не лента), кнопка "+". AC-11.
import { el, mount } from "../dom.js";
import { formatMoney, currentYm } from "../format.js";
import { openNewTransactionSheet } from "./new-transaction.js";
import * as api from "../api.js";
import { showToast } from "../toast.js";
import { homeSkeleton, errorState } from "../states.js";
import { iconPlus, iconWarning } from "../icons.js";
import type { Tab } from "../nav.js";

export interface HomeCtx {
  navigate: (tab: Tab) => void;
  refreshChrome: () => void; // перерисовать nav/badges после сохранения
}

export async function renderHome(container: HTMLElement, ctx: HomeCtx): Promise<void> {
  mount(container, homeSkeleton());

  let balance;
  let spent = 0;
  try {
    balance = await api.getBalance();
    const month = currentYm();
    const txs = await api.listTransactions(month);
    spent = txs.filter((t) => t.kind === "expense").reduce((s, t) => s + t.amount, 0);
  } catch (e) {
    mount(
      container,
      el("div", { class: "screen home-screen" }, [
        errorState(e instanceof Error ? e.message : "Не удалось загрузить данные", () => void renderHome(container, ctx)),
      ]),
    );
    return;
  }

  const freeNegative = balance.free < 0;
  const totalNegative = balance.total < 0;

  // Знак минуса передаётся не только красным цветом: рядом с суммой стоит
  // иконка и текст предупреждения (правило color-not-only).
  const warning = (text: string): HTMLElement =>
    el("p", { class: "warning-text" }, [iconWarning(), el("span", { text })]);

  const freeCard = el("div", { class: `hero-card${freeNegative ? " hero-card-danger" : ""}` }, [
    el("div", { class: "hero-label", text: "Свободно" }),
    el("div", { class: `hero-value${freeNegative ? " negative" : ""}`, text: formatMoney(balance.free) }),
    freeNegative ? warning("Отложено больше, чем есть. Верните деньги из цели или поправьте доход.") : null,
    totalNegative ? warning("Расходы превышают доходы. Проверьте, не удалён ли стартовый остаток.") : null,
  ]);

  const secondaryRow = el("div", { class: "secondary-row" }, [
    el("div", { class: "stat-card" }, [
      el("div", { class: "stat-label", text: "В целях" }),
      el("div", { class: "stat-value", text: formatMoney(balance.inGoals) }),
    ]),
    el(
      "button",
      {
        class: "stat-card stat-card-tappable",
        type: "button",
        onclick: () => ctx.navigate("feed"),
      },
      [
        el("div", { class: "stat-label", text: "Потрачено в этом месяце" }),
        el("div", { class: "stat-value", text: formatMoney(spent) }),
      ],
    ),
  ]);

  const fab = el(
    "button",
    {
      class: "fab",
      type: "button",
      "aria-label": "Добавить запись",
      onclick: () =>
        openNewTransactionSheet(
          () => {
            showToast("Запись сохранена", "info");
            void renderHome(container, ctx);
            ctx.refreshChrome();
          },
          undefined,
          { autoScan: true },
        ),
    },
    [iconPlus()],
  );

  mount(container, el("div", { class: "screen home-screen" }, [freeCard, secondaryRow]), fab);
}
