"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";

import { ProjectForm } from "@/components/ProjectForm";
import { ProjectArchiveActions } from "@/components/ProjectArchiveActions";
import { ProjectHistory } from "@/components/ProjectHistory";
import { ProjectPrint } from "@/components/ProjectPrint";
import { QueryState } from "@/components/QueryState";
import { api } from "@/lib/api";
import type { Project } from "@/lib/types";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const projectQuery = useQuery({
    queryKey: ["project", id],
    queryFn: () => api<Project>(`/projects/${id}`),
  });
  const project = projectQuery.data;

  return (
    <>
      <div className="page-header">
        <h1>{project ? project.name : "Проект"}</h1>
        {project && (
          <span className="muted">
            {project.client.name} · обновлён {new Date(project.updated_at).toLocaleDateString("ru-RU")}
          </span>
        )}
        {project && <ProjectArchiveActions project={project} disabled={projectQuery.isFetching || projectQuery.isError} />}
      </div>
      <div className="page-body">
        <ProjectPrint project={project} pending={projectQuery.fetchStatus !== "idle"} failed={projectQuery.isError} />
        <QueryState query={projectQuery} title="Не удалось загрузить проект" />
        {project?.archived_at && (
          <div className="alert info" role="status">
            Проект в архиве с {new Date(project.archived_at).toLocaleString("ru-RU")}. Для редактирования восстановите проект.
          </div>
        )}
        {project && <ProjectForm key={project.id} project={project} readOnly={!!project.archived_at} />}
        {project && !projectQuery.error && <ProjectHistory projectId={project.id} />}
      </div>
    </>
  );
}
