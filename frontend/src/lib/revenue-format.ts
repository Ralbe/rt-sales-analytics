const integerFormat = new Intl.NumberFormat("ru-RU");

/** API sends monetary decimals as strings; do not lose cents through Number. */
export function revenueRubles(value: string): string {
  if (!/^-?\d+(\.\d{1,2})?$/.test(value)) return "—";
  const [integer, fraction = ""] = value.split(".");
  return `${integerFormat.format(BigInt(integer))},${fraction.padEnd(2, "0")} ₽`;
}
