"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";

import { ProjectForm } from "@/components/ProjectForm";
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
      </div>
      <div className="page-body">
        <ProjectPrint project={project} pending={projectQuery.fetchStatus !== "idle"} failed={projectQuery.isError} />
        <QueryState query={projectQuery} title="Не удалось загрузить проект" />
        {project && <ProjectForm key={project.id} project={project} />}
        {project && !projectQuery.error && <ProjectHistory projectId={project.id} />}
      </div>
    </>
  );
}
