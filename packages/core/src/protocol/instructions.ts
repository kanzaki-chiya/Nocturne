import type { InstructionsLoadedPayload } from "./events.js";

const INTRO =
  "Project instructions for a directory you just accessed. They apply to files under that directory and take precedence over default practices:";

export function formatSubdirInstructions({ files, skipped }: InstructionsLoadedPayload): string {
  const lines = [INTRO];
  if (skipped?.length) {
    lines.push(
      `Skipped (session instruction limit reached): ${skipped.map((source) => JSON.stringify(source)).join(", ")}`,
    );
  }
  for (const { source, content, truncated } of files) {
    const attribute = source
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    lines.push(`<instructions source="${attribute}">`, content);
    if (truncated) lines.push("[Truncated at the 64 KiB instruction file limit]");
    lines.push("</instructions>");
  }
  return lines.join("\n");
}
