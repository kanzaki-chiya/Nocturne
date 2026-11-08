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
