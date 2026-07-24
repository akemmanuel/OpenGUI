import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { responsiveAuditExpression } from "./responsive-audit.ts";

const execFileAsync = promisify(execFile);
const session = `responsive-audit-fixtures-${process.pid}`;
let server: Server;
let origin = "";

async function browser(...args: string[]) {
  const { stdout } = await execFileAsync("agent-browser", ["--session", session, ...args], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

async function audit(markup: string, coarsePointer = false) {
  const script = `document.body.innerHTML=${JSON.stringify(markup)}; true`;
  await browser("eval", script);
  return JSON.parse(
    await browser(
      "eval",
      responsiveAuditExpression({ coarsePointer, state: "synthetic", locale: "en" }),
    ),
  ) as { findings: Array<{ rule: string; selector: string }> };
}

function rules(result: Awaited<ReturnType<typeof audit>>) {
  return result.findings.map((finding) => finding.rule);
}

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(
      "<!doctype html><meta name=viewport content='width=device-width'><style>*{box-sizing:border-box}html,body{margin:0}button{position:relative}</style><body></body>",
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server has no port");
  origin = `http://127.0.0.1:${address.port}`;
  await browser("open", origin);
  await browser("set", "viewport", "320", "240");
});

afterAll(async () => {
  await browser("close").catch(() => undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("responsive DOM detector synthetic red/green fixtures", () => {
  test("production viewport permits browser text zoom and resizes for the virtual keyboard", async () => {
    const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
    const viewport = html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/u)?.[1] ?? "";

    expect(viewport).toContain("width=device-width");
    expect(viewport).toContain("viewport-fit=cover");
    expect(viewport).toContain("interactive-widget=resizes-content");
    expect(viewport).not.toContain("maximum-scale");
    expect(viewport).not.toContain("user-scalable=no");
  });

  test.each([
    ["viewport escape", "<div style='width:360px;height:20px'>wide</div>", "viewport-escape"],
    [
      "nested flex min-content overflow",
      "<div style='display:flex;width:200px;overflow:hidden'><div style='min-width:max-content'>UnbrokenWordUnbrokenWordUnbrokenWordUnbrokenWord</div></div>",
      "clipped-content",
    ],
    [
      "clipped text",
      "<div style='width:40px;white-space:nowrap;overflow:hidden'>clipped readable text</div>",
      "clipped-content",
    ],
    [
      "offscreen portal",
      "<div id='portal' style='position:absolute;left:400px;width:80px;height:40px'>menu</div>",
      "viewport-escape",
    ],
    [
      "transformed escape",
      "<div style='width:80px;height:20px;transform:translateX(300px)'>moved</div>",
      "viewport-escape",
    ],
    [
      "fixed overlay escape",
      "<div style='position:fixed;bottom:-20px;width:100px;height:40px'>toast</div>",
      "viewport-escape",
    ],
    [
      "unmarked scroll container",
      "<div style='width:100px;overflow-x:auto'><div style='width:300px;height:20px'>scroll me</div></div>",
      "unmarked-horizontal-scroll",
    ],
    [
      "coarse hit area",
      "<button aria-label='Small' style='width:20px;height:20px'>x</button>",
      "coarse-target",
      true,
    ],
    [
      "overlapping controls",
      "<button style='position:absolute;left:10px;top:10px;width:80px;height:50px'>A</button><button style='position:absolute;left:30px;top:20px;width:80px;height:50px'>B</button>",
      "action-overlap",
    ],
    [
      "body overflow hiding cannot mask escape",
      "<style>body{overflow-x:hidden}</style><div style='position:absolute;left:310px;width:100px;height:20px'>escaped</div>",
      "viewport-escape",
    ],
    [
      "zero-size clipping ancestor cannot mask content",
      "<div style='width:0;height:0;overflow:hidden'><span style='display:block;width:100px;height:20px'>lost text</span></div>",
      "clipped-content",
    ],
    [
      "ancestor exemption cannot suppress a descendant defect",
      "<div data-responsive-allow='viewport-escape'><div style='width:360px;height:20px'>wide</div></div>",
      "viewport-escape",
    ],
    [
      "text clipping cannot hide a core action",
      "<div data-responsive-allow='text-clip' style='width:100px;overflow:hidden'><button style='margin-left:180px;width:80px;height:44px'>Core action</button></div>",
      "clipped-action",
    ],
    [
      "stale or misspelled exemptions",
      "<div data-responsive-allow='horizontal-scrol'>typo</div>",
      "invalid-responsive-exemption",
    ],
  ])("detects %s", async (_name, markup, expected, coarsePointer = false) => {
    expect(rules(await audit(markup, coarsePointer))).toContain(expected);
  });

  test.each([
    ["display none", "<div style='display:none;width:400px'>hidden</div>"],
    ["visibility hidden", "<div style='visibility:hidden;width:400px'>hidden</div>"],
    [
      "marked scroll owner",
      "<div data-responsive-allow='horizontal-scroll' style='width:100px;overflow-x:auto'><div style='width:300px;height:20px'>scroll me</div></div>",
    ],
    [
      "local text clipping",
      "<div data-responsive-allow='text-clip' style='width:40px;white-space:nowrap;overflow:hidden'>known clipped label</div>",
    ],
    [
      "native text editor scrolling",
      "<input aria-label='Long value' style='width:80px' value='A very long editable value that scrolls natively'>",
    ],
  ])("does not report intentional or hidden %s", async (_name, markup) => {
    expect((await audit(markup)).findings).toEqual([]);
  });
});
