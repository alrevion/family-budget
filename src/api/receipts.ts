// Распознавание QR-чека ОФД. Один маршрут: клиент присылает текст из
// QR-кода (ссылка ofd.soliq.uz/check?...), сервер достаёт чек и магазин.
//
// Кеш: receipts хранит уже распознанный чек, поэтому повторный скан того же
// чека (и любое открытие карточки) не ходит в ОФД. Магазин запоминается по
// ИНН, а категория — по последней сохранённой трате из этого магазина.
//
// Почему поле `ofd`: с edge Cloudflare запросы к new-ofd.soliq.uz не проходят
// (таймаут — ОФД блокирует датацентровые IP). Телефон же пользователя в
// Узбекистане видит ОФД напрямую, а CORS ОФД разрешает любому origin. Поэтому
// при `receipt_unavailable` клиент сам подписывает и делает запрос, а сюда
// присылает уже полученный объект `data`; нормализация, кеш и память
// магазинов остаются на сервере — в одном месте.

import type { Hono } from "hono";
import * as q from "../queries";
import {
  OfdError,
  fetchOfdReceipt,
  normalizeOfdReceipt,
  parseReceiptLink,
  shopIdentity,
  type OfdApiData,
  type ReceiptLink,
} from "../ofd";
import type { AppEnv } from "./validate";
import { readBody } from "./validate";

const OFD_ERROR_STATUS: Record<string, 404 | 422 | 502> = {
  receipt_not_ready: 404,
  receipt_not_found: 404,
  receipt_is_refund: 422,
  receipt_unavailable: 502,
};

/** Ответ ОФД от клиента — не больше пары сотен килобайт. */
const MAX_CLIENT_OFD_BYTES = 200_000;

function linkPayload(link: ReceiptLink): Record<string, unknown> {
  return {
    terminalId: link.terminalId,
    paymentNo: link.paymentNo,
    paymentDate: link.paymentDate,
    fiscalSign: link.fiscalSign,
    fiscalSignHash: link.fiscalSignHash,
  };
}

/** Объект `data` из ответа ОФД, присланный клиентом после прямого запроса. */
function clientOfdData(raw: unknown): OfdApiData | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const data = raw as OfdApiData;
  try {
    if (JSON.stringify(data).length > MAX_CLIENT_OFD_BYTES) return null;
  } catch {
    return null;
  }
  return data;
}

export function mount(api: Hono<AppEnv>): void {
  api.post("/api/receipts/lookup", async (c) => {
    const body = await readBody(c);
    if (body === null) return c.json({ error: "bad_body" }, 400);

    const raw = body.text ?? body.url;
    if (typeof raw !== "string") return c.json({ error: "bad_receipt_link" }, 400);
    const link = parseReceiptLink(raw);
    if (link === null) return c.json({ error: "bad_receipt_link" }, 400);

    const db = c.env.DB;
    const now = new Date().toISOString();
    let receipt = await q.getReceiptByKey(
      db,
      link.terminalId,
      link.paymentNo,
      link.paymentDate,
    );
    const cached = receipt !== null;
    let shop = receipt === null ? null : await q.getShop(db, receipt.shopId);

    if (receipt === null) {
      const fromClient = clientOfdData(body.ofd);
      let parsed;
      try {
        if (fromClient === null) {
          parsed = await fetchOfdReceipt(link);
        } else {
          parsed = normalizeOfdReceipt(fromClient, link);
          // Ключ чека — из QR, а не из присланного клиентом объекта: иначе
          // кеш и дедупликация разъехались бы с тем, что записано в QR.
          parsed.terminalId = link.terminalId;
          parsed.paymentNo = link.paymentNo;
        }
      } catch (e) {
        if (e instanceof OfdError) {
          return c.json(
            {
              error: e.code,
              // Клиенту нужно самому сходить в ОФД: подпись считается по этим
              // параметрам, повторно разбирать ссылку ему не обязательно.
              ...(e.code === "receipt_unavailable" ? { link: linkPayload(link) } : {}),
            },
            OFD_ERROR_STATUS[e.code] ?? 502,
          );
        }
        throw e;
      }

      shop = await q.upsertShop(db, {
        identity: shopIdentity(parsed.merchant.tin, parsed.terminalId),
        tin: parsed.merchant.tin,
        name: parsed.merchant.name,
        legalName: parsed.merchant.legalName,
        address: parsed.merchant.address,
        terminalId: parsed.terminalId,
        now,
      });
      receipt = await q.saveReceipt(db, {
        shopId: shop.id,
        terminalId: parsed.terminalId,
        paymentNo: parsed.paymentNo,
        paymentDate: parsed.paymentDate,
        occurredOn: parsed.occurredOn,
        fiscalSign: link.fiscalSign,
        total: parsed.total,
        items: parsed.items,
        now,
      });
    }

    if (shop === null) return c.json({ error: "receipt_not_found" }, 404);

    // Подсказка — только живая расходная категория. Архивная остаётся в
    // памяти магазина, но подставлять её в форму нельзя.
    const defaultCategory =
      shop.defaultCategoryId === null ? null : await q.getCategory(db, shop.defaultCategoryId);
    const suggested =
      defaultCategory !== null &&
      !defaultCategory.isArchived &&
      defaultCategory.appliesTo !== "income"
        ? defaultCategory
        : null;

    return c.json({
      receipt,
      shop,
      suggestedCategoryId: suggested?.id ?? null,
      suggestedCategoryName: suggested?.name ?? null,
      cached,
    });
  });
}
