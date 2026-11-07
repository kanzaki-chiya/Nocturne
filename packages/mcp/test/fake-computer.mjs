import readline from "node:readline";
let clipboard = "original";
let calls = 0;
const names = [
  "list_apps",
  "list_windows",
  "get_window_state",
  "verify_state",
  "launch_app",
  "click",
  "clipboard_read",
  "clipboard_write",
  "set_agent_cursor_enabled",
  "browser_click",
  "check_for_update",
  "start_recording",
  "replay_trajectory",
  "unknown_future_tool",
];
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  if (request.method === "initialize")
    send(request.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-computer", version: "0" },
    });
  else if (request.method === "tools/list")
    send(request.id, {
      tools: names.map((name) => ({
        name,
        description: name,
        inputSchema: { type: "object", properties: {} },
      })),
    });
  else if (request.method === "tools/call") {
    const { name, arguments: args = {} } = request.params;
    let structuredContent = {};
    if (name === "clipboard_read") {
      if (args.external !== undefined) clipboard = args.external;
      structuredContent = { supported: true, text: clipboard, types: ["text/plain"] };
    } else if (name === "clipboard_write") {
      clipboard = args.text;
      structuredContent = { written_type: "text" };
    } else if (name === "get_window_state" && args.fixture) {
      const header = "window_id=78711444 pid=86512 elements=107 snapshot_id=s00000001";
      const text = `${header}\nelement_token for row [N] = s00000001:N (row [1] is "s00000001:1")\n[88] Button "New"\n${"x".repeat(110_000)}`;
      send(request.id, {
        content: [{ type: "text", text }],
        ...(args.fixture === "text"
          ? {}
          : {
              structuredContent: {
                snapshot_id: "s00000002",
                pid: 20,
                window_id: 100,
                tree_markdown: text,
              },
            }),
      });
      continue;
    } else if (name === "get_window_state")
      structuredContent = {
        effect: "unverifiable",
        calls: ++calls,
        pid: args.pid,
        window_id: args.window_id,
      };
    else if (name === "list_windows")
      structuredContent = {
        pid: process.pid,
        env: Object.fromEntries(
          [
            "DO_NOT_TRACK",
            "CUA_DRIVER_RS_TELEMETRY_ENABLED",
            "CUA_TELEMETRY_ENABLED",
            "CUA_TELEMETRY_DISABLED",
            "CUA_TELEMETRY",
            "CUA_DRIVER_RS_UPDATE_CHECK",
            "CUA_DRIVER_EMBEDDED",
            "CUA_HOME",
            "CUA_DRIVER_HOME",
            "CUA_DRIVER_LOCAL_HOME",
            "CUA_DRIVER_RS_HOME",
            "CUA_DRIVER_TELEMETRY_HOME",
            "CUA_DRIVER_CURSOR_THEME_DIR",
            "HOME",
            "USERPROFILE",
            "LOCALAPPDATA",
            "APPDATA",
          ].map((key) => [key, process.env[key]]),
        ),
        windows: [{ pid: 20, window_id: 100, app_name: "Excel", title: "Budget" }],
      };
    else if (name === "list_apps")
      structuredContent = { apps: [{ pid: 20, name: "Excel", path: "C:/Office/EXCEL.EXE" }] };
    send(request.id, {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    });
  } else if (request.method === "ping") send(request.id, {});
}
