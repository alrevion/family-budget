-- Магазины и чеки ОФД (Soliq). Аддитивная миграция: только новые таблицы.
--
-- shops — «память» по магазину: категория, которую в последний раз выбрали
-- для чека этого магазина, подставляется при следующем сканировании.
-- identity — стабильный ключ (tin:<ИНН> или terminal:<код ККМ>): у части
-- чеков tin = 0, и тогда единственный различитель — терминал.
--
-- receipts — распознанные чеки. Строка создаётся уже на этапе просмотра,
-- но в статистику магазина попадает только после сохранения траты
-- (transaction_id IS NOT NULL). Уникальный ключ не даёт записать один чек
-- дважды: terminal_id + номер чека + дата из QR.
CREATE TABLE shops (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  identity            TEXT    NOT NULL,
  tin                 TEXT    NOT NULL DEFAULT '',
  name                TEXT    NOT NULL,
  legal_name          TEXT    NOT NULL,
  address             TEXT,
  terminal_id         TEXT,
  default_category_id INTEGER REFERENCES categories(id),
  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL
);
CREATE UNIQUE INDEX idx_shops_identity ON shops(identity);

CREATE TABLE receipts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id        INTEGER NOT NULL REFERENCES shops(id),
  terminal_id    TEXT    NOT NULL,
  payment_no     TEXT    NOT NULL,
  payment_date   TEXT    NOT NULL,             -- сырой 'YYYYMMDDhhmmss' из QR
  occurred_on    TEXT    NOT NULL,             -- 'YYYY-MM-DD'
  fiscal_sign    TEXT,
  total          INTEGER NOT NULL CHECK (total > 0),
  items_json     TEXT    NOT NULL,
  transaction_id INTEGER REFERENCES transactions(id),
  created_at     TEXT    NOT NULL
);
CREATE UNIQUE INDEX idx_receipts_identity
  ON receipts(terminal_id, payment_no, payment_date);
CREATE INDEX idx_receipts_shop ON receipts(shop_id);
CREATE INDEX idx_receipts_tx ON receipts(transaction_id);
