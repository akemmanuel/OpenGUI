import { describe, expect, test } from "vite-plus/test";
import type { SessionEntry } from "../harness.ts";
import { buildModelContext } from "./build-context.ts";
import {
  buildHandoffPrompt,
  buildResumePrompt,
  estimateContextTokens,
  findUnresolvedCompactionFailure,
  MAX_HANDOFF_BYTES,
  parseCompactionHandoff,
} from "./compaction.ts";

const VALID_SUMMARY = {
  goal: "Ship the fixture.",
  currentState: "Scaffolding is done.",
  constraints: "No network calls.",
  decisions: "Use SQLite.",
  blockers: "Waiting on review.",
  relevantFiles: ["src/index.ts"],
  nextSteps: ["Write tests.", "Run checks."],
};

describe("estimateContextTokens", () => {
  test("does not count persisted image bytes as text tokens", () => {
    const base64 = "a".repeat(400_000);
    const tokens = estimateContextTokens(
      [
        {
          type: "tool_result",
          toolCallId: "image",
          name: "read",
          output: {
            content: "Read image file [image/png]",
            attachments: [{ type: "image", mimeType: "image/png", data: base64 }],
          },
        },
      ],
      "system",
    );

    expect(tokens).toBeLessThan(1_000);
  });
});

describe("parseCompactionHandoff", () => {
  test("renders required sections for a valid summary", () => {
    const handoff = parseCompactionHandoff(JSON.stringify(VALID_SUMMARY));
    expect(handoff).toContain("## Goal");
    expect(handoff).toContain("Ship the fixture.");
    expect(handoff).toContain("## Next steps");
    expect(handoff).toContain("1. Write tests.");
    expect(handoff).toContain("- src/index.ts");
  });

  test("accepts a single json fence", () => {
    const handoff = parseCompactionHandoff(`\`\`\`json\n${JSON.stringify(VALID_SUMMARY)}\n\`\`\``);
    expect(handoff).toContain("Ship the fixture.");
  });

  test("rejects empty responses", () => {
    expect(() => parseCompactionHandoff("   \n")).toThrow("Compaction summary was empty");
  });

  test("rejects oversized responses without truncating", () => {
    const oversized = { ...VALID_SUMMARY, decisions: "x".repeat(MAX_HANDOFF_BYTES) };
    expect(() => parseCompactionHandoff(JSON.stringify(oversized))).toThrow(
      "Compaction summary exceeds the size limit",
    );
  });

  test("also bounds the rendered summary rather than just its JSON response", () => {
    const raw = JSON.stringify({
      ...VALID_SUMMARY,
      goal: "x".repeat(MAX_HANDOFF_BYTES - 2_500),
      relevantFiles: [],
      nextSteps: Array.from({ length: 500 }, () => "x"),
    });
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(MAX_HANDOFF_BYTES);
    expect(() => parseCompactionHandoff(raw)).toThrow("Compaction summary exceeds the size limit");
  });

  test("rejects prose-only responses", () => {
    expect(() => parseCompactionHandoff("# Handoff\n\nJust continue the work.\n")).toThrow(
      "Compaction summary was invalid",
    );
  });

  test("rejects missing required fields", () => {
    const { goal: _goal, ...withoutGoal } = VALID_SUMMARY;
    expect(() => parseCompactionHandoff(JSON.stringify(withoutGoal))).toThrow(
      "Compaction summary was invalid",
    );
  });

  test("rejects empty next steps", () => {
    expect(() =>
      parseCompactionHandoff(JSON.stringify({ ...VALID_SUMMARY, nextSteps: ["  "] })),
    ).toThrow("Compaction summary was invalid");
  });

  test("error messages expose no filesystem paths", () => {
    for (const raw of ["", "x".repeat(MAX_HANDOFF_BYTES + 1), "plain prose"]) {
      try {
        parseCompactionHandoff(raw);
        expect.unreachable();
      } catch (error) {
        expect(error instanceof Error ? error.message : String(error)).not.toContain("HANDOFF");
      }
    }
  });
});

describe("compaction context safety", () => {
  const entry = (kind: SessionEntry["kind"], payload: Record<string, unknown>): SessionEntry => ({
    id: "fixture",
    sessionId: "session",
    sequence: 1,
    kind,
    payload,
    createdAt: "2026-10-06T00:00:00.000Z",
  });

  test("does not discard earlier history when a completed entry has no usable summary", () => {
    const context = buildModelContext([
      entry("user_message", { text: "Preserve this original accepted intent" }),
      entry("assistant_message", { text: "Preserve this work state" }),
      entry("compaction", { status: "completed", handoff: "  " }),
      entry("user_message", { text: "Continue" }),
    ]);
    expect(JSON.stringify(context)).toContain("Preserve this original accepted intent");
    expect(JSON.stringify(context)).toContain("Preserve this work state");
    expect(JSON.stringify(context)).not.toContain("summary is unavailable");
  });

  test("does not replay failed legacy compaction messages or tool effects as task context", () => {
    const context = buildModelContext([
      entry("user_message", { text: "Task intent" }),
      entry("assistant_message", {
        text: "CONTEXT HANDOFF MODE legacy internals",
        purpose: "compaction",
      }),
      entry("tool_call", { toolCallId: "old", name: "write", input: {}, purpose: "compaction" }),
      entry("tool_result", {
        toolCallId: "old",
        output: "legacy denied write",
        purpose: "compaction",
      }),
    ]);
    expect(context).toHaveLength(1);
    expect(JSON.stringify(context)).toContain("Task intent");
    expect(JSON.stringify(context)).not.toContain("legacy");
  });
});

describe("findUnresolvedCompactionFailure", () => {
  let sequence = 0;
  const entry = (kind: SessionEntry["kind"], payload: Record<string, unknown>): SessionEntry => {
    sequence += 1;
    return {
      id: `entry-${sequence}`,
      sessionId: "session",
      sequence,
      kind,
      payload,
      createdAt: "2026-10-06T00:00:00.000Z",
    };
  };

  test("no compaction entries means no block", () => {
    expect(findUnresolvedCompactionFailure([entry("user_message", { text: "hi" })])).toBeNull();
  });

  test("a failed outcome blocks until a later completion", () => {
    const entries = [
      entry("compaction", { status: "started", runId: "run-1" }),
      entry("compaction", {
        status: "failed",
        runId: "run-1",
        failureSource: "summary",
        error: "Compaction summary was invalid",
      }),
    ];
    expect(findUnresolvedCompactionFailure(entries)).toMatchObject({
      entry: expect.objectContaining({
        kind: "compaction",
        payload: expect.objectContaining({ status: "failed", runId: "run-1" }),
      }),
    });
    expect(
      findUnresolvedCompactionFailure([
        ...entries,
        entry("compaction", { status: "completed", runId: "run-2", handoff: "# Handoff" }),
      ]),
    ).toBeNull();
  });

  test("a started entry with a later same-run run_failed blocks without a failed entry", () => {
    expect(
      findUnresolvedCompactionFailure([
        entry("compaction", { status: "started", runId: "run-9" }),
        entry("run_failed", { runId: "run-9", error: "disk full" }),
      ]),
    ).toMatchObject({
      entry: expect.objectContaining({
        kind: "compaction",
        payload: expect.objectContaining({ status: "started", runId: "run-9" }),
      }),
    });
  });

  test("a bare started entry and aborted runs do not block", () => {
    expect(
      findUnresolvedCompactionFailure([entry("compaction", { status: "started", runId: "run-1" })]),
    ).toBeNull();
    expect(
      findUnresolvedCompactionFailure([
        entry("compaction", { status: "started", runId: "run-1" }),
        entry("run_aborted", { runId: "run-1" }),
      ]),
    ).toBeNull();
  });

  test("a run_failed for another run does not implicate the started entry", () => {
    expect(
      findUnresolvedCompactionFailure([
        entry("compaction", { status: "started", runId: "run-1" }),
        entry("run_failed", { runId: "run-2", error: "task failure" }),
      ]),
    ).toBeNull();
  });
});

describe("compaction prompts", () => {
  test("handoff prompt requests tool-free JSON and names no filesystem path", () => {
    const prompt = buildHandoffPrompt();
    expect(prompt).toContain("CONTEXT HANDOFF MODE");
    expect(prompt).toContain("no tools");
    expect(prompt).toContain("JSON");
    expect(prompt).not.toContain("HANDOFF.md");
  });

  test("resume prompt injects the summary as historical context", () => {
    const prompt = buildResumePrompt("## Goal\nShip it.");
    expect(prompt).toContain("HISTORICAL CONTEXT");
    expect(prompt).toContain("## Goal\nShip it.");
  });
});
