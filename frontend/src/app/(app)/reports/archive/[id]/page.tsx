"use client";

import { useParams } from "next/navigation";
import { SnapshotViewer } from "@/components/reports/SnapshotViewer";

export default function SavedReportPage() {
  const { id } = useParams<{ id: string }>();
  return <><div className="page-header"><h1>Сохранённая версия отчёта</h1></div><div className="page-body"><SnapshotViewer id={id} archived /></div></>;
}
