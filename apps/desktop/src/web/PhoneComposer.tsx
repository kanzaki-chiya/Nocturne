import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { ExternalAgentOverview, SkillOverview } from "@nocturne/core/protocol";
import type { ContextSummary } from "@nocturne/rpc/client";

import { completeSlash, parseSlash, type ParsedSlash } from "../commands";
import type { ChoiceControl, ComposerControls, ComposerSubmit } from "../Composer";
import { ContextPanel, percent } from "../context-panel";
import {
  ContextRing,
  IconMore,
  IconPaperclip,
  IconSend,
  IconShield,
  IconStop,
  IconTerminal,
} from "./icons";
import { Popover, PopoverOption } from "./Popover";

/** 桌面提示里指向左栏、设置页的命令，在手机上换成手机的去处 */
const PHONE_HINTS: Record<string, string> = {
  "/new": "回到项目页，直接在底部输入框输入即新建会话",
  "/clear": "回到项目页，直接在底部输入框输入即新建会话",
  "/resume": "在项目页选择要继续的会话",
  "/help": "输入 / 查看可用命令；模型、思考档位和权限预设在输入框下方切换",
  "/model": "在输入框下方切换模型",
  "/effort": "在输入框下方切换思考档位",
  "/preset": "在输入框下方切换权限预设",
  "/shell": "Shell 只能在电脑上切换",
  "/context": "点输入框下方的上下文圆环查看占比",
  "/provider": "服务商只能在电脑上管理",
  "/agents": "子代理只能在电脑上管理",
  "/skills": "技能只能在电脑上管理",
  "/settings": "设置只能在电脑上修改；主题在手机的「设置」里切换",
  "/theme": "在手机的「设置」里切换主题",
  "/exit": "返回或关闭网页即可",
  "/quit": "返回或关闭网页即可",
};

export function phoneSlashHint(parsed: ParsedSlash | null): string | undefined {
  if (parsed?.kind === "redirect") return PHONE_HINTS[parsed.name.toLowerCase()] ?? parsed.hint;
  if (parsed?.kind === "unknown") return parsed.hint;
  return undefined;
}

export interface PhoneContextSource {
  load: () => Promise<ContextSummary>;
  /** 变化时重新读取（持久条目数与状态） */
  key: string;
}

export interface PhoneComposerProps {
  variant: "draft" | "session";
  controls: ComposerControls | undefined;
  running: boolean;
  /** 不能发送的原因（未连接等） */
  disabled?: string | undefined;
  placeholder?: string;
  skills?: readonly SkillOverview[];
  externalAgents?: readonly ExternalAgentOverview[];
  onSubmit: (input: ComposerSubmit) => Promise<boolean>;
  onInterrupt: () => void;
  /** /compact、/mcp：返回字符串时在浮层里显示（/mcp 状态） */
  onSlash: (line: string) => Promise<string | boolean>;
  context?: PhoneContextSource | undefined;
  shell?: { label: string; note?: string | undefined } | undefined;
  home?: string | null;
}

type PopoverKind = "attach" | "preset" | "model" | "effort" | "context" | "more" | "output";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function PhoneComposer({
  variant,
  controls,
  running,
  disabled,
  placeholder,
  skills = [],
  externalAgents = [],
  onSubmit,
  onInterrupt,
  onSlash,
  context,
  shell,
  home,
}: PhoneComposerProps) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState<PopoverKind | null>(null);
  const [output, setOutput] = useState<{ title: string; text: string }>();
  const [error, setError] = useState<string>();
  const [hint, setHint] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [summary, setSummary] = useState<ContextSummary>();
  const [contextError, setContextError] = useState<string>();
  const field = useRef<HTMLTextAreaElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const triggers = useRef<Partial<Record<PopoverKind, HTMLButtonElement | null>>>({});
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const contextKey = context?.key;
  const loadContext = context?.load;
  useEffect(() => {
    if (loadContext === undefined) return;
    let active = true;
    void loadContext().then(
      (result) => {
        if (!active) return;
        setSummary(result);
        setContextError(undefined);
      },
      (reason: unknown) => {
        if (active) setContextError(errorText(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [contextKey, loadContext, open === "context"]);

  useEffect(() => {
    const node = field.current;
    if (node === null) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 160)}px`;
  }, [draft]);

  const slashGroups = useMemo(
    () => (dismissed ? [] : completeSlash(draft, skills, externalAgents)),
    [draft, dismissed, skills, externalAgents],
  );
  const parsed = useMemo(
    () => parseSlash(draft, variant, skills, externalAgents),
    [draft, variant, skills, externalAgents],
  );
  const redirect = parsed?.kind === "redirect" ? phoneSlashHint(parsed) : undefined;

  const update = (text: string) => {
    setDraft(text);
    setDismissed(false);
    setHint(undefined);
    setError(undefined);
  };
  const toggle = (kind: PopoverKind) => {
    setOpen((current) => (current === kind ? null : kind));
    setError(undefined);
  };
  const close = () => {
    setOpen(null);
  };

  const submit = async () => {
    const text = draft;
    if (disabled !== undefined || running || submitting) return;
    if (text.trim() === "") return;
    const slash = parseSlash(text, variant, skills, externalAgents);
    if (slash?.kind === "redirect" || slash?.kind === "unknown") {
      setHint(phoneSlashHint(slash));
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      if (slash?.kind === "command") {
        const result = await onSlash(text);
        if (result === false) return;
        if (typeof result === "string") {
          setOutput({ title: slash.name === "/mcp" ? "MCP 状态" : slash.name, text: result });
          setOpen("output");
        }
        if (mounted.current) update("");
        return;
      }
      const accepted = await onSubmit({
        text,
        ...(slash?.kind === "skill" ? { skill: slash.invocation } : {}),
        ...(slash?.kind === "agent" ? { delegate: slash.delegate } : {}),
        attachments: [],
      });
      if (accepted && mounted.current) update("");
    } catch (reason) {
      if (mounted.current) setError(errorText(reason));
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  };

  const select = (control: ChoiceControl, value: string) => {
    close();
    setError(undefined);
    void Promise.resolve(control.onSelect(value)).catch((reason: unknown) => {
      if (mounted.current) setError(errorText(reason));
    });
  };

  const used =
    summary === undefined
      ? null
      : percent(summary.report.estimatedTokens, summary.report.budgetTokens);
  const tool = (
    kind: PopoverKind,
    label: string,
    content: ReactNode,
    options: { disabled?: string | undefined; className?: string } = {},
  ) => (
    <button
      type="button"
      ref={(node) => {
        triggers.current[kind] = node;
      }}
      className={`phone-tool${open === kind ? " on" : ""}${options.className ? ` ${options.className}` : ""}`}
      aria-label={label}
      aria-haspopup="dialog"
      aria-expanded={open === kind}
      disabled={options.disabled !== undefined}
      title={options.disabled ?? label}
      onClick={() => {
        toggle(kind);
      }}
    >
      {content}
    </button>
  );

  const choicePopover = (kind: "preset" | "model" | "effort", control: ChoiceControl) => (
    <Popover
      anchor={triggers.current[kind] ?? null}
      label={
        control.heading ?? (kind === "model" ? "模型" : kind === "effort" ? "思考档位" : "权限")
      }
      onClose={close}
    >
      <div className="phone-popover-h">
        {control.heading ?? (kind === "model" ? "模型" : kind === "effort" ? "思考档位" : "权限")}
      </div>
      {control.groups.map((group, index) => (
        <Fragment key={group.label ?? index}>
          {group.label !== undefined && <div className="phone-popover-group">{group.label}</div>}
          {group.options.map((option) => (
            <PopoverOption
              key={option.value}
              {...(kind === "preset" ? { icon: <IconShield risk={option.risk === true} /> } : {})}
              label={
                kind === "model" ? (
                  option.label
                ) : (
                  <>
                    {option.tag ?? option.label}
                    {option.tag !== undefined && (
                      <span className="phone-option-code">{option.label}</span>
                    )}
                  </>
                )
              }
              detail={option.description ?? (kind === "model" ? undefined : option.detail)}
              checked={option.value === control.value}
              disabled={option.disabled}
              risk={option.risk === true}
              onSelect={() => {
                select(control, option.value);
              }}
            />
          ))}
        </Fragment>
      ))}
      {control.note !== undefined && <p className="phone-popover-note">{control.note}</p>}
    </Popover>
  );

  const busyDisabled = (control: ChoiceControl | undefined) =>
    control === undefined ? "正在读取…" : control.disabled;
  const canSend = disabled === undefined && !running && draft.trim() !== "" && !submitting;

  return (
    <div className="phone-composer">
      {(hint ?? redirect) !== undefined && (
        <div className="phone-composer-hint" role="status">
          {hint ?? redirect}
        </div>
      )}
      {slashGroups.length > 0 && (
        <div className="phone-slash" role="listbox" aria-label="斜杠命令补全">
          {slashGroups.map((group) => (
            <Fragment key={group.id}>
              <div className="phone-popover-group">{group.label}</div>
              {group.items.map((item) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  key={`${group.id}:${item.insert}`}
                  className="phone-slash-row"
                  onClick={() => {
                    update(item.insert);
                    setDismissed(true);
                    field.current?.focus();
                  }}
                >
                  <b>
                    {item.label}
                    {item.argumentHint && <em>{item.argumentHint}</em>}
                    {item.source && <small>{item.source}</small>}
                  </b>
                  <span>{item.summary}</span>
                </button>
              ))}
            </Fragment>
          ))}
        </div>
      )}
      <div className="phone-card" ref={card}>
        <textarea
          ref={field}
          aria-label="消息"
          rows={1}
          value={draft}
          placeholder={
            placeholder ?? (running ? "正在运行，可点右侧按钮中断" : "输入消息，/ 查看命令")
          }
          onChange={(event) => {
            update(event.target.value);
          }}
        />
        {running ? (
          <button
            type="button"
            className="phone-send stop"
            aria-label="中断"
            disabled={disabled !== undefined}
            onClick={onInterrupt}
          >
            <IconStop />
          </button>
        ) : (
          <button
            type="button"
            className={`phone-send${canSend ? "" : " off"}`}
            aria-label="发送"
            disabled={!canSend}
            onClick={() => {
              void submit();
            }}
          >
            <IconSend />
          </button>
        )}
      </div>
      <div className="phone-tools" role="toolbar" aria-label="会话控件">
        {tool("attach", "添加图片", <IconPaperclip />)}
        {tool("preset", "切换权限预设", <IconShield risk={controls?.preset.value === "bypass"} />, {
          disabled: busyDisabled(controls?.preset),
        })}
        <span className="phone-tools-sep" aria-hidden="true" />
        {tool(
          "model",
          "切换模型",
          <span className="phone-tool-model">{controls?.model.label ?? "模型 —"}</span>,
          {
            disabled: busyDisabled(controls?.model),
            className: "grow",
          },
        )}
        <span className="phone-tools-sep" aria-hidden="true" />
        {tool(
          "effort",
          "切换思考档位",
          <span className="phone-tool-text">
            {controls?.effort.groups
              .flatMap((group) => group.options)
              .find((option) => option.value === controls.effort.value)?.tag ??
              controls?.effort.label ??
              "—"}
          </span>,
          { disabled: busyDisabled(controls?.effort) },
        )}
        {context !== undefined &&
          tool(
            "context",
            `上下文用量${used === null ? "" : ` ${used}%`}`,
            <ContextRing percent={used} />,
          )}
        {variant === "session" && tool("more", "更多", <IconMore />)}
      </div>
      {(error ?? controls?.error) !== undefined && (
        <div className="phone-composer-error" role="alert">
          {error ?? controls?.error}
        </div>
      )}
      {open === "attach" && (
        <Popover anchor={triggers.current.attach ?? null} label="添加" onClose={close}>
          <div className="phone-popover-h">添加</div>
          <p className="phone-popover-note">图片附件将在下一步提供。</p>
        </Popover>
      )}
      {open === "preset" && controls !== undefined && choicePopover("preset", controls.preset)}
      {open === "model" && controls !== undefined && choicePopover("model", controls.model)}
      {open === "effort" && controls !== undefined && choicePopover("effort", controls.effort)}
      {open === "context" && (
        <Popover anchor={triggers.current.context ?? null} label="上下文用量" onClose={close} wide>
          <div className="phone-popover-h">上下文用量</div>
          {summary !== undefined ? (
            <div className="phone-context">
              <ContextPanel context={summary} home={home} />
            </div>
          ) : (
            <p className="phone-popover-note" role={contextError ? "alert" : "status"}>
              {contextError ?? "正在读取…"}
            </p>
          )}
        </Popover>
      )}
      {open === "more" && (
        <Popover anchor={triggers.current.more ?? null} label="更多" onClose={close}>
          <div className="phone-popover-h">更多</div>
          <PopoverOption
            icon={<IconTerminal />}
            label={`Shell · ${shell?.label ?? "—"}`}
            detail={shell?.note ?? "Shell 设置只能在电脑上切换"}
          />
        </Popover>
      )}
      {open === "output" && output !== undefined && (
        <Popover anchor={card.current} label={output.title} onClose={close} wide>
          <div className="phone-popover-h">{output.title}</div>
          <pre className="phone-output">{output.text}</pre>
        </Popover>
      )}
    </div>
  );
}
