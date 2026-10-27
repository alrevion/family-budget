// Магазины и чеки ОФД. Вся SQL-работа с shops/receipts живёт здесь.
//
// receipts создаются на этапе распознавания QR (чтобы повторный скан не
// ходил в ОФД), но статистика магазина считается только по строкам с
// transaction_id: брошенный скан не должен выглядеть покупкой.

import type { Receipt, ReceiptItem, Shop, ShopSummary } from "../types";

interface ShopRow {
  id: number;
  identity: string;
  tin: string;
  name: string;
  legal_name: string;
  address: string | null;
  terminal_id: string | null;
  default_category_id: number | null;
}

interface ShopSummaryRow extends ShopRow {
  default_category_name: string | null;
  visits: number;
  total_spent: number;
  last_visit: string | null;
}

interface ReceiptRow {
  id: number;
  shop_id: number;
  terminal_id: string;
  payment_no: string;
  payment_date: string;
  occurred_on: string;
  total: number;
  items_json: string;
  transaction_id: number | null;
}

function toShop(row: ShopRow): Shop {
  return {
    id: row.id,
    identity: row.identity,
    tin: row.tin,
    name: row.name,
    legalName: row.legal_name,
    address: row.address,
    terminalId: row.terminal_id,
    defaultCategoryId: row.default_category_id,
  };
}

function toShopSummary(row: ShopSummaryRow): ShopSummary {
  return {
    ...toShop(row),
    defaultCategoryName: row.default_category_name,
    visits: Number(row.visits),
    totalSpent: Number(row.total_spent),
    lastVisit: row.last_visit,
  };
}

function toReceipt(row: ReceiptRow): Receipt {
  let items: ReceiptItem[] = [];
  try {
    const parsed = JSON.parse(row.items_json) as unknown;
    if (Array.isArray(parsed)) items = parsed as ReceiptItem[];
  } catch {
    items = [];
  }
  return {
    id: row.id,
    shopId: row.shop_id,
    terminalId: row.terminal_id,
    paymentNo: row.payment_no,
    paymentDate: row.payment_date,
    occurredOn: row.occurred_on,
    total: row.total,
    items,
    transactionId: row.transaction_id,
  };
}

export interface ShopInput {
  identity: string;
  tin: string;
  name: string;
  legalName: string;
  address: string | null;
  terminalId: string;
  now: string;
}

/**
 * Создаёт магазин или обновляет его реквизиты. default_category_id при
 * конфликте НЕ трогается: память о категории меняется только осознанно —
 * сохранением траты или правкой в разделе «Магазины».
 */
export async function upsertShop(db: D1Database, input: ShopInput): Promise<Shop> {
  await db
    .prepare(
      "INSERT INTO shops" +
        " (identity, tin, name, legal_name, address, terminal_id, default_category_id, created_at, updated_at)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?7)" +
        " ON CONFLICT(identity) DO UPDATE SET" +
        " name = excluded.name, legal_name = excluded.legal_name, address = excluded.address," +
        " terminal_id = excluded.terminal_id, updated_at = excluded.updated_at",
    )
    .bind(
      input.identity,
      input.tin,
      input.name,
      input.legalName,
      input.address,
      input.terminalId,
      input.now,
    )
    .run();
  const shop = await getShopByIdentity(db, input.identity);
  if (shop === null) throw new Error("shop upsert failed");
  return shop;
}

export async function getShopByIdentity(db: D1Database, identity: string): Promise<Shop | null> {
  const row = await db
    .prepare("SELECT * FROM shops WHERE identity = ?1")
    .bind(identity)
    .first<ShopRow>();
  return row === null ? null : toShop(row);
}

export async function getShop(db: D1Database, id: number): Promise<Shop | null> {
  const row = await db.prepare("SELECT * FROM shops WHERE id = ?1").bind(id).first<ShopRow>();
  return row === null ? null : toShop(row);
}

export async function setShopDefaultCategory(
  db: D1Database,
  shopId: number,
  categoryId: number,
  now: string,
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE shops SET default_category_id = ?1, updated_at = ?2 WHERE id = ?3")
    .bind(categoryId, now, shopId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function clearShopDefaultCategory(
  db: D1Database,
  shopId: number,
  now: string,
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE shops SET default_category_id = NULL, updated_at = ?1 WHERE id = ?2")
    .bind(now, shopId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Магазины, по которым есть хотя бы одна сохранённая трата. */
export async function listShops(db: D1Database): Promise<ShopSummary[]> {
  const { results } = await db
    .prepare(
      "SELECT s.*, c.name AS default_category_name," +
        " COUNT(r.id) AS visits, COALESCE(SUM(r.total), 0) AS total_spent," +
        " MAX(r.occurred_on) AS last_visit" +
        " FROM shops s" +
        " JOIN receipts r ON r.shop_id = s.id AND r.transaction_id IS NOT NULL" +
        " LEFT JOIN categories c ON c.id = s.default_category_id" +
        " GROUP BY s.id" +
        " ORDER BY last_visit DESC, s.name",
    )
    .all<ShopSummaryRow>();
  return results.map(toShopSummary);
}

export async function getShopSummary(db: D1Database, id: number): Promise<ShopSummary | null> {
  const row = await db
    .prepare(
      "SELECT s.*, c.name AS default_category_name," +
        " COUNT(r.id) AS visits, COALESCE(SUM(r.total), 0) AS total_spent," +
        " MAX(r.occurred_on) AS last_visit" +
        " FROM shops s" +
        " JOIN receipts r ON r.shop_id = s.id AND r.transaction_id IS NOT NULL" +
        " LEFT JOIN categories c ON c.id = s.default_category_id" +
        " WHERE s.id = ?1" +
        " GROUP BY s.id",
    )
    .bind(id)
    .first<ShopSummaryRow>();
  return row === null ? null : toShopSummary(row);
}

export interface NewReceipt {
  shopId: number;
  terminalId: string;
  paymentNo: string;
  paymentDate: string;
  occurredOn: string;
  fiscalSign: string | null;
  total: number;
  items: ReceiptItem[];
  now: string;
}

export async function saveReceipt(db: D1Database, input: NewReceipt): Promise<Receipt> {
  await db
    .prepare(
      "INSERT INTO receipts" +
        " (shop_id, terminal_id, payment_no, payment_date, occurred_on, fiscal_sign, total, items_json, transaction_id, created_at)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9)" +
        " ON CONFLICT(terminal_id, payment_no, payment_date) DO NOTHING",
    )
    .bind(
      input.shopId,
      input.terminalId,
      input.paymentNo,
      input.paymentDate,
      input.occurredOn,
      input.fiscalSign,
      input.total,
      JSON.stringify(input.items),
      input.now,
    )
    .run();
  const receipt = await getReceiptByKey(
    db,
    input.terminalId,
    input.paymentNo,
    input.paymentDate,
  );
  if (receipt === null) throw new Error("receipt save failed");
  return receipt;
}

export async function getReceiptByKey(
  db: D1Database,
  terminalId: string,
  paymentNo: string,
  paymentDate: string,
): Promise<Receipt | null> {
  const row = await db
    .prepare(
      "SELECT * FROM receipts WHERE terminal_id = ?1 AND payment_no = ?2 AND payment_date = ?3",
    )
    .bind(terminalId, paymentNo, paymentDate)
    .first<ReceiptRow>();
  return row === null ? null : toReceipt(row);
}

export async function getReceipt(db: D1Database, id: number): Promise<Receipt | null> {
  const row = await db.prepare("SELECT * FROM receipts WHERE id = ?1").bind(id).first<ReceiptRow>();
  return row === null ? null : toReceipt(row);
}

export async function linkReceiptToTransaction(
  db: D1Database,
  receiptId: number,
  transactionId: number,
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE receipts SET transaction_id = ?1 WHERE id = ?2 AND transaction_id IS NULL")
    .bind(transactionId, receiptId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Удаление траты убирает и её чек: иначе уникальный ключ не дал бы записать
 * тот же чек заново после исправления ошибки, а «Магазины» показывали бы
 * покупку, которой уже нет.
 */
export async function deleteReceiptsForTransaction(
  db: D1Database,
  transactionId: number,
): Promise<void> {
  await db.prepare("DELETE FROM receipts WHERE transaction_id = ?1").bind(transactionId).run();
}
