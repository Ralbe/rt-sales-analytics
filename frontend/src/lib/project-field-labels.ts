"use client";

import { useMemo } from "react";

import defaults from "./project-field-label-defaults.json";
import { useRefs } from "./hooks";

export type ProjectFieldKey = keyof typeof defaults;
export type ProjectFieldLabels = Record<ProjectFieldKey, string>;
export interface ProjectFieldLabelItem {
  key: ProjectFieldKey;
  label: string;
  default_label: string;
  suffix: string;
  is_overridden: boolean;
}

export const PROJECT_FIELD_LABEL_MAX_LENGTH = 120;
export const PROJECT_FIELD_DEFAULTS = defaults;

/** Старый /refs без нового поля поддерживается, неизвестные ключи не принимаются. */
export function resolveProjectFieldLabels(overrides?: Record<string, unknown>): ProjectFieldLabels {
  return Object.fromEntries(Object.entries(defaults).map(([key, definition]) => {
    const value = overrides && Object.hasOwn(overrides, key) ? overrides[key] : undefined;
    return [key, typeof value === "string" && value.trim() ? value : definition.label];
  })) as ProjectFieldLabels;
}

/** Использует тот же запрос и кэш ["refs"], что и текущие формы. */
export function useProjectFieldLabels() {
  const refsQuery = useRefs();
  const overrides = refsQuery.data?.project_field_labels;
  const labels = useMemo(() => resolveProjectFieldLabels(overrides), [overrides]);
  return {
    ...refsQuery,
    labels,
    label: (key: ProjectFieldKey) => labels[key],
    suffix: (key: ProjectFieldKey) => defaults[key].suffix,
    heading: (key: ProjectFieldKey) => labels[key] + defaults[key].suffix,
  };
}
