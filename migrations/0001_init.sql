-- Family budget v1 — initial schema.
-- Source of truth: .omc/plans/family-budget-v1-consensus.md (rev.4),
-- sections "D1 Schema" and "R1 — Единственный источник «Свободно»".
-- Applied whole; on failure re-run migrations/drop.sql then this file again.

CREATE TABLE users (
  telegram_id INTEGER PRIMARY KEY,
  name        TEXT NOT NULL
);

CREATE TABLE categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  applies_to  TEXT NOT NULL CHECK (applies_to IN ('expense','income','both')),
  is_custom   INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0
);
-- уникальность только среди живых: архивная «Прочее» не должна
-- навсегда блокировать создание новой «Прочее»
CREATE UNIQUE INDEX idx_cat_name_live ON categories(name, applies_to) WHERE is_archived = 0;
-- по (name, applies_to), не по name: расходные «Подарки» из AC-16 не должны
-- запрещать доходные «Подарки» (подарили деньги)

CREATE TABLE transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  amount       INTEGER NOT NULL CHECK (amount > 0 AND amount <= 100000000000),
  kind         TEXT    NOT NULL CHECK (kind IN ('income','expense')),
  category_id  INTEGER NOT NULL REFERENCES categories(id),
  author_id    INTEGER NOT NULL REFERENCES users(telegram_id),
  occurred_on  TEXT    NOT NULL,                       -- 'YYYY-MM-DD'
  comment      TEXT,
  hidden_until TEXT,                                   -- NULL = не скрыта
  created_at   TEXT    NOT NULL
);
CREATE INDEX idx_tx_month ON transactions(occurred_on);

CREATE TABLE goals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  target_amount INTEGER NOT NULL CHECK (target_amount > 0),
  is_archived   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE goal_allocations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id    INTEGER NOT NULL REFERENCES goals(id),
  amount     INTEGER NOT NULL CHECK (amount != 0),  -- отрицательное = возврат
  author_id  INTEGER NOT NULL REFERENCES users(telegram_id),
  created_at TEXT    NOT NULL
);

CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- onboarding_done=1 после ввода стартового остатка. Проверять флаг,
-- а не наличие транзакции: AC-4 разрешает её удалить.
-- last_nag_on — дата последнего "3 дня без записей" напоминания, cooldown.

-- R1: единственный источник "Свободно". Обслуживает главный экран
-- и guard аллокации — двух похожих запросов в двух местах быть не должно.
CREATE VIEW v_balance AS
SELECT
  (SELECT COALESCE(SUM(CASE kind WHEN 'income' THEN amount ELSE -amount END),0)
     FROM transactions) AS total,
  (SELECT COALESCE(SUM(amount),0) FROM goal_allocations) AS in_goals,
  (SELECT COALESCE(SUM(CASE kind WHEN 'income' THEN amount ELSE -amount END),0)
     FROM transactions)
  - (SELECT COALESCE(SUM(amount),0) FROM goal_allocations) AS free;

-- Сид категорий (план, шаг 2). AC-16: 10 расходных категорий.
-- "Стартовый остаток" и "Зарплата" — доходные. Категория "Скрытое"
-- НЕ сидируется: это метка агрегата для отчёта стороннего зрителя (R3),
-- а не строка выбора при создании транзакции.
INSERT INTO categories (name, applies_to, is_custom, is_archived) VALUES
  ('Продукты',              'expense', 0, 0),
  ('Кафе и доставка',       'expense', 0, 0),
  ('Транспорт',             'expense', 0, 0),
  ('Жильё и коммуналка',    'expense', 0, 0),
  ('Здоровье',              'expense', 0, 0),
  ('Одежда',                'expense', 0, 0),
  ('Развлечения',           'expense', 0, 0),
  ('Дети',                  'expense', 0, 0),
  ('Подарки',               'expense', 0, 0),
  ('Прочее',                'expense', 0, 0),
  ('Стартовый остаток',     'income',  0, 0),
  ('Зарплата',              'income',  0, 0);
