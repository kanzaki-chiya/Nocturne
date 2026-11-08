import { compareVersions } from "../../desktop/src/versions";

const RELEASE = "https://api.github.com/repos/kanzaki-chiya/Nocturne/releases/latest";
const DOWNLOAD = "https://github.com/kanzaki-chiya/Nocturne/releases/download/";
const CACHE = "nocturne.android.update";
const DISMISSED = "nocturne.android.update.dismissed";
const INTERVAL = 24 * 60 * 60 * 1000;

/** 两个来源只接受正式的三段版本，GitHub 标签另外允许一个 v 前缀。 */
function stable(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

export class AndroidUpdate {
  state: "idle" | "checking" | "latest" | "error" = "idle";
  private github: string | undefined;
  private desktop: string | undefined;
  private last: number | undefined;
  private dismissed: string | undefined;
  private pending: Promise<void> | undefined;
  private manualPending = false;
  private listeners = new Set<() => void>();
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly storage: Pick<Storage, "getItem" | "setItem">;

  constructor(
    private readonly options: {
      version: string;
      fetch?: typeof globalThis.fetch;
      now?: () => number;
      storage?: Pick<Storage, "getItem" | "setItem">;
    },
  ) {
    this.fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.now = options.now ?? Date.now;
    this.storage = options.storage ?? localStorage;
    try {
      const cached = JSON.parse(this.storage.getItem(CACHE) ?? "null") as {
        at?: unknown;
        version?: unknown;
      } | null;
      if (typeof cached?.at === "number" && Number.isFinite(cached.at)) this.last = cached.at;
      if (stable(cached?.version)) this.github = cached.version;
      const dismissed = this.storage.getItem(DISMISSED);
      if (stable(dismissed)) this.dismissed = dismissed;
    } catch {
      /* 存储不可用不影响当前运行 */
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private changed() {
    for (const listener of this.listeners) listener();
  }
  get version(): string | undefined {
    return [this.github, this.desktop]
      .filter((v): v is string => stable(v) && compareVersions(v, this.options.version) > 0)
      .sort(compareVersions)
      .at(-1);
  }
  get notice(): string | undefined {
    const version = this.version;
    return version && (!this.dismissed || compareVersions(version, this.dismissed) > 0)
      ? version
      : undefined;
  }
  computer(version: string | undefined): void {
    this.desktop = stable(version) ? version : undefined;
    this.changed();
  }
  dismiss(): void {
    this.dismissed = this.version;
    try {
      if (this.dismissed) this.storage.setItem(DISMISSED, this.dismissed);
    } catch {
      /* 本次仍生效 */
    }
    this.changed();
  }
  url(version: string): string {
    if (!stable(version)) throw new Error("Invalid version");
    return `${DOWNLOAD}v${version}/nocturne-${version}.apk`;
  }
  check(manual = false): Promise<void> {
    if (manual) {
      this.manualPending = true;
      this.state = "checking";
      this.changed();
    }
    if (this.pending) return this.pending;
    const elapsed = this.last === undefined ? undefined : this.now() - this.last;
    if (!manual && elapsed !== undefined && elapsed >= 0 && elapsed < INTERVAL)
      return Promise.resolve();
    this.pending = this.request().finally(() => {
      this.pending = undefined;
      this.manualPending = false;
    });
    return this.pending;
  }
  private async request(): Promise<void> {
    try {
      const response = await this.fetch(RELEASE, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("Release request failed");
      const release: unknown = await response.json();
      if (
        !release ||
        typeof release !== "object" ||
        !("tag_name" in release) ||
        typeof release.tag_name !== "string" ||
        !("assets" in release) ||
        !Array.isArray(release.assets)
      )
        throw new Error("Invalid release");
      const version = release.tag_name.replace(/^v/, "");
      const apk = release.assets.some(
        (asset: unknown) =>
          asset !== null &&
          typeof asset === "object" &&
          "name" in asset &&
          asset.name === `nocturne-${version}.apk`,
      );
      this.github =
        stable(version) && apk && !("prerelease" in release && release.prerelease === true)
          ? version
          : undefined;
      this.last = this.now();
      try {
        this.storage.setItem(CACHE, JSON.stringify({ at: this.last, version: this.github }));
      } catch {
        /* 本次仍节流 */
      }
      this.state = "latest";
    } catch {
      if (this.manualPending) this.state = "error";
    }
    this.changed();
  }
}
