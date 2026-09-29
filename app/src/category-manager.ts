// Управление категориями: переименование, удаление, добавление.
//
// Зачем отдельный экран: PATCH/DELETE /api/categories/:id существовали
// с первого дня, но их не звал ни один экран — категорию можно было только
// создать, и она оставалась навсегда. Экрана настроек в приложении нет, пятую
// вкладку заводить нельзя, поэтому вход стоит там, где потребность и
// возникает: последней плиткой в сетке выбора категории (category-grid.ts).
//
// DELETE — это АРХИВАЦИЯ (is_archived=1), а не удаление строк. Транзакции
// остаются и продолжают считаться в балансе и отчётах; категория лишь
// пропадает из выбора. Про это обязан сказать текст подтверждения: иначе
// человек уберёт «Продукты» с историей за полгода, увидит ту же сумму
// расходов и решит, что приложение сломалось.
//
// Разархивации в API нет — поэтому здесь нет и кнопки «вернуть»: показать
// её значило бы обещать действие, которого сервер не умеет.
import { el } from "./dom.js";
import { openSheet, confirmDialog } from "./sheet.js";
import { showToast } from "./toast.js";
import { emptyState, errorState } from "./states.js";
import { iconPencil, iconPlus, iconTrash, iconWarning } from "./icons.js";
import * as api from "./api.js";
import type { Category, CategoryAppliesTo } from "./api-types.js";

type AddableKind = "expense" | "income";

const GROUPS: { kind: CategoryAppliesTo; title: string; add: AddableKind | null }[] = [
  { kind: "expense", title: "Расходы", add: "expense" },
  { kind: "income", title: "Доходы", add: "income" },
  // 'both' этот клиент не создаёт, но такая категория может прийти с сервера
  // (её принимает POST /api/categories). Без своей секции она стала бы
  // невидимой и неуправляемой — единственная причина, по которой группа есть.
  { kind: "both", title: "Общие", add: null },
];

/** Ошибка рядом с полем — с иконкой: один только красный цвет не сигнал. */
function setError(host: HTMLElement, message: string): void {
  host.replaceChildren(...(message ? [iconWarning(16), el("span", { text: message })] : []));
}

function loadingBlock(): HTMLElement {
  return el(
    "div",
    { class: "skeleton catman-skeleton", "aria-busy": "true", "aria-label": "Загрузка категорий" },
    Array.from({ length: 6 }, () => el("div", { class: "skeleton-bar catman-skeleton-row" })),
  );
}

/**
 * @param onChanged вызывается после каждого успешного изменения со ВСЕМ
 * актуальным списком живых категорий (обоих типов) — фильтрацию под свой
 * kind делает вызывающая сторона, ровно как это делает сервер.
 */
export function openCategoryManager(onChanged: (categories: Category[]) => void): void {
  const body = el("div", { class: "catman" });
  openSheet("Категории", body);

  let all: Category[] = [];
  let adding: AddableKind | null = null;
  /** Созданные в этой же шторке: про них точно известно, что транзакций нет,
   *  и подтверждение можно не грузить объяснением про баланс и отчёты. */
  const createdHere = new Set<number>();

  async function load(): Promise<void> {
    body.replaceChildren(loadingBlock());
    try {
      all = await api.listAllCategories();
    } catch (e) {
      body.replaceChildren(
        errorState(e instanceof Error ? e.message : "Не удалось загрузить категории", () => void load()),
      );
      return;
    }
    render();
  }

  function render(): void {
    if (all.length === 0 && adding === null) {
      body.replaceChildren(
        emptyState("Категорий нет", "Добавьте первую — она сразу появится в выборе при вводе.", {
          label: "Добавить расходную",
          onClick: () => {
            adding = "expense";
            render();
          },
        }),
      );
      return;
    }

    const sections: HTMLElement[] = [];
    for (const g of GROUPS) {
      const items = all.filter((c) => c.appliesTo === g.kind);
      // Секция 'both' без содержимого не нужна: добавлять туда нечем.
      if (items.length === 0 && g.add === null) continue;
      sections.push(
        el("section", { class: "catman-group" }, [
          el("h3", { class: "catman-group-title", text: g.title }),
          items.length > 0
            ? el("div", { class: "catman-list" }, items.map(row))
            : el("p", { class: "muted catman-empty", text: "Пока пусто" }),
          g.add === null ? null : adding === g.add ? addForm(g.add) : addButton(g.add),
        ]),
      );
    }
    body.replaceChildren(...sections);
  }

  function addButton(kind: AddableKind): HTMLElement {
    return el(
      "button",
      {
        class: "catman-add",
        type: "button",
        onclick: () => {
          adding = kind;
          render();
        },
      },
      [iconPlus(18), el("span", { text: kind === "expense" ? "Добавить расходную" : "Добавить доходную" })],
    );
  }

  function addForm(kind: AddableKind): HTMLElement {
    const input = el("input", {
      class: "text-input",
      type: "text",
      placeholder: kind === "expense" ? "Название расходной категории" : "Название доходной категории",
      "aria-label": "Название новой категории",
      maxlength: 40,
      autocomplete: "off",
    }) as HTMLInputElement;
    const error = el("div", { class: "form-error", role: "alert" });
    const create = el("button", { class: "btn btn-primary", type: "button", text: "Добавить" }) as HTMLButtonElement;
    const cancel = el("button", {
      class: "btn btn-ghost",
      type: "button",
      text: "Отмена",
      onclick: () => {
        adding = null;
        render();
      },
    });

    const submit = async (): Promise<void> => {
      const name = input.value.trim();
      if (!name) {
        setError(error, "Введите название категории.");
        return;
      }
      create.disabled = true;
      setError(error, "");
      try {
        const created = await api.createCategory(name, kind);
        all = [...all, created];
        createdHere.add(created.id);
        adding = null;
        render();
        onChanged(all);
      } catch (e) {
        create.disabled = false;
        // 409 name_conflict уже переведён в api.ts: имя уникально в паре
        // с назначением и только среди живых, поэтому расходные и доходные
        // «Подарки» уживаются, а архивная тёзка создать новую не мешает.
        setError(error, e instanceof Error ? e.message : "Не удалось добавить категорию");
      }
    };

    create.addEventListener("click", () => void submit());
    input.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") void submit();
    });

    queueMicrotask(() => input.focus());
    return el("div", { class: "catman-form" }, [
      input,
      el("div", { class: "catman-form-actions" }, [cancel, create]),
      error,
    ]);
  }

  function row(c: Category): HTMLElement {
    const node = el("div", { class: "catman-row" });

    const view = (): void => {
      node.className = "catman-row";
      node.replaceChildren(
        el("span", { class: "catman-name", text: c.name }),
        el(
          "button",
          {
            class: "catman-action",
            type: "button",
            "aria-label": `Переименовать категорию «${c.name}»`,
            onclick: edit,
          },
          [iconPencil()],
        ),
        el(
          "button",
          {
            class: "catman-action catman-action-danger",
            type: "button",
            "aria-label": `Удалить категорию «${c.name}»`,
            onclick: () => void remove(c),
          },
          [iconTrash()],
        ),
      );
    };

    const edit = (): void => {
      const input = el("input", {
        class: "text-input",
        type: "text",
        "aria-label": `Новое название категории «${c.name}»`,
        maxlength: 40,
        autocomplete: "off",
      }) as HTMLInputElement;
      input.value = c.name;
      const error = el("div", { class: "form-error", role: "alert" });
      const save = el("button", { class: "btn btn-primary", type: "button", text: "Готово" }) as HTMLButtonElement;
      const cancel = el("button", { class: "btn btn-ghost", type: "button", text: "Отмена", onclick: view });

      const submit = async (): Promise<void> => {
        const name = input.value.trim();
        if (!name) {
          setError(error, "Название не может быть пустым.");
          return;
        }
        if (name === c.name) {
          view();
          return;
        }
        save.disabled = true;
        setError(error, "");
        try {
          await api.renameCategory(c.id, name);
          c.name = name;
          render();
          onChanged(all);
        } catch (e) {
          save.disabled = false;
          setError(error, e instanceof Error ? e.message : "Не удалось переименовать категорию");
        }
      };

      save.addEventListener("click", () => void submit());
      input.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") void submit();
      });

      node.className = "catman-row catman-row-editing";
      node.replaceChildren(input, el("div", { class: "catman-form-actions" }, [cancel, save]), error);
      input.focus();
      input.select();
    };

    view();
    return node;
  }

  async function remove(c: Category): Promise<void> {
    // Про только что созданную категорию точно известно, что записей в ней
    // нет — там объяснять нечего. Про остальные приложение честно не знает
    // (счётчика транзакций в API нет), поэтому говорит о последствиях всегда.
    const message = createdHere.has(c.id)
      ? `Удалить категорию «${c.name}»? Записей в ней нет.`
      : `Удалить категорию «${c.name}»? Она пропадёт из выбора, но записи в ней останутся — баланс и отчёты не изменятся.`;
    if (!(await confirmDialog(message, "Удалить"))) return;
    try {
      await api.archiveCategory(c.id);
      all = all.filter((x) => x.id !== c.id);
      createdHere.delete(c.id);
      render();
      onChanged(all);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Не удалось удалить категорию");
    }
  }

  void load();
}
