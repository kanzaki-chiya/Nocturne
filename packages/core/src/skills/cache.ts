import type { Platform } from "../platform/index.js";
import { discoverSkills } from "./discovery.js";

type Input = Parameters<typeof discoverSkills>[1];
type Result = Awaited<ReturnType<typeof discoverSkills>>;
type Stamp = Awaited<ReturnType<Platform["fs"]["stat"]>> | null;

export function createSkillDiscoveryCache(platform: Platform) {
  const entries = new Map<string, { result: Result; stamps: Map<string, Stamp> }>();
  const scans = new Map<string, Promise<Result>>();
  const stat = async (path: string): Promise<Stamp> => {
    try {
      return await platform.fs.stat(path);
    } catch {
      return null;
    }
  };
  async function scan(key: string, input: Input): Promise<Result> {
    const cached = entries.get(key);
    if (cached) {
      const unchanged = await Promise.all(
        [...cached.stamps].map(async ([path, before]) => {
          const after = await stat(path);
          return (
            before?.mtimeMs === after?.mtimeMs &&
            before?.size === after?.size &&
            before?.type === after?.type
          );
        }),
      );
      if (unchanged.every(Boolean)) return structuredClone(cached.result);
    }
    const watched = new Set<string>();
    const fs: Platform["fs"] = {
      ...platform.fs,
      exists: (path) => {
        watched.add(path);
        return platform.fs.exists(path);
      },
      readdir: (path) => {
        watched.add(path);
        return platform.fs.readdir(path);
      },
      realpath: async (path) => {
        watched.add(path);
        const real = await platform.fs.realpath(path);
        watched.add(real);
        return real;
      },
    };
    const result = await discoverSkills({ ...platform, fs }, input);
    const stamps = new Map(
      await Promise.all([...watched].map(async (path) => [path, await stat(path)] as const)),
    );
    entries.set(key, { result, stamps });
    return structuredClone(result);
  }
  return {
    discover(input: Input): Promise<Result> {
      const key = JSON.stringify([
        platform.homeDir(),
        input.nocturneHome,
        input.workspaceRoot,
        input.cwd,
        input.config?.sources?.agents ?? true,
        input.config?.sources?.claude ?? true,
        input.config?.extraDirs ?? [],
      ]);
      const pending = scans.get(key);
      if (pending) return pending.then((result) => structuredClone(result));
      const promise = scan(key, input).finally(() => {
        scans.delete(key);
      });
      scans.set(key, promise);
      return promise;
    },
  };
}
