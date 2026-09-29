// Авторство записи: кто внёс (author_id) и кто последним правил (edited_by).
// Миграция 0002_edited_by.sql — аддитивная, NULL = не правили.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MaskedTransaction, User } from "../src/types";
import {
  ALISHER_ID,
  ALISHER_INIT_DATA,
  AUTH_DATE_2026_08_24,
  DILNOZA_ID,
  DILNOZA_INIT_DATA,
} from "./fixtures/init-data";
import {
  apiJson,
  applyMigrations,
  CATEGORY,
  categoryId,
  dropSchema,
  freezeTime,
  insertTx,
  resetDb,
  unfreezeTime,
} from "./helpers";

const MONTH = "2026-08";

interface AuthorshipRow {
  author_id: number;
  edited_by: number | null;
  edited_at: string | null;
}

async function authorship(id: number): Promise<AuthorshipRow> {
  const row = await env.DB.prepare(
    "SELECT author_id, edited_by, edited_at FROM transactions WHERE id = ?1",
  )
    .bind(id)
    .first<AuthorshipRow>();
  if (row === null) throw new Error(`no transaction ${id}`);
  return row;
}

/** Обычная (не скрытая) трата Алишера. */
async function alisherLunch(): Promise<number> {
  return insertTx({
    amount: 45_000,
    kind: "expense",
    category: CATEGORY.groceries,
    authorId: ALISHER_ID,
    occurredOn: "2026-08-20",
    comment: "обед",
  });
}

beforeEach(async () => {
  freezeTime(AUTH_DATE_2026_08_24);
  await resetDb();
});

afterEach(() => {
  unfreezeTime();
});

describe("edited_by при правке", () => {
  it("правка партнёром проставляет edited_by и edited_at, author_id не меняется", async () => {
    const id = await alisherLunch();
    const before = await authorship(id);
    expect(before.edited_by).toBeNull();
    expect(before.edited_at).toBeNull();

    const { status, body } = await apiJson<{ transaction: MaskedTransaction }>(
      DILNOZA_INIT_DATA,
      `/api/transactions/${id}`,
      { method: "PATCH", body: { amount: 52_000 } },
    );
    expect(status).toBe(200);

    const after = await authorship(id);
    expect(after.author_id).toBe(ALISHER_ID); // кто создал, тот и создал
    expect(after.edited_by).toBe(DILNOZA_ID);
    expect(after.edited_at).not.toBeNull();
    expect(body.transaction.editedBy).toBe(DILNOZA_ID);
  });

  it("правка автором проставляет его же id, author_id на месте", async () => {
    const id = await alisherLunch();
    await apiJson(ALISHER_INIT_DATA, `/api/transactions/${id}`, {
      method: "PATCH",
      body: { comment: "ужин" },
    });
    const row = await authorship(id);
    expect(row.author_id).toBe(ALISHER_ID);
    expect(row.edited_by).toBe(ALISHER_ID);
  });

  it("создание записи не считается правкой: edited_by остаётся NULL", async () => {
    const { status, body } = await apiJson<{ transaction: MaskedTransaction }>(
      ALISHER_INIT_DATA,
      "/api/transactions",
      {
        method: "POST",
        body: {
          amount: 30_000,
          kind: "expense",
          categoryId: await categoryId(CATEGORY.groceries),
          occurredOn: "2026-08-22",
        },
      },
    );
    expect(status).toBe(201);
    expect(body.transaction.editedBy).toBeNull();
    expect(body.transaction.editedAt).toBeNull();
  });

  it("PATCH без единого поля не считается правкой", async () => {
    const id = await alisherLunch();
    const { status } = await apiJson(DILNOZA_INIT_DATA, `/api/transactions/${id}`, {
      method: "PATCH",
      body: {},
    });
    expect(status).toBe(200);
    expect((await authorship(id)).edited_by).toBeNull();
  });
});

describe("AC-P18: edited_by замаскирован для не-автора скрытой траты", () => {
  // Новый канал утечки: открыть скрытую трату на правку не-автор не может,
  // но видимый edited_by выдавал бы, что с ней происходило. Правило живёт в
  // том же CASE WHEN masked, что category_id/comment/author_id.

  /** Скрытая трата Алишера, которую он же потом правил. */
  async function editedGift(): Promise<number> {
    const id = await insertTx({
      amount: 340_000,
      kind: "expense",
      category: CATEGORY.gifts,
      authorId: ALISHER_ID,
      occurredOn: "2026-08-20",
      comment: "серёжки",
      hiddenUntil: "2026-08-31",
    });
    await apiJson(ALISHER_INIT_DATA, `/api/transactions/${id}`, {
      method: "PATCH",
      body: { amount: 360_000 },
    });
    return id;
  }

  it("в /api/transactions партнёр не видит ни editedBy, ни editedAt", async () => {
    await editedGift();
    const { body } = await apiJson<{ transactions: MaskedTransaction[] }>(
      DILNOZA_INIT_DATA,
      `/api/transactions?month=${MONTH}`,
    );
    const [tx] = body.transactions;
    expect(tx?.isMasked).toBe(true);
    expect(tx?.editedBy).toBeNull();
    expect(tx?.editedAt).toBeNull();
    // Маскирование в SQL: id автора не должен всплыть в сыром JSON ни в одном поле.
    expect(JSON.stringify(body)).not.toContain(String(ALISHER_ID));
  });

  it("в топ-5 отчёта и в одиночной выборке — то же самое", async () => {
    const id = await editedGift();
    const report = await apiJson<{ topExpenses: MaskedTransaction[] }>(
      DILNOZA_INIT_DATA,
      `/api/report?month=${MONTH}`,
    );
    expect(report.body.topExpenses[0]?.editedBy).toBeNull();

    const single = await apiJson<{ transaction: MaskedTransaction }>(
      DILNOZA_INIT_DATA,
      `/api/transactions/${id}`,
    );
    expect(single.body.transaction.editedBy).toBeNull();
    expect(single.body.transaction.editedAt).toBeNull();
  });

  it("автор своей скрытой траты видит editedBy", async () => {
    await editedGift();
    const { body } = await apiJson<{ transactions: MaskedTransaction[] }>(
      ALISHER_INIT_DATA,
      `/api/transactions?month=${MONTH}`,
    );
    expect(body.transactions[0]?.editedBy).toBe(ALISHER_ID);
    expect(body.transactions[0]?.editedAt).not.toBeNull();
  });

  it("после раскрытия edited_by становится виден обоим", async () => {
    const id = await insertTx({
      amount: 340_000,
      kind: "expense",
      category: CATEGORY.gifts,
      authorId: ALISHER_ID,
      occurredOn: "2026-08-20",
      hiddenUntil: "2026-08-24", // = today, уже раскрыта
    });
    await apiJson(ALISHER_INIT_DATA, `/api/transactions/${id}`, {
      method: "PATCH",
      body: { amount: 360_000 },
    });
    const { body } = await apiJson<{ transaction: MaskedTransaction }>(
      DILNOZA_INIT_DATA,
      `/api/transactions/${id}`,
    );
    expect(body.transaction.editedBy).toBe(ALISHER_ID);
  });
});

describe("GET /api/users", () => {
  it("отдаёт обоих пользователей семьи", async () => {
    const { status, body } = await apiJson<{ users: User[] }>(DILNOZA_INIT_DATA, "/api/users");
    expect(status).toBe(200);
    expect(body.users).toEqual([
      { telegramId: ALISHER_ID, name: "Алишер" },
      { telegramId: DILNOZA_ID, name: "Дилноза" },
    ]);
  });

  it("без initData — 401, как и все прочие /api/*", async () => {
    const { status } = await apiJson(null, "/api/users");
    expect(status).toBe(401);
  });
});

describe("миграция 0002_edited_by.sql", () => {
  async function txColumns(): Promise<string[]> {
    const { results } = await env.DB.prepare("PRAGMA table_info(transactions)").all<{
      name: string;
    }>();
    return results.map((r) => r.name);
  }

  it("применяется на чистой базе", async () => {
    await dropSchema();
    await applyMigrations();
    expect(await txColumns()).toEqual(expect.arrayContaining(["edited_by", "edited_at"]));
  });

  it("применяется поверх уже применённой 0001, существующие записи получают NULL", async () => {
    await dropSchema();
    await applyMigrations(0, 1); // прод до этой задачи: только 0001
    expect(await txColumns()).not.toContain("edited_by");

    await env.DB.prepare("INSERT INTO users (telegram_id, name) VALUES (?1, 'Алишер')")
      .bind(ALISHER_ID)
      .run();
    const gifts = await categoryId(CATEGORY.gifts);
    await env.DB.prepare(
      "INSERT INTO transactions (amount, kind, category_id, author_id, occurred_on, created_at)" +
        " VALUES (1000, 'expense', ?1, ?2, '2026-08-20', '2026-08-20T09:00:00.000Z')",
    )
      .bind(gifts, ALISHER_ID)
      .run();

    await applyMigrations(1);

    expect(await txColumns()).toEqual(expect.arrayContaining(["edited_by", "edited_at"]));
    const row = await env.DB.prepare(
      "SELECT author_id, edited_by, edited_at FROM transactions",
    ).first<AuthorshipRow>();
    // Живая строка на месте, авторство не потеряно, «не правили» = NULL.
    expect(row).toEqual({ author_id: ALISHER_ID, edited_by: null, edited_at: null });
  });
});
