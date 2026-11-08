import { compareVersions } from "../../desktop/src/versions";

const RELEASE = "https://api.github.com/repos/kanzaki-chiya/Nocturne/releases/latest";
const TAG_RELEASE = "https://api.github.com/repos/kanzaki-chiya/Nocturne/releases/tags/v";
const DOWNLOAD = "https://github.com/kanzaki-chiya/Nocturne/releases/download/";
const CACHE = "nocturne.android.update";
const DISMISSED = "nocturne.android.update.dismissed";
const INTERVAL = 24 * 60 * 60 * 1000;
const MISSING_TTL = 60 * 60 * 1000;

/** 两个来源只接受正式的三段版本，GitHub 标签另外允许一个 v 前缀。 */
function stable(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
}

/** 校验 GitHub Release JSON 是否为非预发布、非草稿且包含对应 APK 资产的正式版本。 */
function parseApkRelease(release: unknown, expectedVersion?: string): string | undefined {
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
  if (expectedVersion !== undefined && version !== expectedVersion) return undefined;
  const apk = release.assets.some(
    (asset: unknown) =>
      asset !== null &&
      typeof asset === "object" &&
      "name" in asset &&
      asset.name === `nocturne-${version}.apk`,
  );
  return stable(version) &&
    apk &&
    !("prerelease" in release && release.prerelease === true) &&
    !("draft" in release && release.draft === true)
    ? version
    : undefined;
}

type TagRecord = { status: "present" } | { status: "missing"; at: number } | { status: "unknown" };

export class AndroidUpdate {
  state: "idle" | "checking" | "latest" | "error" = "idle";
  private github: string | undefined;
  private desktop: string | undefined;
  private last: number | undefined;
  private dismissed: string | undefined;
  private pending: Promise<void> | undefined;
  private manualTagTask: Promise<void> = Promise.resolve();
  private manualPending = false;
  private tagRecords = new Map<string, TagRecord>();
  private tagPending = new Map<string, Promise<void>>();
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
  private needsTagVerify(version: string | undefined): version is string {
    return (
      stable(version) &&
      compareVersions(version, this.options.version) > 0 &&
      (!this.github || compareVersions(version, this.github) > 0)
    );
  }
  private get verifiedDesktop(): string | undefined {
    const v = this.desktop;
    if (!stable(v) || compareVersions(v, this.options.version) <= 0) return undefined;
    if (this.github && compareVersions(v, this.github) <= 0) return v;
    if (this.tagPending.has(v)) return undefined;
    const record = this.tagRecords.get(v);
    if (!record || record.status === "missing") return undefined;
    return v;
  }
  get version(): string | undefined {
    return [this.github, this.verifiedDesktop]
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
    if (this.needsTagVerify(this.desktop)) {
      void this.verifyTag(this.desktop, false);
    }
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
      if (this.needsTagVerify(this.desktop)) {
        this.manualTagTask = this.verifyTag(this.desktop, true);
      }
      this.changed();
    }
    if (this.pending) return this.pending;
    const elapsed = this.last === undefined ? undefined : this.now() - this.last;
    if (!manual && elapsed !== undefined && elapsed >= 0 && elapsed < INTERVAL)
      return Promise.resolve();
    this.pending = this.request().finally(() => {
      this.pending = undefined;
      this.manualPending = false;
      this.manualTagTask = Promise.resolve();
    });
    return this.pending;
  }
  private verifyTag(version: string, force: boolean): Promise<void> {
    const existing = this.tagPending.get(version);
    if (existing) return existing;
    const record = this.tagRecords.get(version);
    if (!force && record) {
      if (record.status === "present") return Promise.resolve();
      if (record.status === "missing") {
        const elapsed = this.now() - record.at;
        if (elapsed >= 0 && elapsed < MISSING_TTL) return Promise.resolve();
      }
    }
    if (record?.status === "unknown") this.tagRecords.delete(version);
    let task: Promise<void>;
    const settle = (next: TagRecord) => {
      this.tagRecords.set(version, next);
      this.tagPending.delete(version);
      this.changed();
    };
    const handleResponse = (response: Response): Promise<void> | void => {
      if (response.status === 404) {
        settle({ status: "missing", at: this.now() });
        return;
      }
      if (!response.ok) {
        settle({ status: "unknown" });
        return;
      }
      let jsonRes: unknown;
      try {
        jsonRes = response.json();
      } catch {
        settle({ status: "unknown" });
        return;
      }
      if (
        jsonRes &&
        typeof jsonRes === "object" &&
        "then" in jsonRes &&
        typeof jsonRes.then === "function"
      ) {
        return Promise.resolve(
          (jsonRes as PromiseLike<unknown>).then(
            (release) => {
              try {
                const matched = parseApkRelease(release, version);
                settle(matched ? { status: "present" } : { status: "missing", at: this.now() });
              } catch {
                settle({ status: "unknown" });
              }
            },
            () => {
              settle({ status: "unknown" });
            },
          ),
        );
      }
      try {
        const matched = parseApkRelease(jsonRes, version);
        settle(matched ? { status: "present" } : { status: "missing", at: this.now() });
      } catch {
        settle({ status: "unknown" });
      }
      return;
    };
    try {
      const fetchRes: unknown = this.fetch(`${TAG_RELEASE}${version}`, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(15000),
      });
      if (
        fetchRes &&
        typeof fetchRes === "object" &&
        "then" in fetchRes &&
        typeof fetchRes.then === "function"
      ) {
        task = Promise.resolve(
          (fetchRes as PromiseLike<Response>).then(handleResponse, () => {
            settle({ status: "unknown" });
          }),
        );
      } else {
        task = Promise.resolve(handleResponse(fetchRes as Response));
      }
    } catch {
      settle({ status: "unknown" });
      return Promise.resolve();
    }
    if (this.tagRecords.get(version) === undefined) {
      this.tagPending.set(version, task);
      this.changed();
    }
    return task;
  }
  private async request(): Promise<void> {
    let ok = false;
    try {
      const response = await this.fetch(RELEASE, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("Release request failed");
      const release: unknown = await response.json();
      this.github = parseApkRelease(release);
      this.last = this.now();
      try {
        this.storage.setItem(CACHE, JSON.stringify({ at: this.last, version: this.github }));
      } catch {
        /* 本次仍节流 */
      }
      ok = true;
    } catch {
      ok = false;
    }
    await this.manualTagTask;
    if (ok) this.state = "latest";
    else if (this.manualPending) this.state = "error";
    this.changed();
  }
}
