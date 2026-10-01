/** ADR-0037：百分比相对可用输入预算，绝对值按 token 计。 */
export type CompactionThreshold = string | number;

export function parseCompactionThreshold(input: CompactionThreshold): {
  unit: "percent" | "tokens";
  value: number;
} {
  if (typeof input === "string") {
    const match = /^(\d+(?:\.\d+)?)(%|[km])?$/iu.exec(input);
    if (match) {
      const number = Number(match[1]);
      const suffix = match[2]?.toLowerCase();
      if (suffix === "%" && number > 0 && number <= 100) return { unit: "percent", value: number };
      if (suffix !== "%") {
        const value = number * (suffix === "k" ? 1000 : suffix === "m" ? 1000000 : 1);
        if (Number.isSafeInteger(value) && value > 0) return { unit: "tokens", value };
      }
    }
  } else if (Number.isSafeInteger(input) && input > 0) {
    return { unit: "tokens", value: input };
  }
  throw new TypeError("压缩阈值须为 (0, 100%] 的百分比或正整数 token（支持 k/m）");
}
