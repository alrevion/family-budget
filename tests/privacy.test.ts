// AC-P9, AC-P10, AC-P12, AC-P13 — модель приватности R3 (Вариант A).
//
// Ключевое требование плана: маскирование живёт в SQL-проекции слоя запросов,
// поэтому проверяется по СЫРОМУ JSON ответа, а не по тому, что нарисовал бы
// Mini App. Все четыре пути чтения обязаны идти через одну проекцию.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MaskedTransaction } from "../src/types";
import {
  ALISHER_ID,
  ALISHER_INIT_DATA,
  AUTH_DATE_2026_08_24,
  DILNOZA_ID,
  DILNOZA_INIT_DATA,
} from "./fixtures/init-data";
import { apiJson, CATEGORY, categoryId, freezeTime, insertTx, resetDb, unfreezeTime } from "./helpers";

const TODAY = "2026-08-24";
const TOMORROW = "2026-08-25";
const MONTH = "2026-08";

interface ListBody {
  transactions: MaskedTransaction[];
}
interface ReportBody {
  topExpenses: MaskedTransaction[];
  expensesByCategory: Array<{
    categoryId: number | null;
    name: string;
    amount: number;
    count: number;
    share: number;
  }>;
  expense: number;
}

/** Скрытая трата Алишера — подарок Дилнозе, раскроется через неделю. */
async function alisherGift(hiddenUntil: string | null = "2026-08-31"): Promise<number> {
  return insertTx({
    amount: 340_000,
    kind: "expense",
    category: CATEGORY.gifts,
    authorId: ALISHER_ID,
    occurredOn: "2026-08-20",
    comment: "серёжки",
    hiddenUntil,
  });
}

async function listFor(initData: string): Promise<MaskedTransaction[]> {
  const { body } = await apiJson<ListBody>(initData, `/api/transactions?month=${MONTH}`);
  return body.transactions;
}

beforeEach(async () => {
  freezeTime(AUTH_DATE_2026_08_24);
  await resetDb();
});

afterEach(() => {
  unfreezeTime();
});

describe("AC-P9: не-автор не видит категорию, комментарий и авторство", () => {
  it("в /api/transactions поля обнулены, но сумма на месте", async () => {
    const id = await alisherGift();
    const [tx] = await listFor(DILNOZA_INIT_DATA);

    expect(tx).toEqual({
      id,
      amount: 340_000,
      kind: "expense",
      occurredOn: "2026-08-20",
      categoryId: null,
      comment: null,
      authorId: null,
      editedBy: null,
      editedAt: null,
      isMasked: true,
      revealsOn: "2026-08-31",
    });
  });

  it("маскирование сделано в SQL: в сыром JSON ответа нет ни категории, ни комментария", async () => {
    await alisherGift();
    const res = await apiJson(DILNOZA_INIT_DATA, `/api/transactions?month=${MONTH}`);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("серёжки");
    expect(raw).not.toContain(String(ALISHER_ID));
    expect(raw).toContain("340000");
  });

  it("в топ-5 отчёта (AC-22) та же трата тоже замаскирована", async () => {
    // Крупная скрытая трата почти наверняка попадёт в топ-5 — путь обязан
    // идти через ту же проекцию, иначе утечка.
    await alisherGift();
    const { body } = await apiJson<ReportBody>(DILNOZA_INIT_DATA, `/api/report?month=${MONTH}`);
    expect(body.topExpenses).toHaveLength(1);
    expect(body.topExpenses[0]).toMatchObject({
      amount: 340_000,
      categoryId: null,
      comment: null,
      authorId: null,
      isMasked: true,
    });
  });

  it("в круговой диаграмме трата попадает в псевдокатегорию «Скрытое», сумма сходится", async () => {
    await alisherGift();
    await insertTx({
      amount: 120_000,
      kind: "expense",
      category: CATEGORY.groceries,
      authorId: DILNOZA_ID,
      occurredOn: "2026-08-21",
    });

    const { body } = await apiJson<ReportBody>(DILNOZA_INIT_DATA, `/api/report?month=${MONTH}`);
    const hidden = body.expensesByCategory.find((c) => c.categoryId === null);
    // share = 340000 / 460000
    expect(hidden).toEqual({
      categoryId: null,
      name: "Скрытое",
      amount: 340_000,
      count: 1,
      share: 0.7391,
    });
    const sum = body.expensesByCategory.reduce((acc, c) => acc + c.amount, 0);
    expect(sum).toBe(body.expense);
    expect(sum).toBe(460_000);
  });

  it("ответ на GET /api/transactions/:id тоже замаскирован", async () => {
    const id = await alisherGift();
    const { body } = await apiJson<{ transaction: MaskedTransaction }>(
      DILNOZA_INIT_DATA,
      `/api/transactions/${id}`,
    );
    expect(body.transaction.categoryId).toBeNull();
    expect(body.transaction.comment).toBeNull();
    expect(body.transaction.authorId).toBeNull();
    expect(body.transaction.amount).toBe(340_000);
  });
});

describe("AC-P12: автор видит свою скрытую трату целиком (закрывает AC-9)", () => {
  it("отдаёт categoryId, comment и authorId непустыми", async () => {
    const id = await alisherGift();
    const gifts = await categoryId(CATEGORY.gifts);
    const [tx] = await listFor(ALISHER_INIT_DATA);

    expect(tx).toEqual({
      id,
      amount: 340_000,
      kind: "expense",
      occurredOn: "2026-08-20",
      categoryId: gifts,
      comment: "серёжки",
      authorId: ALISHER_ID,
      editedBy: null,
      editedAt: null,
      isMasked: false,
      revealsOn: null,
    });
  });

  it("в отчёте автора трата лежит в своей реальной категории, а не в «Скрытом»", async () => {
    await alisherGift();
    const gifts = await categoryId(CATEGORY.gifts);
    const { body } = await apiJson<ReportBody>(ALISHER_INIT_DATA, `/api/report?month=${MONTH}`);
    expect(body.expensesByCategory).toEqual([
      { categoryId: gifts, name: CATEGORY.gifts, amount: 340_000, count: 1, share: 1 },
    ]);
    expect(body.topExpenses[0]?.isMasked).toBe(false);
  });
});

describe("AC-P13: граница раскрытия (закрывает AC-8)", () => {
  it("hidden_until = today — видна обоим полностью", async () => {
    // Предикат hidden_until > :today, а не >=: в день раскрытия трата уже
    // открыта.
    await alisherGift(TODAY);
    for (const initData of [ALISHER_INIT_DATA, DILNOZA_INIT_DATA]) {
      const [tx] = await listFor(initData);
      expect(tx?.isMasked).toBe(false);
      expect(tx?.comment).toBe("серёжки");
      expect(tx?.authorId).toBe(ALISHER_ID);
    }
  });

  it("hidden_until = today + 1 — замаскирована для не-автора", async () => {
    await alisherGift(TOMORROW);
    const [forPartner] = await listFor(DILNOZA_INIT_DATA);
    expect(forPartner?.isMasked).toBe(true);
    expect(forPartner?.revealsOn).toBe(TOMORROW);

    const [forAuthor] = await listFor(ALISHER_INIT_DATA);
    expect(forAuthor?.isMasked).toBe(false);
  });

  it("hidden_until = NULL — обычная трата, видна обоим", async () => {
    await alisherGift(null);
    for (const initData of [ALISHER_INIT_DATA, DILNOZA_INIT_DATA]) {
      const [tx] = await listFor(initData);
      expect(tx?.isMasked).toBe(false);
      expect(tx?.revealsOn).toBeNull();
    }
  });
});

describe("AC-P10: правка и удаление скрытой траты", () => {
  it("PATCH от не-автора → 403", async () => {
    const id = await alisherGift(TOMORROW);
    const { status, body } = await apiJson(DILNOZA_INIT_DATA, `/api/transactions/${id}`, {
      method: "PATCH",
      body: { amount: 1_000 },
    });
    expect(status).toBe(403);
    expect(body).toEqual({ error: "forbidden" });
  });

  it("DELETE от не-автора → 403 и запись остаётся", async () => {
    const id = await alisherGift(TOMORROW);
    const { status } = await apiJson(DILNOZA_INIT_DATA, `/api/transactions/${id}`, {
      method: "DELETE",
    });
    expect(status).toBe(403);
    const [tx] = await listFor(ALISHER_INIT_DATA);
    expect(tx?.id).toBe(id);
  });

  it("после раскрытия не-автор может править — 403 держится только пока hidden_until > today", async () => {
    const id = await alisherGift(TODAY);
    const { status } = await apiJson(DILNOZA_INIT_DATA, `/api/transactions/${id}`, {
      method: "PATCH",
      body: { amount: 1_000 },
    });
    expect(status).toBe(200);
  });

  it("PATCH, МЕНЯЮЩИЙ hidden_until, → 400", async () => {
    const id = await alisherGift(TOMORROW);
    for (const patch of [
      { hiddenUntil: "2026-12-31" },
      { hidden_until: "2026-12-31" },
      { hiddenUntil: null },
    ]) {
      const { status, body } = await apiJson(ALISHER_INIT_DATA, `/api/transactions/${id}`, {
        method: "PATCH",
        body: patch,
      });
      expect(status, JSON.stringify(patch)).toBe(400);
      expect(body).toEqual({ error: "hidden_until_immutable" });
    }
  });

  it("PATCH с ТЕМ ЖЕ hidden_until → 200: автор может править свою скрытую трату", async () => {
    // Принципиально: типовая форма отправляет загруженный объект целиком,
    // и безусловный отказ на наличие поля положил бы любую правку автором.
    const id = await alisherGift(TOMORROW);
    const { status, body } = await apiJson<{ transaction: MaskedTransaction }>(
      ALISHER_INIT_DATA,
      `/api/transactions/${id}`,
      { method: "PATCH", body: { hiddenUntil: TOMORROW, amount: 500_000, comment: "браслет" } },
    );
    expect(status).toBe(200);
    expect(body.transaction.amount).toBe(500_000);
    expect(body.transaction.comment).toBe("браслет");
  });

  it("PATCH с тем же hidden_until в snake_case тоже проходит", async () => {
    const id = await alisherGift(TOMORROW);
    const { status } = await apiJson(ALISHER_INIT_DATA, `/api/transactions/${id}`, {
      method: "PATCH",
      body: { hidden_until: TOMORROW, amount: 500_000 },
    });
    expect(status).toBe(200);
  });

  it("PATCH обычной траты с hiddenUntil: null проходит — значение не меняется", async () => {
    const id = await alisherGift(null);
    const { status } = await apiJson(ALISHER_INIT_DATA, `/api/transactions/${id}`, {
      method: "PATCH",
      body: { hiddenUntil: null, amount: 500_000 },
    });
    expect(status).toBe(200);
  });

  it("ретроактивно скрыть уже видимую трату нельзя", async () => {
    const id = await alisherGift(null);
    const { status, body } = await apiJson(ALISHER_INIT_DATA, `/api/transactions/${id}`, {
      method: "PATCH",
      body: { hiddenUntil: "2026-12-31" },
    });
    expect(status).toBe(400);
    expect(body).toEqual({ error: "hidden_until_immutable" });
  });

  it("ответ на DELETE от автора идёт через ту же проекцию R3", async () => {
    const id = await alisherGift(TOMORROW);
    const { status, body } = await apiJson<{ transaction: MaskedTransaction }>(
      ALISHER_INIT_DATA,
      `/api/transactions/${id}`,
      { method: "DELETE" },
    );
    expect(status).toBe(200);
    expect(body.transaction.isMasked).toBe(false);
    expect(await listFor(ALISHER_INIT_DATA)).toEqual([]);
  });
});

describe("AC-P17: фильтр по категории не раскрывает скрытую трату (новый канал)", () => {
  // Регрессия на канал, которого в v1 не было. Фильтр по категории — оракул:
  // перебрал все категории, нашёл ту, в которой сумма подскочила на 340 000, и
  // узнал категорию подарка, ничего не «увидев» напрямую. Поэтому фильтр
  // применяется ПОСЛЕ маскирования: у замаскированной записи category_id
  // равен NULL и она не матчится НИ ПО КАКОМУ id.

  async function allCategoryIds(): Promise<number[]> {
    const { results } = await env.DB.prepare("SELECT id FROM categories ORDER BY id").all<{
      id: number;
    }>();
    return results.map((r) => r.id);
  }

  it("ни один id категории не «находит» скрытую трату партнёра", async () => {
    const hiddenId = await alisherGift(TOMORROW);
    await insertTx({
      amount: 120_000,
      kind: "expense",
      category: CATEGORY.groceries,
      authorId: DILNOZA_ID,
      occurredOn: "2026-08-21",
    });

    for (const id of await allCategoryIds()) {
      const { body } = await apiJson<ListBody>(
        DILNOZA_INIT_DATA,
        `/api/transactions?month=${MONTH}&categories=${id}`,
      );
      expect(body.transactions.map((t) => t.id), `категория ${id}`).not.toContain(hiddenId);

      const report = await apiJson<ReportBody>(
        DILNOZA_INIT_DATA,
        `/api/report?month=${MONTH}&categories=${id}`,
      );
      // Сумма 340 000 не должна всплыть ни в одной категорийной выборке.
      expect(report.body.expense, `категория ${id}`).not.toBe(340_000);
      expect(report.body.expensesByCategory.some((c) => c.amount === 340_000)).toBe(false);
    }
  });

  it("фильтр по «Подаркам» пуст для партнёра и непуст для автора", async () => {
    const hiddenId = await alisherGift(TOMORROW);
    const gifts = await categoryId(CATEGORY.gifts);

    const partner = await apiJson<ListBody>(
      DILNOZA_INIT_DATA,
      `/api/transactions?month=${MONTH}&categories=${gifts}`,
    );
    expect(partner.body.transactions).toEqual([]);

    const author = await apiJson<ListBody>(
      ALISHER_INIT_DATA,
      `/api/transactions?month=${MONTH}&categories=${gifts}`,
    );
    expect(author.body.transactions.map((t) => t.id)).toEqual([hiddenId]);
  });

  it("после раскрытия та же фильтрация начинает её показывать — маскирование, а не удаление", async () => {
    const hiddenId = await alisherGift(TODAY); // hidden_until = today, уже раскрыта
    const gifts = await categoryId(CATEGORY.gifts);
    const { body } = await apiJson<ListBody>(
      DILNOZA_INIT_DATA,
      `/api/transactions?month=${MONTH}&categories=${gifts}`,
    );
    expect(body.transactions.map((t) => t.id)).toEqual([hiddenId]);
  });

  it("фильтр по автору не отдаёт скрытую трату партнёра с раскрытой категорией", async () => {
    const hiddenId = await alisherGift(TOMORROW);
    await insertTx({
      amount: 5_000_000,
      kind: "income",
      category: CATEGORY.salary,
      authorId: ALISHER_ID,
      occurredOn: "2026-08-01",
    });

    const { body } = await apiJson<ListBody>(
      DILNOZA_INIT_DATA,
      `/api/transactions?month=${MONTH}&author=${ALISHER_ID}`,
    );
    expect(body.transactions.map((t) => t.id)).not.toContain(hiddenId);
    expect(body.transactions).toHaveLength(1); // только незакрытый доход
    expect(JSON.stringify(body)).not.toContain("серёжки");
  });

  it("комбинация фильтров тоже не даёт обходного пути", async () => {
    const hiddenId = await alisherGift(TOMORROW);
    const gifts = await categoryId(CATEGORY.gifts);
    const { body } = await apiJson<ListBody>(
      DILNOZA_INIT_DATA,
      `/api/transactions?month=${MONTH}&categories=${gifts}&author=${ALISHER_ID}&kind=expense&min=1&max=100000000000`,
    );
    expect(body.transactions.map((t) => t.id)).not.toContain(hiddenId);
  });

  it("фильтр по сумме скрытую трату ВИДИТ — сумма не маскируется по AC-6", async () => {
    // Осознанное допущение, а не дефект: сумма обязана попадать в баланс,
    // поэтому диапазон сумм её находит. Категория при этом остаётся скрытой.
    const hiddenId = await alisherGift(TOMORROW);
    const { body } = await apiJson<ListBody>(
      DILNOZA_INIT_DATA,
      `/api/transactions?month=${MONTH}&min=340000&max=340000`,
    );
    const [tx] = body.transactions;
    expect(tx?.id).toBe(hiddenId);
    expect(tx?.isMasked).toBe(true);
    expect(tx?.categoryId).toBeNull();
    expect(tx?.comment).toBeNull();
  });
});
