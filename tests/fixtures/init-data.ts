// ВНЕШНИЕ векторы initData (AC-P3, план R4).
//
// Каждая строка ниже посчитана @telegram-apps/init-data-node — сторонней
// реализацией схемы Telegram, НЕ кодом из src/auth.ts, и проверена её же
// validate(). Форма ровно та, что шлёт Telegram Bot API 8.0+, включая
// непустое поле signature. Пересоздать:
//   node tests/fixtures/generate-init-data.mjs
//
// Менять руками нельзя: hash считается по всему набору полей.
// BOT_TOKEN зашит и в vitest.config.ts (miniflare.bindings.BOT_TOKEN) —
// менять только вместе.

export const FIXTURE_BOT_TOKEN = "7654321:TEST_ONLY_NOT_A_REAL_BOT_TOKEN";

/** Алишер — «пользователь A» во всех тестах приватности. */
export const ALISHER_ID = 111111111;
/** Дилноза — «пользователь B», партнёр. */
export const DILNOZA_ID = 222222222;

/** auth_date векторов ALISHER/DILNOZA: 2026-08-24T12:00:00Z. */
export const AUTH_DATE_2026_08_24 = 1787572800;
/** auth_date «ташкентского» вектора: 2026-08-31T21:00:00Z = 02:00 1 сентября в Ташкенте. */
export const AUTH_DATE_2026_09_01_TASHKENT = 1788210000;
/** auth_date «мартовского» вектора: 2026-03-01T09:00:00Z. «Полгода» от 1 марта = 184 дня (AC-P4). */
export const AUTH_DATE_2026_03_01 = 1772355600;

export const ALISHER_INIT_DATA =
  "query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A111111111%2C%22first_name%22%3A%22%D0%90%D0%BB%D0%B8%D1%88%D0%B5%D1%80%22%2C%22last_name%22%3A%22%D0%9A%D0%B0%D1%80%D0%B8%D0%BC%D0%BE%D0%B2%22%2C%22username%22%3A%22alisher%22%2C%22language_code%22%3A%22ru%22%2C%22allows_write_to_pm%22%3Atrue%7D&chat_instance=-1234567890123456789&chat_type=sender&signature=K2mQ8xN4vRt7wLpZaBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefghijkl&auth_date=1787572800&hash=2c24e3f133b6eb0695e8eec54fbef157e56fbe528cb49c09f96e52eeb4ee8e44";

export const DILNOZA_INIT_DATA =
  "query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A222222222%2C%22first_name%22%3A%22%D0%94%D0%B8%D0%BB%D0%BD%D0%BE%D0%B7%D0%B0%22%2C%22last_name%22%3A%22%D0%9A%D0%B0%D1%80%D0%B8%D0%BC%D0%BE%D0%B2%22%2C%22username%22%3A%22dilnoza%22%2C%22language_code%22%3A%22ru%22%2C%22allows_write_to_pm%22%3Atrue%7D&chat_instance=-1234567890123456789&chat_type=sender&signature=K2mQ8xN4vRt7wLpZaBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefghijkl&auth_date=1787572800&hash=b31257297849bec84fbb423208dc341620ce4f4483e0161228feb2d1b8e25a8c";

/** Тот же Алишер, но подписан на 02:00 1 сентября по Ташкенту — для AC-P11. */
export const ALISHER_INIT_DATA_TASHKENT_SEP1 =
  "query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A111111111%2C%22first_name%22%3A%22%D0%90%D0%BB%D0%B8%D1%88%D0%B5%D1%80%22%2C%22last_name%22%3A%22%D0%9A%D0%B0%D1%80%D0%B8%D0%BC%D0%BE%D0%B2%22%2C%22username%22%3A%22alisher%22%2C%22language_code%22%3A%22ru%22%2C%22allows_write_to_pm%22%3Atrue%7D&chat_instance=-1234567890123456789&chat_type=sender&signature=K2mQ8xN4vRt7wLpZaBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefghijkl&auth_date=1788210000&hash=54323aecdcefe8fb322ab99e6f69ddaddd609a054cfacbd2abd5e7a1d01c00d1";

/** Тот же Алишер, подписан 1 марта — для AC-P4 («полгода» = 184 дня). */
export const ALISHER_INIT_DATA_MARCH1 =
  "query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A111111111%2C%22first_name%22%3A%22%D0%90%D0%BB%D0%B8%D1%88%D0%B5%D1%80%22%2C%22last_name%22%3A%22%D0%9A%D0%B0%D1%80%D0%B8%D0%BC%D0%BE%D0%B2%22%2C%22username%22%3A%22alisher%22%2C%22language_code%22%3A%22ru%22%2C%22allows_write_to_pm%22%3Atrue%7D&chat_instance=-1234567890123456789&chat_type=sender&signature=K2mQ8xN4vRt7wLpZaBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefghijkl&auth_date=1772355600&hash=d30c853a1c9eb1f4631178750fbd3fdc8a9be8975dd8b74ed5f900397904f8ff";
