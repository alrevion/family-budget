// Фильтры отчёта: категории (много), автор, тип операции, диапазон сумм.
//
// Почему шторка, а не <select multiple>: на мобильном множественный выбор в
// нативном селекте требует удержания/скролла внутри крошечного попапа и на
// iOS выглядит списком без чекбоксов — промахнуться и снять весь выбор проще,
// чем выбрать нужное. Здесь строки-чекбоксы по 44px и поиск: 12+ категорий
// иначе не находятся.
//
// Активные фильтры ВСЕГДА видны свёрнутыми чипами: цифры отчёта меняются
// молча, и без напоминания пользователь решит, что данные потерялись.
import { el } from "./dom.js";
import { formatMoney } from "./format.js";
import { iconClose, iconWarning } from "./icons.js";
import { openSheet } from "./sheet.js";
import type { Category, ReportFilters, TransactionKind } from "./api-types.js";

export interface AuthorRef {
  id: number;
  name: string;
}

export const emptyFilters = (): ReportFilters => ({
  categories: [],
  author: null,
  kind: null,
  min: null,
  max: null,
});

export function filtersCount(f: ReportFilters): number {
  return (
    f.categories.length +
    (f.author != null ? 1 : 0) +
    (f.kind != null ? 1 : 0) +
    (f.min != null || f.max != null ? 1 : 0)
  );
}

const KIND_LABEL: Record<TransactionKind, string> = { expense: "Только расходы", income: "Только доходы" };

/** Имя автора глазами смотрящего: свою запись логичнее видеть как «Я». */
export function authorLabel(a: AuthorRef, viewerId: number | null): string {
  return a.id === viewerId ? "Я" : a.name;
}

interface Chip {
  label: string;
  remove: () => ReportFilters;
}

function chips(f: ReportFilters, categories: Category[], authors: AuthorRef[], viewerId: number | null): Chip[] {
  const list: Chip[] = [];
  const nameById = new Map(categories.map((c) => [c.id, c.name]));

  for (const id of f.categories) {
    list.push({
      label: nameById.get(id) ?? `Категория ${id}`,
      remove: () => ({ ...f, categories: f.categories.filter((x) => x !== id) }),
    });
  }
  if (f.author != null) {
    const author = authors.find((a) => a.id === f.author);
    list.push({
      label: author ? authorLabel(author, viewerId) : `Автор ${f.author}`,
      remove: () => ({ ...f, author: null }),
    });
  }
  if (f.kind != null) {
    list.push({ label: KIND_LABEL[f.kind], remove: () => ({ ...f, kind: null }) });
  }
  if (f.min != null || f.max != null) {
    const label =
      f.min != null && f.max != null
        ? `${formatMoney(f.min)} – ${formatMoney(f.max)}`
        : f.min != null
          ? `от ${formatMoney(f.min)}`
          : `до ${formatMoney(f.max as number)}`;
    list.push({ label, remove: () => ({ ...f, min: null, max: null }) });
  }
  return list;
}

export interface FilterBarOptions {
  filters: ReportFilters;
  categories: Category[];
  authors: AuthorRef[];
  viewerId: number | null;
  onChange: (next: ReportFilters) => void;
}

export function filterBar(opts: FilterBarOptions): HTMLElement {
  const active = chips(opts.filters, opts.categories, opts.authors, opts.viewerId);
  const count = filtersCount(opts.filters);

  const openBtn = el("button", {
    class: `btn btn-secondary filter-open${count > 0 ? " filter-open-active" : ""}`,
    type: "button",
    text: count > 0 ? `Фильтры · ${count}` : "Фильтры",
    onclick: () => openFiltersSheet(opts),
  });

  const row = el("div", { class: "filter-bar" }, [
    openBtn,
    active.length > 0
      ? el("button", {
          class: "btn btn-ghost filter-reset",
          type: "button",
          text: "Сбросить",
          onclick: () => opts.onChange(emptyFilters()),
        })
      : null,
  ]);

  if (active.length === 0) return el("div", { class: "filter-block" }, [row]);

  const chipRow = el(
    "div",
    { class: "chip-row", role: "list", "aria-label": "Активные фильтры" },
    active.map((chip) =>
      el(
        "button",
        {
          class: "chip",
          type: "button",
          role: "listitem",
          "aria-label": `Убрать фильтр: ${chip.label}`,
          onclick: () => opts.onChange(chip.remove()),
        },
        [el("span", { class: "chip-label", text: chip.label }), iconClose(14)],
      ),
    ),
  );

  return el("div", { class: "filter-block" }, [row, chipRow]);
}

/** '1 200 000' / '1200000' -> 1200000; пусто -> null. */
function parseAmount(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, "");
  return digits === "" ? null : Number(digits);
}

function segmented<T>(
  label: string,
  options: { value: T; label: string }[],
  current: T,
  onPick: (v: T) => void,
): HTMLElement {
  const group = el("div", { class: "segmented segmented-wrap", role: "group", "aria-label": label });
  const buttons = options.map((o) =>
    el("button", {
      class: `segmented-btn${o.value === current ? " segmented-btn-active" : ""}`,
      type: "button",
      text: o.label,
      "aria-pressed": String(o.value === current),
      onclick: () => {
        current = o.value;
        buttons.forEach((b, i) => {
          const on = options[i]?.value === current;
          b.classList.toggle("segmented-btn-active", on);
          b.setAttribute("aria-pressed", String(on));
        });
        onPick(o.value);
      },
    }),
  );
  group.append(...buttons);
  return group;
}

function field(title: string, control: HTMLElement): HTMLElement {
  return el("div", { class: "filter-field" }, [el("h3", { class: "filter-field-title", text: title }), control]);
}

export function openFiltersSheet(opts: FilterBarOptions): void {
  let draft: ReportFilters = { ...opts.filters, categories: [...opts.filters.categories] };
  const selected = new Set(draft.categories);

  const search = el("input", {
    class: "text-input",
    type: "search",
    placeholder: "Поиск категории",
    "aria-label": "Поиск категории",
    autocomplete: "off",
  }) as HTMLInputElement;

  const list = el("div", { class: "filter-category-list", role: "group", "aria-label": "Категории" });
  const summary = el("p", { class: "filter-summary" });

  const renderSummary = (): void => {
    summary.textContent =
      selected.size === 0 ? "Все категории" : `Выбрано категорий: ${selected.size}`;
  };

  const renderList = (): void => {
    const query = search.value.trim().toLowerCase();
    const visible = opts.categories.filter((c) => c.name.toLowerCase().includes(query));
    list.replaceChildren(
      ...(visible.length === 0
        ? [el("p", { class: "muted", text: "Ничего не нашлось" })]
        : visible.map((c) => {
            const box = el("input", { type: "checkbox", checked: selected.has(c.id) }) as HTMLInputElement;
            box.addEventListener("change", () => {
              if (box.checked) selected.add(c.id);
              else selected.delete(c.id);
              renderSummary();
            });
            return el("label", { class: "checkbox-row" }, [box, el("span", { text: c.name })]);
          })),
    );
  };

  search.addEventListener("input", renderList);
  renderList();
  renderSummary();

  const minInput = el("input", {
    class: "text-input",
    type: "text",
    inputmode: "numeric",
    placeholder: "от",
    "aria-label": "Сумма от",
    value: draft.min != null ? String(draft.min) : "",
  }) as HTMLInputElement;
  const maxInput = el("input", {
    class: "text-input",
    type: "text",
    inputmode: "numeric",
    placeholder: "до",
    "aria-label": "Сумма до",
    value: draft.max != null ? String(draft.max) : "",
  }) as HTMLInputElement;

  const error = el("p", { class: "form-error", role: "alert" });

  const authorOptions = [
    { value: null as number | null, label: "Оба" },
    ...opts.authors.map((a) => ({ value: a.id as number | null, label: authorLabel(a, opts.viewerId) })),
  ];

  const apply = el("button", { class: "btn btn-primary btn-block", type: "button", text: "Применить" });

  const { close } = openSheet(
    "Фильтры",
    el("div", { class: "form-stack filter-sheet" }, [
      field(
        "Категории",
        el("div", { class: "filter-category-block" }, [
          search,
          summary,
          list,
          el("button", {
            class: "btn btn-ghost filter-clear-categories",
            type: "button",
            text: "Снять выбор",
            onclick: () => {
              selected.clear();
              renderList();
              renderSummary();
            },
          }),
        ]),
      ),
      opts.authors.length > 1
        ? field(
            "Автор",
            segmented("Автор", authorOptions, draft.author, (v) => {
              draft = { ...draft, author: v };
            }),
          )
        : null,
      field(
        "Тип операции",
        segmented<TransactionKind | null>(
          "Тип операции",
          [
            { value: null, label: "Все" },
            { value: "expense", label: "Расходы" },
            { value: "income", label: "Доходы" },
          ],
          draft.kind,
          (v) => {
            draft = { ...draft, kind: v };
          },
        ),
      ),
      field("Сумма операции", el("div", { class: "filter-amount-row" }, [minInput, maxInput])),
      error,
      el("div", { class: "filter-actions" }, [
        el("button", {
          class: "btn btn-ghost",
          type: "button",
          text: "Сбросить всё",
          onclick: () => {
            close();
            opts.onChange(emptyFilters());
          },
        }),
        apply,
      ]),
    ]),
  );

  apply.addEventListener("click", () => {
    const min = parseAmount(minInput.value);
    const max = parseAmount(maxInput.value);
    // Ловим здесь, а не ответом 400 bad_amount_range: подсказка рядом с полем
    // понятнее, чем красная плашка поверх уже отрисованного отчёта.
    if (min != null && max != null && min > max) {
      error.replaceChildren(iconWarning(16), el("span", { text: "Сумма «от» больше суммы «до»" }));
      return;
    }
    close();
    opts.onChange({ ...draft, categories: [...selected], min, max });
  });
}
