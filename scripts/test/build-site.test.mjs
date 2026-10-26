import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { access, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSite } from "../build-site.mjs";
import { headingCharacters } from "../subset-site-font.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let out;
let pages;
let version;
beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "nocturne-site-test-"));
  ({ version } = await buildSite(ROOT, out));
  pages = await Promise.all(
    ["index.html", "en/index.html"].map((file) => readFile(join(out, file), "utf8")),
  );
});
afterAll(async () => {
  await rm(out, { recursive: true, force: true });
});

describe("static homepage", () => {
  it("replaces every placeholder with the root package version", async () => {
    expect(version).toBe(JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version);
    for (const html of pages) {
      expect(html).not.toContain("{{");
      expect(html).toContain(`/v${version}/Nocturne_${version}_x64-setup.exe`);
      expect(html).toContain(`npm install -g ./nctrn-${version}.tgz`);
      expect(html).toContain(`v${version}`);
      expect(html).not.toMatch(/<script\b|fonts\.googleapis|fonts\.gstatic/i);
    }
  });
  it("links the two languages to each other", () => {
    expect(pages[0]).toMatch(/href="en\/"[^>]*hreflang="en"/);
    expect(pages[1]).toMatch(/href="\.\.\/"[^>]*hreflang="zh-CN"/);
  });
  it("resolves all HTML and CSS local references, including anchors", async () => {
    async function checkReference(file, ref) {
      if (/^(?:https?:|mailto:|data:|\/\/)/.test(ref)) return;
      const [pathname, hash] = ref.split("#");
      let target = pathname ? resolve(dirname(file), pathname) : file;
      if ((await stat(target)).isDirectory()) target = join(target, "index.html");
      await access(target);
      if (hash && target.endsWith(".html"))
        expect(await readFile(target, "utf8")).toContain(`id="${hash}"`);
    }
    async function walk(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (/\.(html|css)$/.test(file)) {
          const text = await readFile(file, "utf8");
          const pattern = file.endsWith(".html")
            ? /(?:href|src)="([^"]+)"/g
            : /url\(["']?([^\s)"']+)["']?\)/g;
          for (const match of text.matchAll(pattern)) await checkReference(file, match[1]);
        }
      }
    }
    await walk(out);
  });
  it("copies the custom domain", async () => {
    expect(await readFile(join(out, "CNAME"), "utf8")).toBe("nocturne.koxia.cn\n");
  });
  it("keeps the committed font subset in sync with the headings", async () => {
    expect((await readFile(join(out, "assets/fonts/characters.txt"), "utf8")).trim()).toBe(
      (await headingCharacters()).trim(),
    );
  });
});
