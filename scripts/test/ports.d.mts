import type { Server } from "node:net";

export function isFetchBlockedPort(port: number): boolean;
export function listenFetchSafe(server: Server, host?: string): Promise<number>;
export function unusedFetchSafePort(host?: string): Promise<number>;
export function fetchSafeListen(host?: string): Promise<string>;
