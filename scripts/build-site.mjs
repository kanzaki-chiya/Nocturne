#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Standalone build: no workspace packages or npm dependencies are needed. */
export async function buildSite(root = ROOT, out = join(root, "dist-site")) {
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) {
    throw new Error("package.json must contain a valid version");
  }
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(join(root, "site"), out, { recursive: true });
  async function render(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await render(file);
      else if (entry.name.endsWith(".html")) {
        const html = (await readFile(file, "utf8")).replaceAll("{{version}}", version);
        if (html.includes("{{")) throw new Error(`Unresolved placeholder in ${file}`);
        await writeFile(file, html);
      }
    }
  }
  await render(out);
  return { out, version };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version } = await buildSite();
  console.log(`Built site v${version} → dist-site/`);
}
