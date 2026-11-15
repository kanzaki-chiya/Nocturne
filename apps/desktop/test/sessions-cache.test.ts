import { beforeEach, expect, it, vi } from "vitest";

import { readSessionsCache, SESSIONS_CACHE_KEY, writeSessionsCache } from "../src/sessions-cache";
import type { SessionSummary } from "../src/session-tree";

const host = {
  sessionPaths: { sessionsDir: "Z:/isolated/sessions", plainWorkspace: "Z:/isolated/workspace" },
  note: vi.fn(),
};
const session: SessionSummary = {
  id: "one",
  createdAt: "2026-11-15T00:00:00Z",
  cwd: "Z:/project",
  workspaceRoot: "Z:/project",
  model: { provider: "test", model: "test" },
  mtimeMs: 123,
  firstText: "标题",
  archivedAt: "2026-11-15T01:00:00Z",
  schedule: { taskId: "task", scheduledAt: "2026-11-15T00:00:00Z", trigger: "manual" },
  client: { kind: "agent", name: "agent", deviceId: "device" },
  locked: true,
  openHere: true,
};
const storage = () => localStorage;
beforeEach(() => {
  localStorage.clear();
  host.note.mockClear();
});

it("只保存展示白名单与目录标识，顺序原样保留，丢弃实时锁与模型配置", () => {
  writeSessionsCache(storage, host, [session, { ...session, id: "two" }]);
  const raw = localStorage.getItem(SESSIONS_CACHE_KEY) ?? "";
  expect(raw).not.toMatch(/locked|openHere|workspaceRoot|model/);
  expect(raw).toContain('"sessionsDir":"Z:/isolated/sessions"');
  const result = readSessionsCache(storage, host);
  expect(result?.map((s) => s.id)).toEqual(["one", "two"]);
  expect(result?.[0]).toEqual({
    id: session.id,
    createdAt: session.createdAt,
    cwd: session.cwd,
    mtimeMs: session.mtimeMs,
    firstText: session.firstText,
    archivedAt: session.archivedAt,
    schedule: session.schedule,
    client: session.client,
  });
});

it.each([
  "{broken",
  JSON.stringify({ version: 2, sessionsDir: host.sessionPaths.sessionsDir, sessions: [] }),
  JSON.stringify({ version: 1, sessionsDir: "Z:/other/sessions", sessions: [] }),
  JSON.stringify({ version: 1, sessionsDir: host.sessionPaths.sessionsDir, sessions: [{}] }),
  JSON.stringify({
    version: 1,
    sessionsDir: host.sessionPaths.sessionsDir,
    sessions: [session, session],
  }),
  JSON.stringify({
    version: 1,
    sessionsDir: host.sessionPaths.sessionsDir,
    sessions: [{ ...session, schedule: {} }],
  }),
])("损坏、版本或标识不符时忽略且只记诊断：%s", (raw) => {
  localStorage.setItem(SESSIONS_CACHE_KEY, raw);
  expect(readSessionsCache(storage, host)).toBeUndefined();
  expect(host.note).toHaveBeenCalledOnce();
});

it("缺少外壳标识时不读写缓存；Windows 目录比较归并大小写与分隔符", () => {
  writeSessionsCache(storage, host, [session]);
  expect(readSessionsCache(storage, { note: host.note })).toBeUndefined();
  writeSessionsCache(storage, { note: host.note }, []);
  expect(
    readSessionsCache(storage, {
      ...host,
      sessionPaths: { ...host.sessionPaths, sessionsDir: "z:\\isolated\\sessions\\" },
    }),
  ).toHaveLength(1);
});

it("localStorage 属性访问、读取和配额写入失败都静默降级", () => {
  const denied = () => {
    throw new Error("denied");
  };
  expect(readSessionsCache(denied, host)).toBeUndefined();
  expect(() => writeSessionsCache(denied, host, [session])).not.toThrow();
  const failing = () => ({ getItem: denied, setItem: denied }) as unknown as Storage;
  expect(readSessionsCache(failing, host)).toBeUndefined();
  expect(() => writeSessionsCache(failing, host, [session])).not.toThrow();
  expect(host.note).toHaveBeenCalledTimes(4);
});
