import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type {
  ExternalAgentOverview,
  PendingInputsSnapshot,
  SkillOverview,
} from "@nocturne/core/protocol";

import { completeSlash, parseSlash, type ParsedSlash } from "../commands";
import type { ChoiceControl, ComposerControls, ComposerSubmit, FileRefSource } from "../Composer";
import { PendingInputs } from "../PendingInputs";
import {
  completeFileRefs,
  fileRefDeleteRange,
  fileRefToken,
  type FileIndexEntry,
} from "../file-refs";
import {
  IconAt,
  IconCamera,
  IconImage,
  IconPaperclip,
  IconSend,
  IconShield,
  IconStop,
} from "./icons";
import {
  estimateSubmitBytes,
  formatBytes,
  preparePhoneImage,
  SUBMIT_MESSAGE_LIMIT,
  type PhoneImage,
} from "./phone-images";
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
  "/context": "点右上角的上下文圆环查看占比",
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

export interface PhoneComposerProps {
  variant: "draft" | "session";
  controls: ComposerControls | undefined;
  running: boolean;
  /** 不能发送的原因（未连接等） */
  disabled?: string | undefined;
  placeholder?: string;
  skills?: readonly SkillOverview[];
  externalAgents?: readonly ExternalAgentOverview[];
  /**
   * 发送（ADR-0070 修订 2026-11-01）：Turn 运行中第二参数传 queue（排队），
   * 空闲时不传；待发列表的「立即发送」通过 onUpdatePending 转为 steer（插话）。
   */
  onSubmit: (input: ComposerSubmit, mode?: "steer" | "queue") => Promise<boolean>;
  onInterrupt: () => void;
  /** 待发输入快照（ADR-0070）；缺省不显示待发列表 */
  pendingInputs?: PendingInputsSnapshot | undefined;
  onUpdatePending?:
    ((id: string, patch: { mode?: "steer" | "queue"; text?: string }) => Promise<void>) | undefined;
  onCancelPending?: ((id: string) => Promise<void>) | undefined;
  onResumePending?: (() => Promise<void>) | undefined;
  /** /compact、/mcp：返回字符串时在浮层里显示（/mcp 状态） */
  onSlash: (line: string) => Promise<string | boolean>;
  grantsFooter?: ReactNode;
  /** null：本目录没有项目文件索引（普通对话、草稿），@ 引用不可用 */
  fileRefs?: FileRefSource | null;
  /** 从会话菜单「输入历史」选中的一条：seq 变化时填回输入框 */
  fill?: { text: string; seq: number } | undefined;
  /** 首张图片加入时读一次，模型不支持图片时给出提示（与桌面相同） */
  getVisionHint?: (() => Promise<string | undefined>) | undefined;
  /** 测试注入：图片处理 */
  prepareImage?: (file: File) => Promise<PhoneImage>;
}

type PopoverKind = "attach" | "preset" | "model" | "effort" | "output";

interface PhoneAttachment {
  name: string;
  data: Uint8Array;
  mimeType: string;
  source: "paste" | "upload";
  url: string;
}

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
  pendingInputs,
  onUpdatePending,
  onCancelPending,
  onResumePending,
  onSlash,
  grantsFooter,
  fileRefs = null,
  fill,
  getVisionHint,
  prepareImage: _prepareImage = preparePhoneImage,
}: PhoneComposerProps) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState<PopoverKind | null>(null);
  const [output, setOutput] = useState<{ title: string; text: string }>();
  const [error, setError] = useState<string>();
  const [hint, setHint] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const triggers = useRef<Partial<Record<PopoverKind, HTMLButtonElement | null>>>({});
  const mounted = useRef(true);
  const [attachments, setAttachments] = useState<PhoneAttachment[]>([]);
  const attachmentsRef = useRef<PhoneAttachment[]>([]);
  attachmentsRef.current = attachments;
  const [processing, setProcessing] = useState(0);
  const [vision, setVision] = useState<string>();
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const [refsDismissed, setRefsDismissed] = useState(false);
  const [index, setIndex] = useState<{
    key: string | number;
    entries: FileIndexEntry[];
    failed?: boolean;
  }>();
  const indexLoading = useRef<string | number | null>(null);
  useEffect(
    () => () => {
      mounted.current = false;
      for (const attachment of attachmentsRef.current) URL.revokeObjectURL(attachment.url);
    },
    [],
  );

  // 首张图片加入时问一次视觉能力（模型不支持图片时提示）
  useEffect(() => {
    if (attachments.length === 0) {
      setVision(undefined);
      return;
    }
    if (vision !== undefined || getVisionHint === undefined) return;
    let cancelled = false;
    void getVisionHint().then(
      (text) => {
        if (!cancelled) setVision(text);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [attachments.length, getVisionHint, vision]);

  // @ 引用：首次用到时拉取文件索引，fileRefs.key 变化时重新拉
  const indexKey = index?.key;
  const ensureIndex = useCallback(() => {
    if (fileRefs === null) return;
    const key = fileRefs.key;
    if (indexKey === key || indexLoading.current === key) return;
    indexLoading.current = key;
    void fileRefs
      .load()
      .then(
        (entries) => {
          if (mounted.current) setIndex({ key, entries });
        },
        () => {
          if (mounted.current) setIndex({ key, entries: [], failed: true });
        },
      )
      .finally(() => {
        if (indexLoading.current === key) indexLoading.current = null;
      });
  }, [fileRefs, indexKey]);
  const refToken = fileRefs !== null && !refsDismissed ? fileRefToken(draft, caret) : undefined;
  const refActive = refToken !== undefined;
  useEffect(() => {
    if (refActive) ensureIndex();
  }, [refActive, ensureIndex]);
  const refCompletion = refActive
    ? completeFileRefs(draft, caret, index?.entries ?? [])
    : undefined;
  const indexReady = fileRefs !== null && index?.key === fileRefs.key;

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

  const update = (text: string, nextCaret = text.length) => {
    setDraft(text);
    setCaret(nextCaret);
    setDismissed(false);
    setRefsDismissed(false);
    setHint(undefined);
    setError(undefined);
  };
  const placeCaret = (position: number) => {
    requestAnimationFrame(() => {
      const node = field.current;
      if (node === null) return;
      node.focus();
      node.setSelectionRange(position, position);
      setCaret(position);
    });
  };
  // 只在会话菜单选中新的一条输入历史时填回（update/placeCaret 每次渲染重建，不作依赖）
  const fillSeq = fill?.seq;
  useEffect(() => {
    if (fill === undefined) return;
    update(fill.text);
    placeCaret(fill.text.length);
  }, [fillSeq]);
  const insertRef = () => {
    setOpen(null);
    const node = field.current;
    const at = node?.selectionStart ?? draft.length;
    const before = draft.slice(0, at);
    const after = draft.slice(node?.selectionEnd ?? at);
    const prefix = before === "" || /\s$/.test(before) ? "" : " ";
    const position = before.length + prefix.length + 1;
    update(`${before}${prefix}@${after}`, position);
    placeCaret(position);
    ensureIndex();
  };
  const chooseRef = (insert: string, directory: boolean) => {
    if (refCompletion === undefined) return;
    const next = draft.slice(0, refCompletion.start) + insert + draft.slice(refCompletion.end);
    const position = refCompletion.start + insert.length;
    update(next, position);
    if (!directory) setRefsDismissed(true);
    placeCaret(position);
  };

  const literalPaste = useRef(false);
  const pasteNumber = useRef(1);
  const addFiles = async (files: File[], source: "paste" | "upload" = "upload") => {
    setOpen(null);
    if (files.length === 0) return;
    setProcessing((n) => n + files.length);
    setError(undefined);
    for (const file of files) {
      try {
        const image = {
          name: file.name,
          data: new Uint8Array(await file.arrayBuffer()),
          mimeType: file.type || "application/octet-stream",
        };
        if (!mounted.current) return;
        const url = URL.createObjectURL(new Blob([image.data], { type: image.mimeType }));
        setAttachments((current) => [...current, { ...image, source, url }]);
      } catch (reason) {
        if (mounted.current) setError(errorText(reason));
      } finally {
        if (mounted.current) setProcessing((n) => n - 1);
      }
    }
  };
  const removeAttachment = (at: number) => {
    setAttachments((current) => {
      const removed = current[at];
      if (removed !== undefined) URL.revokeObjectURL(removed.url);
      return current.filter((_, i) => i !== at);
    });
    setError(undefined);
  };
  const messageBytes = estimateSubmitBytes(
    draft,
    attachments.map((attachment) => ({ data: attachment.data, label: attachment.name })),
  );
  const tooLarge =
    messageBytes > SUBMIT_MESSAGE_LIMIT ||
    attachments.reduce((sum, file) => sum + file.data.byteLength, 0) >
      Math.floor((SUBMIT_MESSAGE_LIMIT * 3) / 4) - 1024;

  const toggle = (kind: PopoverKind) => {
    setOpen((current) => (current === kind ? null : kind));
    setError(undefined);
  };
  const close = () => {
    setOpen(null);
  };

  const submit = async () => {
    const text = draft;
    if (disabled !== undefined || submitting || processing > 0) return;
    if (text.trim() === "" && attachmentsRef.current.length === 0) return;
    if (tooLarge) return;
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
      const payload = {
        text: slash?.kind === "work" ? slash.text : text,
        ...(slash?.kind === "work" ? { workMode: slash.workMode } : {}),
        ...(slash?.kind === "skill" ? { skill: slash.invocation } : {}),
        ...(slash?.kind === "agent" ? { delegate: slash.delegate } : {}),
        attachments: attachmentsRef.current.map((attachment) => ({
          data: attachment.data,
          mimeType: attachment.mimeType,
          label: attachment.name,
          source: attachment.source,
        })),
      };
      const accepted = running ? await onSubmit(payload, "queue") : await onSubmit(payload);
      if (accepted && mounted.current) {
        update("");
        for (const attachment of attachmentsRef.current) URL.revokeObjectURL(attachment.url);
        setAttachments([]);
      }
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
              detail={kind === "model" ? undefined : option.detail}
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
      {kind === "preset" && grantsFooter}
    </Popover>
  );

  const busyDisabled = (control: ChoiceControl | undefined) =>
    control === undefined ? "正在读取…" : control.disabled;
  const canSend =
    disabled === undefined &&
    (draft.trim() !== "" || attachments.length > 0) &&
    !submitting &&
    processing === 0 &&
    !tooLarge;

  return (
    <div className="phone-composer">
      {pendingInputs !== undefined && pendingInputs.items.length > 0 && (
        <PendingInputs
          snapshot={pendingInputs}
          running={running}
          disabled={disabled !== undefined}
          onUpdate={onUpdatePending ?? (() => Promise.resolve())}
          onCancel={onCancelPending ?? (() => Promise.resolve())}
          onResume={onResumePending ?? (() => Promise.resolve())}
        />
      )}
      {(hint ?? redirect) !== undefined && (
        <div className="phone-composer-hint" role="status">
          {hint ?? redirect}
        </div>
      )}
      {tooLarge && (
        <div className="phone-composer-error" role="alert">
          这条消息约 {formatBytes(messageBytes)}，超过远程连接单条上限{" "}
          {formatBytes(SUBMIT_MESSAGE_LIMIT)}，不会发送。请减少图片。
        </div>
      )}
      {!tooLarge && vision !== undefined && (
        <div className="phone-composer-hint" role="status">
          {vision}
        </div>
      )}
      {refActive && (
        <div className="phone-slash" role="listbox" aria-label="文件引用补全">
          <div className="phone-popover-group">引用文件</div>
          {!indexReady ? (
            <p className="phone-popover-note">正在读取文件索引…</p>
          ) : index.failed ? (
            <p className="phone-popover-note">读取文件索引失败</p>
          ) : refCompletion === undefined || refCompletion.candidates.length === 0 ? (
            <p className="phone-popover-note">没有匹配的文件</p>
          ) : (
            refCompletion.candidates.slice(0, 50).map((candidate) => (
              <button
                type="button"
                role="option"
                aria-selected={false}
                key={candidate.path}
                className="phone-slash-row ref"
                onClick={() => {
                  chooseRef(candidate.insert, candidate.directory);
                }}
              >
                <b>{candidate.label}</b>
              </button>
            ))
          )}
        </div>
      )}
      {!refActive && slashGroups.length > 0 && (
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
      <div
        className="phone-card"
        ref={card}
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          void addFiles(Array.from(event.dataTransfer.files));
        }}
      >
        {(attachments.length > 0 || processing > 0) && (
          <div className="phone-attachments" aria-label="图片附件">
            {attachments.map((attachment, at) => (
              <span className="phone-attachment" key={attachment.url}>
                {attachment.mimeType.startsWith("image/") ? (
                  <img src={attachment.url} alt={attachment.name} />
                ) : (
                  <span>▤ {attachment.name}</span>
                )}
                <button
                  type="button"
                  aria-label={`移除 ${attachment.name}`}
                  onClick={() => {
                    removeAttachment(at);
                  }}
                >
                  ×
                </button>
                <small>{formatBytes(attachment.data.length)}</small>
              </span>
            ))}
            {processing > 0 && (
              <span className="phone-attachment busy" role="status" aria-label="正在处理图片">
                …
              </span>
            )}
          </div>
        )}
        <textarea
          ref={field}
          aria-label="消息"
          rows={1}
          value={draft}
          placeholder={placeholder ?? "输入消息"}
          onChange={(event) => {
            update(event.target.value, event.target.selectionStart);
          }}
          onSelect={(event) => {
            setCaret(event.currentTarget.selectionStart);
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length) {
              event.preventDefault();
              void addFiles(files);
              return;
            }
            const text = event.clipboardData.getData("text/plain");
            if (!literalPaste.current && new TextEncoder().encode(text).byteLength >= 32768) {
              event.preventDefault();
              void addFiles(
                [new File([text], `pasted-${pasteNumber.current++}.txt`, { type: "text/plain" })],
                "paste",
              );
            }
            literalPaste.current = false;
          }}
          onKeyDown={(event) => {
            literalPaste.current =
              (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "v";
            if (event.key !== "Backspace" && event.key !== "Delete") return;
            const node = event.currentTarget;
            if (node.selectionStart !== node.selectionEnd) return;
            const range = fileRefDeleteRange(
              draft,
              node.selectionStart,
              event.key === "Backspace" ? "backward" : "forward",
            );
            if (range === undefined) return;
            event.preventDefault();
            update(draft.slice(0, range.start) + draft.slice(range.end), range.start);
            placeCaret(range.start);
          }}
        />
        {running ? (
          <>
            <button
              type="button"
              className="phone-send stop"
              aria-label="中断"
              disabled={disabled !== undefined}
              onClick={onInterrupt}
            >
              <IconStop />
            </button>
            {canSend && (
              <button
                type="button"
                className="phone-send"
                aria-label="发送"
                title="发送"
                disabled={!canSend}
                onClick={() => {
                  void submit();
                }}
              >
                <IconSend />
              </button>
            )}
          </>
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
        {tool("attach", "添加文件", <IconPaperclip />)}
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
      </div>
      {(error ?? controls?.error) !== undefined && (
        <div className="phone-composer-error" role="alert">
          {error ?? controls?.error}
        </div>
      )}
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        aria-label="拍照"
        onChange={(event) => {
          void addFiles([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      <input
        ref={gallery}
        type="file"
        multiple
        hidden
        aria-label="选择图片"
        onChange={(event) => {
          void addFiles([...(event.target.files ?? [])]);
          event.target.value = "";
        }}
      />
      {open === "attach" && (
        <Popover anchor={triggers.current.attach ?? null} label="添加" onClose={close}>
          <div className="phone-popover-h">添加</div>
          <PopoverOption
            icon={<IconCamera />}
            label="拍照"
            onSelect={() => {
              camera.current?.click();
            }}
          />
          <PopoverOption
            icon={<IconImage />}
            label="选择图片"
            onSelect={() => {
              gallery.current?.click();
            }}
          />
          <PopoverOption
            icon={<IconAt />}
            label="引用文件"
            disabled={fileRefs === null ? "普通对话与新会话没有项目文件索引" : undefined}
            onSelect={insertRef}
          />
        </Popover>
      )}
      {open === "preset" && controls !== undefined && choicePopover("preset", controls.preset)}
      {open === "model" && controls !== undefined && choicePopover("model", controls.model)}
      {open === "effort" && controls !== undefined && choicePopover("effort", controls.effort)}
      {open === "output" && output !== undefined && (
        <Popover anchor={card.current} label={output.title} onClose={close} wide>
          <div className="phone-popover-h">{output.title}</div>
          <pre className="phone-output">{output.text}</pre>
        </Popover>
      )}
    </div>
  );
}
