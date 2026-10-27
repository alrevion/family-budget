// Чеки ОФД и магазины: разбор QR, нормализация ответа API, кеш/дедупликация
// и память категории. Сеть в тестах не трогаем: кеш проверяется на
// заранее вставленном чеке, а нормализация — на фикстуре реального ответа.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OfdError,
  cleanShopName,
  normalizeOfdReceipt,
  parseReceiptLink,
  shopIdentity,
  type ReceiptLink,
} from "../src/ofd";
import { ALISHER_INIT_DATA, AUTH_DATE_2026_08_24 } from "./fixtures/init-data";
import { apiJson, CATEGORY, categoryId, freezeTime, resetDb, unfreezeTime } from "./helpers";

const RECEIPT_URL =
  "https://ofd.soliq.uz/check?t=UZ210317259438&r=96329&c=20261027105934&s=561051029258";

const LINK: ReceiptLink = {
  terminalId: "UZ210317259438",
  paymentNo: "96329",
  paymentDate: "20261027105934",
  fiscalSign: "561051029258",
  fiscalSignHash: null,
};

/** Срез реального ответа new-ofd.soliq.uz/api/payment по чеку из QR. */
const API_DATA = {
  tin: 202099756,
  terminalId: "UZ210317259438",
  paymentNo: "96329",
  paymentDate: "27.10.2026 10:59:34",
  cashTotal: 0,
  cardTotal: 33250,
  isRefund: 0,
  kkmName: "POS2k",
  kkmSerialNumber: "STS-20231010-000138",
  paymentDetails: [
    { name: "Paket Kraft o'rt", amount: 1, price: 1590, productName: "Sumkalar va poliyetilen paketlar" },
    { name: "Yopgan non Mahalla, dona", amount: 2, price: 7800, productName: "Yopgan non" },
    { name: "Pishloq Ясь Белоус Rossyosh 50% 200g", amount: 1, price: 22990, productName: "Pishloqlar" },
    { name: "Katakli daftar Alloma 12 varaq, dona", amount: 3, price: 870, productName: "Daftarlar" },
  ],
  extraInfo: {
    companyName:
      '"ANGLESEY FOOD" MAS`ULIYATI CHEKLANGAN JAMIYAT XORIJIY KORXONA',
    address: "город Ташкент, Шахонтохурский район, квартал Лабзак, дом 28",
  },
};

interface ShopBody {
  id: number;
  name: string;
  defaultCategoryId: number | null;
  defaultCategoryName: string | null;
  visits: number;
  totalSpent: number;
  lastVisit: string | null;
}

interface LookupBody {
  receipt: {
    id: number;
    total: number;
    occurredOn: string;
    transactionId: number | null;
    items: Array<{ name: string; price: number }>;
  };
  shop: ShopBody;
  suggestedCategoryId: number | null;
  suggestedCategoryName: string | null;
  cached: boolean;
  error?: string;
}

interface TxBody {
  transaction: { id: number };
  error?: string;
}

describe("QR-ссылка чека", () => {
  it("разбирает полную ссылку из QR", () => {
    expect(parseReceiptLink(RECEIPT_URL)).toEqual(LINK);
  });

  it("принимает хвост query-параметров и EPI-хеш вместо s", () => {
    expect(parseReceiptLink("t=UZ210317259438&r=96329&c=20261027105934&s=561051029258")).toEqual(
      LINK,
    );
    const epi = parseReceiptLink(
      "https://ofd.soliq.uz/check?t=UZ210317259438&r=96329&c=20261027105934&h=7754735A7F24F83132C92A12F1796CD3",
    );
    expect(epi?.fiscalSign).toBeNull();
    expect(epi?.fiscalSignHash).toBe("7754735A7F24F83132C92A12F1796CD3");
  });

  it("отклоняет чужие ссылки, неполный QR и мусор", () => {
    expect(parseReceiptLink("https://example.com/check?t=UZ1&r=1&c=20261027105934&s=1")).toBeNull();
    expect(parseReceiptLink("https://ofd.soliq.uz/check?t=UZ1&r=1&c=20261027105934")).toBeNull();
    expect(parseReceiptLink("https://ofd.soliq.uz/check?t=UZ1&r=1&c=2026&s=1")).toBeNull();
    expect(parseReceiptLink("просто текст")).toBeNull();
  });
});

describe("Нормализация ответа ОФД", () => {
  it("берёт итог, дату, магазин и позиции", () => {
    const receipt = normalizeOfdReceipt(API_DATA, LINK);
    expect(receipt.total).toBe(33250);
    expect(receipt.occurredOn).toBe("2026-10-27");
    expect(receipt.merchant.name).toBe("ANGLESEY FOOD");
    expect(receipt.merchant.tin).toBe("202099756");
    expect(receipt.items).toHaveLength(4);
    // В API price — сумма строки, а не цена за единицу (иначе 4 позиции
    // дали бы 42 790 вместо Jami to'lov 33 250).
    expect(receipt.items.reduce((sum, item) => sum + item.price, 0)).toBe(33250);
  });

  it("отделяет чек возврата", () => {
    try {
      normalizeOfdReceipt({ ...API_DATA, isRefund: 1 }, LINK);
      expect.unreachable("чек возврата должен падать");
    } catch (e) {
      expect(e).toBeInstanceOf(OfdError);
      expect((e as OfdError).code).toBe("receipt_is_refund");
    }
  });

  it("чистит юридическую обвязку названия", () => {
    expect(cleanShopName(API_DATA.extraInfo.companyName)).toBe("ANGLESEY FOOD");
    expect(cleanShopName("OOO Romashka")).toBe("Romashka");
    expect(cleanShopName("MCHJ Baraka Savdo")).toBe("Baraka Savdo");
    expect(cleanShopName("")).toBe("Магазин");
  });

  it("строит ключ магазина по ИНН, а при tin=0 — по терминалу", () => {
    expect(shopIdentity("202099756", "UZ210317259438")).toBe("tin:202099756");
    expect(shopIdentity("0", "UZ210317259438")).toBe("terminal:UZ210317259438");
  });
});

// --- API: кеш, сохранение чека, память магазина -------------------------

async function seedShop(defaultCategoryId: number | null): Promise<number> {
  const res = await env.DB.prepare(
    "INSERT INTO shops" +
      " (identity, tin, name, legal_name, address, terminal_id, default_category_id, created_at, updated_at)" +
      " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
  )
    .bind(
      "tin:202099756",
      "202099756",
      "ANGLESEY FOOD",
      API_DATA.extraInfo.companyName,
      API_DATA.extraInfo.address,
      "UZ210317259438",
      defaultCategoryId,
      "2026-08-24T09:00:00.000Z",
    )
    .run();
  return Number(res.meta.last_row_id);
}

async function seedReceipt(shopId: number): Promise<number> {
  const res = await env.DB.prepare(
    "INSERT INTO receipts" +
      " (shop_id, terminal_id, payment_no, payment_date, occurred_on, fiscal_sign, total, items_json, transaction_id, created_at)" +
      " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9)",
  )
    .bind(
      shopId,
      LINK.terminalId,
      LINK.paymentNo,
      LINK.paymentDate,
      "2026-08-24",
      LINK.fiscalSign,
      33250,
      JSON.stringify([{ name: "Хлеб", qty: 2, price: 7800, productName: "Yopgan non" }]),
      "2026-08-24T09:00:00.000Z",
    )
    .run();
  return Number(res.meta.last_row_id);
}

async function shopRow(id: number): Promise<{ default_category_id: number | null }> {
  const row = await env.DB.prepare("SELECT default_category_id FROM shops WHERE id = ?1")
    .bind(id)
    .first<{ default_category_id: number | null }>();
  if (row === null) throw new Error("shop not found");
  return row;
}

async function receiptRow(id: number): Promise<{ transaction_id: number | null }> {
  const row = await env.DB.prepare("SELECT transaction_id FROM receipts WHERE id = ?1")
    .bind(id)
    .first<{ transaction_id: number | null }>();
  if (row === null) throw new Error("receipt not found");
  return row;
}

beforeEach(async () => {
  freezeTime(AUTH_DATE_2026_08_24);
  await resetDb();
});

afterEach(() => {
  unfreezeTime();
});

describe("POST /api/receipts/lookup", () => {
  it("отдаёт чек из кеша D1, не ходя в ОФД, и подсказывает категорию", async () => {
    const groceries = await categoryId(CATEGORY.groceries);
    const shopId = await seedShop(groceries);
    const receiptId = await seedReceipt(shopId);

    const { status, body } = await apiJson<LookupBody>(ALISHER_INIT_DATA, "/api/receipts/lookup", {
      method: "POST",
      body: { text: RECEIPT_URL },
    });

    expect(status).toBe(200);
    expect(body.cached).toBe(true);
    expect(body.receipt.id).toBe(receiptId);
    expect(body.receipt.total).toBe(33250);
    expect(body.receipt.transactionId).toBeNull();
    expect(body.shop.id).toBe(shopId);
    expect(body.suggestedCategoryId).toBe(groceries);
    expect(body.suggestedCategoryName).toBe(CATEGORY.groceries);
  });

  it("возвращает 400 на мусор вместо ссылки", async () => {
    const { status, body } = await apiJson<LookupBody>(ALISHER_INIT_DATA, "/api/receipts/lookup", {
      method: "POST",
      body: { text: "https://example.com/check?t=1" },
    });
    expect(status).toBe(400);
    expect(body.error).toBe("bad_receipt_link");
  });

  // С edge Cloudflare ОФД недоступен (таймаут), поэтому чек со своего телефона
  // клиент запрашивает сам и присылает готовый объект `data`. Сервер обязан
  // разобрать его тем же кодом, что и свой запрос, и не ходить в сеть.
  it("принимает ответ ОФД, полученный клиентом, без запроса в сеть", async () => {
    const { status, body } = await apiJson<LookupBody>(ALISHER_INIT_DATA, "/api/receipts/lookup", {
      method: "POST",
      body: { text: RECEIPT_URL, ofd: API_DATA },
    });

    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.cached).toBe(false);
    expect(body.receipt.total).toBe(33250);
    expect(body.receipt.occurredOn).toBe("2026-10-27");
    expect(body.receipt.items).toHaveLength(4);
    expect(body.receipt.items[2]?.price).toBe(22990);
    expect(body.shop.name).toBe("ANGLESEY FOOD");

    // Магазин запомнился: повторный скан того же чека уже из кеша D1.
    const again = await apiJson<LookupBody>(ALISHER_INIT_DATA, "/api/receipts/lookup", {
      method: "POST",
      body: { text: RECEIPT_URL },
    });
    expect(again.status).toBe(200);
    expect(again.body.cached).toBe(true);
    expect(again.body.receipt.id).toBe(body.receipt.id);
  });
});

describe("Трата из чека", () => {
  it("связывает чек с тратой и запоминает категорию магазина", async () => {
    const groceries = await categoryId(CATEGORY.groceries);
    const shopId = await seedShop(null);
    const receiptId = await seedReceipt(shopId);

    const created = await apiJson<TxBody>(ALISHER_INIT_DATA, "/api/transactions", {
      method: "POST",
      body: {
        amount: 33250,
        kind: "expense",
        categoryId: groceries,
        occurredOn: "2026-08-24",
        comment: "ANGLESEY FOOD",
        receiptId,
      },
    });
    expect(created.status).toBe(201);

    const txId = created.body.transaction.id;
    expect((await receiptRow(receiptId)).transaction_id).toBe(txId);
    expect((await shopRow(shopId)).default_category_id).toBe(groceries);

    const shops = await apiJson<{ shops: ShopBody[] }>(ALISHER_INIT_DATA, "/api/shops");
    expect(shops.status).toBe(200);
    expect(shops.body.shops).toHaveLength(1);
    expect(shops.body.shops[0]?.visits).toBe(1);
    expect(shops.body.shops[0]?.totalSpent).toBe(33250);
    expect(shops.body.shops[0]?.defaultCategoryName).toBe(CATEGORY.groceries);
  });

  it("не даёт записать один чек дважды", async () => {
    const groceries = await categoryId(CATEGORY.groceries);
    const shopId = await seedShop(null);
    const receiptId = await seedReceipt(shopId);
    const payload = {
      amount: 33250,
      kind: "expense",
      categoryId: groceries,
      occurredOn: "2026-08-24",
      receiptId,
    };

    expect((await apiJson(ALISHER_INIT_DATA, "/api/transactions", {
      method: "POST",
      body: payload,
    })).status).toBe(201);

    const second = await apiJson<TxBody>(ALISHER_INIT_DATA, "/api/transactions", {
      method: "POST",
      body: payload,
    });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("receipt_already_saved");
  });

  it("не принимает чек в доходной трате", async () => {
    const salary = await categoryId(CATEGORY.salary);
    const shopId = await seedShop(null);
    const receiptId = await seedReceipt(shopId);

    const res = await apiJson<TxBody>(ALISHER_INIT_DATA, "/api/transactions", {
      method: "POST",
      body: {
        amount: 33250,
        kind: "income",
        categoryId: salary,
        occurredOn: "2026-08-24",
        receiptId,
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_receipt");
    expect((await receiptRow(receiptId)).transaction_id).toBeNull();
  });

  it("при удалении траты удаляет чек, чтобы его можно было записать заново", async () => {
    const groceries = await categoryId(CATEGORY.groceries);
    const shopId = await seedShop(null);
    const receiptId = await seedReceipt(shopId);

    const created = await apiJson<TxBody>(ALISHER_INIT_DATA, "/api/transactions", {
      method: "POST",
      body: {
        amount: 33250,
        kind: "expense",
        categoryId: groceries,
        occurredOn: "2026-08-24",
        receiptId,
      },
    });
    const txId = created.body.transaction.id;

    const removed = await apiJson(ALISHER_INIT_DATA, `/api/transactions/${txId}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);

    const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM receipts").first<{ c: number }>();
    expect(count?.c).toBe(0);
    const shops = await apiJson<{ shops: ShopBody[] }>(ALISHER_INIT_DATA, "/api/shops");
    expect(shops.body.shops).toHaveLength(0);
  });
});

describe("PATCH /api/shops/:id", () => {
  it("меняет и забывает категорию магазина", async () => {
    const groceries = await categoryId(CATEGORY.groceries);
    const transport = await categoryId(CATEGORY.transport);
    const shopId = await seedShop(groceries);

    const changed = await apiJson(ALISHER_INIT_DATA, `/api/shops/${shopId}`, {
      method: "PATCH",
      body: { defaultCategoryId: transport },
    });
    expect(changed.status).toBe(200);
    expect((await shopRow(shopId)).default_category_id).toBe(transport);

    const cleared = await apiJson(ALISHER_INIT_DATA, `/api/shops/${shopId}`, {
      method: "PATCH",
      body: { defaultCategoryId: null },
    });
    expect(cleared.status).toBe(200);
    expect((await shopRow(shopId)).default_category_id).toBeNull();
  });

  it("не принимает доходную категорию", async () => {
    const groceries = await categoryId(CATEGORY.groceries);
    const salary = await categoryId(CATEGORY.salary);
    const shopId = await seedShop(groceries);

    const res = await apiJson(ALISHER_INIT_DATA, `/api/shops/${shopId}`, {
      method: "PATCH",
      body: { defaultCategoryId: salary },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_default_category");
    expect((await shopRow(shopId)).default_category_id).toBe(groceries);
  });
});
