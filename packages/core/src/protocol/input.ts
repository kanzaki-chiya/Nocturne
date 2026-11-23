/**
 * 待提交内容的已准备形态（ADR-0070）：附件已落盘、`@` 引用与技能正文已固定。
 * 普通提交、待发输入（插话/排队）与 Agent Loop 共用这一形状，避免 Agent Loop
 * 认识待发列表或 Provider 细节。
 */
import type { BackgroundShellResult, SubagentResult } from "./events.js";
import type { EnsemblePostDelivery } from "./ensemble.js";
import type { SuiteReportDelivery } from "./suite.js";
import type {
  AgentDelegation,
  ContentBlock,
  FileRef,
  ImageAttachment,
  FileAttachment,
} from "./types.js";
import type { SkillInvocation, SkillSnapshot } from "./skills.js";
import type { WorkModeSnapshot } from "./work-modes.js";
import type { PageCommentsSnapshot } from "./page-comments.js";
import type { MessageQuote } from "./quotes.js";

export interface PreparedInput {
  subagent?: SubagentResult | undefined;
  backgroundShell?: BackgroundShellResult | undefined;
  ensemble?: EnsemblePostDelivery | undefined;
  /** Ensemble Runtime 安静提醒标记（ADR-0089 §9 修订） */
  ensembleQuietReminder?: true | undefined;
  /** 组曲线程自动汇报投递标记（ADR-0097 §3.4） */
  suiteReport?: SuiteReportDelivery | undefined;
  /** Core 放在最前面给模型看的快照块（如引用回复块），编辑文本时原样保留 */
  prepended?: ContentBlock[] | undefined;
  /** 用户输入的正文块；编辑待发输入时只替换这里 */
  content: ContentBlock[];
  /** Core 追加给模型看的快照块（`@` 引用、技能正文、委派指令），编辑文本时原样保留 */
  appended: ContentBlock[];
  attachments?: ImageAttachment[] | undefined;
  files?: FileAttachment[] | undefined;
  fileRefs?: FileRef[] | undefined;
  skill?: SkillSnapshot | undefined;
  /** 技能斜杠原始调用参数（仅供 UserPromptSubmit Hook，不写入持久化事件） */
  skillInvocation?: SkillInvocation | undefined;
  delegate?: AgentDelegation | undefined;
  /** 执行方式快照（ADR-0076）；说明块在 appended 里 */
  workMode?: WorkModeSnapshot | undefined;
  /** 面板页面评论快照。写入用户消息时分配 ID 并生成英文块。 */
  pageComments?: PageCommentsSnapshot | undefined;
  pageCommentScreenshotIndices?: ReadonlySet<number> | undefined;
  /** 引用回复片段（ADR-0116）；首块文本在 prepended 里 */
  quotes?: MessageQuote[] | undefined;
}

/** `message.user` 的 content：首部快照块 + 用户正文 + 尾部快照块（与普通提交同序） */
export function preparedContent(input: PreparedInput): ContentBlock[] {
  return [...(input.prepended ?? []), ...input.content, ...input.appended];
}
