/**
 * Codex 插件生效版本选择与 SemVer 2.0 解析比较（不引第三方依赖）。
 * 对齐 openai/codex `codex-rs/core-plugin-common/src/installed.rs` 的 `active_plugin_version`。
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[];
}

const VALID_DIR_NAME = /^[A-Za-z0-9.+_-]+$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isValidPluginVersionDirName(name: string): boolean {
  return name !== "." && name !== ".." && VALID_DIR_NAME.test(name);
}

export function parseSemver(raw: string): SemVer | undefined {
  const m = SEMVER_RE.exec(raw);
  if (!m) return undefined;
  const prereleaseRaw = m[4];
  const prerelease = prereleaseRaw !== undefined ? prereleaseRaw.split(".") : [];
  for (const id of prerelease) {
    if (/^\d+$/.test(id) && id.length > 1 && id.startsWith("0")) {
      return undefined;
    }
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease,
  };
}

export function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  const ap = a.prerelease;
  const bp = b.prerelease;
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1;
  if (bp.length === 0) return -1;
  const len = Math.min(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const ai = ap[i];
    const bi = bp[i];
    if (ai === undefined || bi === undefined || ai === bi) continue;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const av = BigInt(ai);
      const bv = BigInt(bi);
      return av < bv ? -1 : 1;
    }
    if (aNum !== bNum) return aNum ? -1 : 1;
    return ai < bi ? -1 : 1;
  }
  if (ap.length === bp.length) return 0;
  return ap.length < bp.length ? -1 : 1;
}

export function comparePluginVersions(a: string, b: string): number {
  const sa = parseSemver(a);
  const sb = parseSemver(b);
  if (sa !== undefined && sb !== undefined) return compareSemver(sa, sb);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * 从 `plugins/cache/<marketplace>/<name>/` 下的子目录选出生效版本：
 * 1. 只保留合法子目录名（ASCII 字母、数字、. + _ -，排除 . 与 ..）；
 * 2. 存在 `local` 时直接选 `local`；
 * 3. 否则按 Codex 规则取最大值（双 SemVer 按 SemVer 比，否则按字符串比）。
 */
export function selectActivePluginVersion(
  entries: readonly { name: string; type: string }[],
): string | undefined {
  const candidates = entries
    .filter((e) => e.type === "directory" && isValidPluginVersionDirName(e.name))
    .map((e) => e.name);
  if (candidates.length === 0) return undefined;
  if (candidates.includes("local")) return "local";
  let best = candidates[0];
  if (best === undefined) return undefined;
  for (let i = 1; i < candidates.length; i++) {
    const next = candidates[i];
    if (next !== undefined && comparePluginVersions(best, next) < 0) best = next;
  }
  return best;
}
