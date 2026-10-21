"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api } from "./api";
import type { Refs, Role, User } from "./types";

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => api<User>("/auth/me"), retry: false, staleTime: 60_000 });
}

export function useRefs() {
  return useQuery({ queryKey: ["refs"], queryFn: () => api<Refs>("/refs"), staleTime: 5 * 60_000 });
}

export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export const canEditProjects = (role?: Role) => role === "manager" || role === "head" || role === "admin";
export const seesAllProjects = (role?: Role) => role === "analyst" || role === "head" || role === "admin";
export const canPublishDashboards = seesAllProjects;

export const ROLE_LABELS: Record<Role, string> = {
  analyst: "Аналитик",
  manager: "Менеджер",
  head: "Руководитель",
  admin: "Администратор",
};
