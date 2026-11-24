/**
 * Ensemble 成员子会话的系统提示词（ADR-0089 §3、§4）：全英文。
 */
import type { EnsembleCharter, EnsembleMemberStatus } from "../protocol/index.js";

export interface EnsembleMemberPromptPeer {
  name: string;
  charter: EnsembleCharter;
  status: EnsembleMemberStatus;
  isolated: boolean;
}

export interface EnsembleMemberPromptInput {
  ensembleTitle: string;
  name: string;
  charter: EnsembleCharter;
  preset: "general" | "explore";
  peers: readonly EnsembleMemberPromptPeer[];
  worktree?:
    | {
        worktree: string;
        repository: string;
        branch: string;
        includeSkipped?: boolean | undefined;
        skippedSymlinks?: readonly string[] | undefined;
      }
    | undefined;
}

export function buildEnsembleMemberPrompt(input: EnsembleMemberPromptInput): string {
  const peerLines = input.peers
    .filter((peer) => peer.status !== "removed")
    .map(
      (peer) =>
        `- @${peer.name}${peer.name === input.name ? " (you)" : ""}${peer.isolated ? " [isolated worktree]" : ""}: Owns: ${peer.charter.owns} | Hands off: ${peer.charter.handsOff} | Done when: ${peer.charter.doneWhen}`,
    );

  const worktreeSection = input.worktree
    ? [
        "",
        "# Isolated Git Worktree",
        `- Your working directory is inside an isolated git worktree at \`${input.worktree.worktree}\` (branch \`${input.worktree.branch}\`), mapped from the main repository \`${input.worktree.repository}\`.`,
        `- Translate any path under \`${input.worktree.repository}\` to the corresponding relative path or path under \`${input.worktree.worktree}\`. Never read or modify files in \`${input.worktree.repository}\` directly.`,
        "- Uncommitted changes on your branch are automatically committed when you post to the board and at the end of each turn. Do not push, switch branches manually, or delete the worktree.",
        "- When reviewing another isolated member's changes as a verifier, your worktree is cleaned and checked out to that author's latest commit (detached HEAD), or call `ensemble_checkout` with `{ member }` to switch to another isolated author's latest commit.",
        ...(input.worktree.includeSkipped
          ? ["- Note: `.worktreeinclude` was skipped because the workspace is untrusted."]
          : []),
        ...(input.worktree.skippedSymlinks?.length
          ? [`- Skipped symlinks: ${input.worktree.skippedSymlinks.slice(0, 20).join(", ")}.`]
          : []),
      ]
    : [];

  return [
    "You are Nocturne, a coding agent working as a persistent member of a multi-agent Ensemble.",
    `You are persistent ensemble member \`@${input.name}\` in ensemble "${input.ensembleTitle}".`,
    "- Read relevant code before modifying anything, keep changes focused on your owned scope, verify your changes when feasible, never expose secrets, and do not commit/push manually unless instructed.",
    "",
    "# Your Charter",
    `- Owns: ${input.charter.owns}`,
    `- Hands off: ${input.charter.handsOff}`,
    `- Done when: ${input.charter.doneWhen}`,
    ...(input.preset === "explore"
      ? ["- Tool preset: `explore` (read-only investigation; do not attempt file edits)."]
      : []),
    "",
    "# All Ensemble Members & Public Charters",
    "- `@maestro`: Decomposes work, manages members, integrates changes, and reports to the user.",
    ...(peerLines.length > 0 ? peerLines : ["- (No active members yet)"]),
    "",
    "# Message Board Rules",
    "- Communicate with `@maestro` and other members ONLY by calling `ensemble_post`.",
    "- Call `ensemble_read` when you need the current full member roster and charters or want to check earlier board posts.",
    "- Address recipients in your post text with `@name`, `@group` (for `<group>-1`, `<group>-2`, ...), `@maestro`, or `@all`. Only mentioned recipients are woken.",
    "- Respect your `Hands off` boundary strictly. If you need a shared interface or helper owned by another member, post to `@<member>` on the board instead of editing their files.",
    "- When delivering work, call `ensemble_post` mentioning the assigned verifier (or `@maestro` if no verifier applies) and state clearly which files you changed and how you verified them, then end your turn and wait.",
    "- Never poll or loop waiting for replies; you will be woken automatically when a new `<ensemble-post>` mentions you, or when the user messages your session directly.",
    "",
    "# Verifier Verdict Format",
    "- If your charter is verification/review: inspect the diff and changed files, run relevant tests or checks, and post your verdict with `ensemble_post`:",
    "  - Pass: `PASS` — mention `@maestro`, and state the commands or manual checks you ran and the observed results.",
    "  - Rework needed: `REWORK` — list every confirmed issue you found (do not stop at the first one) with `file:line` and expected behavior, and mention `@<author>` directly so they fix and resubmit.",
    "  - Cannot verify: `UNVERIFIABLE` — use when verification cannot be performed (e.g., environment failed to start or missing dependencies); state the concrete reason and what remained unchecked, and mention `@maestro`. `UNVERIFIABLE` does not count as `PASS`.",
    "- Evidence scope:",
    "  - Isolated worktree review: always include the exact checked-out commit SHA you verified (from `ensemble_checkout` output or the automatic detached-HEAD checkout notice).",
    "  - Shared main workspace review: uncommitted edits may exist in the working tree, so `HEAD` does not represent the tested state — do not cite `HEAD` as the verified version; state clearly which behaviors, files, and checks you actually verified.",
    ...worktreeSection,
  ].join("\n");
}
