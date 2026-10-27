// Чеки ОФД (Soliq). QR-код чека — это ссылка вида
// https://ofd.soliq.uz/check?t=<ККМ>&r=<номер>&c=<дата>&s=<фискальный признак>
// (у EPI-чеков вместо s параметр h — хеш фискального признака).
//
// Страницу ofd.soliq.uz парсить не нужно: она сама ходит в публичный
// JSON API new-ofd.soliq.uz/api/payment с HMAC-подписью. Повторяем этот
// запрос на сервере — без CORS, без загрузки SPA и с кешем в D1: повторный
// скан того же чека уже не ходит в ОФД.
//
// Секрет подписи лежит в открытом JS-бандле ofd.soliq.uz — это не наш
// секрет. Наружу из воркера он всё равно не отдаётся.

const OFD_API_BASE = "https://new-ofd.soliq.uz/api";
const OFD_SIGNATURE_SECRET = "thisIsPaymentSecretKey123@#";
// С edge Cloudflare ОФД обычно не отвечает вовсе (см. комментарий в
// app/src/ofd-direct.ts — чек со своего телефона запрашивает клиент).
// Серверный путь остаётся запасным, поэтому ждём недолго: иначе пользователь
// смотрел бы на «Читаю чек…» лишние секунды перед фолбэком.
const OFD_TIMEOUT_MS = 6_000;

export type OfdErrorCode =
  | "receipt_not_ready"
  | "receipt_not_found"
  | "receipt_is_refund"
  | "receipt_unavailable";

export class OfdError extends Error {
  constructor(
    public readonly code: OfdErrorCode,
    options?: { cause?: unknown },
  ) {
    super(code, options);
    this.name = "OfdError";
  }
}

export interface ReceiptLink {
  terminalId: string;
  paymentNo: string;
  /** Сырая дата из QR: 'YYYYMMDDhhmmss'. */
  paymentDate: string;
  fiscalSign: string | null;
  fiscalSignHash: string | null;
}

export interface OfdReceiptItem {
  name: string;
  qty: number;
  /** Сумма по строке в сумах (в API приходит уже умноженной на количество). */
  price: number;
  productName: string | null;
}

export interface OfdReceipt {
  terminalId: string;
  paymentNo: string;
  /** Сырой ключ из QR — по нему чек дедуплицируется. */
  paymentDate: string;
  occurredOn: string; // 'YYYY-MM-DD'
  total: number;
  merchant: {
    tin: string;
    name: string; // очищенное имя для интерфейса
    legalName: string; // как в чеке
    address: string | null;
  };
  items: OfdReceiptItem[];
  kkmName: string | null;
  kkmSerial: string | null;
}

const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/i;

/**
 * Достаёт параметры чека из ссылки (или из строки query-параметров).
 * Возвращает null для любого мусора: и чужие ссылки, и недописанные QR.
 */
export function parseReceiptLink(input: string): ReceiptLink | null {
  const text = String(input ?? "").trim();
  if (text.length === 0 || text.length > 2048) return null;

  let params: URLSearchParams;
  const urlMatch = URL_IN_TEXT.exec(text);
  if (urlMatch !== null) {
    let url: URL;
    try {
      url = new URL(urlMatch[0]);
    } catch {
      return null;
    }
    // Никаких запросов по этой ссылке не делаем, но пускать сюда произвольный
    // хост незачем: QR чека всегда ведёт на домен Soliq.
    if (!/(^|\.)soliq\.uz$/i.test(url.hostname)) return null;
    if (!url.pathname.includes("/check")) return null;
    params = url.searchParams;
  } else if (text.includes("=")) {
    // Пользователь вставил только хвост "t=...&r=...&c=...&s=...".
    params = new URLSearchParams(text.replace(/^\?/, ""));
  } else {
    return null;
  }

  const terminalId = (params.get("t") ?? "").trim();
  const paymentNo = (params.get("r") ?? "").trim();
  const paymentDate = (params.get("c") ?? "").trim();
  const fiscalSign = (params.get("s") ?? "").trim();
  const fiscalSignHash = (params.get("h") ?? "").trim();

  if (!/^[A-Z0-9]{6,32}$/i.test(terminalId)) return null;
  if (!/^\d{1,20}$/.test(paymentNo)) return null;
  if (!/^\d{14}$/.test(paymentDate)) return null;
  if (fiscalSign === "" && fiscalSignHash === "") return null;
  if (fiscalSign !== "" && !/^\d{1,40}$/.test(fiscalSign)) return null;
  if (fiscalSignHash !== "" && !/^[A-Fa-f0-9]{16,64}$/.test(fiscalSignHash)) return null;

  return {
    terminalId,
    paymentNo,
    paymentDate,
    fiscalSign: fiscalSign === "" ? null : fiscalSign,
    fiscalSignHash: fiscalSignHash === "" ? null : fiscalSignHash,
  };
}

/** Ключ магазина: ИНН, а при tin=0 — терминал (у мелких ККМ ИНН пустой). */
export function shopIdentity(tin: string, terminalId: string): string {
  const digits = String(tin ?? "").replace(/\D/g, "");
  return digits !== "" && digits !== "0" ? `tin:${digits}` : `terminal:${terminalId}`;
}

const LEGAL_FORM_PATTERNS: RegExp[] = [
  /\bMAS[`'´’]?ULIYATI CHEKLANGAN JAMIYAT\b/gi,
  /\bXORIJIY KORXONA\b/gi,
  /\bAKSIYADORLIK JAMIYATI\b/gi,
  /\bOCHIQ AKSIYADORLIK JAMIYATI\b/gi,
  /\bYAKKA TARTIBDAGI TADBIRKOR\b/gi,
  /\bXUSUSIY KORXONA\b/gi,
  /\bUNITAR KORXONA\b/gi,
  /\bDAVLAT KORXONASI\b/gi,
  /\b(MCHJ|OOO|ООО|ОАО|ЗАО|АО|ИП|ЧП|AJ|АЖ)\b/gi,
];

/**
 * "«ANGLESEY FOOD» MAS`ULIYATI CHEKLANGAN JAMIYAT XORIJIY KORXONA"
 * -> "ANGLESEY FOOD". Название в кавычках — и есть вывеска; юридическую
 * обвязку без кавычек срезаем по формам собственности.
 */
export function cleanShopName(legalName: string): string {
  const source = String(legalName ?? "").replace(/\s+/g, " ").trim();
  if (source === "") return "Магазин";

  const quoted = /^["«“„']([^"»“”']{2,80})["»“”']/.exec(source);
  if (quoted?.[1]) {
    const name = quoted[1].trim();
    if (name.length >= 2) return name;
  }

  let cleaned = source;
  for (const re of LEGAL_FORM_PATTERNS) cleaned = cleaned.replace(re, " ");
  cleaned = cleaned
    .replace(/[",;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length < 2) return source.slice(0, 80);
  return cleaned.slice(0, 80);
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** '27.10.2026 10:59:34' | ISO | 'YYYYMMDDhhmmss' -> 'YYYY-MM-DD'. */
export function ofdYmd(value: unknown, fallbackRaw = ""): string {
  if (typeof value === "string") {
    const dotted = /^(\d{2})[./-](\d{2})[./-](\d{4})/.exec(value);
    if (dotted?.[3] !== undefined) return `${dotted[3]}-${dotted[2]}-${dotted[1]}`;
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (iso?.[3] !== undefined) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const raw = /^(\d{4})(\d{2})(\d{2})/.exec(fallbackRaw);
  return raw?.[3] !== undefined ? `${raw[1]}-${raw[2]}-${raw[3]}` : "";
}

export interface OfdApiItem {
  name?: unknown;
  productName?: unknown;
  amount?: unknown;
  price?: unknown;
}

export interface OfdApiData {
  terminalId?: unknown;
  paymentNo?: unknown;
  paymentDate?: unknown;
  cashTotal?: unknown;
  cardTotal?: unknown;
  tin?: unknown;
  isRefund?: unknown;
  paymentDetails?: unknown;
  kkmName?: unknown;
  kkmSerialNumber?: unknown;
  extraInfo?: {
    companyName?: unknown;
    address?: unknown;
    merchantTin?: unknown;
  };
}

/**
 * Приводит ответ ОФД к форме приложения. Отдельно от сети — чтобы это
 * можно было проверить тестом без запросов к soliq.uz.
 */
export function normalizeOfdReceipt(data: OfdApiData, link: ReceiptLink): OfdReceipt {
  if (num(data.isRefund) === 1) throw new OfdError("receipt_is_refund");

  const itemsRaw = Array.isArray(data.paymentDetails) ? data.paymentDetails : [];
  const items: OfdReceiptItem[] = itemsRaw.map((raw) => {
    const item = (raw ?? {}) as OfdApiItem;
    const name = String(item.name ?? "").trim();
    return {
      name: name === "" ? "Позиция" : name,
      qty: Math.max(1, Math.round(num(item.amount))),
      price: Math.max(0, Math.round(num(item.price))),
      productName: item.productName == null ? null : String(item.productName),
    };
  });

  let total = Math.round(num(data.cashTotal) + num(data.cardTotal));
  if (total <= 0) total = items.reduce((sum, item) => sum + item.price, 0);
  if (total <= 0) throw new OfdError("receipt_not_found");

  const legalName = String(data.extraInfo?.companyName ?? "").trim();
  const tin = String(data.tin ?? "").replace(/\D/g, "");
  const address = String(data.extraInfo?.address ?? "").trim();

  return {
    terminalId: String(data.terminalId ?? link.terminalId),
    paymentNo: String(data.paymentNo ?? link.paymentNo),
    paymentDate: link.paymentDate,
    occurredOn: ofdYmd(data.paymentDate, link.paymentDate),
    total,
    merchant: {
      tin: tin === "0" ? "" : tin,
      name: cleanShopName(legalName),
      legalName,
      address: address === "" ? null : address,
    },
    items,
    kkmName: data.kkmName == null ? null : String(data.kkmName),
    kkmSerial: data.kkmSerialNumber == null ? null : String(data.kkmSerialNumber),
  };
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Запрос чека в ОФД. Подпись — HMAC-SHA256 по строке
 * "<terminalId>:<paymentNo>:<unix seconds>", ровно как в веб-клиенте Солiк.
 */
export async function fetchOfdReceipt(
  link: ReceiptLink,
  fetcher: typeof fetch = fetch,
): Promise<OfdReceipt> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await hmacHex(
    OFD_SIGNATURE_SECRET,
    `${link.terminalId}:${link.paymentNo}:${timestamp}`,
  );

  const isEpi = link.fiscalSignHash !== null;
  const endpoint = isEpi ? `${OFD_API_BASE}/payment/mobile-dashboard` : `${OFD_API_BASE}/payment`;
  const payload: Record<string, string> = {
    terminalId: link.terminalId,
    paymentNo: link.paymentNo,
    paymentDate: link.paymentDate,
    paymentType: isEpi ? "CHECK_EPI" : "CHECK",
  };
  if (isEpi) payload.fiscalSignHash = link.fiscalSignHash!;
  else payload.fiscalSign = link.fiscalSign ?? "";

  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // Ведём себя как веб-клиент ОФД: без браузерных заголовков WAF
        // Soliq может резать запросы с «пустым» клиентом из Worker'а.
        "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        Origin: "https://ofd.soliq.uz",
        Referer: "https://ofd.soliq.uz/",
        "X-Timestamp": timestamp,
        "X-Signature": signature,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(OFD_TIMEOUT_MS),
    });
  } catch (e) {
    console.error("[ofd] request failed", e);
    throw new OfdError("receipt_unavailable", { cause: e });
  }

  if (!response.ok) {
    const snippet = await response.text().catch(() => "");
    console.error("[ofd] HTTP", response.status, snippet.slice(0, 300));
    throw new OfdError(
      response.status >= 500 ? "receipt_unavailable" : "receipt_not_ready",
      { cause: `HTTP ${response.status}` },
    );
  }

  let body: { success?: unknown; data?: unknown; message?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch (e) {
    console.error("[ofd] invalid JSON", e);
    throw new OfdError("receipt_unavailable", { cause: e });
  }

  if (body.success !== true || typeof body.data !== "object" || body.data === null) {
    throw new OfdError("receipt_not_ready");
  }

  return normalizeOfdReceipt(body.data as OfdApiData, link);
}
