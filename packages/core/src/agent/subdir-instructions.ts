import type { InstructionSet } from "../context/index.js";
import type { Platform } from "../platform/index.js";
import type {
  HistoryEntry,
  InstructionsLoadedPayload,
  PermissionSubject,
} from "../protocol/index.js";

export const INSTRUCTION_FILE_LIMIT = 64 * 1024;
const SESSION_INSTRUCTION_LIMIT = 128 * 1024;

export async function loadSubdirInstructions(input: {
  platform: Platform;
  workspaceRoot: string;
  instructionWorkspaceRoot: string;
  instructions: InstructionSet;
  history: readonly HistoryEntry[];
  subjects: readonly PermissionSubject[];
}): Promise<InstructionsLoadedPayload | undefined> {
  const {
    platform: { fs, paths },
    workspaceRoot,
    subjects,
  } = input;
  const targets = subjects.flatMap(({ resolved }) =>
    resolved !== undefined && paths.isWithin(workspaceRoot, resolved) ? [resolved] : [],
  );
  if (targets.length === 0) return undefined;

  const encoder = new TextEncoder();
  const seen = new Set<string>();
  let remaining = SESSION_INSTRUCTION_LIMIT;
  let limitReached = false;
  for (const entry of input.history) {
    if (entry.kind !== "note" || entry.instructions === undefined) continue;
    for (const file of entry.instructions.files) {
      seen.add(paths.canonicalize(file.source));
      remaining -= encoder.encode(file.content).byteLength;
    }
    for (const source of entry.instructions.skipped ?? []) {
      seen.add(paths.canonicalize(source));
      limitReached = true;
    }
  }
  const systemSources = [input.instructions.user, ...input.instructions.project].flatMap((file) =>
    file === undefined ? [] : [file.source],
  );
  const systemRoots = new Set([workspaceRoot, input.instructionWorkspaceRoot]);
  for (const source of systemSources) {
    if (!paths.isAbsolute(source)) continue;
    // The startup cwd can use a Windows short path or a symlink to a directory.
    let location = source;
    if (![...systemRoots].some((root) => paths.isWithin(root, source))) {
      const directory = await fs.realpath(paths.dirname(source)).catch(() => undefined);
      if (directory === undefined) continue;
      location = paths.join(directory, paths.basename(source));
    }
    for (const root of systemRoots) {
      if (paths.isWithin(root, location)) {
        seen.add(paths.canonicalize(paths.relative(root, location)));
      }
    }
  }

  const candidates = new Set<string>();
  for (const target of targets) {
    const stat = await fs.stat(target).catch(() => undefined);
    const directory = stat?.type === "directory" ? target : paths.dirname(target);
    if (!paths.isWithin(workspaceRoot, directory)) continue;
    let current = workspaceRoot;
    candidates.add(paths.join(current, "AGENTS.md"));
    const relative = paths.relative(workspaceRoot, directory);
    for (const segment of relative === "" ? [] : relative.split(paths.sep)) {
      current = paths.join(current, segment);
      candidates.add(paths.join(current, "AGENTS.md"));
    }
  }

  const files: InstructionsLoadedPayload["files"] = [];
  const skipped: string[] = [];
  for (const candidate of candidates) {
    const relative = paths.relative(workspaceRoot, candidate);
    const key = paths.canonicalize(relative);
    if (seen.has(key)) continue;
    seen.add(key);
    const source = relative.split(paths.sep).join("/");
    try {
      const real = await fs.realpath(candidate);
      if (!paths.isWithin(workspaceRoot, real) || (await fs.stat(real)).type !== "file") continue;
      if (limitReached || remaining === 0) {
        skipped.push(source);
        continue;
      }
      const bytes = await fs.readFileSlice(real, INSTRUCTION_FILE_LIMIT + 1);
      const truncated = bytes.byteLength > INSTRUCTION_FILE_LIMIT;
      const prefix = bytes.subarray(0, INSTRUCTION_FILE_LIMIT);
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(prefix, {
        stream: truncated,
      });
      const size = encoder.encode(content).byteLength;
      if (size > remaining) {
        limitReached = true;
        skipped.push(source);
        continue;
      }
      files.push({ source, content, ...(truncated ? { truncated } : {}) });
      remaining -= size;
    } catch {
      // A missing, unreadable or invalid UTF-8 file does not affect the tool result.
    }
  }
  if (files.length === 0 && skipped.length === 0) return undefined;
  return { files, ...(skipped.length > 0 ? { skipped } : {}) };
}
