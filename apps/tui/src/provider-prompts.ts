/**
 * 服务商配置的客户端输入原语（ADR-0044 第 6 节）：行式终端与 TUI 弹层各自实现，
 * 共用 provider-setup-flow / provider-login 的呈现顺序。
 * 这里没有任何流程判断——哪些字段要问、走哪种凭据、失败怎么提示，全部来自 Core 的
 * describeProviderSetup / addProvider；本接口只负责"问一句、读一行、打印一行"。
 */
export interface PromptOpts {
  /** 提示下方的灰色小字说明 */
  hint?: string | undefined;
}

export interface MultiPromptOpts extends PromptOpts {
  /** "全否"选项下标：勾选它时其余勾选无效 */
  exclusiveIndex?: number | undefined;
}

export interface SetupPrompts {
  /** 普通单行输入（回显） */
  ask(prompt: string, opts?: PromptOpts): Promise<string>;
  /** 密钥输入：回显为 *（TTY raw mode / TUI 掩码框）；非 TTY 退化为普通读取 */
  askSecret(prompt: string, opts?: PromptOpts): Promise<string>;
  /** 多选勾选：返回选中项的下标（有序去重），空数组 = 全部不选 */
  chooseMulti(
    prompt: string,
    options: readonly string[],
    opts?: MultiPromptOpts,
  ): Promise<number[]>;
  /** 瞬时进度行：会被后续输出覆盖，不进历史（TUI 渲染为忙碌行；CLI 直接打印） */
  busy(text: string): void;
  /** 已完成步骤的一行摘要：TUI 折叠为同行"名称 x • 地址 y"；CLI 逐行打印 */
  step(text: string): void;
  print(text: string): void;
}

/** 配置流程被用户取消（Ctrl+C / Ctrl+D / Esc / 列表选择越界） */
export class SetupAbort extends Error {
  constructor() {
    super("已取消");
    this.name = "SetupAbort";
  }
}
