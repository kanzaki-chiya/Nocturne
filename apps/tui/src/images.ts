/** 输入框图片占位：只在本次运行的内存保存字节。 */
import {
  IMAGE_MAX_BYTES,
  IMAGE_MAX_EDGE,
  parseImageSize,
  sniffImageMime,
  type Platform,
} from "@nocturne/core";

import type { ImageMimeType } from "@nocturne/core/protocol";

export interface PendingImage {
  data: Uint8Array;
  mimeType: ImageMimeType;
  label: string;
}
const TOKEN = /\[Image #(\d+)\]/g;

export function imageTokenBefore(text: string): number {
  return /\[Image #\d+\]$/.exec(text)?.[0].length ?? 0;
}

export function imageTokenAt(text: string): number {
  return /^\[Image #\d+\]/.exec(text)?.[0].length ?? 0;
}

export function checkImage(
  data: Uint8Array,
): { kind: "ok"; mimeType: ImageMimeType } | { kind: "unsupported" } | { kind: "too_large" } {
  const mimeType = sniffImageMime(data);
  if (mimeType === undefined) return { kind: "unsupported" };
  const size = parseImageSize(data, mimeType);
  if (
    data.byteLength > IMAGE_MAX_BYTES ||
    size === undefined ||
    size.width > IMAGE_MAX_EDGE ||
    size.height > IMAGE_MAX_EDGE
  )
    return { kind: "too_large" };
  return { kind: "ok", mimeType };
}

export async function droppedImage(
  text: string,
  platform: Pick<Platform, "fs" | "paths">,
): Promise<{ kind: "none" } | { kind: "too_large" } | { kind: "ok"; image: PendingImage }> {
  const trimmed = text.trim();
  const path =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;
  if (path === "" || path.includes("\n")) return { kind: "none" };
  const stat = await platform.fs.stat(path).catch(() => undefined);
  if (stat?.type !== "file") return { kind: "none" };
  const data = await platform.fs.readFile(path).catch(() => undefined);
  if (data === undefined) return { kind: "none" };
  const checked = checkImage(data);
  if (checked.kind === "unsupported") return { kind: "none" };
  if (checked.kind === "too_large") return checked;
  return {
    kind: "ok",
    image: { data, mimeType: checked.mimeType, label: platform.paths.basename(path) },
  };
}

export function createImageStore() {
  const images = new Map<number, PendingImage>();
  let next = 1;
  return {
    add(image: PendingImage): string {
      const id = next++;
      images.set(id, image);
      return `[Image #${id}]`;
    },
    in(text: string): PendingImage[] {
      return [...text.matchAll(TOKEN)].flatMap((m) => {
        const image = images.get(Number(m[1]));
        return image === undefined ? [] : [image];
      });
    },
    prune(text: string): void {
      const used = new Set([...text.matchAll(TOKEN)].map((m) => Number(m[1])));
      for (const id of images.keys()) if (!used.has(id)) images.delete(id);
    },
    strip(text: string): string {
      return text.replace(TOKEN, "").trim();
    },
    clear(): void {
      images.clear();
    },
  };
}
