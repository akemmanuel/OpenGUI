import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
let lists = 0;

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
        serverInfo: { name: "OpenGUI MCP race fixture", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method !== "tools/list") return;
  lists += 1;
  const list = lists;
  setTimeout(
    () => {
      if (list === 1 && process.env.MCP_FIRST_LIST_ERROR === "1") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32_603, message: "Old discovery failed" },
        });
        return;
      }
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: list === 1 ? "old_tool" : "new_tool",
              description: `Catalog response ${list}`,
              inputSchema: { type: "object" },
            },
          ],
        },
      });
    },
    list === 1 ? 100 : 0,
  );
});
