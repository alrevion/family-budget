// AC-1/AC-2: сумма -> категория -> сохранить, без промежуточного экрана
// подтверждения — тап по категории и есть сохранение. AC-5: флаг "скрытая"
// доступен только для расходов, с обязательным текстом предупреждения (R3).
import { el } from "../dom.js";
import { keypad } from "../keypad.js";
import { categoryGrid } from "../category-grid.js";
import { openSheet } from "../sheet.js";
import { showToast } from "../toast.js";
import { todayYmd } from "../format.js";
import { dateField } from "../date-field.js";
import { iconWarning } from "../icons.js";
import * as api from "../api.js";
import type { Category, HideOption, TransactionKind } from "../api-types.js";

const HIDDEN_OPTIONS: { value: HideOption; label: string }[] = [
  { value: "1d", label: "1 день" },
  { value: "1w", label: "1 неделя" },
  { value: "1m", label: "1 месяц" },
  { value: "6m", label: "Полгода" },
];

/**
 * @param initialDate 'YYYY-MM-DD' — дата, на которой открыть форму. Приходит
 * из кнопки догона в cron-напоминании (?add=); проверена в main.ts. Без неё —
 * сегодня, как при обычном открытии с главной.
 */
export function openNewTransactionSheet(onSaved: () => void, initialDate?: string): void {
  // `as TransactionKind`: без него TS сужает let-переменную до литерала
  // "expense" в месте объявления и ругается на "kind === 'income'" ниже
  // как на заведомо ложное сравнение (сужение живёт до первого setKind()).
  let kind = "expense" as TransactionKind;
  let amount = 0;
  let occurredOn = initialDate ?? todayYmd();
  let comment = "";
  let hidden: HideOption | null = null;
  let categories: Category[] = [];
  let saving = false;

  const body = el("div", { class: "tx-form" });
  const { close } = openSheet("Новая запись", body);

  const kindToggle = el("div", { class: "segmented" }, [
    el("button", {
      class: `segmented-btn${kind === "expense" ? " segmented-btn-active" : ""}`,
      type: "button",
      text: "Расход",
      onclick: () => setKind("expense"),
    }),
    el("button", {
      class: `segmented-btn${kind === "income" ? " segmented-btn-active" : ""}`,
      type: "button",
      text: "Доход",
      onclick: () => setKind("income"),
    }),
  ]);

  const pad = keypad({
    confirmLabel: "",
    onConfirm: () => {},
    onDigitsChange: (v) => (amount = v),
  });
  // Кнопка подтверждения клавиатуры не нужна в этой форме — сумма вводится
  // свободно, следующий шаг это тап по категории.
  pad.querySelector(".btn-primary")?.remove();

  const dateInput = dateField({
    value: occurredOn,
    max: todayYmd(),
    onChange: (ymd) => (occurredOn = ymd),
  });

  const commentInput = el("textarea", {
    class: "text-input",
    placeholder: "Комментарий (необязательно)",
    rows: 2,
    maxlength: 280,
    oninput: (e: Event) => (comment = (e.target as HTMLTextAreaElement).value),
  });

  const hiddenWarning = el("p", {
    class: "hidden-warning",
    text: "Партнёр увидит сумму, дату и выбранный срок — но не категорию и не комментарий.",
  });
  const hiddenOptionsRow = el(
    "div",
    { class: "segmented segmented-wrap" },
    HIDDEN_OPTIONS.map((o) =>
      el(
        "button",
        {
          class: `segmented-btn${hidden === o.value ? " segmented-btn-active" : ""}`,
          type: "button",
          onclick: () => {
            hidden = o.value;
            renderHiddenSection();
          },
        },
        [o.label],
      ),
    ),
  );
  const hiddenToggle = el("label", { class: "checkbox-row" }, [
    el("input", {
      type: "checkbox",
      onchange: (e: Event) => {
        const on = (e.target as HTMLInputElement).checked;
        hidden = on ? "1w" : null;
        renderHiddenSection();
      },
    }),
    el("span", { text: "Скрытая трата" }),
  ]);
  const hiddenSection = el("div", { class: "hidden-section" });
  function renderHiddenSection(): void {
    // Пустой <div> оставлял бы после себя gap контейнера .tx-form — секция
    // должна исчезать полностью (styles.css: .hidden-section:empty).
    hiddenSection.replaceChildren(...(hidden !== null ? [hiddenOptionsRow, hiddenWarning] : []));
  }
  renderHiddenSection();

  const hiddenToggleRow = el("div", { class: "hidden-toggle-row" });
  function renderHiddenToggleRow(): void {
    hiddenToggleRow.replaceChildren(...(kind === "expense" ? [hiddenToggle] : []));
    if (kind !== "expense" && hidden !== null) {
      hidden = null;
      renderHiddenSection();
    }
  }
  renderHiddenToggleRow();

  // Форма открыта с чужой датой — секцию раскрываем сразу, иначе дата
  // «за прошлую пятницу» осталась бы спрятанной под свёрнутым summary.
  const details = el("details", { class: "tx-details", open: initialDate !== undefined }, [
    el("summary", { text: "Дата, комментарий" }),
    el("div", { class: "form-stack" }, [dateInput, commentInput]),
  ]);

  const categoryHost = el("div", { class: "category-host" });
  const errorHost = el("div", { class: "form-error", role: "alert" });

  /** Ошибка формы — с иконкой: один только красный цвет не сигнал (color-not-only). */
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
        selectedId: null,
        kind,
        onSelect: (c) => void save(c.id),
        onCategoriesChanged: (list) => {
          categories = list;
          renderCategories();
        },
      }),
    );
  }

  function setKind(next: TransactionKind): void {
    kind = next;
    kindToggle.querySelectorAll(".segmented-btn").forEach((btn, i) => {
      btn.classList.toggle("segmented-btn-active", (i === 0) === (next === "expense"));
    });
    renderHiddenToggleRow();
    void loadCategories();
  }

  async function save(categoryId: number): Promise<void> {
    if (saving) return;
    if (amount <= 0) {
      showError("Введите сумму больше нуля.");
      return;
    }
    saving = true;
    showError("");
    try {
      await api.createTransaction({
        amount,
        kind,
        categoryId,
        occurredOn,
        comment: comment.trim() || null,
        ...(hidden ? { hide: hidden } : {}),
      });
      close();
      onSaved();
    } catch (e) {
      saving = false;
      showToast(e instanceof Error ? e.message : "Не удалось сохранить запись");
    }
  }

  body.append(kindToggle, pad, hiddenToggleRow, hiddenSection, details, errorHost, categoryHost);

  void loadCategories();
}
