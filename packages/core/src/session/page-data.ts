import { randomUUID } from "node:crypto";
import { fsErrorCode, type Platform } from "../platform/index.js";
import { deriveSessionPages, type SessionPage } from "../protocol/index.js";
import { SessionError } from "./errors.js";
import type { Session } from "./types.js";

const MAX_PAGE_DATA_BYTES = 1024 * 1024;
const SAFE_PAGE_ID = /^(?:page-\d+|legacy-[A-Za-z0-9._-]+)$/u;

export function requireSessionPage(session: Session, page: string): SessionPage {
  const found = SAFE_PAGE_ID.test(page)
    ? deriveSessionPages(session.durableEvents()).find((item) => item.page === page)
    : undefined;
  if (!found) throw new SessionError("page_not_found", "本会话没有该页面的有效版本");
  return found;
}

export function pageDataDir(platform: Platform, sessionsDir: string, sessionId: string): string {
  return platform.paths.join(sessionsDir, "attachments", sessionId, "page-data");
}

async function statIfPresent(platform: Platform, path: string) {
  return platform.fs.lstat(path).catch((error: unknown) => {
    if (fsErrorCode(error) !== "ENOENT") throw error;
    return undefined;
  });
}

async function existingPageDataDir(platform: Platform, dir: string): Promise<boolean> {
  const parent = platform.paths.dirname(dir);
  for (const path of [platform.paths.dirname(parent), parent, dir]) {
    const stat = await statIfPresent(platform, path);
    if (!stat) return false;
    if (stat.type !== "directory") {
      throw new SessionError("page_storage_failed", "页面数据目录必须是普通目录");
    }
  }
  return true;
}

export async function prunePageData(
  platform: Platform,
  sessionsDir: string,
  sessionId: string,
  keptPages: ReadonlySet<string>,
): Promise<void> {
  const dir = pageDataDir(platform, sessionsDir, sessionId);
  if (!(await existingPageDataDir(platform, dir))) return;
  for (const entry of await platform.fs.readdir(dir)) {
    if (!entry.name.endsWith(".json") || keptPages.has(entry.name.slice(0, -5))) continue;
    await platform.fs.unlink(entry.path);
  }
}

/**
 * 跨会话接着改时复制单个页面的数据文件（ADR-0111、ADR-0114 §5）：
 * 源页面无数据文件时静默返回；有数据时原子写入目标页面文件，之后两边各写各的。
 */
export async function copyPageDataFile(
  platform: Platform,
  sessionsDir: string,
  fromSessionId: string,
  fromPage: string,
  toSessionId: string,
  toPage: string,
): Promise<void> {
  if (!SAFE_PAGE_ID.test(fromPage) || !SAFE_PAGE_ID.test(toPage)) {
    throw new SessionError("page_storage_failed", "页面标识无效");
  }
  const srcDir = pageDataDir(platform, sessionsDir, fromSessionId);
  if (!(await existingPageDataDir(platform, srcDir))) return;
  const srcFile = platform.paths.join(srcDir, `${fromPage}.json`);
  const stat = await statIfPresent(platform, srcFile);
  if (!stat) return;
  if (stat.type !== "file" || stat.size > MAX_PAGE_DATA_BYTES) {
    throw new SessionError("page_storage_failed", "源页面数据文件无效");
  }
  const bytes = await platform.fs.readFile(srcFile);
  const dstDir = pageDataDir(platform, sessionsDir, toSessionId);
  await platform.fs.mkdir(dstDir);
  const dstFile = platform.paths.join(dstDir, `${toPage}.json`);
  const temp = `${dstFile}.tmp-${randomUUID()}`;
  try {
    await platform.fs.createExclusive(temp, bytes);
    await platform.fs.rename(temp, dstFile);
  } catch (error) {
    await platform.fs.unlink(temp).catch(() => undefined);
    throw error;
  }
}

function validateKey(key: string): void {
  if (typeof key !== "string" || key === "" || Array.from(key).length > 200) {
    throw new SessionError("invalid_command", "页面数据键必须包含 1 至 200 个字符");
  }
}

function jsonValue(value: unknown): unknown {
  try {
    const json = JSON.stringify(value) as string | undefined;
    if (json === undefined) throw new TypeError("Missing JSON value");
    return JSON.parse(json) as unknown;
  } catch (cause) {
    throw new SessionError("invalid_command", "页面数据值必须能序列化为 JSON", { cause });
  }
}

export function createPageStorage(platform: Platform, sessionsDir: string, session: Session) {
  const { fs, paths } = platform;
  const dir = pageDataDir(platform, sessionsDir, session.id);
  const tails = new Map<string, Promise<void>>();

  async function read(file: string): Promise<Map<string, unknown>> {
    if (!(await existingPageDataDir(platform, dir))) return new Map();
    const stat = await statIfPresent(platform, file);
    if (!stat) return new Map();
    if (stat.type !== "file" || stat.size > MAX_PAGE_DATA_BYTES) {
      throw new SessionError("page_storage_failed", "页面数据文件无效");
    }
    const data = JSON.parse(await fs.readTextFile(file)) as {
      version?: unknown;
      entries?: Record<string, unknown>;
    } | null;
    if (
      data?.version !== 1 ||
      !data.entries ||
      Array.isArray(data.entries) ||
      typeof data.entries !== "object"
    ) {
      throw new SessionError("page_storage_failed", "页面数据文件格式无效");
    }
    return new Map(Object.entries(data.entries));
  }

  async function write(file: string, entries: Map<string, unknown>): Promise<void> {
    const text = JSON.stringify({ version: 1, entries: Object.fromEntries(entries) });
    if (Buffer.byteLength(text) > MAX_PAGE_DATA_BYTES) {
      throw new SessionError("page_storage_full", "页面数据不能超过 1 MiB");
    }
    await fs.mkdir(dir);
    const temp = `${file}.tmp-${randomUUID()}`;
    try {
      await fs.createExclusive(temp, text);
      await fs.rename(temp, file);
    } catch (error) {
      await fs.unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  function run<T>(
    page: string,
    operation: (entries: Map<string, unknown>, file: string) => T | Promise<T>,
  ): Promise<T> {
    const current = (tails.get(page) ?? Promise.resolve()).then(async () => {
      requireSessionPage(session, page);
      const file = paths.join(dir, `${page}.json`);
      try {
        return await operation(await read(file), file);
      } catch (cause) {
        if (cause instanceof SessionError) throw cause;
        throw new SessionError("page_storage_failed", "无法访问页面数据", { cause });
      }
    });
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    tails.set(page, tail);
    void tail.then(() => {
      if (tails.get(page) === tail) tails.delete(page);
    });
    return current;
  }

  return {
    get: async (page: string, key: string) => {
      validateKey(key);
      return run(page, (entries) => entries.get(key));
    },
    set: async (page: string, key: string, value: unknown) => {
      validateKey(key);
      const normalized = jsonValue(value);
      await run(page, (entries, file) => write(file, entries.set(key, normalized)));
    },
    delete: async (page: string, key: string) => {
      validateKey(key);
      await run(page, async (entries, file) => {
        if (entries.delete(key)) await write(file, entries);
      });
    },
    keys: (page: string) => run(page, (entries) => [...entries.keys()]),
    drain: () => Promise.all(tails.values()),
  };
}
