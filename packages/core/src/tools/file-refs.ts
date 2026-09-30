/** ADR-0033：提交时读取用户指定的文件，返回可以持久化的快照。 */
import type { FileSystem, PathOps } from "../platform/index.js";
import {
  parseFileRefs,
  type ContentBlock,
  type FileRef,
  type ImageAttachment,
} from "../protocol/index.js";
import type { AttachmentStore } from "./attachments.js";
import { GitignoreChain } from "./builtin/gitignore.js";
import { IMAGE_MAX_BYTES, IMAGE_MAX_EDGE, parseImageSize, sniffImageMime } from "./image.js";
import type { ReadStateStore } from "./types.js";
import { isBinary } from "./text.js";

const MESSAGE_LIMIT = 150_000;
const PUNCTUATION = /[，。,.;；:：)）!！?？]+$/u;
const escapeAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

async function directoryEntries(
  fs: FileSystem,
  paths: PathOps,
  root: string,
  dir: string,
): Promise<string[]> {
  // 根目录到目标目录的每一层都参加忽略判定；工作区外则以该目录为根。
  const base = paths.isWithin(root, dir) ? root : dir;
  const relative = paths.relative(base, dir).split(paths.sep).filter(Boolean);
  const chain = new GitignoreChain();
  let current = base;
  for (let i = 0; i <= relative.length; i++) {
    const rel = paths.relative(base, current).split(paths.sep).join("/");
    chain.push(
      rel,
      await fs.readTextFile(paths.join(current, ".gitignore")).catch(() => undefined),
    );
    if (i < relative.length) current = paths.join(current, relative[i] ?? "");
  }
  const entries = await fs.readdir(dir);
  return entries
    .filter((entry) => {
      if (entry.name.startsWith(".") || entry.type === "symlink") return false;
      const rel = paths.relative(base, paths.join(dir, entry.name)).split(paths.sep).join("/");
      return !chain.ignores(rel, entry.type === "directory");
    })
    .map((entry) => entry.name + (entry.type === "directory" ? "/" : ""))
    .sort((a, b) => a.localeCompare(b));
}

export async function resolveFileRefs(
  content: readonly ContentBlock[],
  options: {
    fs: FileSystem;
    paths: PathOps;
    cwd: string;
    workspaceRoot: string;
    readState: ReadStateStore;
    attachments?: AttachmentStore | undefined;
    imageInput: boolean;
    signal: AbortSignal;
  },
): Promise<{
  content: ContentBlock[];
  attachments: ImageAttachment[];
  fileRefs: FileRef[];
  warnings: string[];
}> {
  const { fs, paths } = options;
  const workspaceRoot = paths.normalize(
    await fs.realpath(options.workspaceRoot).catch(() => options.workspaceRoot),
  );
  const blocks: ContentBlock[] = [];
  const attachments: ImageAttachment[] = [];
  const fileRefs: FileRef[] = [];
  const warnings: string[] = [];
  const isAborted = (): boolean => options.signal.aborted;
  const seen = new Set<string>();
  let remaining = MESSAGE_LIMIT;
  for (const block of content) {
    if (block.type !== "text") continue;
    for (const ref of parseFileRefs(block.text)) {
      if (isAborted()) break;
      let display = ref.path;
      let target = paths.resolve(options.cwd, display);
      if (!(await fs.exists(target))) {
        display = display.replace(PUNCTUATION, "");
        target = paths.resolve(options.cwd, display);
        if (display === ref.path || !(await fs.exists(target))) continue;
      }
      const resolved = await fs.realpath(target).catch(() => undefined);
      const real = resolved === undefined ? undefined : paths.normalize(resolved);
      if (real === undefined) continue;
      const key = paths.canonicalize(real);
      if (seen.has(key)) continue;
      seen.add(key);
      const stat = await fs.stat(real).catch(() => undefined);
      if (stat === undefined) continue;
      const warning = (message: string): void => {
        warnings.push(`@${display}：${message}`);
      };
      if (remaining <= 0) {
        warning("引用合计达到 150,000 字符上限，仅保留路径");
        continue;
      }
      if (stat.type === "directory") {
        const entries = await directoryEntries(fs, paths, workspaceRoot, real).catch(
          () => undefined,
        );
        if (entries === undefined) {
          warning("目录无法读取，仅保留路径");
          continue;
        }
        let count = Math.min(entries.length, 200);
        const initialCount = count;
        const render = (): string => {
          const note =
            count < entries.length ? `\n…（共 ${entries.length} 项，只附带 ${count} 项）` : "";
          return `<directory path="${escapeAttribute(display)}" entries="${count}">\n${entries.slice(0, count).join("\n")}${note}\n</directory>`;
        };
        let text = render();
        while (text.length > remaining && count > 0) {
          count--;
          text = render();
        }
        if (text.length > remaining || (count === 0 && entries.length > 0)) {
          warning("引用合计达到 150,000 字符上限，仅保留路径");
          remaining = 0;
          continue;
        }
        if (count < initialCount) {
          warning("引用合计达到 150,000 字符上限，后续引用仅保留路径");
          remaining = text.length;
        }
        blocks.push({ type: "text", text });
        remaining -= text.length;
        fileRefs.push({
          path: display,
          kind: "directory",
          chars: entries.slice(0, count).join("\n").length,
          truncated: count < entries.length,
        });
        continue;
      }
      if (stat.type !== "file") continue;
      const bytes = await fs.readFile(real).catch(() => undefined);
      if (bytes === undefined) {
        warning("文件无法读取，仅保留路径");
        continue;
      }
      if (isAborted()) break;
      const mimeType = sniffImageMime(bytes);
      if (mimeType !== undefined) {
        if (!options.imageInput) {
          warning("当前模型不支持看图，仅保留路径");
          continue;
        }
        const size = parseImageSize(bytes, mimeType);
        if (
          size === undefined ||
          bytes.length > IMAGE_MAX_BYTES ||
          size.width > IMAGE_MAX_EDGE ||
          size.height > IMAGE_MAX_EDGE
        ) {
          warning("图片格式或尺寸不符合要求（至多 5 MB、每边 8000 px），仅保留路径");
          continue;
        }
        if (options.attachments === undefined) {
          warning("附件存储不可用，仅保留路径");
          continue;
        }
        attachments.push(
          await options.attachments.save({
            data: bytes,
            mimeType,
            label: display,
            source: "paste",
          }),
        );
        fileRefs.push({ path: display, kind: "image", chars: 0, truncated: false });
        continue;
      }
      if (isBinary(bytes)) {
        warning("二进制文件不附带内容，仅保留路径");
        continue;
      }
      const raw = new TextDecoder("utf-8").decode(bytes);
      const lines = raw.split("\n");
      let count = lines.length;
      if (count > 2000 && raw.length > 50_000) {
        let chars = 0;
        let withinChars = 0;
        for (const line of lines) {
          const next = chars + line.length + (withinChars > 0 ? 1 : 0);
          if (next > 50_000) break;
          chars = next;
          withinChars++;
        }
        count = Math.max(2000, withinChars);
      }
      const numbered = lines
        .slice(0, count)
        .map((line, i) => `${i + 1}|${line.replace(/\r$/, "")}`);
      const render = (): string => {
        const note =
          count < lines.length
            ? `\n文件共 ${lines.length} 行，只附带了第 1–${count} 行，其余用 read 查看`
            : "";
        return `<file path="${escapeAttribute(display)}" lines="1-${count}" total="${lines.length}">\n${numbered.slice(0, count).join("\n")}${note}\n</file>`;
      };
      let text = render();
      if (text.length > remaining) {
        warning("引用合计达到 150,000 字符上限，后续引用仅保留路径");
        // 完整行截取：预算包括行号、标签和截断提示，不会因格式开销越过硬上限。
        let low = 0;
        let high = count;
        while (low < high) {
          count = Math.ceil((low + high) / 2);
          if (render().length <= remaining) low = count;
          else high = count - 1;
        }
        count = low;
        text = render();
        if (count === 0 || text.length > remaining) {
          remaining = 0;
          continue;
        }
        remaining = text.length; // 本文件用尽当前消息的引用预算。
      }
      blocks.push({ type: "text", text });
      remaining -= text.length;
      fileRefs.push({
        path: display,
        kind: "file",
        lines: count,
        totalLines: lines.length,
        chars: lines.slice(0, count).join("\n").length,
        truncated: count < lines.length,
      });
      options.readState.record(real, { mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }
  return { content: [...content, ...blocks], attachments, fileRefs, warnings };
}
