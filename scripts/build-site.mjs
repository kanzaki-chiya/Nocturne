#!/usr/bin/env node
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "https://github.com/kanzaki-chiya/Nocturne";
const SITE_ORIGIN = "https://nocturne.koxia.cn";

const escapeHtml = (text) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

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

/** Generate a stable heading id preserving CJK characters and deduplicating collisions. */
export function slugifyHeading(text, seen = new Map()) {
  const plain = text
    .replace(/<[^>]*>/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .trim()
    .toLowerCase();
  const base = plain.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "section";
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

function pageHref(fromSlug, toSlug) {
  if (fromSlug === "") {
    return toSlug === "" ? "./" : `${toSlug}/`;
  }
  return toSlug === "" ? "../" : `../${toSlug}/`;
}

function resolveDocLink(href, fromSlug, knownFiles) {
  if (/^(?:https?:|mailto:|#)/.test(href)) return href;
  const match = /^(?:\.\/)?([a-z0-9-]+)\.md(#.*)?$/i.exec(href);
  if (!match) return href;
  const targetName = match[1].toLowerCase();
  const hash = match[2] ?? "";
  if (!knownFiles.has(`${targetName}.md`)) {
    throw new Error(`Broken doc link "${href}" (target "${targetName}.md" is not in nav.json)`);
  }
  const targetSlug = targetName === "index" ? "" : targetName;
  if (targetSlug === fromSlug && hash) return hash;
  return `${pageHref(fromSlug, targetSlug)}${hash}`;
}

function assertNoRawHtml(tokens, file) {
  for (const token of tokens) {
    if (token.type === "html") {
      throw new Error(`Raw HTML is not allowed in ${file}: ${token.raw.trim()}`);
    }
    if (Array.isArray(token.tokens)) assertNoRawHtml(token.tokens, file);
    if (Array.isArray(token.items)) {
      for (const item of token.items) {
        if (Array.isArray(item.tokens)) assertNoRawHtml(item.tokens, file);
      }
    }
    if (Array.isArray(token.header)) {
      for (const cell of token.header) {
        if (Array.isArray(cell.tokens)) assertNoRawHtml(cell.tokens, file);
      }
    }
    if (Array.isArray(token.rows)) {
      for (const row of token.rows) {
        for (const cell of row) {
          if (Array.isArray(cell.tokens)) assertNoRawHtml(cell.tokens, file);
        }
      }
    }
  }
}

export function renderDocMarkdown(
  markdown,
  { fromSlug = "", knownFiles = new Set(["index.md"]), file = "doc.md" } = {},
) {
  const firstLine = markdown.split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.startsWith("# ")) {
    throw new Error(`${file} must start with a level-1 heading ("# 标题")`);
  }
  const h1 = firstLine.slice(2).trim();
  const seenIds = new Map();
  const toc = [];
  const marked = new Marked();

  marked.use({
    renderer: {
      heading({ tokens, depth, text }) {
        const inner = this.parser.parseInline(tokens);
        if (depth === 1) {
          return `<h1>${inner}</h1>\n`;
        }
        if (depth === 2 || depth === 3) {
          const id = slugifyHeading(text, seenIds);
          const cleanLabel = text.replace(/`([^`]*)`/g, "$1").trim();
          toc.push({ depth, id, text: cleanLabel });
          return `<h${depth} id="${escapeHtml(id)}">${inner}</h${depth}>\n`;
        }
        return `<h${depth}>${inner}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const resolved = resolveDocLink(href, fromSlug, knownFiles);
        const label = this.parser.parseInline(tokens);
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        return `<a href="${escapeHtml(resolved)}"${titleAttr}>${label}</a>`;
      },
      table(token) {
        let headerCells = "";
        for (const cell of token.header) {
          const align = cell.align ? ` style="text-align:${cell.align}"` : "";
          headerCells += `<th${align}>${this.parser.parseInline(cell.tokens)}</th>`;
        }
        let bodyRows = "";
        for (const row of token.rows) {
          let rowCells = "";
          for (const cell of row) {
            const align = cell.align ? ` style="text-align:${cell.align}"` : "";
            rowCells += `<td${align}>${this.parser.parseInline(cell.tokens)}</td>`;
          }
          bodyRows += `<tr>${rowCells}</tr>\n`;
        }
        const tbody = bodyRows ? `<tbody>\n${bodyRows}</tbody>` : "";
        return `<div class="docs-table-wrap"><table>\n<thead>\n<tr>${headerCells}</tr>\n</thead>\n${tbody}</table></div>\n`;
      },
    },
  });

  const tokens = marked.lexer(markdown);
  assertNoRawHtml(tokens, file);
  const body = marked.parser(tokens);
  return { h1, body, toc };
}

async function buildDocs(root, out, version) {
  const docsDir = join(root, "site-docs");
  const navRaw = JSON.parse(await readFile(join(docsDir, "nav.json"), "utf8"));
  if (!Array.isArray(navRaw) || navRaw.length === 0) {
    throw new Error("site-docs/nav.json must be a non-empty array of groups");
  }

  const template = await readFile(join(docsDir, "template.html"), "utf8");
  const entries = await readdir(docsDir, { withFileTypes: true });
  const actualMdFiles = new Set(
    entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name),
  );

  const flatPages = [];
  const expectedMdFiles = new Set();

  for (const group of navRaw) {
    if (
      typeof group?.group !== "string" ||
      !Array.isArray(group?.pages) ||
      group.pages.length === 0
    ) {
      throw new Error("Each group in site-docs/nav.json must have a group title and pages array");
    }
    for (const page of group.pages) {
      if (typeof page?.slug !== "string" || typeof page?.title !== "string") {
        throw new Error("Each page in site-docs/nav.json must have string slug and title");
      }
      if (page.slug !== "" && !/^[a-z0-9-]+$/.test(page.slug)) {
        throw new Error(`Invalid doc slug "${page.slug}" in site-docs/nav.json`);
      }
      const mdFile = page.slug === "" ? "index.md" : `${page.slug}.md`;
      if (expectedMdFiles.has(mdFile)) {
        throw new Error(`Duplicate page "${mdFile}" in site-docs/nav.json`);
      }
      expectedMdFiles.add(mdFile);
      flatPages.push({
        group: group.group,
        slug: page.slug,
        title: page.title,
        mdFile,
      });
    }
  }

  for (const file of expectedMdFiles) {
    if (!actualMdFiles.has(file)) {
      throw new Error(`site-docs/nav.json references missing file site-docs/${file}`);
    }
  }
  for (const file of actualMdFiles) {
    if (!expectedMdFiles.has(file)) {
      throw new Error(`site-docs/${file} is not listed in site-docs/nav.json`);
    }
  }

  for (let i = 0; i < flatPages.length; i++) {
    const page = flatPages[i];
    const mdPath = join(docsDir, page.mdFile);
    const rawMd = (await readFile(mdPath, "utf8")).replaceAll("{{version}}", version);
    const { h1, body, toc } = renderDocMarkdown(rawMd, {
      fromSlug: page.slug,
      knownFiles: expectedMdFiles,
      file: `site-docs/${page.mdFile}`,
    });
    if (h1 !== page.title) {
      throw new Error(
        `Heading mismatch in site-docs/${page.mdFile}: "# ${h1}" !== nav.json title "${page.title}"`,
      );
    }

    const navHtml = navRaw
      .map((group) => {
        const items = group.pages
          .map((item) => {
            const href = pageHref(page.slug, item.slug);
            const current = item.slug === page.slug ? ' aria-current="page"' : "";
            return `<li><a href="${href}"${current}>${escapeHtml(item.title)}</a></li>`;
          })
          .join("\n");
        return `<div class="docs-nav-group">\n<p class="docs-nav-title">${escapeHtml(group.group)}</p>\n<ul class="docs-nav-list">\n${items}\n</ul>\n</div>`;
      })
      .join("\n");

    const tocHtml =
      toc.length === 0
        ? ""
        : `<p class="docs-toc-title">本页</p>\n<ul class="docs-toc-list">\n${toc
            .map((entry) => {
              const cls = entry.depth === 3 ? ' class="docs-toc-h3"' : "";
              return `<li${cls}><a href="#${escapeHtml(entry.id)}">${escapeHtml(entry.text)}</a></li>`;
            })
            .join("\n")}\n</ul>`;

    const prev = i > 0 ? flatPages[i - 1] : null;
    const next = i + 1 < flatPages.length ? flatPages[i + 1] : null;
    const prevLink = prev
      ? `<a class="docs-pager-link docs-pager-prev" href="${pageHref(page.slug, prev.slug)}"><span class="docs-pager-dir">上一页</span><span class="docs-pager-title">${escapeHtml(prev.title)}</span></a>`
      : "";
    const nextLink = next
      ? `<a class="docs-pager-link docs-pager-next" href="${pageHref(page.slug, next.slug)}"><span class="docs-pager-dir">下一页</span><span class="docs-pager-title">${escapeHtml(next.title)}</span></a>`
      : "";
    const pagerHtml =
      prevLink || nextLink
        ? `<nav class="docs-pager" aria-label="翻页">\n${prevLink}\n${nextLink}\n</nav>`
        : "";

    const rootPrefix = page.slug === "" ? "../" : "../../";
    const docsRoot = page.slug === "" ? "./" : "../";
    const canonical =
      page.slug === "" ? `${SITE_ORIGIN}/docs/` : `${SITE_ORIGIN}/docs/${page.slug}/`;

    const html = template
      .replaceAll("{{version}}", () => version)
      .replaceAll("{{docs.title}}", () => escapeHtml(page.title))
      .replaceAll("{{docs.group}}", () => escapeHtml(page.group))
      .replaceAll("{{docs.canonical}}", () => canonical)
      .replaceAll("{{docs.root}}", () => rootPrefix)
      .replaceAll("{{docs.docsRoot}}", () => docsRoot)
      .replaceAll("{{docs.nav}}", () => navHtml)
      .replaceAll("{{docs.body}}", () => body)
      .replaceAll("{{docs.toc}}", () => tocHtml)
      .replaceAll("{{docs.pager}}", () => pagerHtml);

    const outDir = page.slug === "" ? join(out, "docs") : join(out, "docs", page.slug);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "index.html"), html);
  }
}

export async function buildSite(root = ROOT, out = join(root, "dist-site")) {
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) {
    throw new Error("package.json must contain a valid version");
  }
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(join(root, "site"), out, { recursive: true });
  await buildDocs(root, out, version);
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
