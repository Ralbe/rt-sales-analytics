const rub = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const oneDigit = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
const twoDigits = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

/** Компактная сумма: 1,25 млрд ₽ / 35,4 млн ₽ / 820 тыс. ₽ */
export function money(value: number | string): string {
  const v = Number(value);
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${twoDigits.format(v / 1e9)} млрд ₽`;
  if (abs >= 1e6) return `${oneDigit.format(v / 1e6)} млн ₽`;
  if (abs >= 1e3) return `${rub.format(v / 1e3)} тыс. ₽`;
  return `${rub.format(v)} ₽`;
}

export function moneyFull(value: number | string): string {
  return `${rub.format(Number(value))} ₽`;
}

export function count(value: number): string {
  return rub.format(value);
}

export function date(value: string | null | undefined): string {
  if (!value) return "—";
  const [y, m, d] = value.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

export function pct(value: number | null): string {
  if (value === null) return "—";
  return `${value > 0 ? "+" : ""}${oneDigit.format(value)}%`;
}

export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}


/** Один масштаб на всю диаграмму; в подписях делений только числа. */
export function chartMoney(values: number[]) {
  const max = Math.max(0, ...values.map(Math.abs));
  const divisor = max >= 1e9 ? 1e9 : max >= 1e6 ? 1e6 : max >= 1e3 ? 1e3 : 1;
  const unit = divisor === 1e9 ? "млрд ₽" : divisor === 1e6 ? "млн ₽" : divisor === 1e3 ? "тыс. ₽" : "₽";
  return { unit, format: (v: number) => twoDigits.format(v / divisor) };
}

export function duration(days: number | null | undefined): string {
  if (days == null || !Number.isFinite(days)) return "—";
  const total = Math.round(Math.max(0, days) * 1440);
  if (!total) return days > 0 ? "< 1 мин" : "0 мин";
  const d = Math.floor(total / 1440), h = Math.floor(total % 1440 / 60), m = total % 60;
  return [d && `${d} дн.`, h && `${h} ч`, m && `${m} мин`].filter(Boolean).join(" ");
}
