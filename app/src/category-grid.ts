// Общая сетка категорий: форма создания и правка транзакции (в т.ч. смена
// kind, план R "Правка kind"). Фильтр applies_to IN (kind, 'both')
// выполняется сервером в GET /api/categories?kind=; здесь только выбор.
import { el } from "./dom.js";
import type { Category, TransactionKind } from "./api-types.js";
import * as api from "./api.js";
import { openSheet } from "./sheet.js";
import { openCategoryManager } from "./category-manager.js";
import { iconPlus, iconSliders } from "./icons.js";
import { showToast } from "./toast.js";

export interface CategoryGridOptions {
  categories: Category[];
  selectedId: number | null;
  kind: TransactionKind;
  onSelect: (category: Category) => void;
  onCategoriesChanged?: (categories: Category[]) => void;
}

export function categoryGrid(opts: CategoryGridOptions): HTMLElement {
  const live = opts.categories.filter((c) => !c.isArchived);
  const tiles = live.map((c) =>
    el(
      "button",
      {
        class: `category-tile${c.id === opts.selectedId ? " category-tile-selected" : ""}`,
        type: "button",
        onclick: () => opts.onSelect(c),
      },
      [c.name],
    ),
  );

  // Две служебные плитки в конце сетки. Быстрое добавление остаётся одним
  // тапом (горячий путь при вводе траты), а «Настроить» — единственный вход
  // в переименование и удаление: отдельная вкладка настроек перегрузила бы
  // нижнюю навигацию, где уже пять разделов. Обе плитки визуально отделены
  // от категорий (пунктир + цвет ссылки), чтобы не путались с сохранением.
  tiles.push(
    el(
      "button",
      {
        class: "category-tile category-tile-utility",
        type: "button",
        onclick: () => openAddCategorySheet(opts),
      },
      [iconPlus(18), el("span", { text: "Своя категория" })],
    ),
    el(
      "button",
      {
        class: "category-tile category-tile-utility",
        type: "button",
        onclick: () =>
          openCategoryManager((all) => {
            // Тот же фильтр, что делает сервер для GET /api/categories?kind=.
            opts.onCategoriesChanged?.(
              all.filter((c) => c.appliesTo === opts.kind || c.appliesTo === "both"),
            );
          }),
      },
      [iconSliders(18), el("span", { text: "Настроить" })],
    ),
  );

  return el("div", { class: "category-grid" }, tiles);
}

function openAddCategorySheet(opts: CategoryGridOptions): void {
  const input = el("input", {
    class: "text-input",
    type: "text",
    placeholder: "Название категории",
    maxlength: 40,
  }) as HTMLInputElement;
  const saveBtn = el("button", { class: "btn btn-primary btn-block", type: "button", text: "Добавить" });

  const { close } = openSheet("Своя категория", el("div", { class: "form-stack" }, [input, saveBtn]));

  saveBtn.addEventListener("click", async () => {
    const name = input.value.trim();
    if (!name) return;
    try {
      const created = await api.createCategory(name, opts.kind);
      close();
      opts.onCategoriesChanged?.([...opts.categories, created]);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Не удалось создать категорию");
    }
  });
  input.focus();
}
