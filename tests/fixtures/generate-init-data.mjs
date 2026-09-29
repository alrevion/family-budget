// Генератор внешних векторов initData для AC-P3.
//
// Запуск:  node tests/fixtures/generate-init-data.mjs
// Вывод копируется в tests/fixtures/init-data.ts.
//
// Смысл существования этого файла — требование AC-P3: вектор обязан быть
// посчитан СТОРОННЕЙ реализацией (@telegram-apps/init-data-node), а не тем же
// кодом, который его потом проверяет (src/auth.ts). Иначе тест
// самоподтверждается: перепутанный порядок аргументов при выводе ключа
// (HMAC(data = BOT_TOKEN, key = "WebAppData") вместо наоборот) дал бы
// симметрично неправильные подпись и проверку, и тест остался бы зелёным.
//
// Каждый вектор здесь же прогоняется через validate() той же библиотеки:
// если бы сборка была неверной, вектор не прошёл бы стороннюю проверку.

import { sign, validate } from "@telegram-apps/init-data-node";

const TOKEN = "7654321:TEST_ONLY_NOT_A_REAL_BOT_TOKEN";

const USERS = {
  ALISHER: { id: 111111111, first_name: "Алишер", username: "alisher" },
  DILNOZA: { id: 222222222, first_name: "Дилноза", username: "dilnoza" },
};

/** Вектор ровно той формы, что шлёт Telegram Bot API 8.0+ — с непустым signature. */
function signInitData(user, authDate) {
  const initData = sign(
    {
      query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
      // Ключи именно snake_case: так их шлёт Telegram. Библиотека
      // пробрасывает неизвестные ей ключи в query-строку как есть.
      user: {
        id: user.id,
        first_name: user.first_name,
        last_name: "Каримов",
        username: user.username,
        language_code: "ru",
        allows_write_to_pm: true,
      },
      chat_instance: "-1234567890123456789",
      chat_type: "sender",
      // Поле Telegram для сторонней Ed25519-валидации. При проверке по
      // BOT_TOKEN оно ВХОДИТ в data_check_string — непустое значение делает
      // тест на это осмысленным.
      signature: "K2mQ8xN4vRt7wLpZaBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefghijkl",
    },
    TOKEN,
    authDate,
  );
  validate(initData, TOKEN, { expiresIn: 0 });
  return initData;
}

const AT_2026_08_24 = new Date("2026-08-24T12:00:00Z");
const AT_TASHKENT_SEP1 = new Date("2026-08-31T21:00:00Z"); // 02:00 1 сентября в Ташкенте
const AT_MARCH1 = new Date("2026-03-01T09:00:00Z"); // 1 марта — «полгода» = 184 дня (AC-P4)

const OUT = {
  ALISHER_INIT_DATA: signInitData(USERS.ALISHER, AT_2026_08_24),
  DILNOZA_INIT_DATA: signInitData(USERS.DILNOZA, AT_2026_08_24),
  ALISHER_INIT_DATA_TASHKENT_SEP1: signInitData(USERS.ALISHER, AT_TASHKENT_SEP1),
  ALISHER_INIT_DATA_MARCH1: signInitData(USERS.ALISHER, AT_MARCH1),
};

for (const [name, value] of Object.entries(OUT)) {
  console.log(`export const ${name} =\n  ${JSON.stringify(value)};\n`);
}
console.log(`// auth_date 2026-08-24T12:00:00Z = ${AT_2026_08_24.getTime() / 1000}`);
console.log(`// auth_date 2026-08-31T21:00:00Z = ${AT_TASHKENT_SEP1.getTime() / 1000}`);
console.log(`// auth_date 2026-03-01T09:00:00Z = ${AT_MARCH1.getTime() / 1000}`);
