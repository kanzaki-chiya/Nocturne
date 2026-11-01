#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "https://github.com/kanzaki-chiya/Nocturne";

const escapeHtml = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function inlineMarkdown(text) {
  return text
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      return escapeHtml(part)
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
          const url = /^https?:/.test(href) ? href : `${REPO}/blob/main/${href}`;
          return `<a href="${url}">${label}</a>`;
        });
    })
    .join("");
}

/** CHANGELOG.md only uses version and group headings, paragraphs and two-level lists. */
export function renderChangelog(markdown) {
  const versions = [];
  const body = [];
  let depth = 0;
  let open = false;
  const closeLists = (to = 0) => {
    while (depth > to) {
      body.push("</li></ul>");
      depth -= 1;
    }
  };
  const closeVersion = () => {
    closeLists();
    if (open) body.push("</section>");
  };
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const item = /^( *)- (.*)$/.exec(line);
    if (line.startsWith("# ")) continue;
    if (line.startsWith("## ")) {
      closeVersion();
      const version = escapeHtml(line.slice(3).trim());
      versions.push(version);
      open = true;
      body.push(
        `<section class="release" id="v${version}">`,
        `<h2><a href="${REPO}/releases/tag/v${version}">${version}</a></h2>`,
      );
    } else if (line.startsWith("### ")) {
      closeLists();
      body.push(`<h3>${inlineMarkdown(line.slice(4))}</h3>`);
    } else if (item !== null) {
      const level = item[1].length >= 2 ? 2 : 1;
      if (level > depth) {
        body.push("<ul>");
        depth += 1;
      } else {
        closeLists(level);
        body.push("</li>");
      }
      body.push(`<li>${inlineMarkdown(item[2])}`);
    } else if (line !== "") {
      closeLists();
      body.push(`<p>${inlineMarkdown(line)}</p>`);
    }
  }
  closeVersion();
  const index = versions.map((version) => `<a href="#v${version}">${version}</a>`).join("");
  return { index, body: body.join("\n") };
}

/** Standalone build: no workspace packages or npm dependencies are needed. */
export async function buildSite(root = ROOT, out = join(root, "dist-site")) {
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) {
    throw new Error("package.json must contain a valid version");
  }
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(join(root, "site"), out, { recursive: true });
  const changelog = renderChangelog(await readFile(join(root, "CHANGELOG.md"), "utf8"));
  async function render(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await render(file);
      else if (entry.name.endsWith(".html")) {
        const template = (await readFile(file, "utf8")).replaceAll("{{version}}", version);
        if (template.replace(/\{\{changelog\.(?:index|body)\}\}/g, "").includes("{{")) {
          throw new Error(`Unresolved placeholder in ${file}`);
        }
        const html = template
          .replaceAll("{{changelog.index}}", () => changelog.index)
          .replaceAll("{{changelog.body}}", () => changelog.body);
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
