import {
  parseSkillSlash,
  parseWorkModeSlash,
  workModeCommandName,
  type SkillOverview,
  type WorkModeName,
} from "@nocturne/core/protocol";
import type { IconName } from "./ui/Icon";

export const SKILL_ICON = "magic_1";
export const PLUGIN_ICON = "code";

interface InputIcon {
  icon: IconName;
  image?: string | undefined;
}
export type InputLabelData = InputIcon & { label: string };

export const WORK_MODE_ITEMS: readonly (InputLabelData & { name: WorkModeName })[] = [
  { name: "grill-me", label: "追问需求", icon: "question" },
  { name: "goal", label: "目标", icon: "target" },
  { name: "plan", label: "计划", icon: "list_check" },
  { name: "fugue", label: "多代理攻坚", icon: "robot" },
  { name: "ensemble", label: "合奏", icon: "group" },
  { name: "cadenza", label: "华彩", icon: "layout_right" },
];

export function workModeLabel(name: string): InputLabelData {
  const canonical = workModeCommandName(name);
  return (
    WORK_MODE_ITEMS.find((item) => item.name === canonical) ?? {
      icon: "list_check",
      label: canonical,
    }
  );
}

export function skillLabel(name: string, skill?: SkillOverview): InputLabelData {
  if (skill?.source !== "plugin") return { icon: SKILL_ICON, label: name };
  const manifestName = skill.plugin?.split("@")[0];
  return {
    icon: PLUGIN_ICON,
    image: skill.pluginIcon,
    label:
      manifestName?.toLowerCase() === name.toLowerCase() ? (skill.pluginDisplayName ?? name) : name,
  };
}

export function invocableSkills(skills: readonly SkillOverview[]): SkillOverview[] {
  return skills
    .filter(
      (skill) =>
        skill.enabled &&
        !skill.shadowedBy &&
        !skill.commandConflict &&
        (skill.invocation === "both" || skill.invocation === "user"),
    )
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

export function skillCommandLength(text: string, name: string): number {
  const match = /^\s*\/([^\s]+)(?:[ \t]|(?=\s|$))/.exec(text);
  return match?.[1]?.toLowerCase() === name.toLowerCase() ? match[0].length : 0;
}

interface DraftLabel {
  prefix: string;
  skill?: InputLabelData;
  workMode?: WorkModeName;
}

// Keep potential subcommands editable as plain text until they become tasks.
const ACTION_WORDS: Partial<Record<WorkModeName, readonly string[]>> = {
  goal: ["stop", "resume", "cancel"],
  plan: ["approve", "cancel"],
  ensemble: ["board", "end"],
};

export function draftLabel(
  text: string,
  skills: readonly SkillOverview[],
  allowWorkMode: boolean,
): DraftLabel {
  const prefix = /^\s*\/\S+[ \t]/.exec(text)?.[0];
  if (!prefix) return { prefix: "" };
  const work = allowWorkMode ? parseWorkModeSlash(text) : undefined;
  if (
    work?.kind === "submit" &&
    !ACTION_WORDS[work.workMode]?.some(
      (word) => word.startsWith(work.text.toLowerCase()) && !/\s$/.test(text),
    )
  ) {
    return { prefix, workMode: work.workMode };
  }
  const invocation = parseSkillSlash(text.trimStart(), skills);
  if (!invocation) return { prefix: "" };
  const skill = skills.find(
    (candidate) => candidate.name === invocation.name && candidate.enabled && !candidate.shadowedBy,
  );
  return { prefix, skill: skillLabel(invocation.name, skill) };
}

export function insertSkillCommand(
  text: string,
  name: string,
  skills: readonly SkillOverview[],
): string {
  const active = draftLabel(text, skills, false);
  const body = active.skill
    ? text.slice(active.prefix.length)
    : /^\s*\/\S*$/.test(text)
      ? ""
      : text;
  return `/${name} ${body}`;
}
