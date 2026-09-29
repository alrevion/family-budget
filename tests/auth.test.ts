// AC-P2 и AC-P3 — валидация initData (план, R4) и порядок проверки whitelist.

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticate, parseAllowedIds, verifyInitData } from "../src/auth";
import type { Env } from "../src/types";
import {
  ALISHER_ID,
  ALISHER_INIT_DATA,
  AUTH_DATE_2026_08_24,
  DILNOZA_ID,
  FIXTURE_BOT_TOKEN,
} from "./fixtures/init-data";
import { apiJson, freezeTime, resetDb, unfreezeTime } from "./helpers";

/** Заменяет одно поле в query-строке initData, hash не пересчитывая. */
function tamper(initData: string, key: string, value: string): string {
  const params = new URLSearchParams(initData);
  params.set(key, value);
  return params.toString();
}

function authRequest(initData: string): Request {
  return new Request("https://example.test/api/balance", {
    headers: { Authorization: `tma ${initData}` },
  });
}

/**
 * D1, падающий на любом обращении. Единственный способ доказать «403 ДО
 * любого обращения к D1» (AC-P2): если бы порядок проверок был обратным,
 * тест упал бы с этой ошибкой вместо 403.
 */
function explodingDb(): D1Database {
  const boom = (): never => {
    throw new Error("D1 touched before the whitelist check");
  };
  return new Proxy({} as D1Database, { get: boom, apply: boom });
}

beforeEach(async () => {
  freezeTime(AUTH_DATE_2026_08_24);
  await resetDb();
});

afterEach(() => {
  unfreezeTime();
});

describe("AC-P3: внешний вектор initData", () => {
  it("принимает вектор, посчитанный @telegram-apps/init-data-node", async () => {
    // Единственный тест, доказывающий, что порядок аргументов вывода ключа
    // (secret = HMAC(data = BOT_TOKEN, key = "WebAppData")) не перепутан:
    // подпись посчитана СТОРОННЕЙ реализацией, а не src/auth.ts.
    const params = await verifyInitData(ALISHER_INIT_DATA, FIXTURE_BOT_TOKEN);
    expect(params).not.toBeNull();
    expect(JSON.parse(params!.get("user")!).id).toBe(ALISHER_ID);
  });

  it("отклоняет вектор с испорченным hash", async () => {
    const params = new URLSearchParams(ALISHER_INIT_DATA);
    const hash = params.get("hash")!;
    params.set("hash", (hash[0] === "0" ? "1" : "0") + hash.slice(1));
    expect(await verifyInitData(params.toString(), FIXTURE_BOT_TOKEN)).toBeNull();
  });

  it("отклоняет подмену user.id при сохранённом hash", async () => {
    // Ровно та атака, ради которой R4 существует: посторонний берёт свой
    // валидный initData и переписывает id на чужой.
    const forged = tamper(
      ALISHER_INIT_DATA,
      "user",
      JSON.stringify({ id: DILNOZA_ID, first_name: "Алишер" }),
    );
    expect(await verifyInitData(forged, FIXTURE_BOT_TOKEN)).toBeNull();
  });

  it("отклоняет вектор без поля hash", async () => {
    const params = new URLSearchParams(ALISHER_INIT_DATA);
    params.delete("hash");
    expect(await verifyInitData(params.toString(), FIXTURE_BOT_TOKEN)).toBeNull();
  });

  it("отклоняет hash, не являющийся hex", async () => {
    expect(
      await verifyInitData(tamper(ALISHER_INIT_DATA, "hash", "zz"), FIXTURE_BOT_TOKEN),
    ).toBeNull();
  });

  it("отклоняет тот же вектор под другим BOT_TOKEN", async () => {
    expect(await verifyInitData(ALISHER_INIT_DATA, "1:OTHER_TOKEN")).toBeNull();
  });

  it("отклоняет добавленное к вектору лишнее поле", async () => {
    expect(
      await verifyInitData(tamper(ALISHER_INIT_DATA, "start_param", "injected"), FIXTURE_BOT_TOKEN),
    ).toBeNull();
  });

  it("отклоняет подмену signature: поле ВХОДИТ в data_check_string", async () => {
    // Регрессия на дефект, который этот критерий и поймал: rev.4 плана
    // требовала исключать signature из data_check_string наравне с hash.
    // Telegram исключает его ТОЛЬКО при сторонней Ed25519-проверке; при
    // проверке по BOT_TOKEN входят все поля кроме hash. С Bot API 8.0
    // signature приходит в КАЖДОМ initData, поэтому исключение давало 401
    // на любом запросе. Если оно вернётся — этот тест покраснеет.
    const changed = tamper(ALISHER_INIT_DATA, "signature", "anything-at-all");
    expect(await verifyInitData(changed, FIXTURE_BOT_TOKEN)).toBeNull();
  });

  it("вектор несёт непустой signature — форма Bot API 8.0+, а не урезанная", async () => {
    // Страховка от тихой деградации фикстуры: без этой проверки кто-нибудь
    // перегенерировал бы векторы без signature, и тест выше стал бы
    // проверять пустоту.
    expect(new URLSearchParams(ALISHER_INIT_DATA).get("signature")).toBeTruthy();
  });
});

describe("AC-P3: свежесть auth_date (R4.6)", () => {
  it("отклоняет initData старше 24 часов", async () => {
    freezeTime(AUTH_DATE_2026_08_24, 24 * 60 * 60 + 1);
    const result = await authenticate(authRequest(ALISHER_INIT_DATA), env);
    expect(result).toEqual({ ok: false, status: 401, error: "stale_init_data" });
  });

  it("отклоняет initData из будущего", async () => {
    freezeTime(AUTH_DATE_2026_08_24, -60);
    const result = await authenticate(authRequest(ALISHER_INIT_DATA), env);
    expect(result).toEqual({ ok: false, status: 401, error: "stale_init_data" });
  });

  it("принимает initData возрастом чуть меньше суток", async () => {
    freezeTime(AUTH_DATE_2026_08_24, 24 * 60 * 60 - 1);
    const result = await authenticate(authRequest(ALISHER_INIT_DATA), env);
    expect(result.ok).toBe(true);
  });
});

describe("AC-P2: whitelist предшествует обращению к D1", () => {
  it("отдаёт 403 для telegram_id вне ALLOWED_IDS, не тронув D1", async () => {
    const hostile: Env = { ...env, ALLOWED_IDS: "999999999", DB: explodingDb() };
    const result = await authenticate(authRequest(ALISHER_INIT_DATA), hostile);
    expect(result).toEqual({ ok: false, status: 403, error: "forbidden" });
  });

  it("контрольный прогон: для разрешённого id тот же D1 действительно трогается", async () => {
    // Без этого теста предыдущий проходил бы и на коде, который к D1 не
    // обращается вовсе, — то есть ничего бы не доказывал.
    const hostile: Env = { ...env, DB: explodingDb() };
    await expect(authenticate(authRequest(ALISHER_INIT_DATA), hostile)).rejects.toThrow(
      "D1 touched before the whitelist check",
    );
  });

  it("HTTP-путь: посторонний получает 403 от /api/balance", async () => {
    const { status, body } = await apiJson(ALISHER_INIT_DATA, "/api/balance", {
      envOverride: { ALLOWED_IDS: "999999999" },
    });
    expect(status).toBe(403);
    expect(body).toEqual({ error: "forbidden" });
  });

  it("HTTP-путь: запрос без заголовка Authorization → 401", async () => {
    const { status, body } = await apiJson(null, "/api/balance");
    expect(status).toBe(401);
    expect(body).toEqual({ error: "missing_init_data" });
  });
});

describe("parseAllowedIds", () => {
  it("разбирает CSV целых с пробелами", () => {
    expect(parseAllowedIds(" 111111111 , 222222222 ")).toEqual([111111111, 222222222]);
  });

  it("выбрасывает нечисловой мусор", () => {
    expect(parseAllowedIds("111111111,abc")).toEqual([111111111]);
  });

  it("отбрасывает пустые элементы, а не превращает их в id 0", () => {
    // Регрессия: Number("") === 0 и Number.isInteger(0) === true, поэтому
    // наивный фильтр тихо расширял whitelist нулём на каждой висячей запятой.
    expect(parseAllowedIds("111111111,")).toEqual([111111111]);
    expect(parseAllowedIds(",,111111111,,222222222,,")).toEqual([111111111, 222222222]);
    expect(parseAllowedIds("")).toEqual([]);
  });

  it("отбрасывает ноль и отрицательные id", () => {
    expect(parseAllowedIds("0,-1,111111111")).toEqual([111111111]);
  });
});

describe("R4.7: upsert users", () => {
  it("заводит пользователя с именем из проверенного initData", async () => {
    await env.DB.prepare("DELETE FROM users WHERE telegram_id = ?1").bind(ALISHER_ID).run();
    const result = await authenticate(authRequest(ALISHER_INIT_DATA), env);
    expect(result.ok).toBe(true);
    const row = await env.DB.prepare("SELECT name FROM users WHERE telegram_id = ?1")
      .bind(ALISHER_ID)
      .first<{ name: string }>();
    // Кириллица приезжает URL-декодированной — R4.2.
    expect(row?.name).toBe("Алишер");
  });

  it("обновляет имя при повторном входе, а не игнорирует его", async () => {
    await env.DB.prepare("UPDATE users SET name = 'старое' WHERE telegram_id = ?1")
      .bind(ALISHER_ID)
      .run();
    await authenticate(authRequest(ALISHER_INIT_DATA), env);
    const row = await env.DB.prepare("SELECT name FROM users WHERE telegram_id = ?1")
      .bind(ALISHER_ID)
      .first<{ name: string }>();
    expect(row?.name).toBe("Алишер");
  });
});
