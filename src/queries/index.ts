// Слой запросов над D1 — шаг 5 плана (.omc/plans/family-budget-v1-consensus.md,
// rev.4), разбитый по доменам. Барьер импорта: снаружи модуль остаётся одним
// «src/queries», состав экспортов тот же, что до разбиения.
//
// Маскирование скрытых трат (R3) живёт в ./masking и только там. Наружу из
// него уходит один тип TxFilter — maskedSource / MASKED_COLUMNS / whereSql
// намеренно НЕ реэкспортируются: их потребители внутри пакета импортируют
// "./masking" напрямую, и это видно в дереве импортов.

export type { TxFilter } from "./masking";
export * from "./state";
export * from "./transactions";
export * from "./categories";
export * from "./goals";
export * from "./reports";
export * from "./shops";
