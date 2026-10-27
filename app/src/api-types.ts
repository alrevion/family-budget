// Типы JSON-контракта Mini App <-> API. Контракт получен от воркера
// "backend" 2026-08-24 (сообщение в команде family-budget-v1), camelCase.
// Конверты ({transactions:[...]} и т.п.) разворачиваются в api.ts —
// эти типы описывают уже развёрнутые данные, которыми пользуются экраны.

export type TransactionKind = "income" | "expense";
export type CategoryAppliesTo = "expense" | "income" | "both";
export type HideOption = "1d" | "1w" | "1m" | "6m";

export interface Balance {
  total: number;
  inGoals: number;
  free: number;
}

/** Пользователь семьи. Имена пишет auth-слой воркера из проверенного initData. */
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

/** Tx из контракта — проекция R3, единственная форма транзакции с сервера. */
export interface MaskedTransaction {
  id: number;
  amount: number;
  kind: TransactionKind;
  occurredOn: string; // YYYY-MM-DD
  categoryId: number | null;
  comment: string | null;
  authorId: number | null; // кто создал; null у замаскированной
  /** Кто последним правил. null и когда не правили, и когда запись замаскирована. */
  editedBy: number | null;
  editedAt: string | null; // ISO-8601 | null
  isMasked: boolean;
  revealsOn: string | null; // YYYY-MM-DD | null
}

export interface Goal {
  id: number;
  name: string;
  targetAmount: number;
  saved: number;
  isArchived: boolean;
}

// --- Отчёт: период, фильтры, срезы ------------------------------------
// Сервер отдаёт эти формы на /api/report и /api/compare (контракт от воркера
// "analytics-api" 2026-08-25). `to` в PeriodInfo — граница ВКЛЮЧИТЕЛЬНО,
// внутри воркера она полуоткрытая, наружу отдаётся -1 день.

export type PeriodKind = "month" | "quarter" | "year" | "range";

/** Шаг блока «динамика»: до 62 дней период режется по дням, дальше по месяцам. */
export type Granularity = "day" | "month";

export interface PeriodInfo {
  kind: PeriodKind;
  label: string; // '2026-08' | '2026-Q3' | '2026' | '2026-01-01..2026-03-31'
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD, включительно
  granularity: Granularity;
}

/** Выбор периода на клиенте. Три взаимоисключающие формы — ровно как в API:
 *  комбинация month/period/from-to даёт 400 conflicting_period. */
export type PeriodSel =
  | { kind: "month" | "quarter" | "year"; anchor: string } // anchor = YYYY-MM внутри периода
  | { kind: "range"; from: string; to: string };

/** Необязательные фильтры выборки, соединяются по И. Пустое значение = фильтра нет. */
export interface ReportFilters {
  categories: number[];
  author: number | null;
  kind: TransactionKind | null;
  min: number | null;
  max: number | null;
}

export interface ReportCategorySlice {
  categoryId: number | null; // null -> "Скрытое" (R3, псевдокатегория)
  name: string;
  amount: number;
  count: number; // число операций в срезе
  share: number; // доля 0..1, сумма долей по срезу = 1
}

export interface ReportComparisonRow {
  categoryId: number | null;
  name: string;
  current: number;
  previous: number; // 0 => категории не было в базовом периоде ("новая")
  delta: number; // current - previous
}

export interface ReportBucketTotals {
  bucket: string; // YYYY-MM-DD при granularity="day", иначе YYYY-MM
  month: string; // легаси-псевдоним bucket, оставлен сервером для совместимости
  income: number;
  expense: number;
}

export interface MonthlyReport {
  month: string; // = period.label
  period: PeriodInfo;
  income: number;
  expense: number;
  expensesByCategory: ReportCategorySlice[]; // AC-19, только расходы
  comparison: ReportComparisonRow[]; // AC-20, база — ПРЕДЫДУЩИЙ период той же длины
  dynamics: ReportBucketTotals[]; // AC-21
  topExpenses: MaskedTransaction[]; // AC-22, до 5, маскированные по R3
  saved: number; // AC-23: income - expense за период
}

/** Разбивка по автору. Оба пользователя приходят всегда, даже с нулями.
 *  Скрытая сумма партнёра лежит в его expense — согласованное решение (AC-6). */
export interface AuthorBreakdown {
  authorId: number;
  name: string;
  income: number;
  expense: number;
  topCategories: ReportCategorySlice[]; // до 5
}

export interface CompareAuthors {
  mode: "authors";
  period: PeriodInfo;
  authors: AuthorBreakdown[];
}

export interface ComparePeriods {
  mode: "periods";
  a: PeriodInfo;
  b: PeriodInfo;
  categories: ReportComparisonRow[]; // current = a, previous = b
}

export interface OnboardingState {
  done: boolean;
}

export interface CreateTransactionInput {
  amount: number;
  kind: TransactionKind;
  categoryId: number;
  occurredOn?: string;
  comment?: string | null;
  hide?: HideOption | null;
  /** Чек ОФД, из которого подставлена сумма. Сервер свяжет его с тратой. */
  receiptId?: number;
}

export interface UpdateTransactionInput {
  amount: number;
  kind: TransactionKind;
  categoryId: number;
  occurredOn: string;
  comment: string | null;
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

export interface ShopSummary extends Shop {
  defaultCategoryName: string | null;
  visits: number;
  totalSpent: number;
  lastVisit: string | null;
}

export interface ReceiptLookup {
  receipt: Receipt;
  shop: Shop;
  suggestedCategoryId: number | null;
  suggestedCategoryName: string | null;
  cached: boolean;
}
