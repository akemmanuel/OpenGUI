import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "OpenGUI MCP fixture", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "tools/list") {
    if (process.env.MCP_HANG_LIST === "1") return;
    const toolName = process.env.MCP_PID_TOOL === "1" ? `echo_${process.pid}` : "echo";
    const toolCount = Number.parseInt(process.env.MCP_TOOL_COUNT ?? "1", 10);
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: Array.from({ length: toolCount }, (_, index) => ({
          name: index === 0 ? toolName : `${toolName}_${index}`,
          title: "Echo",
          description: "Return the supplied message.",
          inputSchema: {
            type: "object",
            properties: { message: { type: "string" } },
            required: ["message"],
          },
        })),
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: `echo:${message.params?.arguments?.message ?? ""}` }],
      },
    });
  }
});
