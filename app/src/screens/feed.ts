// Шаг 11 плана: лента — единственный вход в правку и удаление (AC-4).
// Замаскированные записи не открываются на редактирование (R3).
import { el, mount } from "../dom.js";
import { formatMoney, formatDateHuman, currentYm, formatMonthHuman } from "../format.js";
import * as api from "../api.js";
import { showToast } from "../toast.js";
import { listSkeleton, emptyState, errorState } from "../states.js";
import { iconArrowLeft, iconArrowRight } from "../icons.js";
import { openEditTransactionSheet } from "./edit-transaction.js";
import type { Category, MaskedTransaction, User } from "../api-types.js";

/** Свой telegram_id — из initDataUnsafe. Нужен только чтобы отличить «Я» от имени партнёра. */
const myId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id ?? null;

export async function renderFeed(container: HTMLElement, onChanged: () => void): Promise<void> {
  let month = currentYm();

  async function load(): Promise<void> {
    mount(container, listSkeleton());
    let txs: MaskedTransaction[];
    let expenseCats: Category[];
    let incomeCats: Category[];
    let users: User[];
    try {
      [txs, expenseCats, incomeCats, users] = await Promise.all([
        api.listTransactions(month),
        api.listCategories("expense"),
        api.listCategories("income"),
        api.listUsers(),
      ]);
    } catch (e) {
      mount(
        container,
        el("div", { class: "screen feed-screen" }, [
          errorState(e instanceof Error ? e.message : "Не удалось загрузить ленту", () => void load()),
        ]),
      );
      return;
    }
    const catById = new Map<number, Category>([...expenseCats, ...incomeCats].map((c) => [c.id, c]));
    const nameById = new Map<number, string>(users.map((u) => [u.telegramId, u.name]));
    render(txs, catById, nameById);
  }

  function render(
    txs: MaskedTransaction[],
    catById: Map<number, Category>,
    nameById: Map<number, string>,
  ): void {
    const monthSwitcher = el("div", { class: "month-switcher" }, [
      el("button", { class: "month-nav", type: "button", "aria-label": "Предыдущий месяц", onclick: () => shift(-1) }, [
        iconArrowLeft(),
      ]),
      el("div", { class: "month-switcher-label", text: formatMonthHuman(month) }),
      el("button", { class: "month-nav", type: "button", "aria-label": "Следующий месяц", onclick: () => shift(1) }, [
        iconArrowRight(),
      ]),
    ]);

    // Порядок приходит с сервера: ORDER BY occurred_on DESC, id DESC.
    // Клиентская пересортировка была здесь и ломала порядок внутри одного
    // дня: компаратор `a.occurredOn < b.occurredOn ? 1 : -1` для РАВНЫХ дат
    // возвращает -1 вместо 0, то есть нарушает контракт сравнения и
    // переставляет одинаковые элементы. Из-за этого последняя запись дня
    // оказывалась не сверху. Тай-брейк по id клиент всё равно сделать не мог
    // бы корректнее сервера — просто не трогаем порядок.
    const list =
      txs.length === 0
        ? emptyState(
            "В этом месяце пока нет записей",
            "Записи появятся здесь после первой траты или дохода. Добавить их можно кнопкой «+» на главной.",
          )
        : el(
            "ul",
            { class: "tx-list" },
            txs.map((t) => txRow(t, catById, nameById)),
          );

    mount(container, el("div", { class: "screen feed-screen" }, [monthSwitcher, list]));
  }

  function shift(delta: number): void {
    const [y, m] = month.split("-").map(Number);
    const d = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1 + delta, 1));
    month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    void load();
  }

  /**
   * «Кто внёс» — в ту же вторичную строку, что дата и комментарий: отдельной
   * строки в ряду нет места, а сумма с категорией обязаны остаться главными.
   *
   * Замаскированная запись сюда не доходит (отдельная ветка в txRow) и подписи
   * не получает: при двух пользователях «скрыл партнёр» и так очевидно, а лишняя
   * надпись только притягивает внимание к подарку.
   *
   * «изменено» без имени, когда правил сам автор: имя там было бы шумом.
   * Формулировка безличная — пол пользователя из БД неизвестен.
   */
  function authorLine(t: MaskedTransaction, nameById: Map<number, string>): string {
    if (t.authorId == null) return "";
    const who = (id: number): string =>
      id === myId ? "Я" : (nameById.get(id) ?? "Партнёр");
    const author = who(t.authorId);
    if (t.editedBy == null) return author;
    return t.editedBy === t.authorId ? `${author} · изменено` : `${author} · изменено: ${who(t.editedBy)}`;
  }

  function txRow(
    t: MaskedTransaction,
    catById: Map<number, Category>,
    nameById: Map<number, string>,
  ): HTMLElement {
    if (t.isMasked) {
      return el(
        "li",
        { class: "tx-row tx-row-masked" },
        [
          el("div", { class: "tx-row-main" }, [
            // Дата раскрытия ушла в подпись: в одной строке с заголовком она
            // обрезалась многоточием на 375px и пользователь терял главное —
            // когда трата станет видимой.
            el("div", { class: "tx-row-title", text: "Скрытая трата" }),
            el("div", {
              class: "tx-row-sub",
              text: `${formatDateHuman(t.occurredOn)} · раскроется ${t.revealsOn ? formatDateHuman(t.revealsOn) : "позже"}`,
            }),
          ]),
          el("div", { class: "tx-row-amount expense", text: `−${formatMoney(t.amount)}` }),
        ],
      );
    }
    const category = t.categoryId != null ? catById.get(t.categoryId) : undefined;
    const sign = t.kind === "expense" ? "−" : "+";
    return el(
      "li",
      {
        class: "tx-row",
        role: "button",
        tabindex: "0",
        onclick: () =>
          openEditTransactionSheet(t, () => {
            showToast("Изменения сохранены", "info");
            void load();
            onChanged();
          }, () => {
            void load();
            onChanged();
          }),
      },
      [
        el("div", { class: "tx-row-main" }, [
          el("div", { class: "tx-row-title", text: category?.name ?? "Без категории" }),
          // Авторство первым: при обрезке многоточием на 375px оно обязано
          // уцелеть — ради него подпись и появилась.
          el("div", {
            class: "tx-row-sub",
            text: [authorLine(t, nameById), formatDateHuman(t.occurredOn), t.comment]
              .filter(Boolean)
              .join(" · "),
          }),
        ]),
        el("div", { class: `tx-row-amount ${t.kind}`, text: `${sign}${formatMoney(t.amount)}` }),
      ],
    );
  }

  await load();
}
