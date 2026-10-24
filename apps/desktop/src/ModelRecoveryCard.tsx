/**
 * 「换模型」卡片：会话记录的模型已不在当前配置里（resumeSession 报
 * invalid_model）时，主区占位显示这张卡片代替「打开会话失败 + 重试」。
 * 模型清单按会话工作区取（listModels / defaultModel 带 workspaceRoot），
 * 分组与禁用规则复用状态栏模型菜单（modelGroups + ChoiceMenu）。
 * 选好后由调用方带 model 重新 resumeSession；Core 先写 config_changed 再开放，
 * 以后再打开这个会话不会再进这张卡片（sessions.md 4.2）。
 * ADR-0054 §4：错误带结构化 disabled 时换成「已停用」文案，并给「重新启用」按钮。
 */
import { useEffect, useRef, useState } from "react";
import type { ModelRef } from "@nocturne/core/protocol";
import type { RpcRuntime } from "@nocturne/rpc/client";

import { ChoiceMenu } from "./Menu";
import type { ModelInfo } from "./rpc-types";
import { modelGroups, refKey } from "./session-controls";
import { modelRefText } from "./model-ref";

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 默认选中：上次尝试的替代模型 → 当前生效的默认模型 → 第一个可用模型 */
function preselect(
  models: ModelInfo[],
  attempted: ModelRef | string | undefined,
  configured: ModelRef | undefined,
): string | undefined {
  const usable = (key: string | undefined) =>
    key !== undefined &&
    models.some((info) => refKey(info.ref) === key && info.unavailable === undefined);
  const attemptedKey = typeof attempted === "string" ? attempted : attempted && refKey(attempted);
  if (usable(attemptedKey)) return attemptedKey;
  const configuredKey = configured && refKey(configured);
  if (usable(configuredKey)) return configuredKey;
  const first = models.find((info) => info.unavailable === undefined);
  return first === undefined ? undefined : refKey(first.ref);
}

export function ModelRecoveryCard({
  runtime,
  workspace,
  error,
  attempted,
  disabled,
  disabledModel,
  providersVersion,
  onContinue,
  onOpenProviders,
  onReenable,
}: {
  runtime: RpcRuntime | undefined;
  /** 会话的工作区：模型清单按它合并项目层 */
  workspace: string;
  /** Core 的原始错误信息（排查用，次要样式） */
  error: string;
  /** 上一次携带的替代模型（换模型后仍失败时沿用） */
  attempted?: ModelRef | string | undefined;
  /** 停用来源（ADR-0054）：provider 整体停用或该模型逐个停用 */
  disabled?: "provider" | "model" | undefined;
  /** 被停用的模型引用（Core 错误里的结构化字段） */
  disabledModel?: ModelRef | undefined;
  /** 服务商配置变更计数：从服务商页配好回来时重新拉清单 */
  providersVersion: number;
  onContinue: (model: ModelRef) => void;
  onOpenProviders: () => void;
  /** 重新启用被停用的服务商或模型；未提供时不显示该按钮 */
  onReenable?: (() => void) | undefined;
}) {
  const [data, setData] = useState<{ models: ModelInfo[]; recents: ModelRef[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [menuOpen, setMenuOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const attemptedRef = useRef(attempted);
  attemptedRef.current = attempted;

  useEffect(() => {
    if (runtime === undefined) return;
    let cancelled = false;
    const scope = { workspaceRoot: workspace };
    void Promise.all([
      runtime.listModels(scope),
      runtime.listRecentModels(),
      runtime.defaultModel(scope),
    ]).then(
      ([models, recents, configured]) => {
        if (cancelled) return;
        setData({ models, recents });
        setLoadError(null);
        setPicked((current) =>
          current !== undefined &&
          models.some((info) => refKey(info.ref) === current && info.unavailable === undefined)
            ? current
            : preselect(models, attemptedRef.current, configured),
        );
      },
      (failure: unknown) => {
        if (!cancelled) setLoadError(message(failure));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [runtime, workspace, providersVersion]);

  const models = data?.models ?? [];
  const chosen = models.find((info) => refKey(info.ref) === picked);
  const empty = data !== null && models.length === 0;
  const disabledRef = disabledModel === undefined ? undefined : refKey(disabledModel);
  const reenableLabel = `重新启用 ${
    disabled === "provider" ? (disabledModel?.provider ?? "") : (disabledRef ?? "")
  }`.trim();

  return (
    <div className="nodecard">
      <h3>{disabled === undefined ? "这个会话用的模型已不可用" : "这个会话用的模型已停用"}</h3>
      <div className="lead">
        {disabled === undefined ? (
          "原来的模型已不可用，选一个继续；之前的记录不变"
        ) : (
          <>
            <span className="mono">{disabledRef ?? "这个模型"}</span>
            {" 已停用，选一个继续；之前的记录不变"}
          </>
        )}
      </div>
      {data === null && loadError === null && <div className="fine">正在读取可用模型…</div>}
      {loadError !== null && <div className="fine">读取模型清单失败：{loadError}</div>}
      {empty && <div className="fine">当前配置里没有可用的模型，请先配置服务商。</div>}
      {data !== null && !empty && (
        <div>
          <button
            ref={trigger}
            className="btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="选择模型"
            onClick={() => {
              setMenuOpen((open) => !open);
            }}
          >
            {chosen === undefined ? "选择模型" : modelRefText(chosen.ref)} ▾
          </button>
          {menuOpen && (
            <ChoiceMenu
              anchor={trigger.current}
              label="选择模型"
              control={{
                value: picked,
                groups: modelGroups(models, data.recents),
                onSelect: (value) => {
                  setPicked(value);
                },
              }}
              onClose={() => {
                setMenuOpen(false);
              }}
            />
          )}
        </div>
      )}
      <div className="acts">
        {data !== null && !empty && (
          <button
            className="btn primary"
            disabled={chosen === undefined || chosen.unavailable !== undefined}
            onClick={() => {
              if (chosen !== undefined) onContinue(chosen.ref);
            }}
          >
            用这个模型继续
          </button>
        )}
        {disabledModel !== undefined && onReenable !== undefined ? (
          <button className="btn" onClick={onReenable}>
            {reenableLabel}
          </button>
        ) : (
          <button className="btn" onClick={onOpenProviders}>
            去配置服务商
          </button>
        )}
      </div>
      <div className="fine">{error}</div>
    </div>
  );
}
