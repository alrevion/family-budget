// Валидация Telegram initData — R4 плана (.omc/plans/family-budget-v1-consensus.md,
// rev.4), пункты 1-7. Единственная защита всех данных семьи.

import type { Env, User } from "./types";

/** auth_date не старше 24 часов (R4.6). */
const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;

const encoder = new TextEncoder();

export type AuthResult =
  | { ok: true; user: User }
  | { ok: false; status: 401 | 403; error: string };

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) return null;
    out[i] = byte;
  }
  return out;
}

function importHmacKey(raw: BufferSource, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/**
 * Проверяет подпись initData и возвращает разобранные параметры, либо null.
 *
 * Схема выведения ключа (R4, порядок аргументов НЕ инвертировать):
 *   secret = HMAC_SHA256(data = BOT_TOKEN, key = "WebAppData")
 * и уже этим secret подписывается data_check_string.
 */
export async function verifyInitData(
  initData: string,
  botToken: string,
): Promise<URLSearchParams | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (hash === null) return null;

  // R4.1-R4.2: все поля КРОМЕ hash, отсортированные ПО КЛЮЧУ, key=value через \n.
  // URLSearchParams уже отдаёт значения URL-декодированными — сборка из сырой
  // encoded-строки была бы классическим багом.
  //
  // ВАЖНО: `signature` НЕ исключается. rev.4 плана требовала исключать и его —
  // это было неверно и поймано тестом AC-P3 на внешнем векторе. Telegram
  // исключает `signature` ТОЛЬКО при сторонней Ed25519-проверке; при проверке
  // по BOT_TOKEN в строку входят все полученные поля кроме hash. С Bot API 8.0
  // Telegram кладёт signature в КАЖДЫЙ initData, поэтому его исключение давало
  // бы 401 на любом запросе и убивало Mini App целиком.
  const fields: Array<[string, string]> = [];
  for (const [key, value] of params) {
    if (key === "hash") continue;
    fields.push([key, value]);
  }
  fields.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const checkString = fields.map(([k, v]) => `${k}=${v}`).join("\n");

  const seedKey = await importHmacKey(encoder.encode("WebAppData"), "sign");
  const secret = await crypto.subtle.sign("HMAC", seedKey, encoder.encode(botToken));
  const signingKey = await importHmacKey(secret, "verify");

  const signature = hexToBytes(hash);
  if (signature === null) return null;

  // R4.3: сравнение внутри subtle.verify и в константном времени,
  // а не ручным сравнением hex-строк.
  const valid = await crypto.subtle.verify(
    "HMAC",
    signingKey,
    signature,
    encoder.encode(checkString),
  );
  return valid ? params : null;
}

/** R4.5: ALLOWED_IDS — CSV целых чисел, сравнение числовое. */
export function parseAllowedIds(csv: string): number[] {
  return csv
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0) // иначе "111," дало бы Number("") === 0
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0);
}

interface InitDataUser {
  id?: unknown;
  first_name?: unknown;
}

function readUser(params: URLSearchParams): { id: number; name: string } | null {
  const raw = params.get("user");
  if (raw === null) return null;
  let parsed: InitDataUser;
  try {
    parsed = JSON.parse(raw) as InitDataUser;
  } catch {
    return null;
  }
  const id = typeof parsed.id === "number" ? parsed.id : Number(parsed.id);
  if (!Number.isInteger(id)) return null;
  const firstName = typeof parsed.first_name === "string" ? parsed.first_name.trim() : "";
  return { id, name: firstName.length > 0 ? firstName : String(id) };
}

/**
 * Полный цикл R4 для запроса к /api/*:
 * заголовок Authorization: tma <initData> (R4.4, не query-параметр) →
 * проверка подписи → свежесть auth_date → whitelist ДО любого обращения
 * к D1 (AC-P2) → upsert users (R4.7).
 */
export async function authenticate(req: Request, env: Env): Promise<AuthResult> {
  const header = req.headers.get("Authorization") ?? "";
  const match = /^tma\s+(.+)$/i.exec(header);
  const initData = match?.[1];
  if (initData === undefined) {
    return { ok: false, status: 401, error: "missing_init_data" };
  }

  const params = await verifyInitData(initData, env.BOT_TOKEN);
  if (params === null) {
    return { ok: false, status: 401, error: "bad_init_data" };
  }

  // R4.6: не старше 24 часов И не из будущего.
  const authDate = Number(params.get("auth_date"));
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    !Number.isFinite(authDate) ||
    authDate > nowSeconds ||
    nowSeconds - authDate > MAX_AUTH_AGE_SECONDS
  ) {
    return { ok: false, status: 401, error: "stale_init_data" };
  }

  // R4.5: user.id берётся из ПРОВЕРЕННОГО initData, после верификации хэша.
  const user = readUser(params);
  if (user === null) {
    return { ok: false, status: 401, error: "bad_init_data" };
  }

  // Whitelist предшествует любому обращению к D1 — AC-P2.
  if (!parseAllowedIds(env.ALLOWED_IDS).includes(user.id)) {
    return { ok: false, status: 403, error: "forbidden" };
  }

  // R4.7: без upsert первый INSERT транзакции упал бы по FK — users нигде
  // не сидируется. INSERT OR IGNORE не годится: имя никогда бы не обновилось.
  await env.DB.prepare(
    "INSERT INTO users (telegram_id, name) VALUES (?1, ?2)" +
      " ON CONFLICT(telegram_id) DO UPDATE SET name = excluded.name",
  )
    .bind(user.id, user.name)
    .run();

  return { ok: true, user: { telegramId: user.id, name: user.name } };
}
