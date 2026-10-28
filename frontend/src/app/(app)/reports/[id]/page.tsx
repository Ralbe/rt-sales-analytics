"use client";
import { useParams } from "next/navigation";
import { ReportPage } from "@/components/reports/ReportPage";
export default function Page() { const { id } = useParams<{ id: string }>(); return <ReportPage id={id} />; }
