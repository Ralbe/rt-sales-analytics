/** Проверка контрольной суммы ИНН — та же логика, что на сервере. */
export function innIsValid(inn: string): boolean {
  if (!/^\d{10}$|^\d{12}$/.test(inn)) return false;
  const d = inn.split("").map(Number);
  const sum = (coefs: number[]) => (coefs.reduce((acc, c, i) => acc + c * d[i], 0) % 11) % 10;
  if (inn.length === 10) return sum([2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[9];
  return sum([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[10] && sum([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === d[11];
}
