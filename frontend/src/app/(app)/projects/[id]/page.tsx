"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";

import { ProjectForm } from "@/components/ProjectForm";
import { api } from "@/lib/api";
import type { Project } from "@/lib/types";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const { data: project, error } = useQuery({
    queryKey: ["project", id],
    queryFn: () => api<Project>(`/projects/${id}`),
  });

  return (
    <>
      <div className="page-header">
        <h1>{project ? project.name : "Проект"}</h1>
        {project && (
          <span className="muted">
            {project.client.name} · обновлён {new Date(project.updated_at).toLocaleDateString("ru-RU")}
          </span>
        )}
      </div>
      <div className="page-body">
        {error && <div className="alert">Проект не найден или нет доступа</div>}
        {project && <ProjectForm key={project.updated_at} project={project} />}
      </div>
    </>
  );
}
