export type SkillSource = "host" | "project";

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: SkillSource;
  disableModelInvocation: boolean;
}

export type SkillDiagnostic =
  | { type: "warning" | "error"; message: string; path: string }
  | {
      type: "collision";
      message: string;
      path: string;
      winnerPath: string;
      loserPath: string;
      name: string;
    };

export interface LoadSkillsResult {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
}
