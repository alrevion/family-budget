// AC-P4 (граница срока скрытия) и AC-P5 (Number.isSafeInteger на границе,
// amount в БД всегда INTEGER).

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMonths } from "../src/time";
import { isValidAmount } from "../src/money";
import {
  ALISHER_ID,
  ALISHER_INIT_DATA,
  ALISHER_INIT_DATA_MARCH1,
  AUTH_DATE_2026_03_01,
  AUTH_DATE_2026_08_24,
} from "./fixtures/init-data";
import { apiJson, CATEGORY, categoryId, freezeTime, resetDb, unfreezeTime } from "./helpers";

interface TxBody {
  transaction: { id: number; amount: number; revealsOn: string | null; isMasked: boolean };
}

async function post(initData: string, body: Record<string, unknown>) {
  return apiJson<TxBody & { error?: string }>(initData, "/api/transactions", {
    method: "POST",
    body,
  });
}

async function baseTx(): Promise<Record<string, unknown>> {
  return {
    amount: 340_000,
    kind: "expense",
    categoryId: await categoryId(CATEGORY.groceries),
  };
}

async function hiddenUntilOf(id: number): Promise<string | null> {
  const row = await env.DB.prepare("SELECT hidden_until FROM transactions WHERE id = ?1")
    .bind(id)
    .first<{ hidden_until: string | null }>();
  return row?.hidden_until ?? null;
}

beforeEach(async () => {
  freezeTime(AUTH_DATE_2026_08_24);
  await resetDb();
});

afterEach(() => {
  unfreezeTime();
});

describe("AC-P4: срок скрытия задаётся вариантом, дату считает сервер", () => {
  it("принимает все четыре варианта и считает дату сервером", async () => {
    const today = "2026-08-24";
    const expected: Record<string, string> = {
      "1d": "2026-08-25",
      "1w": "2026-08-31",
      "1m": "2026-09-24",
      "6m": "2027-02-24",
    };
    for (const [option, date] of Object.entries(expected)) {
      const { status, body } = await post(ALISHER_INIT_DATA, { ...(await baseTx()), hide: option });
      expect(status, option).toBe(201);
      expect(await hiddenUntilOf(body.transaction.id), option).toBe(date);
      expect(date > today).toBe(true);
    }
  });

  it("отвергает вариант вне перечисления — 400", async () => {
    for (const hide of ["7m", "1y", "183d", "", 6, true]) {
      const { status, body } = await post(ALISHER_INIT_DATA, { ...(await baseTx()), hide });
      expect(status, String(hide)).toBe(400);
      expect(body.error).toBe("bad_hide_option");
    }
  });

  it("«полгода» от 1 марта ПРИНИМАЕТСЯ: 184 дня, а не 183", async () => {
    // Именно тот баг, который стережёт критерий: жёсткая граница «183 дня»
    // отвергла бы эту опцию примерно в трети месяцев года — ровно в момент
    // самого эмоционально нагруженного действия в продукте.
    freezeTime(AUTH_DATE_2026_03_01);
    await resetDb();
    const { status, body } = await post(ALISHER_INIT_DATA_MARCH1, {
      ...(await baseTx()),
      hide: "6m",
    });
    expect(status).toBe(201);
    const until = await hiddenUntilOf(body.transaction.id);
    expect(until).toBe("2026-09-01");
    expect(until).toBe(addMonths("2026-03-01", 6));

    const days =
      (Date.parse("2026-09-01T00:00:00Z") - Date.parse("2026-03-01T00:00:00Z")) / 86_400_000;
    expect(days).toBe(184);
  });

  it("не позволяет задать hidden_until дальше addMonths(today, 6): дату от клиента не берёт", async () => {
    // Клиент шлёт только вариант; произвольная дата отвергается, а не
    // применяется — верхняя граница держится перечислением.
    const { status, body } = await post(ALISHER_INIT_DATA, {
      ...(await baseTx()),
      hiddenUntil: "2030-01-01",
    });
    expect(status).toBe(400);
    expect(body.error).toBe("hidden_until_immutable");
  });

  it("отвергает hiddenUntil в теле POST явно, а не игнорирует молча", async () => {
    // Раньше поле проглатывалось: клиент получал 201 и НЕзаскрытую трату,
    // не узнав об этом. Теперь поведение симметрично PATCH.
    for (const body of [
      { hiddenUntil: "2026-08-31" },
      { hidden_until: "2026-08-31" },
      { hiddenUntil: "не-дата-вообще" },
      { hiddenUntil: null },
    ]) {
      const res = await post(ALISHER_INIT_DATA, { ...(await baseTx()), ...body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe("hidden_until_immutable");
    }
    const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM transactions").first<{
      c: number;
    }>();
    expect(count?.c).toBe(0);
  });
});

describe("AC-P5: суммы — безопасные целые в (0, 1e11]", () => {
  it("isValidAmount отвергает нецелые, небезопасные и выходящие за границы", () => {
    expect(isValidAmount(1)).toBe(true);
    expect(isValidAmount(100_000_000_000)).toBe(true); // верхняя граница включительно
    expect(isValidAmount(100_000_000_001)).toBe(false);
    expect(isValidAmount(0)).toBe(false);
    expect(isValidAmount(-1)).toBe(false);
    expect(isValidAmount(340_000.5)).toBe(false);
    expect(isValidAmount(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
    expect(isValidAmount(Number.NaN)).toBe(false);
    expect(isValidAmount(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidAmount(1e21)).toBe(false);
  });

  it("POST /api/transactions отвергает такие суммы с 400", async () => {
    const bad = [0, -1, -340_000, 340_000.5, 100_000_000_001, Number.MAX_SAFE_INTEGER + 2, 1e21];
    for (const amount of bad) {
      const { status, body } = await post(ALISHER_INIT_DATA, { ...(await baseTx()), amount });
      expect(status, String(amount)).toBe(400);
      expect(body.error).toBe("bad_amount");
    }
    const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM transactions").first<{
      c: number;
    }>();
    expect(count?.c).toBe(0);
  });

  it("POST отвергает сумму, пришедшую строкой", async () => {
    const { status, body } = await post(ALISHER_INIT_DATA, {
      ...(await baseTx()),
      amount: "340000",
    });
    expect(status).toBe(400);
    expect(body.error).toBe("bad_amount");
  });

  it("PATCH отвергает те же суммы и не меняет запись", async () => {
    const created = await post(ALISHER_INIT_DATA, await baseTx());
    const id = created.body.transaction.id;
    for (const amount of [0, -1, 340_000.5, 100_000_000_001]) {
      const { status } = await apiJson(ALISHER_INIT_DATA, `/api/transactions/${id}`, {
        method: "PATCH",
        body: { amount },
      });
      expect(status, String(amount)).toBe(400);
    }
    const row = await env.DB.prepare("SELECT amount FROM transactions WHERE id = ?1")
      .bind(id)
      .first<{ amount: number }>();
    expect(row?.amount).toBe(340_000);
  });

  it("amount в БД хранится с типом INTEGER, а не REAL/TEXT", async () => {
    await post(ALISHER_INIT_DATA, { ...(await baseTx()), amount: 100_000_000_000 });
    const row = await env.DB.prepare(
      "SELECT typeof(amount) AS t, amount FROM transactions LIMIT 1",
    ).first<{ t: string; amount: number }>();
    expect(row?.t).toBe("integer");
    expect(row?.amount).toBe(100_000_000_000);
    expect(Number.isSafeInteger(row!.amount)).toBe(true);
  });

  it("CHECK в схеме держит границу и при записи мимо API", async () => {
    // Валидация на границе дублируется схемой — если бы кто-то добавил путь
    // записи мимо src/api.ts, деньги всё равно не уехали бы за 1e11.
    const cat = await categoryId(CATEGORY.groceries);
    await expect(
      env.DB.prepare(
        "INSERT INTO transactions (amount, kind, category_id, author_id, occurred_on, created_at)" +
          " VALUES (?1, 'expense', ?2, ?3, '2026-08-01', '2026-08-01T00:00:00.000Z')",
      )
        .bind(100_000_000_001, cat, ALISHER_ID)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        "INSERT INTO transactions (amount, kind, category_id, author_id, occurred_on, created_at)" +
          " VALUES (?1, 'expense', ?2, ?3, '2026-08-01', '2026-08-01T00:00:00.000Z')",
      )
        .bind(0, cat, ALISHER_ID)
        .run(),
    ).rejects.toThrow();
  });

  it("отвергает сумму цели по тем же правилам", async () => {
    for (const targetAmount of [0, -1, 1.5, 100_000_000_001]) {
      const { status } = await apiJson(ALISHER_INIT_DATA, "/api/goals", {
        method: "POST",
        body: { name: "Отпуск", targetAmount },
      });
      expect(status, String(targetAmount)).toBe(400);
    }
  });
});

describe("прочая валидация на границе", () => {
  it("отвергает дату в будущем по Ташкенту", async () => {
    const { status, body } = await post(ALISHER_INIT_DATA, {
      ...(await baseTx()),
      occurredOn: "2026-08-25",
    });
    expect(status).toBe(400);
    expect(body.error).toBe("future_date");
  });

  it("принимает сегодняшнюю дату по Ташкенту", async () => {
    const { status } = await post(ALISHER_INIT_DATA, {
      ...(await baseTx()),
      occurredOn: "2026-08-24",
    });
    expect(status).toBe(201);
  });

  it("отвергает несуществующую календарную дату", async () => {
    const { status, body } = await post(ALISHER_INIT_DATA, {
      ...(await baseTx()),
      occurredOn: "2026-02-30",
    });
    expect(status).toBe(400);
    expect(body.error).toBe("bad_date");
  });

  it("отвергает категорию, не соответствующую kind", async () => {
    const { status, body } = await post(ALISHER_INIT_DATA, {
      amount: 100,
      kind: "income",
      categoryId: await categoryId(CATEGORY.groceries),
    });
    expect(status).toBe(400);
    expect(body.error).toBe("kind_mismatch");
  });

  it("отвергает архивную категорию", async () => {
    const cat = await categoryId(CATEGORY.groceries);
    await env.DB.prepare("UPDATE categories SET is_archived = 1 WHERE id = ?1").bind(cat).run();
    const { status, body } = await post(ALISHER_INIT_DATA, {
      amount: 100,
      kind: "expense",
      categoryId: cat,
    });
    expect(status).toBe(400);
    expect(body.error).toBe("not_found");
  });

  it("отдаёт 409 на конфликт имени живой категории, а не сырую ошибку SQLite", async () => {
    const { status, body } = await apiJson(ALISHER_INIT_DATA, "/api/categories", {
      method: "POST",
      body: { name: CATEGORY.groceries, appliesTo: "expense" },
    });
    expect(status).toBe(409);
    expect(body).toEqual({ error: "name_conflict" });
  });

  it("разрешает одноимённые категории для расходов и доходов", async () => {
    // Уникальность по (name, applies_to): расходные «Подарки» не должны
    // запрещать доходные «Подарки» (подарили деньги).
    const { status } = await apiJson(ALISHER_INIT_DATA, "/api/categories", {
      method: "POST",
      body: { name: CATEGORY.gifts, appliesTo: "income" },
    });
    expect(status).toBe(201);
  });

  it("фильтрует категории предикатом applies_to IN (:kind, 'both')", async () => {
    await apiJson(ALISHER_INIT_DATA, "/api/categories", {
      method: "POST",
      body: { name: "Общая", appliesTo: "both" },
    });
    const { body } = await apiJson<{ categories: Array<{ name: string }> }>(
      ALISHER_INIT_DATA,
      "/api/categories?kind=income",
    );
    const names = body.categories.map((c) => c.name);
    expect(names).toContain(CATEGORY.salary);
    expect(names).toContain("Общая");
    expect(names).not.toContain(CATEGORY.groceries);
  });
});
