// Правка и удаление (AC-4). Правка kind требует выбора новой категории и
// подтверждения влияния на баланс (план, раздел "Правка kind"). Замаскированные
// сюда не попадают — feed.ts не даёт их открыть.
import { el } from "../dom.js";
import { keypad } from "../keypad.js";
import { categoryGrid } from "../category-grid.js";
import { openSheet, confirmDialog } from "../sheet.js";
import { showToast } from "../toast.js";
import { formatSigned, todayYmd } from "../format.js";
import { dateField } from "../date-field.js";
import { iconWarning } from "../icons.js";
import * as api from "../api.js";
import type { Category, MaskedTransaction, TransactionKind } from "../api-types.js";

const effect = (kind: TransactionKind, amount: number): number => (kind === "income" ? amount : -amount);

export function openEditTransactionSheet(
  tx: MaskedTransaction,
  onSaved: () => void,
  onDeleted: () => void,
): void {
  if (tx.isMasked || tx.categoryId == null) return; // не должно случиться: feed.ts не открывает замаскированные

  const originalKind = tx.kind;
  const originalAmount = tx.amount;
  let kind: TransactionKind = tx.kind;
  let amount = tx.amount;
  let selectedCategoryId: number | null = tx.categoryId;
  let occurredOn = tx.occurredOn;
  let comment = tx.comment ?? "";
  let categories: Category[] = [];
  let saving = false;

  const body = el("div", { class: "tx-form" });
  const { close } = openSheet("Запись", body);

  const kindToggle = el("div", { class: "segmented" }, [
    btn("Расход", () => setKind("expense"), kind === "expense"),
    btn("Доход", () => setKind("income"), kind === "income"),
  ]);
  function btn(label: string, onclick: () => void, active: boolean): HTMLElement {
    return el("button", { class: `segmented-btn${active ? " segmented-btn-active" : ""}`, type: "button", text: label, onclick });
  }

  const pad = keypad({
    confirmLabel: "",
    initialAmount: amount,
    onConfirm: () => {},
    onDigitsChange: (v) => (amount = v),
  });
  pad.querySelector(".btn-primary")?.remove();

  const dateInput = dateField({
    value: occurredOn,
    max: todayYmd(),
    onChange: (ymd) => (occurredOn = ymd),
  });
  const commentInput = el("textarea", {
    class: "text-input",
    placeholder: "Комментарий",
    rows: 2,
    maxlength: 280,
    oninput: (e: Event) => (comment = (e.target as HTMLTextAreaElement).value),
  }) as HTMLTextAreaElement;
  commentInput.value = comment;

  const categoryHost = el("div", { class: "category-host" });
  const errorHost = el("div", { class: "form-error", role: "alert" });

  function showError(message: string): void {
    errorHost.replaceChildren(...(message ? [iconWarning(16), el("span", { text: message })] : []));
  }

  async function loadCategories(): Promise<void> {
    categoryHost.replaceChildren(el("p", { class: "muted", text: "Загрузка категорий…" }));
    try {
      categories = await api.listCategories(kind);
      renderCategories();
    } catch (e) {
      categoryHost.replaceChildren(
        el("p", { class: "form-error", text: e instanceof Error ? e.message : "Не удалось загрузить категории" }),
      );
    }
  }

  function renderCategories(): void {
    categoryHost.replaceChildren(
      categoryGrid({
        categories,
        selectedId: selectedCategoryId,
        kind,
        onSelect: (c) => {
          selectedCategoryId = c.id;
          renderCategories();
        },
        onCategoriesChanged: (list) => {
          categories = list;
          // Выбранную категорию могли удалить (=архивировать) в «Настроить» —
          // сервер её больше не отдаёт. Оставить id значило бы отправить
          // PATCH с архивной категорией и получить 400 вместо сохранения.
          if (selectedCategoryId != null && !list.some((c) => c.id === selectedCategoryId)) {
            selectedCategoryId = null;
          }
          renderCategories();
        },
      }),
    );
  }

  function setKind(next: TransactionKind): void {
    if (next === kind) return;
    kind = next;
    // AC требует новую категорию из отфильтрованного списка — сброс обязателен,
    // иначе доход останется привязан к расходной категории.
    selectedCategoryId = null;
    kindToggle.replaceChildren(
      btn("Расход", () => setKind("expense"), kind === "expense"),
      btn("Доход", () => setKind("income"), kind === "income"),
    );
    void loadCategories();
  }

  const saveBtn = el("button", { class: "btn btn-primary btn-block", type: "button", text: "Сохранить" }) as HTMLButtonElement;
  const deleteBtn = el("button", { class: "btn btn-danger-ghost btn-block", type: "button", text: "Удалить" });

  saveBtn.addEventListener("click", async () => {
    if (saving) return;
    if (amount <= 0) {
      showError("Сумма должна быть больше нуля.");
      return;
    }
    if (selectedCategoryId == null) {
      showError("Выберите категорию.");
      return;
    }
    if (kind !== originalKind) {
      const delta = effect(kind, amount) - effect(originalKind, originalAmount);
      const ok = await confirmDialog(`Это изменит баланс на ${formatSigned(delta)}`, "Сохранить");
      if (!ok) return;
    }
    saving = true;
    showError("");
    try {
      await api.updateTransaction(tx.id, {
        amount,
        kind,
        categoryId: selectedCategoryId,
        occurredOn,
        comment: comment.trim() || null,
      });
      close();
      onSaved();
    } catch (e) {
      saving = false;
      showToast(e instanceof Error ? e.message : "Не удалось сохранить изменения");
    }
  });

  deleteBtn.addEventListener("click", async () => {
    const ok = await confirmDialog("Удалить эту запись без возможности восстановить?", "Удалить");
    if (!ok) return;
    try {
      await api.deleteTransaction(tx.id);
      close();
      onDeleted();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Не удалось удалить запись");
    }
  });

  body.append(kindToggle, pad, el("div", { class: "form-stack" }, [dateInput, commentInput]), errorHost, categoryHost, saveBtn, deleteBtn);
  void loadCategories();
}
