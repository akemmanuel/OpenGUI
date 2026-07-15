import { executeEditTool } from "./edit.ts";
import { executeReadTool } from "./read.ts";
import { executeShellTool, type ShellToolContext } from "./shell.ts";
import { executeWriteTool } from "./write.ts";

export interface ToolExecutionContext extends ShellToolContext {}

export function executeTool(context: ToolExecutionContext, name: string, input: unknown) {
  switch (name) {
    case "read":
      return executeReadTool(context.projectDirectory, input);
    case "write":
      return executeWriteTool(context.projectDirectory, input);
    case "edit":
      return executeEditTool(context.projectDirectory, input);
    case "shell":
      return executeShellTool(context, input);
    default:
      return Promise.resolve({ error: `Unknown tool: ${name}` });
  }
}
