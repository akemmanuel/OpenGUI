import type { BackendEventBus } from "./event-bus.ts";
import type {
  StorageService,
  ProjectRecord,
  CreateProjectInput,
  UpdateProjectInput,
} from "./storage-service.ts";

function sameProjectPath(project: ProjectRecord, input: { path: string; canonicalPath: string }) {
  return project.canonicalPath === input.canonicalPath || project.path === input.path;
}

export class ProjectService {
  private readonly storage: StorageService;
  private readonly events?: BackendEventBus;

  constructor(storage: StorageService, events?: BackendEventBus) {
    this.storage = storage;
    this.events = events;
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return this.storage.listProjects();
  }

  async getProject(id: string): Promise<ProjectRecord | null> {
    return this.storage.getProject(id);
  }

  async findProjectByPath(input: {
    path: string;
    canonicalPath?: string;
  }): Promise<ProjectRecord | null> {
    const projects = await this.storage.listProjects();
    const canonicalPath = input.canonicalPath ?? input.path;
    return (
      projects.find((project) => sameProjectPath(project, { ...input, canonicalPath })) ?? null
    );
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    const existing = await this.findProjectByPath({
      path: input.path,
      canonicalPath: input.canonicalPath,
    });

    if (existing) {
      const updated = await this.storage.updateProject(existing.id, {
        displayName: input.displayName,
        path: input.path,
        canonicalPath: input.canonicalPath ?? input.path,
        allowedRootId: input.allowedRootId,
        git: input.git,
      });
      if (updated) {
        this.events?.emit(
          "project.updated",
          { projectId: updated.id, project: updated },
          { projectId: updated.id },
        );
        return updated;
      }
    }

    const project = await this.storage.createProject(input);
    this.events?.emit(
      "project.created",
      { projectId: project.id, project },
      { projectId: project.id },
    );
    return project;
  }

  async updateProject(id: string, input: UpdateProjectInput): Promise<ProjectRecord | null> {
    const project = await this.storage.updateProject(id, input);
    if (project) {
      this.events?.emit(
        "project.updated",
        { projectId: project.id, project },
        { projectId: project.id },
      );
    }
    return project;
  }
}
