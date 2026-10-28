"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { QueryState } from "@/components/QueryState";
import { api } from "@/lib/api";

type GalleryReport = { id: number; title: string; published: boolean };
type GalleryPage = { items: GalleryReport[]; total: number; offset: number; limit: number };
const PAGE_SIZE = 20;

async function loadReports(offset: number): Promise<GalleryPage> {
  const response = await api<unknown>("/reports", { query: { published: true, offset, limit: PAGE_SIZE } });
  if (!response || typeof response !== "object" || !("items" in response) || !Array.isArray(response.items)) {
    throw new Error("Некорректный ответ сервера");
  }
  if (!("total" in response) || !Number.isSafeInteger(response.total) || (response.total as number) < 0 ||
    !("offset" in response) || response.offset !== offset ||
    !("limit" in response) || response.limit !== PAGE_SIZE) {
    throw new Error("Некорректный ответ сервера");
  }
  const items: unknown[] = response.items;
  if (!items.every((item): item is GalleryReport =>
    !!item && typeof item === "object" && "id" in item && Number.isSafeInteger(item.id) &&
    (item.id as number) > 0 && "title" in item && typeof item.title === "string" &&
    "published" in item && typeof item.published === "boolean")) {
    throw new Error("Некорректный ответ сервера");
  }
  return { items: items.filter((item) => item.published === true), total: response.total as number, offset, limit: PAGE_SIZE };
}

/** Витрина показывает только опубликованные шаблоны; доступ к данным проверяет сервер. */
export default function ReportGallery() {
  const [offset, setOffset] = useState(0);
  const query = useQuery({
    queryKey: ["report-gallery", offset],
    queryFn: () => loadReports(offset),
    refetchOnMount: "always",
    staleTime: 0,
    retry: false,
  });
  // При обновлении не показываем устаревшие публикации, пока сервер не подтвердит их видимость.
  const result = !query.error && !query.isFetching && !query.isPaused ? query.data : undefined;
  const reports = result?.items;

  return (
    <>
      <div className="page-header"><h1>Готовые отчёты</h1></div>
      <div className="page-body report-gallery">
        <p className="muted">Опубликованные отчёты доступны для просмотра в пределах ваших прав.</p>
        {query.isFetching && <p className="muted" role="status">Загружаем отчёты…</p>}
        {!query.isFetching && (query.error || query.isPaused) && (
          <QueryState query={{ ...query, data: undefined }} title="Не удалось загрузить отчёты" />
        )}
        {reports?.length === 0 && <p className="muted">{offset === 0 && result?.total === 0
          ? "Пока нет опубликованных отчётов."
          : "На этой странице нет опубликованных отчётов."}</p>}
        {reports && reports.length > 0 && (
          <ul className="report-gallery-list">
            {reports.map((report) => (
              <li className="card report-gallery-card" key={report.id}>
                <h2>{report.title}</h2>
                <Link className="btn" href={`/reports/${report.id}`} aria-label={`Открыть отчёт «${report.title}»`}>
                  Открыть отчёт
                </Link>
              </li>
            ))}
          </ul>
        )}
        {(offset > 0 || (result && result.total > PAGE_SIZE)) && (
          <nav className="report-gallery-pagination" aria-label="Страницы отчётов">
            <button type="button" className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
              Назад
            </button>
            <span aria-live="polite">Страница {Math.floor(offset / PAGE_SIZE) + 1}</span>
            <button type="button" className="btn" disabled={!result || offset + PAGE_SIZE >= result.total}
              onClick={() => setOffset(offset + PAGE_SIZE)}>
              Вперёд
            </button>
          </nav>
        )}
      </div>
    </>
  );
}
