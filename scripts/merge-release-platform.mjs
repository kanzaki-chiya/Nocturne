import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function mergeReleasePlatform(latest, entry) {
  if (!latest.version || latest.version !== entry.version) throw new Error("更新清单版本不一致");
  if (!entry.signature || !entry.url || !entry.platform) throw new Error("平台条目不完整");
  return {
    ...latest,
    platforms: {
      ...latest.platforms,
      [entry.platform]: { signature: entry.signature, url: entry.url },
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [latest, entry] = process.argv.slice(2);
  const parse = (file) => JSON.parse(readFileSync(file, "utf8"));
  const merged = mergeReleasePlatform(parse(latest), parse(entry));
  writeFileSync(latest, `${JSON.stringify(merged, null, 2)}\n`);
}
