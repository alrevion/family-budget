-- Авторство правки. Аддитивная миграция: только ADD COLUMN, ни одного
-- DROP/RENAME — 0001_init.sql уже накачена в прод, данные живые.
--
-- NULL = запись ни разу не правили. Для всех существующих строк это правда,
-- поэтому бэкфилл не нужен и колонки остаются nullable.
--
-- Имя файла обязано матчиться migrations_pattern из wrangler.toml
-- (NNNN_*.sql) — иначе wrangler его не увидит вовсе.
--
-- author_id этой миграцией НЕ трогается: кто создал, тот и создал.

ALTER TABLE transactions ADD COLUMN edited_by INTEGER REFERENCES users(telegram_id);
ALTER TABLE transactions ADD COLUMN edited_at TEXT;
