"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "rt-font-settings";

export const FONT_FAMILIES = [
  { id: "brand", name: "Фирменный", css: "\"Rostelecom Basis\", Arial, \"Liberation Sans\", sans-serif" },
  { id: "arial", name: "Arial", css: "Arial, \"Liberation Sans\", sans-serif" },
] as const;

export const FONT_SCALES = [
  { id: "90", name: "Мелкий", zoom: 0.9 },
  { id: "100", name: "Обычный", zoom: 1 },
  { id: "115", name: "Крупный", zoom: 1.15 },
  { id: "130", name: "Очень крупный", zoom: 1.3 },
] as const;

type Settings = { family: string; scale: string };
const DEFAULTS: Settings = { family: "brand", scale: "100" };

function read(): Settings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

function apply(settings: Settings) {
  const family = FONT_FAMILIES.find((f) => f.id === settings.family) ?? FONT_FAMILIES[0];
  const scale = FONT_SCALES.find((s) => s.id === settings.scale) ?? FONT_SCALES[1];
  const root = document.documentElement;
  root.style.setProperty("--font", family.css);
  // zoom меняет все размеры интерфейса пропорционально, включая жёстко заданные в пикселях.
  root.style.setProperty("--ui-scale", String(scale.zoom));
  root.style.setProperty("zoom", scale.zoom === 1 ? "" : String(scale.zoom));
}

/** Применяет сохранённые шрифт и размер на любой странице, включая вход. */
export function FontSettingsApplier() {
  useEffect(() => apply(read()), []);
  return null;
}

/** Выбор шрифта и размера текста; хранится в браузере пользователя. */
export function FontSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  useEffect(() => setSettings(read()), []);
  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    apply(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* без хранилища настройка действует до перезагрузки */
    }
  };
  return (
    <details className="font-settings-toggle">
      <summary>Шрифт и размер текста</summary>
      <div className="font-settings">
      <label>
        Шрифт
        <select className="input" value={settings.family} onChange={(e) => update({ family: e.target.value })}>
          {FONT_FAMILIES.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </label>
      <label>
        Размер
        <select className="input" value={settings.scale} onChange={(e) => update({ scale: e.target.value })}>
          {FONT_SCALES.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      </div>
    </details>
  );
}
