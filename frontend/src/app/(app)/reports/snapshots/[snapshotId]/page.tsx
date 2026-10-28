"use client";
import { useParams } from "next/navigation";
import { SnapshotViewer } from "@/components/reports/SnapshotViewer";
export default function Page() { const { snapshotId } = useParams<{ snapshotId: string }>(); return <><div className="page-header"><h1>Результат отчёта</h1></div><div className="page-body"><SnapshotViewer id={snapshotId} /></div></>; }
