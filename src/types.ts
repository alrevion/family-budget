// Биндинги воркера и доменные типы по схеме migrations/0001_init.sql.
// Домены используют camelCase; D1-слой (src/queries.ts, ещё не написан)
// отвечает за перевод snake_case колонок и INTEGER-булевых (0/1) сюда.

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Секрет: токен Telegram-бота. */
  BOT_TOKEN: string;
  /** Секрет: значение заголовка X-Telegram-Bot-Api-Secret-Token для /tg/webhook. */
  WEBHOOK_SECRET: string;
  /** Секрет: CSV целых Telegram ID, напр. "111111111,222222222". Парсится в number[] в src/auth.ts (R4.5). */
  ALLOWED_IDS: string;
  /** Публичный username бота без @ — для фолбэк-ссылки t.me/<bot>/<app> (src/bot.ts, план шаг 15). */
  BOT_USERNAME: string;
  /** Короткое имя Mini App, зарегистрированное в BotFather — вторая часть t.me/<bot>/<app>. */
  MINI_APP_SHORT_NAME: string;
  /** HTTPS-адрес задеплоенного Mini App — для основной web_app-кнопки. */
  MINI_APP_URL: string;
}

export type TransactionKind = "income" | "expense";
export type CategoryAppliesTo = "expense" | "income" | "both";

export interface User {
  telegramId: number;
  name: string;
}

export interface Category {
  id: number;
  name: string;
  appliesTo: CategoryAppliesTo;
  isCustom: boolean;
  isArchived: boolean;
}

/** Полная (немаскированная) запись — вид автора и внутренние операции. */
export interface Transaction {
  id: number;
  amount: number;
  kind: TransactionKind;
  categoryId: number;
  authorId: number;
  occurredOn: string; // 'YYYY-MM-DD'
  comment: string | null;
  hiddenUntil: string | null; // 'YYYY-MM-DD' | null, null = не скрыта
  createdAt: string;
  /** Кто последним правил запись. null = не правили ни разу. authorId не меняется никогда. */
  editedBy: number | null;
  editedAt: string | null; // ISO-8601 | null
}

/**
 * Проекция R3 — единственная форма, в которой транзакция покидает слой
 * запросов для чтения (список месяца, топ-5, ответы PATCH/DELETE, одиночная
 * выборка). Для не-автора активно скрытой записи
 * category_id/comment/authorId/editedBy/editedAt равны null,
 * isMasked === true, revealsOn содержит hidden_until.
 */
export interface MaskedTransaction {
  id: number;
  amount: number;
  kind: TransactionKind;
  occurredOn: string;
  categoryId: number | null;
  comment: string | null;
  authorId: number | null;
  /** Кто последним правил. null и когда не правили, и когда запись замаскирована. */
  editedBy: number | null;
  editedAt: string | null;
  isMasked: boolean;
  revealsOn: string | null;
}

export interface Goal {
  id: number;
  name: string;
  targetAmount: number;
  isArchived: boolean;
}

export interface GoalAllocation {
  id: number;
  goalId: number;
  amount: number; // отрицательное значение = возврат (AC-15)
  authorId: number;
  createdAt: string;
}

/** Единственный источник "Свободно" — см. вью v_balance (план, раздел R1). */
export interface Balance {
  total: number;
  inGoals: number;
  free: number;
}

// --- Магазины и чеки ОФД ------------------------------------------------

export interface ReceiptItem {
  name: string;
  qty: number;
  price: number;
  productName: string | null;
}

export interface Receipt {
  id: number;
  shopId: number;
  terminalId: string;
  paymentNo: string;
  paymentDate: string;
  occurredOn: string;
  total: number;
  items: ReceiptItem[];
  /** null — чек распознан, но трата ещё не сохранена. */
  transactionId: number | null;
}

export interface Shop {
  id: number;
  identity: string;
  tin: string;
  name: string;
  legalName: string;
  address: string | null;
  terminalId: string | null;
  defaultCategoryId: number | null;
}

/** Магазин для раздела «Магазины»: память + статистика по сохранённым чекам. */
export interface ShopSummary extends Shop {
  defaultCategoryName: string | null;
  visits: number;
  totalSpent: number;
  lastVisit: string | null;
}

/** Ответ на распознавание QR: чек, магазин и подсказка категории. */
export interface ReceiptLookup {
  receipt: Receipt;
  shop: Shop;
  suggestedCategoryId: number | null;
  suggestedCategoryName: string | null;
  /** true — ответ из кеша D1, в ОФД не ходили. */
  cached: boolean;
}
