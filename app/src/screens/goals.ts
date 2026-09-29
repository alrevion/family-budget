// Шаг 12 плана: прогресс-бары, создание, "Отложить в цель", возврат,
// архивация. 409 -> человеческий текст через toast (api.ts#ApiConflictError).
import { el, mount } from "../dom.js";
import { formatMoney } from "../format.js";
import { keypad } from "../keypad.js";
import { openSheet, confirmDialog } from "../sheet.js";
import { showToast } from "../toast.js";
import { listSkeleton, emptyState, errorState } from "../states.js";
import { iconClose } from "../icons.js";
import * as api from "../api.js";
import { ApiConflictError } from "../api.js";
import type { Goal } from "../api-types.js";

export async function renderGoals(container: HTMLElement, onChanged: () => void): Promise<void> {
  async function load(): Promise<void> {
    mount(container, listSkeleton(3));
    let goals: Goal[];
    try {
      goals = await api.listGoals();
    } catch (e) {
      mount(
        container,
        el("div", { class: "screen goals-screen" }, [
          errorState(e instanceof Error ? e.message : "Не удалось загрузить цели", () => void load()),
        ]),
      );
      return;
    }
    render(goals);
  }

  function render(goals: Goal[]): void {
    const live = goals.filter((g) => !g.isArchived);
    const list =
      live.length === 0
        ? emptyState(
            "Пока нет целей",
            "Цель откладывает часть свободных денег, чтобы их не потратить. Например: отпуск, ремонт, подушка безопасности.",
          )
        : el("div", { class: "goal-list" }, live.map(goalCard));

    const createBtn = el("button", {
      class: "btn btn-primary btn-block",
      type: "button",
      text: "Создать цель",
      onclick: openCreateGoal,
    });

    mount(container, el("div", { class: "screen goals-screen" }, [list, createBtn]));
  }

  function goalCard(g: Goal): HTMLElement {
    const pct = g.targetAmount > 0 ? Math.min(100, Math.round((g.saved / g.targetAmount) * 100)) : 0;
    const remaining = Math.max(0, g.targetAmount - g.saved);
    return el("div", { class: "goal-card" }, [
      el("div", { class: "goal-card-header" }, [
        el("div", { class: "goal-name", text: g.name }),
        el(
          "button",
          { class: "goal-archive", type: "button", "aria-label": `Архивировать цель «${g.name}»`, onclick: () => archive(g) },
          [iconClose(18)],
        ),
      ]),
      el(
        "div",
        {
          class: "progress-track",
          role: "progressbar",
          "aria-valuenow": String(pct),
          "aria-valuemin": "0",
          "aria-valuemax": "100",
          "aria-label": `Прогресс цели «${g.name}»`,
        },
        [el("div", { class: "progress-fill", style: `width:${pct}%` })],
      ),
      el("div", { class: "goal-stats" }, [
        el("span", { text: `${formatMoney(g.saved)} / ${formatMoney(g.targetAmount)}` }),
        el("span", { text: `${pct}%` }),
      ]),
      el("div", { class: "goal-stats muted", text: remaining > 0 ? `Осталось ${formatMoney(remaining)}` : "Цель достигнута" }),
      el("div", { class: "goal-actions" }, [
        el("button", { class: "btn btn-secondary", type: "button", text: "Отложить", onclick: () => openAllocate(g, "allocate") }),
        el("button", { class: "btn btn-ghost", type: "button", text: "Вернуть", onclick: () => openAllocate(g, "deallocate") }),
      ]),
    ]);
  }

  async function archive(g: Goal): Promise<void> {
    const ok = await confirmDialog(`Архивировать цель «${g.name}»? Отложенные деньги вернутся в свободные.`, "Архивировать");
    if (!ok) return;
    try {
      await api.archiveGoal(g.id);
      await load();
      onChanged();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Не удалось архивировать цель");
    }
  }

  function openAllocate(g: Goal, mode: "allocate" | "deallocate"): void {
    const pad = keypad({
      confirmLabel: mode === "allocate" ? "Отложить" : "Вернуть в свободные",
      onConfirm: async (amount) => {
        try {
          if (mode === "allocate") await api.allocateToGoal(g.id, amount);
          else await api.deallocateFromGoal(g.id, amount);
          close();
          await load();
          onChanged();
        } catch (e) {
          const msg = e instanceof ApiConflictError ? e.message : e instanceof Error ? e.message : "Не удалось сохранить";
          showToast(msg);
        }
      },
    });
    const { close } = openSheet(mode === "allocate" ? `Отложить в «${g.name}»` : `Вернуть из «${g.name}»`, pad);
  }

  function openCreateGoal(): void {
    const nameInput = el("input", { class: "text-input", type: "text", placeholder: "Название цели", maxlength: 60 }) as HTMLInputElement;
    const pad = keypad({
      confirmLabel: "Создать",
      onConfirm: async (amount) => {
        const name = nameInput.value.trim();
        if (!name) {
          showToast("Введите название цели");
          return;
        }
        try {
          await api.createGoal(name, amount);
          close();
          await load();
          onChanged();
        } catch (e) {
          showToast(e instanceof Error ? e.message : "Не удалось создать цель");
        }
      },
    });
    const { close } = openSheet("Новая цель", el("div", { class: "form-stack" }, [nameInput, pad]));
  }

  await load();
}
