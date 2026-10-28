"use client";
import { useParams } from "next/navigation";
import { ReportEditor } from "@/components/reports/ReportEditor";
export default function Page() { const { id } = useParams<{ id: string }>(); return <ReportEditor id={id} />; }
