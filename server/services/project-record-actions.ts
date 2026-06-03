import type {
  BackendServiceContext,
  CreateProjectInput,
  ProjectRecord,
  UpdateProjectInput,
} from "./index.ts";

export async function getProjectRecordOrThrow(input: {
  services: BackendServiceContext;
  projectId: string;
}): Promise<ProjectRecord> {
  const project = await input.services.projects.getProject(input.projectId);
  if (!project) throw new Error("Project not found");
  return project;
}

export async function listProjectRecords(input: { services: BackendServiceContext }) {
  return await input.services.projects.listProjects();
}

export async function createProjectRecord(input: {
  services: BackendServiceContext;
  project: CreateProjectInput;
}): Promise<ProjectRecord> {
  return await input.services.projects.createProject(input.project);
}

export async function updateProjectRecord(input: {
  services: BackendServiceContext;
  projectId: string;
  patch: UpdateProjectInput;
}): Promise<ProjectRecord | null> {
  return await input.services.projects.updateProject(input.projectId, input.patch);
}

export async function findOrCreateProjectRecordByPath(input: {
  services: BackendServiceContext;
  project: CreateProjectInput;
}): Promise<ProjectRecord> {
  const existing = await input.services.projects.findProjectByPath({
    path: input.project.path,
    canonicalPath: input.project.canonicalPath,
  });
  return existing ?? (await input.services.projects.createProject(input.project));
}
