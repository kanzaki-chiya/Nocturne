/** Pending file bytes remain in memory until submission; history stores pasted source text. */
export interface PendingFile {
  data: Uint8Array;
  mimeType: string;
  label: string;
  source: "paste" | "upload";
}

const TOKEN = /\[File #(\d+) [^\]\r\n]*\]/g;
export const LARGE_PASTE_BYTES = 32 * 1024;

export function fileTokenBefore(text: string): number {
  return /\[File #\d+ [^\]\r\n]*\]$/.exec(text)?.[0].length ?? 0;
}
export function fileTokenAt(text: string): number {
  return /^\[File #\d+ [^\]\r\n]*\]/.exec(text)?.[0].length ?? 0;
}

export function createFileStore() {
  const files = new Map<number, PendingFile>();
  let next = 1;
  let pasted = 1;
  return {
    add(file: PendingFile): string {
      const id = next++;
      files.set(id, file);
      const size =
        file.data.byteLength < 1024
          ? `${file.data.byteLength} B`
          : `${Math.ceil(file.data.byteLength / 1024)} KB`;
      return `[File #${id} ${file.label.replace(/[\]\r\n]/g, "_")} ${size}]`;
    },
    addPaste(text: string): string | undefined {
      const data = Buffer.from(text, "utf8");
      if (data.byteLength < LARGE_PASTE_BYTES) return undefined;
      return this.add({
        data,
        mimeType: "text/plain",
        label: `pasted-${pasted++}.txt`,
        source: "paste",
      });
    },
    in(text: string): PendingFile[] {
      return [...text.matchAll(TOKEN)].flatMap((m) => {
        const file = files.get(Number(m[1]));
        return file ? [file] : [];
      });
    },
    expandPaste(text: string): string {
      return text.replace(TOKEN, (token, id: string) => {
        const file = files.get(Number(id));
        return file?.source === "paste" ? Buffer.from(file.data).toString("utf8") : token;
      });
    },
    strip(text: string): string {
      return text.replace(TOKEN, "").trim();
    },
    prune(text: string): void {
      const used = new Set([...text.matchAll(TOKEN)].map((m) => Number(m[1])));
      for (const id of files.keys()) if (!used.has(id)) files.delete(id);
    },
    clear(): void {
      files.clear();
    },
  };
}
