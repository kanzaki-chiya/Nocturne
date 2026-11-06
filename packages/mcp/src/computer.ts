import type {
  ApplicationTarget,
  McpOpenScope,
  McpSession,
  PermissionSubject,
  Platform,
  SubjectRequest,
  ToolContext,
  ToolDefinition,
  ToolResult,
  McpServerStatus,
} from "@nocturne/core";
import { createMcpConnector, type RuntimeMcpSource } from "./connector.js";
import release from "./computer-release.json" with { type: "json" };
import { createHash } from "node:crypto";
import { resolveWindowsApplication, type ApplicationEvidence } from "./windows-app.js";

export const COMPUTER_TOOLS = new Set([
  "list_apps",
  "list_windows",
  "get_window_state",
  "verify_state",
  "launch_app",
  "bring_to_front",
  "set_window_frame",
  "click",
  "double_click",
  "right_click",
  "drag",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "scroll",
  "clipboard_read",
  "clipboard_write",
  "get_screen_size",
  "get_desktop_state",
  "get_cursor_position",
  "move_cursor",
  "set_agent_cursor_enabled",
  "set_agent_cursor_motion",
  "get_agent_cursor_state",
  "set_agent_cursor_theme",
]);
const UNTARGETED = new Set([
  "list_apps",
  "list_windows",
  "clipboard_read",
  "clipboard_write",
  "get_screen_size",
  "get_desktop_state",
  "get_cursor_position",
  "move_cursor",
  "set_agent_cursor_enabled",
  "set_agent_cursor_motion",
  "get_agent_cursor_state",
  "set_agent_cursor_theme",
]);
const PREFIX = "mcp__computer__";
export interface ComputerState {
  enabled: boolean;
  cursor: boolean;
  state: "stopped" | "starting" | "running" | "error";
  version: string;
  error?: string | undefined;
  active?: { sessionId: string; turnId: string; app: ApplicationTarget } | undefined;
}
export interface ComputerOptions {
  platform: Platform;
  cwd: string;
  home: string;
  executable: string;
  args?: string[] | undefined;
  enabled?: boolean | undefined;
  cursor?: boolean | undefined;
  resolveApplication?:
    ((target: ApplicationTarget) => Promise<ApplicationEvidence | undefined>) | undefined;
  changed?: ((state: ComputerState) => void) | undefined;
  verifyPackage?: (() => Promise<void>) | undefined;
}
export function takeComputerBootstrap(
  env: Record<string, string | undefined>,
): { executable: string } | undefined {
  const raw = env.NOCTURNE_COMPUTER_USE_BOOTSTRAP;
  delete env.NOCTURNE_COMPUTER_USE_BOOTSTRAP;
  if (raw === undefined) return undefined;
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== "object" ||
    value === null ||
    !("executable" in value) ||
    typeof value.executable !== "string"
  )
    throw new Error("invalid computer bootstrap");
  return { executable: value.executable };
}
export async function validateComputerPackage(
  platform: Platform,
  executable: string,
): Promise<void> {
  if (
    !platform.paths.isAbsolute(executable) ||
    platform.paths.basename(executable) !== release.executable
  )
    throw new Error("invalid computer executable");
  const directory = platform.paths.dirname(executable);
  for (const [name, expected] of Object.entries(release.files)) {
    const bytes = await platform.fs.readFile(platform.paths.join(directory, name));
    if (createHash("sha256").update(bytes).digest("hex").toUpperCase() !== expected)
      throw new Error(`computer SHA-256 mismatch: ${name}`);
  }
}
export function applicationIdentity(evidence: ApplicationEvidence): string | undefined {
  if (evidence.packageFamilyName) return evidence.packageFamilyName;
  const exe = evidence.exePath?.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  return exe?.endsWith(".exe") && exe !== "applicationframehost.exe" ? exe : undefined;
}
export function computerEnvironment(platform: Platform, home: string): Record<string, string> {
  const root = platform.paths.join(home, "computer");
  return {
    DO_NOT_TRACK: "1",
    CUA_TELEMETRY: "false",
    CUA_TELEMETRY_ENABLED: "false",
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    CUA_HOME: platform.paths.join(root, "cua"),
    CUA_DRIVER_HOME: platform.paths.join(root, "driver"),
    CUA_DRIVER_LOCAL_HOME: platform.paths.join(root, "local"),
    CUA_DRIVER_RS_HOME: platform.paths.join(root, "runtime"),
    CUA_DRIVER_TELEMETRY_HOME: platform.paths.join(root, "telemetry"),
    HOME: platform.paths.join(root, "home"),
    USERPROFILE: platform.paths.join(root, "home"),
    LOCALAPPDATA: platform.paths.join(root, "localappdata"),
    APPDATA: platform.paths.join(root, "appdata"),
    TEMP: platform.paths.join(root, "tmp"),
    TMP: platform.paths.join(root, "tmp"),
  };
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
function data(result: ToolResult): Record<string, unknown> {
  const structured = record(result.output).structured;
  if (structured !== undefined) return record(structured);
  try {
    return record(JSON.parse(result.modelContent));
  } catch {
    return {};
  }
}
export function createComputerSource(options: ComputerOptions) {
  const { platform } = options;
  let state: ComputerState = {
    enabled: options.enabled ?? false,
    cursor: options.cursor ?? true,
    state: "stopped",
    version: release.version,
  };
  let owner: McpSession | undefined;
  let starting: Promise<void> | undefined;
  let closed = false;
  let generation = 0;
  let operations: Promise<unknown> = Promise.resolve();
  let controls: Promise<void> = Promise.resolve();
  const control = (work: () => Promise<void>) => {
    const next = controls.then(work);
    controls = next.catch(() => undefined);
    return next;
  };
  const scopes = new Set<McpOpenScope>();
  const wrappers = new WeakMap<ToolDefinition, ToolDefinition>();
  const tokens = new Map<string, ApplicationTarget>();
  const clipboards = new Map<string, { before: string; last: string; ctx: ToolContext }>();
  const listeners = new Set<() => void>();
  const emit = () => {
    options.changed?.({ ...state });
    for (const listener of listeners) listener();
  };
  const resolveApplication =
    options.resolveApplication ?? ((target) => resolveWindowsApplication(platform, target));
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = operations.then(work);
    operations = next.catch(() => undefined);
    return next;
  };
  function status(): McpServerStatus {
    return {
      name: "computer",
      state:
        state.state === "running"
          ? "ready"
          : state.state === "starting"
            ? "starting"
            : state.state === "error"
              ? "failed"
              : "stopped",
      error: state.error,
      toolCount:
        owner?.tools().filter((t) => COMPUTER_TOOLS.has(t.name.slice(PREFIX.length))).length ?? 0,
      restarts: 0,
    };
  }
  function emitStatus() {
    for (const scope of scopes) scope.emitServer(status());
    emit();
  }
  function raw(name: string): ToolDefinition {
    const tool = owner?.tools().find((t) => t.name === PREFIX + name);
    if (!tool) throw new Error(`computer/${name} unavailable`);
    return tool;
  }
  async function call(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    return raw(name).execute(input, ctx);
  }
  async function finishTurn(sessionId: string, turnId?: string) {
    await serialized(async () => {
      for (const [key, saved] of clipboards) {
        if (
          saved.ctx.sessionId !== sessionId ||
          (turnId !== undefined && saved.ctx.turnId !== turnId)
        )
          continue;
        clipboards.delete(key);
        if (!owner) continue;
        const ctx = { ...saved.ctx, signal: new AbortController().signal };
        const current = await call("clipboard_read", { include_text: true }, ctx);
        if (current.status === "ok" && data(current).text === saved.last)
          await call("clipboard_write", { text: saved.before }, ctx);
      }
      if (
        state.active?.sessionId === sessionId &&
        (turnId === undefined || state.active.turnId === turnId)
      ) {
        state = { ...state, active: undefined };
        emit();
      }
    });
  }
  function target(
    input: Record<string, unknown>,
    launching = false,
  ): ApplicationTarget | undefined {
    const token =
      typeof input.element_token === "string" ? tokens.get(input.element_token) : undefined;
    const pid = typeof input.pid === "number" ? input.pid : token?.pid;
    const windowId = typeof input.window_id === "number" ? input.window_id : token?.windowId;
    const identity = launching
      ? typeof input.path === "string"
        ? input.path
        : typeof input.bundle_id === "string"
          ? `shell:appsFolder\\${input.bundle_id}`
          : typeof input.name === "string"
            ? input.name
            : undefined
      : undefined;
    return pid !== undefined ||
      windowId !== undefined ||
      identity !== undefined ||
      input.element_token !== undefined
      ? { pid, windowId, identity }
      : undefined;
  }
  function requests(name: string, input: Record<string, unknown>): SubjectRequest[] {
    if (UNTARGETED.has(name)) return [];
    const found: SubjectRequest[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const object = record(value);
      const app = target(object, name === "launch_app");
      if (app !== undefined)
        found.push({
          kind: "app",
          target:
            app.identity ??
            (app.pid === undefined
              ? typeof object.element_token === "string"
                ? object.element_token
                : String(app.windowId ?? "")
              : `PID ${app.pid}`),
          app,
        });
      for (const nested of Object.values(object))
        if (typeof nested === "object" && nested !== null) visit(nested);
    };
    visit(input);
    return [...new Map(found.map((request) => [JSON.stringify(request.app), request])).values()];
  }
  async function resolveSubject(request: SubjectRequest): Promise<PermissionSubject> {
    const app = request.app ?? {};
    const evidence = await resolveApplication(app).catch(() => undefined);
    const identity = evidence === undefined ? undefined : applicationIdentity(evidence);
    return {
      kind: "app",
      target: identity ?? request.target,
      appUnresolved: identity === undefined,
      app: { ...app, ...evidence, identity },
      detail: evidence?.title,
    };
  }
  function rememberTokens(value: unknown, app?: ApplicationTarget) {
    if (Array.isArray(value)) {
      for (const item of value) rememberTokens(item, app);
      return;
    }
    const object = record(value);
    const bound = {
      ...app,
      ...(typeof object.pid === "number" ? { pid: object.pid } : {}),
      ...(typeof object.window_id === "number" ? { windowId: object.window_id } : {}),
    };
    if (typeof object.element_token === "string" && bound.pid !== undefined)
      tokens.set(object.element_token, bound);
    for (const [key, nested] of Object.entries(object))
      if (key !== "element_token") rememberTokens(nested, bound);
  }
  function wrap(tool: ToolDefinition): ToolDefinition {
    const existing = wrappers.get(tool);
    if (existing) return existing;
    const name = tool.name.slice(PREFIX.length);
    const wrapped: ToolDefinition = {
      ...tool,
      description:
        tool.description + "\n结果不确定时先观察窗口或桌面，再决定下一步；不要自动重试。",
      permissionSubjects: (input) => requests(name, record(input)),
      resolveSubject,
      finishTurn,
      execute: async (input, ctx) =>
        serialized(async () => {
          if (!state.enabled || !owner)
            return {
              status: "error",
              modelContent: "computer unavailable",
              error: { code: "mcp_server_failed", message: "computer unavailable" },
            };
          const args = { ...record(input) };
          if (name === "set_agent_cursor_enabled" && !state.cursor) args.enabled = false;
          const foreground =
            args.delivery_mode === "foreground" ||
            args.scope === "desktop" ||
            name === "bring_to_front";
          if (foreground) {
            state = {
              ...state,
              active: {
                sessionId: ctx.sessionId,
                turnId: ctx.turnId,
                app: ctx.subjects.find((s) => s.kind === "app")?.app ?? target(args) ?? {},
              },
            };
            emit();
          }
          try {
            const key = `${ctx.sessionId}/${ctx.turnId}`;
            if (name === "clipboard_write" && !clipboards.has(key)) {
              const before = await call("clipboard_read", { include_text: true }, ctx);
              const text = data(before).text;
              if (before.status !== "ok" || (text !== null && typeof text !== "string"))
                return {
                  status: "error",
                  modelContent: "clipboard backup unavailable",
                  error: { code: "tool_failed", message: "clipboard backup unavailable" },
                };
              clipboards.set(key, { before: text ?? "", last: text ?? "", ctx });
            }
            const result = await tool.execute(args, ctx);
            if (name === "clipboard_write" && result.status === "ok") {
              const saved = clipboards.get(key);
              if (saved) {
                const after = await call("clipboard_read", { include_text: true }, ctx);
                const text = data(after).text;
                if (typeof text === "string") saved.last = text;
                else clipboards.delete(key);
              }
            }
            rememberTokens(data(result), target(args));
            return result;
          } finally {
            if (foreground) {
              state = { ...state, active: undefined };
              emit();
            }
          }
        }),
    };
    wrappers.set(tool, wrapped);
    return wrapped;
  }
  async function start() {
    const usable = () => !closed && state.enabled;
    if (owner || !usable()) return;
    if (starting) return starting;
    const epoch = generation;
    state = { ...state, state: "starting", error: undefined };
    emitStatus();
    starting = (async () => {
      await (options.verifyPackage?.() ?? validateComputerPackage(platform, options.executable));
      const env = computerEnvironment(platform, options.home);
      for (const key of ["HOME", "LOCALAPPDATA", "APPDATA", "TEMP"]) {
        const dir = env[key];
        if (dir) await platform.fs.mkdir(dir);
      }
      const connection = await createMcpConnector().open({
        servers: [
          {
            name: "computer",
            origin: "app",
            command: options.executable,
            args: options.args ?? ["mcp", "--direct"],
            env,
            callTimeoutMs: 30_000,
          },
        ],
        cwd: options.cwd,
        workspaceRoot: options.cwd,
        sessionId: "computer-driver",
        platform,
        emitServer: (payload) => {
          if (epoch !== generation) return;
          if (payload.state === "failed") {
            state = { ...state, state: "error", error: payload.error };
            emitStatus();
          }
        },
        warn: (code, message) => {
          for (const scope of scopes) scope.warn(code, message);
        },
      });
      await connection.startup();
      connection.applyPendingTools();
      if (epoch !== generation || !usable()) {
        await connection.close();
        return;
      }
      owner = connection;
      if (!state.cursor && connection.status().every((server) => server.state === "ready")) {
        const ctx = {
          sessionId: "computer-settings",
          turnId: "settings",
          callId: "cursor",
          signal: new AbortController().signal,
          subjects: [],
        } as unknown as ToolContext;
        await call("set_agent_cursor_enabled", { enabled: false }, ctx);
      }
      state = {
        ...state,
        state: connection.status().every((s) => s.state === "ready") ? "running" : "error",
      };
      emitStatus();
    })()
      .catch((error: unknown) => {
        if (epoch === generation) {
          state = { ...state, state: "error", error: String(error) };
          emitStatus();
        }
      })
      .finally(() => {
        starting = undefined;
      });
    return starting;
  }
  async function stop() {
    generation++;
    for (const sessionId of new Set([...clipboards.values()].map((s) => s.ctx.sessionId)))
      await finishTurn(sessionId).catch(() => undefined);
    await starting;
    const previous = owner;
    owner = undefined;
    await previous?.close();
    tokens.clear();
    state = { ...state, state: "stopped", active: undefined };
    emitStatus();
  }
  const source: RuntimeMcpSource = {
    open(scope) {
      scopes.add(scope);
      let applied = new Map<string, ToolDefinition>();
      const lease: McpSession = {
        startup: async () => {
          await start();
          applied = new Map(
            (state.enabled ? (owner?.tools() ?? []) : [])
              .filter((t) => COMPUTER_TOOLS.has(t.name.slice(PREFIX.length)))
              .map((t) => [t.name, wrap(t)]),
          );
        },
        prepareTurn: async (signal) => {
          if (!signal?.aborted) {
            await start();
            await owner?.prepareTurn?.(signal);
          }
        },
        finishTurn,
        tools: () => [...applied.values()],
        status: () => [status()],
        applyPendingTools() {
          owner?.applyPendingTools();
          const next = new Map(
            (state.enabled ? (owner?.tools() ?? []) : [])
              .filter((t) => COMPUTER_TOOLS.has(t.name.slice(PREFIX.length)))
              .map((t) => [t.name, wrap(t)]),
          );
          const diff = {
            add: [...next].filter(([name, t]) => applied.get(name) !== t).map(([, t]) => t),
            remove: [...applied.keys()].filter((name) => !next.has(name)),
          };
          applied = next;
          return diff;
        },
        reconcile: () => Promise.resolve(),
        close: async () => {
          await finishTurn(scope.sessionId);
          scopes.delete(scope);
          applied.clear();
        },
      };
      return Promise.resolve({
        servers: [],
        credentials: { get: () => Promise.resolve(undefined) },
        callerMetadata: false,
        connection: lease,
        close: () => lease.close(),
      });
    },
  };
  return {
    ...source,
    getState: (): ComputerState => ({ ...state }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setEnabled(enabled: boolean) {
      state = { ...state, enabled };
      emit();
      return control(async () => {
        if (enabled) await start();
        else await stop();
      });
    },
    async setCursor(cursor: boolean) {
      state = { ...state, cursor };
      emit();
      if (owner) {
        const ctx = {
          sessionId: "computer-settings",
          turnId: "settings",
          callId: "cursor",
          signal: new AbortController().signal,
          subjects: [],
        } as unknown as ToolContext;
        await serialized(() => call("set_agent_cursor_enabled", { enabled: cursor }, ctx));
      }
    },
    restart() {
      return control(async () => {
        await stop();
        await start();
      });
    },
    async runningApps(): Promise<ApplicationTarget[]> {
      if (!owner) return [];
      const ctx = {
        sessionId: "computer-settings",
        turnId: "settings",
        callId: "apps",
        signal: new AbortController().signal,
        subjects: [],
      } as unknown as ToolContext;
      const result = await serialized(() => call("list_windows", {}, ctx));
      const windows = data(result).windows;
      if (!Array.isArray(windows)) return [];
      const apps = new Map<string, ApplicationTarget>();
      for (const value of windows) {
        const item = record(value);
        const pid = typeof item.pid === "number" ? item.pid : undefined;
        const windowId = typeof item.window_id === "number" ? item.window_id : undefined;
        if (pid === undefined) continue;
        const info = await resolveApplication({ pid, windowId });
        if (!info) continue;
        const identity = applicationIdentity(info);
        if (!identity || apps.has(identity)) continue;
        apps.set(identity, {
          ...info,
          pid,
          windowId,
          name:
            info.name ??
            (typeof item.app_name === "string" ? item.app_name.replace(/\.exe$/iu, "") : identity),
          identity,
        });
      }
      return [...apps.values()];
    },
    async close() {
      closed = true;
      state = { ...state, enabled: false };
      await control(stop);
      scopes.clear();
    },
  };
}
