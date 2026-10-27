// Прямой запрос чека в ОФД из браузера (Mini App).
//
// Зачем: с edge Cloudflare запросы к new-ofd.soliq.uz не проходят (таймаут —
// ОФД блокирует датацентровые IP), а телефон пользователя в Узбекистане
// видит ОФД напрямую. CORS ОФД разрешает любой origin, подпись — HMAC-SHA256
// по строке "<terminalId>:<paymentNo>:<unix seconds>".
//
// Секрет подписи не является секретом приложения: он лежит в открытом
// JS-бандле ofd.soliq.uz, который скачивает любой посетитель. Здесь он нужен
// ровно для того же публичного запроса чека, что делает веб-клиент Soliq.
//
// Наружу из этого модуля уходит только объект `data` из ответа ОФД; разбор,
// кеш и память магазинов делает сервер (/api/receipts/lookup).

const OFD_API_BASE = "https://new-ofd.soliq.uz/api";
const OFD_SIGNATURE_SECRET = "thisIsPaymentSecretKey123@#";
const OFD_DIRECT_TIMEOUT_MS = 9_000;

export interface OfdLink {
  terminalId: string;
  paymentNo: string;
  paymentDate: string;
  fiscalSign: string | null;
  fiscalSignHash: string | null;
}

export type OfdDirectResult =
  | { ok: true; data: unknown }
  | { ok: false; code: "receipt_not_ready" | "receipt_unavailable" };

/**
 * Достаёт параметры чека из ссылки/строки запроса. Полная проверка ссылки
 * всё равно остаётся на сервере: здесь важно только то, что нужно для
 * подписи. Всё непонятное -> null (тогда работает обычный серверный путь).
 */
export function parseOfdLink(input: string): OfdLink | null {
  const text = String(input ?? "").trim();
  if (text === "" || text.length > 2048) return null;

  let params: URLSearchParams;
  const urlMatch = /https?:\/\/[^\s"'<>]+/i.exec(text);
  if (urlMatch !== null) {
    let url: URL;
    try {
      url = new URL(urlMatch[0]);
    } catch {
      return null;
    }
    if (!/(^|\.)soliq\.uz$/i.test(url.hostname)) return null;
    params = url.searchParams;
  } else if (text.includes("=")) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

/** AbortSignal.timeout есть не во всех WebView (iOS < 16) — тогда свой таймер. */
function abortable(ms: number): { signal: AbortSignal; done: () => void } {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return { signal: AbortSignal.timeout(ms), done: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/** Чек из ОФД напрямую с телефона. Никогда не бросает — только результат. */
export async function fetchOfdData(link: OfdLink, fetcher: typeof fetch = fetch): Promise<OfdDirectResult> {
  // crypto.subtle есть только в защищённом контексте (https). Mini App всегда
  // https, но в экзотическом WebView лучше сразу уйти на серверный путь.
  if (typeof crypto === "undefined" || crypto.subtle === undefined) {
    return { ok: false, code: "receipt_unavailable" };
  }

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
  const timeout = abortable(OFD_DIRECT_TIMEOUT_MS);
  try {
    response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Timestamp": timestamp,
        "X-Signature": signature,
      },
      body: JSON.stringify(payload),
      signal: timeout.signal,
    });
  } catch {
    return { ok: false, code: "receipt_unavailable" };
  } finally {
    timeout.done();
  }

  if (!response.ok) {
    // 5xx — ОФД лежит/режет запрос, 4xx — скорее всего чек ещё не обработан.
    return { ok: false, code: response.status >= 500 ? "receipt_unavailable" : "receipt_not_ready" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, code: "receipt_unavailable" };
  }

  if (!isRecord(body) || body.success !== true || !isRecord(body.data)) {
    return { ok: false, code: "receipt_not_ready" };
  }
  return { ok: true, data: body.data };
}
