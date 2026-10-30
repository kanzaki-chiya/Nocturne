import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPlatform } from "../platform/index.js";
import { createAttachmentStore } from "./attachments.js";
import {
  attachmentReferences,
  FILE_MAX_BYTES,
  saveInputAttachments,
  validateAttachmentInputs,
} from "./file-attachments.js";

const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2,
  0, 0, 0, 3, 8, 6, 0, 0, 0,
]);
describe("文件附件", () => {
  it("图片分流，文本严格检测，编号与扩展名、哈希回读", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nct-files-"));
    try {
      const platform = createPlatform();
      const store = createAttachmentStore({
        fs: platform.fs,
        paths: platform.paths,
        attachmentsDir: root,
        sessionId: "s",
      });
      const large = new Uint8Array(5 * 1024 * 1024 + 1);
      large.set(png);
      const result = await saveInputAttachments(store, [
        { data: png, mimeType: "image/png" },
        { data: new Uint8Array([66, 77, 0]), mimeType: "image/bmp", label: "x.BMP" },
        { data: large, mimeType: "image/png", label: "large.png" },
        { data: new TextEncoder().encode("a\r\nb\n"), mimeType: "text/plain", label: 'a"<&.T-X_T' },
        { data: new Uint8Array([0xff]), mimeType: "application/octet-stream", label: "binary" },
      ]);
      expect(result.attachments).toHaveLength(1);
      expect(result.files).toHaveLength(4);
      expect(result.files[0]).toMatchObject({ file: "file-1.bmp", source: "upload" });
      expect(result.files[2]).toMatchObject({ file: "file-3.txt", text: { lines: 2 } });
      expect(result.files[3]?.text).toBeUndefined();
      for (const file of result.files) expect((await store.load(file))?.length).toBe(file.bytes);
      const ref = result.files[2];
      if (!ref) throw new Error("missing file");
      const text = attachmentReferences([ref], (file) => `C:\\a&b\\${file}`);
      expect(text).toBe(
        '<attachment name="a&quot;&lt;&amp;.T-X_T" path="C:\\a&amp;b\\file-3.txt" size="5 B" lines="2" />',
      );
      for (const [data, lines] of [
        [new Uint8Array(), 0],
        [new TextEncoder().encode("a"), 1],
        [new TextEncoder().encode("a\n\n"), 2],
      ] as const) {
        expect((await store.saveFile({ data, label: "lines", source: "paste" })).text?.lines).toBe(
          lines,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("20 MiB 与十个附件边界", () => {
    const input = { data: new Uint8Array(FILE_MAX_BYTES), mimeType: "x" };
    expect(validateAttachmentInputs([input])).toBeUndefined();
    expect(
      validateAttachmentInputs([{ ...input, data: new Uint8Array(FILE_MAX_BYTES + 1) }]),
    ).toContain("20 MB");
    expect(validateAttachmentInputs(Array.from({ length: 10 }, () => input))).toBeUndefined();
    expect(validateAttachmentInputs(Array.from({ length: 11 }, () => input))).toContain("10");
  });
});
