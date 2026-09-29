/** 只对已读文本做有界提示；绝不参与替换。 */
export function diagnoseNoMatch(text: string, old: string): string {
  const fallback = "请重新 read 并提供精确的 old";
  if (text.length > 100_000 || old.length > 4_000) return fallback;
  const lines = text.split(/\r\n|\n|\r/);
  const wanted = old.split(/\r\n|\n|\r/);
  if (lines.length > 2_000 || wanted.length > 40) return fallback;

  const modes: { name: string; normalize: (s: string) => string }[] = [
    { name: "换行符", normalize: (s) => s.replace(/\r\n|\r/g, "\n") },
    { name: "缩进", normalize: (s) => s.replace(/^[ \t]+/gm, "") },
    { name: "空白", normalize: (s) => s.replace(/\s+/g, "") },
  ];
  for (const mode of modes) {
    const needle = mode.normalize(old);
    if (needle === "") continue;
    for (let i = 0; i < lines.length; i++) {
      const slice = lines.slice(i, i + wanted.length).join("\n");
      if (mode.normalize(slice).includes(needle)) {
        return `${i + 1} 行附近的${mode.name}不同；请按文件原文提供精确的 old`;
      }
    }
  }

  const target = old.replace(/\s+/g, " ").trim().slice(0, 300);
  if (target.length < 3) return "找不到相近片段；" + fallback;
  const grams = (s: string): Set<string> =>
    new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  const wantedGrams = grams(target);
  let best = { score: 0, start: -1, count: 0 };
  for (let i = 0; i < lines.length; i++) {
    const count = Math.min(wanted.length, 5, lines.length - i);
    const candidate = lines
      .slice(i, i + count)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (candidate.length > 500 || candidate.length === 0) continue;
    const found = grams(candidate);
    let common = 0;
    for (const gram of wantedGrams) if (found.has(gram)) common++;
    const score = (2 * common) / (wantedGrams.size + found.size);
    if (score > best.score) best = { score, start: i, count };
  }
  if (best.score < 0.55 || best.start < 0) return "找不到相近片段；" + fallback;
  const excerpt = lines
    .slice(best.start, best.start + best.count)
    .map((line, i) => `${best.start + i + 1}: ${line.slice(0, 160)}`)
    .join("\n");
  return `相近片段：\n${excerpt}\n请按文件原文提供精确的 old`;
}
