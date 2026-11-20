import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const viewerHtml = readFileSync(path.join(here, "viewer.html"), "utf8");
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

let statsCalls = 0;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  const { id, method, params } = req;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "mcp-apps-demo-server", version: "1.0.0" },
      },
    });
    return;
  }

  if (method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "show_demo",
            description: "Open the MCP Apps demo surface and display a document summary",
            inputSchema: {
              type: "object",
              properties: {
                title: { type: "string" },
                note: { type: "string" },
              },
              required: ["title"],
            },
            annotations: { readOnlyHint: true },
            _meta: {
              ui: {
                resourceUri: "ui://demo/viewer.html",
                surface: "demo-viewer",
                visibility: ["model", "app"],
              },
            },
          },
          {
            name: "open_demo_file",
            description: "Open a .nctdemo file in the demo viewer (app-only read-only)",
            inputSchema: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
            },
            annotations: { readOnlyHint: true },
            _meta: {
              ui: {
                resourceUri: "ui://demo/viewer.html",
                surface: "demo-viewer",
                visibility: ["app"],
              },
            },
          },
          {
            name: "fetch_app_stats",
            description: "Read-only app-only tool returning counter and summary",
            inputSchema: {
              type: "object",
              properties: {
                section: { type: "string" },
              },
            },
            annotations: { readOnlyHint: true },
            _meta: {
              ui: {
                visibility: ["app"],
              },
            },
          },
          {
            name: "mutate_demo_state",
            description: "Write app-only tool that must be rejected when called from app",
            inputSchema: {
              type: "object",
              properties: {
                value: { type: "string" },
              },
            },
            annotations: { readOnlyHint: false },
            _meta: {
              ui: {
                visibility: ["app"],
              },
            },
          },
        ],
      },
    });
    return;
  }

  if (method === "resources/read") {
    const uri = params?.uri;
    if (uri === "ui://demo/viewer.html") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          contents: [
            {
              uri,
              mimeType: "text/html;profile=mcp-app",
              text: viewerHtml,
            },
          ],
        },
      });
      return;
    }
    if (uri === "ui://demo/blob.html") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          contents: [
            {
              uri,
              mimeType: "text/html;profile=mcp-app",
              blob: Buffer.from(viewerHtml, "utf8").toString("base64"),
            },
          ],
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32002, message: `Resource not found: ${String(uri)}` },
    });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === "show_demo") {
      const title = typeof args.title === "string" ? args.title : "未命名";
      const note = typeof args.note === "string" ? args.note : "";
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `已加载示例：${title}${note ? `（${note}）` : ""}` }],
          structuredContent: {
            title,
            note,
            sections: [
              { id: "s1", heading: "概述", words: 128 },
              { id: "s2", heading: "验证项", words: 64 },
            ],
          },
        },
      });
      return;
    }
    if (name === "open_demo_file") {
      const filePath = typeof args.path === "string" ? args.path : "";
      let body = "";
      try {
        body = readFileSync(filePath, "utf8");
      } catch (err) {
        body = `读取失败: ${err instanceof Error ? err.message : String(err)}`;
      }
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `打开文件：${path.basename(filePath)}` }],
          structuredContent: { path: filePath, body },
        },
      });
      return;
    }
    if (name === "fetch_app_stats") {
      statsCalls += 1;
      const section = typeof args.section === "string" ? args.section : "all";
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `统计查询 #${statsCalls}（${section}）` }],
          structuredContent: { count: statsCalls, section, status: "ok" },
        },
      });
      return;
    }
    if (name === "mutate_demo_state") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `mutated:${String(args.value ?? "")}` }],
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unknown tool: ${String(name)}` },
    });
    return;
  }

  if (id !== undefined) {
    send({ jsonrpc: "2.0", id, result: {} });
  }
});
