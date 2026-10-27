// Раздел «Магазины»: какие магазины уже встречались в QR-чеках, сколько
// потрачено и какая категория запомнена для следующего сканирования.
//
// Список — это память, а не бухгалтерия: суммы и количество покупок считаются
// по чекам, привязанным к сохранённым тратам.
import { el, mount } from "../dom.js";
import { formatDateHuman, formatMoney } from "../format.js";
import { categoryGrid } from "../category-grid.js";
import { openSheet } from "../sheet.js";
import { showToast } from "../toast.js";
import { emptyState, errorState, listSkeleton } from "../states.js";
import { iconShop } from "../icons.js";
import * as api from "../api.js";
import type { Category, ShopSummary } from "../api-types.js";

function plural(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

export async function renderShops(container: HTMLElement, onChanged: () => void): Promise<void> {
  async function load(): Promise<void> {
    mount(container, listSkeleton(4));
    let shops: ShopSummary[];
    let categories: Category[];
    try {
      [shops, categories] = await Promise.all([api.listShops(), api.listCategories("expense")]);
    } catch (e) {
      mount(
        container,
        el("div", { class: "screen shops-screen" }, [
          errorState(e instanceof Error ? e.message : "Не удалось загрузить магазины", () => void load()),
        ]),
      );
      return;
    }
    render(shops, categories);
  }

  function render(shops: ShopSummary[], categories: Category[]): void {
    const header = el("header", { class: "shops-heading" }, [
      el("h1", { class: "shops-title", text: "Магазины" }),
      el("p", {
        class: "shops-sub",
        text: "Категория запоминается по чеку и подставляется при следующем сканировании.",
      }),
    ]);

    const content =
      shops.length === 0
        ? emptyState(
            "Пока нет магазинов",
            "Отсканируйте QR-код чека в форме «Новая запись» — магазин появится здесь, а выбранная категория запомнится.",
          )
        : el(
            "div",
            { class: "shop-list" },
            shops.map((shop) =>
              shopRow(shop, () => openShop(shop, categories, () => void load())),
            ),
          );

    mount(
      container,
      el("div", { class: "screen shops-screen" }, [header, content]),
    );
  }

  function shopRow(shop: ShopSummary, onClick: () => void): HTMLElement {
    const visitsText = `${shop.visits} ${plural(shop.visits, ["покупка", "покупки", "покупок"])}`;

    // Сумма стоит рядом с названием, а мета-строка занимает всю ширину
    // карточки: дата последней покупки переехала в карточку магазина, иначе
    // категория с количеством не влезали на экранах 320–360 px.
    return el(
      "button",
      { class: "shop-row", type: "button", onclick: onClick },
      [
        el("span", { class: "shop-row-icon" }, [iconShop(22)]),
        el("span", { class: "shop-row-main" }, [
          el("span", { class: "shop-row-head" }, [
            el("span", { class: "shop-row-name", text: shop.name }),
            el("span", { class: "shop-row-amount", text: formatMoney(shop.totalSpent) }),
          ]),
          el("span", {
            class: "shop-row-meta",
            text: `${shop.defaultCategoryName ?? "Категория не выбрана"} · ${visitsText}`,
          }),
        ]),
      ],
    );
  }

  function openShop(shop: ShopSummary, categories: Category[], reload: () => void): void {
    let close = (): void => {};
    const header: (Node | null)[] = [
      shop.legalName !== shop.name
        ? el("p", { class: "shop-legal", text: shop.legalName })
        : null,
      el("div", { class: "shop-stats" }, [
        el("div", { class: "shop-stat" }, [
          el("span", { class: "shop-stat-value", text: formatMoney(shop.totalSpent) }),
          el("span", { class: "shop-stat-label", text: "потрачено" }),
        ]),
        el("div", { class: "shop-stat" }, [
          el("span", {
            class: "shop-stat-value",
            text: String(shop.visits),
          }),
          el("span", {
            class: "shop-stat-label",
            text: plural(shop.visits, ["покупка", "покупки", "покупок"]),
          }),
        ]),
      ]),
      shop.lastVisit !== null
        ? el("p", {
            class: "shop-requisites",
            text: `Последняя покупка: ${formatDateHuman(shop.lastVisit)}`,
          })
        : null,
    ];

    if (shop.tin !== "") {
      header.push(el("p", { class: "shop-requisites", text: `ИНН: ${shop.tin}` }));
    }
    if (shop.address !== null) {
      header.push(el("p", { class: "shop-requisites", text: shop.address }));
    }

    const gridHost = el("div", { class: "shop-category-host" });

    function paintGrid(list: Category[]): void {
      gridHost.replaceChildren(
        categoryGrid({
          categories: list,
          selectedId: shop.defaultCategoryId,
          kind: "expense",
          onSelect: (category) => void remember(shop, category.id, close, reload),
          onCategoriesChanged: (next) => paintGrid(next),
        }),
      );
    }
    paintGrid(categories);

    const content: (Node | null)[] = [...header];
    if (shop.defaultCategoryId !== null) {
      content.push(
        el("button", {
          class: "btn btn-danger-ghost btn-block",
          type: "button",
          text: "Забыть категорию",
          onclick: () => void remember(shop, null, close, reload),
        }),
      );
    }
    content.push(
      el("p", {
        class: "shop-hint",
        text: "Тап по плитке запоминает категорию для чеков этого магазина.",
      }),
      gridHost,
    );

    close = openSheet(shop.name, el("div", { class: "form-stack shop-sheet" }, content)).close;
  }

  async function remember(
    shop: ShopSummary,
    categoryId: number | null,
    close: () => void,
    reload: () => void,
  ): Promise<void> {
    try {
      await api.setShopCategory(shop.id, categoryId);
      close();
      showToast(categoryId === null ? "Категория забыта" : "Категория запомнена", "info");
      reload();
      onChanged();
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Не удалось сохранить категорию");
    }
  }

  void load();
}
