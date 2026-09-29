// Три состояния экрана помимо данных: загрузка, пусто, ошибка.
//
// Скелетон вместо спиннера и порог 300мс: у скелетона `animation-delay:300ms`
// на проявлении (styles.css), поэтому быстрый ответ вообще не успевает
// показать плейсхолдер — мигания нет, JS-таймеров тоже.
import { el } from "./dom.js";

function bar(width: string, height: string, radius = "8px"): HTMLElement {
  return el("div", { class: "skeleton-bar", style: `width:${width};height:${height};border-radius:${radius}` });
}

/** Скелетон главной: одна большая карточка + две маленькие. */
export function homeSkeleton(): HTMLElement {
  return el("div", { class: "screen skeleton", "aria-busy": "true", "aria-label": "Загрузка" }, [
    el("div", { class: "hero-card" }, [bar("40%", "13px"), el("div", { style: "height:10px" }), bar("75%", "38px", "10px")]),
    el("div", { class: "secondary-row" }, [
      el("div", { class: "stat-card" }, [bar("60%", "12px"), el("div", { style: "height:10px" }), bar("85%", "20px")]),
      el("div", { class: "stat-card" }, [bar("70%", "12px"), el("div", { style: "height:10px" }), bar("80%", "20px")]),
    ]),
  ]);
}

/** Скелетон списка (лента, цели). */
export function listSkeleton(rows = 5): HTMLElement {
  return el(
    "div",
    { class: "screen skeleton", "aria-busy": "true", "aria-label": "Загрузка" },
    Array.from({ length: rows }, () =>
      el("div", { class: "skeleton-row" }, [
        el("div", { class: "skeleton-row-main" }, [bar("55%", "15px"), el("div", { style: "height:8px" }), bar("35%", "11px")]),
        bar("84px", "15px"),
      ]),
    ),
  );
}

/** Пустое состояние: что произошло + что с этим делать. */
export function emptyState(title: string, hint: string, action?: { label: string; onClick: () => void }): HTMLElement {
  return el("div", { class: "state-block" }, [
    el("p", { class: "state-title", text: title }),
    el("p", { class: "state-hint", text: hint }),
    action
      ? el("button", { class: "btn btn-secondary state-action", type: "button", text: action.label, onclick: action.onClick })
      : null,
  ]);
}

/** Ошибка: текст + путь восстановления. Без "Повторить" экран становится
 *  тупиком — переключение вкладок туда-обратно не очевидно пользователю. */
export function errorState(message: string, onRetry: () => void): HTMLElement {
  return el("div", { class: "state-block state-block-error", role: "alert" }, [
    el("p", { class: "state-title", text: "Не удалось загрузить" }),
    el("p", { class: "state-hint", text: message }),
    el("button", { class: "btn btn-primary state-action", type: "button", text: "Повторить", onclick: onRetry }),
  ]);
}
