"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { ApiError, post } from "@/lib/api";
import type { Dashboard } from "@/lib/types";

export default function NewDashboard() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Введите название");
    try {
      const d = await post<Dashboard>("/dashboards", { name: name.trim(), widgets: [] });
      await queryClient.invalidateQueries({ queryKey: ["dashboards"] });
      router.push(`/dashboards/${d.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Ошибка");
    }
  };

  return (
    <>
      <div className="page-header">
        <h1>Новый дашборд</h1>
      </div>
      <div className="page-body">
        <form className="card" style={{ maxWidth: 440, padding: 20, display: "grid", gap: 8 }} onSubmit={create}>
          <div className={`field ${error ? "has-error" : ""}`}>
            <label htmlFor="name">Название</label>
            <input
              id="name"
              className="input"
              value={name}
              autoFocus
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              placeholder="Например: Госсектор — еженедельный"
            />
            <div className="error">{error}</div>
          </div>
          <div className="muted">После создания добавьте виджеты кнопкой «+ Виджет».</div>
          <div>
            <button className="btn primary" type="submit">
              Создать
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
