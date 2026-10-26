#!/usr/bin/env node
/**
 * Manually rerun after changing headings: node scripts/subset-site-font.mjs
 * Noto Serif CJK 2.003, SC Black; SIL OFL 1.1.
 * Source pinned to the Serif2.003 commit of notofonts/noto-cjk.
 * Original OTF stays in the OS temp directory, never in the repository.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import subsetFont from "subset-font";
import { setGlobalProxyFromEnv } from "node:http";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE =
  "https://raw.githubusercontent.com/notofonts/noto-cjk/9b0f1436e455d902de067a2501422e5dc71ad16b/Serif/SubsetOTF/SC/NotoSerifSC-Black.otf";

export async function headingCharacters(root = ROOT) {
  let text = "0123456789";
  for (const page of ["index.html", "en/index.html"]) {
    const html = await readFile(join(root, "site", page), "utf8");
    for (const match of html.matchAll(
      /<(h[12])\b[^>]*>([\s\S]*?)<\/\1>|<a\b[^>]*class="wordmark"[^>]*>([\s\S]*?)<\/a>/g,
    )) {
      text += (match[2] ?? match[3]).replace(/<[^>]*>/g, "");
    }
  }
  return [...new Set(text)].sort().join("");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setGlobalProxyFromEnv();
  const temp = await mkdtemp(join(tmpdir(), "nocturne-site-font-"));
  try {
    const response = await fetch(SOURCE, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Font download failed: ${response.status}`);
    const original = Buffer.from(await response.arrayBuffer());
    await writeFile(join(temp, "NotoSerifSC-Black.otf"), original);
    const text = await headingCharacters();
    const font = await subsetFont(original, text, { targetFormat: "woff2" });
    const out = join(ROOT, "site/assets/fonts");
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "noto-serif-sc-headings.woff2"), font);
    await writeFile(join(out, "characters.txt"), `${text}\n`);
    console.log(`Noto Serif SC 2.003: ${[...text].length} characters, ${font.length} bytes`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
