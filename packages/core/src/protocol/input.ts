/**
 * 待提交内容的已准备形态（ADR-0070）：附件已落盘、`@` 引用与技能正文已固定。
 * 普通提交、待发输入（插话/排队）与 Agent Loop 共用这一形状，避免 Agent Loop
 * 认识待发列表或 Provider 细节。
 */
import type { AgentDelegation, ContentBlock, FileRef, ImageAttachment } from "./types.js";
import type { SkillSnapshot } from "./skills.js";

export interface PreparedInput {
  /** 用户输入的正文块；编辑待发输入时只替换这里 */
  content: ContentBlock[];
  /** Core 追加给模型看的快照块（`@` 引用、技能正文、委派指令），编辑文本时原样保留 */
  appended: ContentBlock[];
  attachments?: ImageAttachment[] | undefined;
  fileRefs?: FileRef[] | undefined;
  skill?: SkillSnapshot | undefined;
  delegate?: AgentDelegation | undefined;
}

/** `message.user` 的 content：用户正文 + 追加的快照块（与普通提交同序） */
export function preparedContent(input: PreparedInput): ContentBlock[] {
  return [...input.content, ...input.appended];
}
