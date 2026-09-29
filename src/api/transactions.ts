// Маршруты транзакций и список месяцев.

import type { Hono } from "hono";
import * as q from "../queries";
import { isValidAmount } from "../money";
import { todayInTashkent } from "../time";
import type { TransactionKind } from "../types";
import { parseFilter, parsePeriodQuery } from "./periods";
import type { AppEnv } from "./validate";
import { HIDE_OPTIONS, KINDS, categoryMismatch, isValidDate, parseId, readBody } from "./validate";

export function mount(api: Hono<AppEnv>): void {
  api.get("/api/transactions", async (c) => {
    const today = todayInTashkent();
    const period = parsePeriodQuery(c, today);
    if (!period.ok) return c.json({ error: period.error }, 400);
    const filter = await parseFilter(c.env.DB, c);
    if (!filter.ok) return c.json({ error: filter.error }, 400);
    const viewer = c.get("user").telegramId;
    const transactions = await q.listTransactions(
      c.env.DB,
      viewer,
      period.value,
      today,
      filter.value,
    );
    return c.json({ transactions, period: q.periodInfo(period.value) });
  });

  api.get("/api/months", async (c) => c.json({ months: await q.listMonths(c.env.DB) }));

  api.get("/api/transactions/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "bad_id" }, 400);
    const tx = await q.getTransaction(c.env.DB, c.get("user").telegramId, id, todayInTashkent());
    if (tx === null) return c.json({ error: "not_found" }, 404);
    return c.json({ transaction: tx });
  });

  api.post("/api/transactions", async (c) => {
    const body = await readBody(c);
    if (body === null) return c.json({ error: "bad_body" }, 400);
    const today = todayInTashkent();

    const amount = body.amount;
    if (typeof amount !== "number" || !isValidAmount(amount)) {
      return c.json({ error: "bad_amount" }, 400);
    }
    const kind = body.kind;
    if (typeof kind !== "string" || !KINDS.includes(kind)) return c.json({ error: "bad_kind" }, 400);
    const categoryId = body.categoryId;
    if (typeof categoryId !== "number" || !Number.isInteger(categoryId)) {
      return c.json({ error: "bad_category" }, 400);
    }
    const occurredOn = body.occurredOn ?? today;
    if (!isValidDate(occurredOn)) return c.json({ error: "bad_date" }, 400);
    if (occurredOn > today) return c.json({ error: "future_date" }, 400);
    const comment = body.comment ?? null;
    if (comment !== null && (typeof comment !== "string" || comment.length > 280)) {
      return c.json({ error: "bad_comment" }, 400);
    }

    // Срок скрытия — вариант, дату считает сервер. Дату от клиента не принимаем:
    // клиентский и серверный расчёт «полугода» разошлись бы на день ровно на той
    // опции, ради которой правка и вносилась.
    // Симметрично PATCH: дату раскрытия считает сервер из варианта hide,
    // прислать её напрямую нельзя. Молчаливое игнорирование давало клиенту 201
    // и НЕскрытую трату без единого сигнала.
    for (const key of ["hiddenUntil", "hidden_until"] as const) {
      if (key in body) return c.json({ error: "hidden_until_immutable" }, 400);
    }

    let hiddenUntil: string | null = null;
    const hide = body.hide ?? null;
    if (hide !== null) {
      if (typeof hide !== "string" || !(hide in HIDE_OPTIONS)) {
        return c.json({ error: "bad_hide_option" }, 400);
      }
      hiddenUntil = HIDE_OPTIONS[hide]!(today);
    }

    const mismatch = await categoryMismatch(c.env.DB, categoryId, kind as TransactionKind);
    if (mismatch !== null) return c.json({ error: mismatch }, 400);

    const id = await q.createTransaction(c.env.DB, {
      amount,
      kind: kind as TransactionKind,
      categoryId,
      authorId: c.get("user").telegramId,
      occurredOn,
      comment: comment as string | null,
      hiddenUntil,
      createdAt: new Date().toISOString(),
    });
    const transaction = await q.getTransaction(c.env.DB, c.get("user").telegramId, id, today);
    return c.json({ transaction }, 201);
  });

  api.patch("/api/transactions/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "bad_id" }, 400);
    const body = await readBody(c);
    if (body === null) return c.json({ error: "bad_body" }, 400);

    const today = todayInTashkent();
    const viewer = c.get("user").telegramId;
    const row = await q.getTransactionRaw(c.env.DB, id);
    if (row === null) return c.json({ error: "not_found" }, 404);

    // R3: не-автор не может править скрытую запись, пока hidden_until > today.
    if (row.hiddenUntil !== null && row.hiddenUntil > today && row.authorId !== viewer) {
      return c.json({ error: "forbidden" }, 403);
    }

    // Отклоняется ИЗМЕНЕНИЕ hidden_until, а не наличие поля: типовая форма
    // отправляет загруженный объект целиком, и безусловный отказ положил бы
    // правку автором своей же скрытой траты. Принимаются оба написания ключа.
    for (const key of ["hiddenUntil", "hidden_until"] as const) {
      if (key in body && (body[key] ?? null) !== row.hiddenUntil) {
        return c.json({ error: "hidden_until_immutable" }, 400);
      }
    }

    const patch: q.TransactionPatch = {};
    if ("amount" in body) {
      if (typeof body.amount !== "number" || !isValidAmount(body.amount)) {
        return c.json({ error: "bad_amount" }, 400);
      }
      patch.amount = body.amount;
    }
    if ("kind" in body) {
      if (typeof body.kind !== "string" || !KINDS.includes(body.kind)) {
        return c.json({ error: "bad_kind" }, 400);
      }
      patch.kind = body.kind as TransactionKind;
    }
    if ("categoryId" in body) {
      if (typeof body.categoryId !== "number" || !Number.isInteger(body.categoryId)) {
        return c.json({ error: "bad_category" }, 400);
      }
      patch.categoryId = body.categoryId;
    }
    if ("occurredOn" in body) {
      if (!isValidDate(body.occurredOn)) return c.json({ error: "bad_date" }, 400);
      if (body.occurredOn > today) return c.json({ error: "future_date" }, 400);
      patch.occurredOn = body.occurredOn;
    }
    if ("comment" in body) {
      const comment = body.comment ?? null;
      if (comment !== null && (typeof comment !== "string" || comment.length > 280)) {
        return c.json({ error: "bad_comment" }, 400);
      }
      patch.comment = comment as string | null;
    }

    // Правка kind требует категории, соответствующей НОВОМУ kind.
    const nextKind = patch.kind ?? row.kind;
    const nextCategory = patch.categoryId ?? row.categoryId;
    if (patch.kind !== undefined || patch.categoryId !== undefined) {
      const mismatch = await categoryMismatch(c.env.DB, nextCategory, nextKind);
      if (mismatch !== null) return c.json({ error: mismatch }, 400);
    }

    // viewer — тот, кто правит; author_id записи при этом не трогается.
    await q.updateTransaction(c.env.DB, id, patch, viewer, new Date().toISOString());
    const transaction = await q.getTransaction(c.env.DB, viewer, id, today);
    return c.json({ transaction });
  });

  api.delete("/api/transactions/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return c.json({ error: "bad_id" }, 400);
    const today = todayInTashkent();
    const viewer = c.get("user").telegramId;
    const row = await q.getTransactionRaw(c.env.DB, id);
    if (row === null) return c.json({ error: "not_found" }, 404);
    if (row.hiddenUntil !== null && row.hiddenUntil > today && row.authorId !== viewer) {
      return c.json({ error: "forbidden" }, 403);
    }
    // Ответ идёт через ту же проекцию R3, что и чтение.
    const transaction = await q.getTransaction(c.env.DB, viewer, id, today);
    await q.deleteTransaction(c.env.DB, id);
    return c.json({ ok: true, transaction });
  });
}
