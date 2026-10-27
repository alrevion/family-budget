-- Rollback for a failed apply of 0001_init.sql. Not a general-purpose
-- migration; drops everything so 0001_init.sql can be re-applied cleanly.
-- Usage: npx wrangler d1 execute <DATABASE_NAME> --file migrations/drop.sql

DROP VIEW IF EXISTS v_balance;
DROP INDEX IF EXISTS idx_tx_month;
DROP INDEX IF EXISTS idx_cat_name_live;
DROP INDEX IF EXISTS idx_receipts_tx;
DROP INDEX IF EXISTS idx_receipts_shop;
DROP INDEX IF EXISTS idx_receipts_identity;
DROP INDEX IF EXISTS idx_shops_identity;
DROP TABLE IF EXISTS receipts;
DROP TABLE IF EXISTS shops;
DROP TABLE IF EXISTS goal_allocations;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS goals;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS app_state;
DROP TABLE IF EXISTS users;

-- Без этого wrangler считает 0001_init.sql уже применённой (запись
-- в служебной d1_migrations остаётся) и следующий `npm run migrate`
-- молча не сделает ничего, хотя все таблицы выше только что удалены.
-- Проверено прогоном: без этой строки "и заново" из плана не работает.
-- КАЖДАЯ новая миграция обязана попадать в этот список, иначе цикл
-- "дропнуть и накатить заново" молча пропустит её.
DELETE FROM d1_migrations WHERE name IN ('0001_init.sql', '0002_edited_by.sql', '0003_shops_receipts.sql');
