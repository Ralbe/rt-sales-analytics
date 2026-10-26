"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { post } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import type { Project } from "@/lib/types";

export function ProjectArchiveActions({ project, disabled = false }: { project: Project; disabled?: boolean }) {
  const { data: me } = useMe();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (me?.role !== "admin") return null;
  const archived = !!project.archived_at;
  const change = async () => {
    if (pending) return;
    if (!archived && !window.confirm(`Переместить проект «${project.name}» в архив? Финансы и история сохранятся.`)) return;
    setPending(true);
    setError(null);
    try {
      const saved = await post<Project>(`/projects/${project.id}/${archived ? "restore" : "archive"}`);
      client.setQueryData(["project", String(project.id)], saved);
      await client.invalidateQueries({ predicate: (query) => query.queryKey[0] !== "project" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось изменить состояние проекта. Повторите попытку.");
    } finally {
      setPending(false);
    }
  };
  return (
    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <button type="button" className="btn small" disabled={pending || disabled} onClick={change}>
        {pending ? "Сохраняем…" : archived ? "Восстановить проект" : "В архив"}
      </button>
      {error && <span role="alert" className="error">{error}</span>}
    </div>
  );
}
