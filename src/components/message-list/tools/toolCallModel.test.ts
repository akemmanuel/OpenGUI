import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { ToolCallState } from "@/protocol/session-transcript";
import { getToolCallViewModel } from "./toolCallModel";

function toolPart(part: { tool: string; state: ToolCallState }) {
  return {
    id: "part-1",
    type: "tool",
    ...part,
  } as Parameters<typeof getToolCallViewModel>[0];
}

describe("getToolCallViewModel", () => {
  test("presents unknown failed tools with a prettified label and no expansion", () => {
    const vm = getToolCallViewModel(
      toolPart({
        tool: "sengine_scrape",
        state: { status: "error", error: "Sengine request failed (500): goto:" },
      }),
    );

    expect(vm.status).toBe("error");
    expect(vm.label).toBe("Sengine Scrape");
    expect(vm.expandable).toBe(false);
    expect(vm.output).toEqual([
      { type: "text", text: "Sengine request failed (500): goto:", format: "plain" },
    ]);
  });

  test("makes completed tools with meaningful output expandable", () => {
    const vm = getToolCallViewModel(
      toolPart({ tool: "sengine_scrape", state: { status: "completed", output: "result" } }),
    );

    expect(vm.status).toBe("success");
    expect(vm.expandable).toBe(true);
  });

  test("does not make empty or prompt-marker output expandable", () => {
    const vm = getToolCallViewModel(
      toolPart({
        tool: "sengine_scrape",
        state: { status: "completed", output: "\n>\n>\n>\n" },
      }),
    );

    expect(vm.status).toBe("success");
    expect(vm.expandable).toBe(false);
    expect(vm.output).toEqual([]);
  });

  test("maps protocol pending to product running", () => {
    const vm = getToolCallViewModel(
      toolPart({ tool: "bash", state: { status: "pending", input: { command: "vp check" } } }),
    );

    expect(vm.status).toBe("running");
    expect(vm.label).toBe("Running vp check");
  });

  test("question-shaped tools are not a special tool kind", () => {
    const vm = getToolCallViewModel(
      toolPart({ tool: "ask_user", state: { status: "completed", output: "ok" } }),
    );

    expect(vm.kind).toBe("unknown");
    expect(vm.label).toBe("Ask User");
  });

  test("keeps todo raw output separate when formatted todos are available", () => {
    const vm = getToolCallViewModel(
      toolPart({
        tool: "todowrite",
        state: {
          status: "completed",
          input: { todos: [{ content: "Buy milk", status: "pending", priority: "medium" }] },
          output: '[{"content":"Buy milk","status":"pending","priority":"medium"}]',
        },
      }),
    );

    expect(vm.output).toEqual([
      { type: "todos", todos: [{ content: "Buy milk", status: "pending", priority: "medium" }] },
    ]);
    expect(vm.rawOutput).toBe('[{"content":"Buy milk","status":"pending","priority":"medium"}]');
  });

  test("prefers completed bash output over streaming metadata for raw output", () => {
    const vm = getToolCallViewModel(
      toolPart({
        tool: "bash",
        state: {
          status: "completed",
          output: "final output",
          metadata: { output: "partial output" },
        },
      }),
    );

    expect(vm.output).toEqual([{ type: "text", text: "final output", format: "terminal" }]);
    expect(vm.rawOutput).toBe(null);
  });

  test("uses bash metadata while output is still streaming", () => {
    const vm = getToolCallViewModel(
      toolPart({
        tool: "bash",
        state: { status: "running", metadata: { output: "streaming output" } },
      }),
    );

    expect(vm.output).toEqual([{ type: "text", text: "streaming output", format: "terminal" }]);
    expect(vm.rawOutput).toBe(null);
  });

  test("uses error text for failed tools", () => {
    const vm = getToolCallViewModel(
      toolPart({ tool: "bash", state: { status: "error", error: "command failed" } }),
    );

    expect(vm.output).toEqual([{ type: "text", text: "command failed", format: "terminal" }]);
    expect(vm.rawOutput).toBe(null);
  });

  test("prefers bash error text over partial output when both are present", () => {
    const vm = getToolCallViewModel(
      toolPart({
        tool: "bash",
        state: { status: "error", output: "partial stdout", error: "command failed" },
      }),
    );

    expect(vm.output).toEqual([{ type: "text", text: "command failed", format: "terminal" }]);
    expect(vm.rawOutput).toBe(null);
  });

  test("keeps raw output null for formatted output with meaningless text", () => {
    const vm = getToolCallViewModel(
      toolPart({
        tool: "todowrite",
        state: {
          status: "completed",
          input: { todos: [{ content: "Buy milk", status: "pending", priority: "medium" }] },
          output: "\n>\n>\n",
        },
      }),
    );

    expect(vm.output).toEqual([
      { type: "todos", todos: [{ content: "Buy milk", status: "pending", priority: "medium" }] },
    ]);
    expect(vm.rawOutput).toBe(null);
  });
});
