import type { ChildProcess } from "node:child_process";

interface ProcessHandle {
  readonly pid?: number;
  exited?(): Promise<unknown>;
  kill(): Promise<void>;
  detachOutput?(): void;
}
export function killPidTree(pid: number): Promise<void>;
export function removeTempDirs(directories: Iterable<string>): Promise<void>;
export function createProcessCleanup(): {
  track<T extends ProcessHandle>(proc: T): T;
  trackChild<T extends ChildProcess>(proc: T): T;
  trackPid(pid: number): void;
  watchPidFile(file: string): void;
  wrap<T extends object>(runner: T): T;
  platform<T extends { readonly process: object }>(platform: T): T;
  cleanup(): Promise<void>;
};
