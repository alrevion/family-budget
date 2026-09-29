// Единственная точка входа в сеть. Контракт получен от воркера "backend"
// 2026-08-24 (команда family-budget-v1) — пути и конверты ответов ниже
// соответствуют ему. Экраны зовут только функции этого файла.
import type {
  Balance,
  Category,
  CompareAuthors,
  ComparePeriods,
  CreateTransactionInput,
  Goal,
  MaskedTransaction,
  MonthlyReport,
  OnboardingState,
  PeriodSel,
  ReportFilters,
  UpdateTransactionInput,
  User,
} from "./api-types.js";

let initData = "";
let onUnauthorized: () => void = () => {};

/** Вызывается один раз из main.ts после Telegram.WebApp.ready(). */
export function configureApi(data: string, unauthorizedHandler: () => void): void {
  initData = data;
  onUnauthorized = unauthorizedHandler;
}

/** 409 — ожидаемый бизнес-конфликт, показывается человеческим текстом, не как ошибка. */
export class ApiConflictError extends Error {}

/** Любой другой сетевой/серверный сбой. */
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Коды из тела {"error":"<code>"} -> человеческий текст. Явно перечислены
// только коды из контракта; неизвестный код показывается как есть —
// сервер уже пишет их по-английски короткими, но лучше показать что-то,
// чем проглотить ошибку молча.
const ERROR_MESSAGES: Record<string, string> = {
  missing_init_data: "Сессия устарела, откройте приложение заново",
  bad_init_data: "Сессия устарела, откройте приложение заново",
  stale_init_data: "Сессия устарела, откройте приложение заново",
  forbidden: "Недостаточно прав для этого действия",
  bad_month: "Некорректный месяц",
  not_found: "Запись не найдена",
  bad_id: "Некорректный идентификатор",
  bad_body: "Некорректные данные",
  bad_amount: "Сумма указана некорректно",
  bad_kind: "Некорректный тип операции",
  bad_category: "Некорректная категория",
  bad_date: "Некорректная дата",
  future_date: "Дата не может быть в будущем",
  bad_comment: "Слишком длинный комментарий",
  bad_hide_option: "Некорректный срок скрытия",
  kind_mismatch: "Выберите категорию для нового типа операции",
  hidden_until_immutable: "Срок раскрытия скрытой траты изменить нельзя",
  name_conflict: "Категория с таким именем уже существует",
  allocation_rejected: "Свободных денег недостаточно",
  deallocation_rejected: "В цели отложено меньше, чем вы пытаетесь вернуть",
  bad_value: "Некорректное значение",
  // Период и фильтры отчёта (контракт analytics-api).
  bad_period: "Некорректный вид периода",
  bad_anchor: "Некорректный месяц периода",
  bad_range: "Начало диапазона позже конца",
  future_range: "Диапазон не может заходить в будущее",
  range_too_long: "Диапазон длиннее пяти лет",
  conflicting_period: "Период задан двумя способами сразу",
  missing_period: "Не выбраны периоды для сравнения",
  bad_mode: "Некорректный режим сравнения",
  unknown_category: "Категория из фильтра не найдена",
  too_many_categories: "Слишком много категорий в фильтре",
  bad_author: "Некорректный автор",
  unknown_author: "Автор из фильтра не найден",
  bad_min: "Некорректная сумма «от»",
  bad_max: "Некорректная сумма «до»",
  bad_amount_range: "Сумма «от» больше суммы «до»",
};

function translateError(code: string | null, fallback: string): string {
  if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
  return code ?? fallback;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `tma ${initData}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Нет связи с сервером. Проверьте интернет и попробуйте снова.");
  }

  if (res.status === 401) {
    // R4.6: НЕ location.reload() — initData во фрагменте URL переживёт
    // перезагрузку, auth_date останется тем же просроченным -> вечный 401.
    onUnauthorized();
    throw new ApiError(401, "Сессия устарела");
  }

  if (res.status === 409) {
    const code = await safeErrorCode(res);
    throw new ApiConflictError(translateError(code, "Действие невозможно"));
  }

  if (!res.ok) {
    const code = await safeErrorCode(res);
    throw new ApiError(res.status, translateError(code, `Ошибка сервера (${res.status})`));
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function safeErrorCode(res: Response): Promise<string | null> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error ?? null;
  } catch {
    return null;
  }
}

// --- Баланс -----------------------------------------------------------
export const getBalance = () => request<Balance>("GET", "/api/balance");

// --- Пользователи -------------------------------------------------------
// Нужны ленте, чтобы подписать чужую запись именем. Лёгкий маршрут, а не
// /api/compare?mode=authors: тот ради двух имён считает агрегаты за период.
export const listUsers = async () => (await request<{ users: User[] }>("GET", "/api/users")).users;

// --- Онбординг (план: app_state, шаг 9) --------------------------------
// Нет выделенного /api/onboarding — это state-ключ onboarding_done плюс
// обычная транзакция категории "Стартовый остаток" (контракт от backend).
export async function getOnboarding(): Promise<OnboardingState> {
  const { value } = await request<{ key: string; value: string | null }>("GET", "/api/state/onboarding_done");
  return { done: value === "1" };
}

export async function completeOnboarding(startingAmount: number): Promise<OnboardingState> {
  const incomeCategories = await listCategories("income");
  const startingCategory = incomeCategories.find((c) => c.name === "Стартовый остаток");
  if (!startingCategory) {
    throw new ApiError(0, "Категория «Стартовый остаток» не найдена. Обратитесь к администратору.");
  }
  await createTransaction({
    amount: startingAmount,
    kind: "income",
    categoryId: startingCategory.id,
    comment: null,
  });
  await request<{ ok: true }>("PUT", "/api/state/onboarding_done", { value: "1" });
  return { done: true };
}

/**
 * Кнопка «Ничего не тратили» из ежедневного напоминания. Срок тишины считает
 * сервер (src/cron.ts#quietUntil) — клиент его не знает и знать не должен.
 */
export const markNoSpend = async (): Promise<void> => {
  await request<{ ok: true; until: string }>("POST", "/api/state/quiet");
};

// --- Транзакции ---------------------------------------------------------
export const listTransactions = async (month: string) =>
  (await request<{ transactions: MaskedTransaction[] }>("GET", `/api/transactions?month=${encodeURIComponent(month)}`))
    .transactions;

export const createTransaction = async (input: CreateTransactionInput) =>
  (await request<{ transaction: MaskedTransaction }>("POST", "/api/transactions", input)).transaction;

export const updateTransaction = async (id: number, input: UpdateTransactionInput) =>
  (await request<{ transaction: MaskedTransaction }>("PATCH", `/api/transactions/${id}`, input)).transaction;

export const deleteTransaction = async (id: number): Promise<void> => {
  await request<{ ok: true; transaction: MaskedTransaction }>("DELETE", `/api/transactions/${id}`);
};

// --- Категории ------------------------------------------------------------
export const listCategories = async (kind: "expense" | "income") =>
  (await request<{ categories: Category[] }>("GET", `/api/categories?kind=${kind}`)).categories;

/** Без ?kind — все живые категории обоих типов. Нужен фильтру отчёта: там
 *  выбор не привязан к типу операции (можно фильтровать и доходы, и расходы). */
export const listAllCategories = async () =>
  (await request<{ categories: Category[] }>("GET", "/api/categories")).categories;

export const createCategory = async (
  name: string,
  appliesTo: "expense" | "income",
): Promise<Category> => {
  const { id } = await request<{ id: number }>("POST", "/api/categories", { name, appliesTo });
  return { id, name, appliesTo, isCustom: true, isArchived: false };
};

export const renameCategory = async (id: number, name: string): Promise<void> => {
  await request<{ ok: true }>("PATCH", `/api/categories/${id}`, { name });
};

export const archiveCategory = async (id: number): Promise<void> => {
  await request<{ ok: true }>("DELETE", `/api/categories/${id}`);
};

// --- Цели ------------------------------------------------------------------
export const listGoals = async () => (await request<{ goals: Goal[] }>("GET", "/api/goals")).goals;

export const createGoal = async (name: string, targetAmount: number): Promise<number> =>
  (await request<{ id: number }>("POST", "/api/goals", { name, targetAmount })).id;

export const allocateToGoal = async (id: number, amount: number): Promise<void> => {
  await request<{ ok: true }>("POST", `/api/goals/${id}/allocate`, { amount });
};

export const deallocateFromGoal = async (id: number, amount: number): Promise<void> => {
  await request<{ ok: true }>("POST", `/api/goals/${id}/deallocate`, { amount });
};

export const archiveGoal = async (id: number): Promise<void> => {
  await request<{ ok: true }>("DELETE", `/api/goals/${id}`);
};

// --- Отчёт -------------------------------------------------------------
// Период передаётся ровно одной формой: ?period=&anchor= для календарных,
// ?from=&to= для произвольного диапазона. Легаси ?month= клиент не шлёт —
// на нём остаётся cron; смешение форм сервер отвергает (conflicting_period).
function periodParams(sel: PeriodSel): URLSearchParams {
  const p = new URLSearchParams();
  if (sel.kind === "range") {
    p.set("from", sel.from);
    p.set("to", sel.to);
  } else {
    p.set("period", sel.kind);
    p.set("anchor", sel.anchor);
  }
  return p;
}

/** Пустое значение параметра сервер трактует как «фильтра нет» — не шлём его вовсе. */
function appendFilters(p: URLSearchParams, f?: ReportFilters): URLSearchParams {
  if (!f) return p;
  if (f.categories.length > 0) p.set("categories", f.categories.join(","));
  if (f.author != null) p.set("author", String(f.author));
  if (f.kind != null) p.set("kind", f.kind);
  if (f.min != null) p.set("min", String(f.min));
  if (f.max != null) p.set("max", String(f.max));
  return p;
}

/** Однострочная форма периода для ?a=/?b= режима сравнения периодов. */
export function periodSpec(sel: PeriodSel): string {
  if (sel.kind === "range") return `${sel.from}..${sel.to}`;
  return sel.kind === "month" ? sel.anchor : `${sel.kind}:${sel.anchor}`;
}

export const listMonths = async () => (await request<{ months: string[] }>("GET", "/api/months")).months;

export const getReport = (sel: PeriodSel, filters?: ReportFilters) =>
  request<MonthlyReport>("GET", `/api/report?${appendFilters(periodParams(sel), filters)}`);

export const compareAuthors = (sel: PeriodSel, filters?: ReportFilters) => {
  const p = appendFilters(periodParams(sel), filters);
  p.set("mode", "authors");
  return request<CompareAuthors>("GET", `/api/compare?${p}`);
};

export const comparePeriods = (a: PeriodSel, b: PeriodSel, filters?: ReportFilters) => {
  const p = appendFilters(new URLSearchParams(), filters);
  p.set("mode", "periods");
  p.set("a", periodSpec(a));
  p.set("b", periodSpec(b));
  return request<ComparePeriods>("GET", `/api/compare?${p}`);
};
