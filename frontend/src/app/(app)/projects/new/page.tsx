"use client";

import { ProjectForm } from "@/components/ProjectForm";
import { useMe } from "@/lib/hooks";

export default function NewProjectPage() {
  const { data: me } = useMe();
  return (
    <>
      <div className="page-header">
        <h1>Новый проект</h1>
        <span className="muted">Поля со звёздочкой обязательны</span>
      </div>
      <div className="page-body">{me && <ProjectForm />}</div>
    </>
  );
}
