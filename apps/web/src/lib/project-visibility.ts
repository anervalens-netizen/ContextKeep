import type { ProjectDto } from "@contextkeep/shared";

export function partitionProjectVisibility(projects: ProjectDto[]): {
  active: ProjectDto[];
  inactive: ProjectDto[];
} {
  return {
    active: projects.filter((project) => project.lifecycle === "active"),
    inactive: projects.filter((project) => project.lifecycle !== "active"),
  };
}
