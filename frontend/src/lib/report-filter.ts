import type { ReportDefinition, ReportField } from "./report-api";

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
export function serializeFilters(definition: ReportDefinition, fields: ReportField[]): ReportDefinition {
  const filters = definition.filters.map((filter, index) => {
    const field = fields.find((item) => item.id === filter.field);
    if (!field || !field.grains.includes(definition.grain) || !field.operators.includes(filter.operator)) throw new Error(`Фильтр ${index + 1}: выберите доступные поле и оператор.`);
    const raw = filter.value;
    const emptyStringAllowed = field.type === "string" && !field.choices && !["project.stage", "project.stage_scheme", "financial.kind"].includes(field.id) && ["eq", "ne", "contains"].includes(filter.operator);
    if (raw === null || raw === undefined || (raw === "" && !emptyStringAllowed)) throw new Error(`Фильтр ${index + 1}: укажите значение.`);
    if (filter.operator === "is_null" || field.type === "boolean") {
      if (typeof raw !== "boolean") throw new Error(`Фильтр ${index + 1}: выберите «Да» или «Нет».`);
      return { ...filter, value: raw };
    }
    const value = String(raw);
    if ((field.choices || ["project.stage", "project.stage_scheme", "financial.kind"].includes(field.id)) && !field.choices?.some((choice) => choice.value === value)) throw new Error(`Фильтр ${index + 1}: выберите значение из списка.`);
    if (field.type === "integer") {
      const n = Number(value);
      if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(n)) throw new Error(`Фильтр ${index + 1}: введите целое число в допустимом диапазоне.`);
      return { ...filter, value: n };
    }
    if (field.type === "decimal" && !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error(`Фильтр ${index + 1}: введите десятичное число через точку.`);
    if (field.type === "date" && !validDate(value)) throw new Error(`Фильтр ${index + 1}: введите корректную дату в формате ГГГГ-ММ-ДД.`);
    if (field.type === "datetime") {
      const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
      if (!match || !validDate(match[1]) || Number.isNaN(Date.parse(value))) throw new Error(`Фильтр ${index + 1}: введите дату и время ISO с часовым поясом, например 2026-10-28T12:30:00+03:00.`);
    }
    return { ...filter, value };
  });
  return { ...definition, filters };
}
