export interface RawChangelogEntry {
  version: string;
  notes: string;
}

export interface ChangelogEntry {
  version: string;
  notes: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 解析 latest.json 的 changelog 字段：每项必须有字符串 version 与 notes，不合格项丢弃；
 * 字段缺失或非数组时返回空数组。
 */
export function parseRawChangelog(raw: unknown): RawChangelogEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: RawChangelogEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (typeof item.version === "string" && item.version !== "" && typeof item.notes === "string") {
      entries.push({ version: item.version, notes: item.notes });
    }
  }
  return entries;
}

/** 解析 prefs.pendingUpdate 里的 changelog 字段；字段缺失或非数组返回 undefined（旧格式兼容）。 */
export function parseStoredChangelog(raw: unknown): ChangelogEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const entries: ChangelogEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    if (
      typeof item.version === "string" &&
      item.version !== "" &&
      (typeof item.notes === "string" || item.notes === null)
    ) {
      entries.push({ version: item.version, notes: item.notes });
    }
  }
  return entries;
}

/** semver 比较：a<b→负数；无预发布号的版本大于同基线的预发布版（0.6.0 > 0.6.0-rc.1） */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    if (match === null) return undefined;
    return {
      nums: [Number(match[1]), Number(match[2]), Number(match[3])],
      pre: match[4],
    };
  };
  const va = parse(a);
  const vb = parse(b);
  if (va === undefined || vb === undefined) return a === b ? 0 : a < b ? -1 : 1;
  for (let i = 0; i < 3; i += 1) {
    const xa = va.nums[i] ?? 0;
    const xb = vb.nums[i] ?? 0;
    if (xa !== xb) return xa - xb;
  }
  if (va.pre === vb.pre) return 0;
  if (va.pre === undefined) return 1;
  if (vb.pre === undefined) return -1;
  const pa = va.pre.split(".");
  const pb = vb.pre.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const xa = pa[i];
    const xb = pb[i];
    if (xa === undefined) return -1;
    if (xb === undefined) return 1;
    const na = Number(xa);
    const nb = Number(xb);
    const aNum = xa !== "" && Number.isInteger(na);
    const bNum = xb !== "" && Number.isInteger(nb);
    if (aNum && bNum) {
      if (na !== nb) return na - nb;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1; // semver：数字标识符比字母小
    } else if (xa !== xb) {
      return xa < xb ? -1 : 1;
    }
  }
  return 0;
}
