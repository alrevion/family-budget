// Все суммы — целые сумы, без дробной части. См. план, раздел "Утилиты"
// и AC-P5.

const AMOUNT_MIN_EXCLUSIVE = 0;
const AMOUNT_MAX_INCLUSIVE = 100_000_000_000; // 1e11, соответствует CHECK в схеме transactions.amount

const numberFormatter = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 0,
});

/** Форматирует целую сумму сумов: разделители тысяч + " сум". */
export function formatMoney(amount: number): string {
  return `${numberFormatter.format(amount)} сум`;
}

/**
 * Валидная сумма — безопасное целое в (0, 1e11]. Используется на границе
 * API для валидации amount транзакций, аллокаций и возвратов.
 */
export function isValidAmount(amount: number): boolean {
  return (
    Number.isSafeInteger(amount) &&
    amount > AMOUNT_MIN_EXCLUSIVE &&
    amount <= AMOUNT_MAX_INCLUSIVE
  );
}
