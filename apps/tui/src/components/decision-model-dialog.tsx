import { Box, Text, useInput, type DOMElement } from "ink";
import { useEffect, useRef, useState } from "react";
import {
  GEMINI_DECISION_ENDPOINTS,
  JEV_ENDPOINTS,
  validateSettingsPatch,
  type DecisionModelConfig,
  type GeminiDecisionEndpoint,
  type JevEndpoint,
  type Runtime,
} from "@nocturne/core";
import { DialogFrame } from "./dialog/dialog-frame.js";
import { Buttons } from "./dialog/buttons.js";
import { Segmented } from "./dialog/segmented.js";
import { TextInput, inputWindow } from "./dialog/text-input.js";
import { moveFocus } from "./dialog/focus.js";
import { screenRect, type DialogMouseFrame } from "./dialog/mouse.js";
import { InputCursor } from "./input-cursor.js";
import { PickList } from "./pick-list.js";
import { useTheme } from "../theme.js";

const SOURCES = ["unset", "gemini", "jev"] as const;
const GEMINI_EPS: readonly GeminiDecisionEndpoint[] = ["ai-studio", "custom"];
const JEV_EPS: readonly JevEndpoint[] = ["opencode-zen", "typesafe", "custom"];
const DEFAULT_MODELS = new Set(["gemini-decision-1", "jev-1.13-free", "jev-latest"]);
const DEFAULT_ENVS = new Set(["GEMINI_API_KEY", "OPENCODE_API_KEY", "TYPESAFE_API_KEY"]);

export function DecisionModelDialog({
  runtime,
  initial,
  width,
  height,
  onApply,
  onCancel,
  onMouseFrame,
}: {
  runtime: Runtime;
  initial: DecisionModelConfig | undefined;
  width: number;
  height: number;
  onApply: (
    decisionModel: DecisionModelConfig | null,
    decisionModelKey?: string,
  ) => Promise<string | undefined>;
  onCancel: () => void;
  onMouseFrame?: ((frame: DialogMouseFrame | undefined) => void) | undefined;
}): React.JSX.Element {
  const theme = useTheme();
  const [source, setSource] = useState<"unset" | "gemini" | "jev">(initial?.source ?? "unset");
  const [geminiEndpoint, setGeminiEndpoint] = useState<GeminiDecisionEndpoint>(
    initial?.source === "gemini" ? initial.endpoint : "ai-studio",
  );
  const [jevEndpoint, setJevEndpoint] = useState<JevEndpoint>(
    initial?.source === "jev" ? initial.endpoint : "opencode-zen",
  );
  const [baseURL, setBaseURL] = useState(initial?.baseURL ?? "");
  const [model, setModel] = useState(initial?.model ?? "gemini-decision-1");
  const [credKind, setCredKind] = useState<"provider" | "env" | "stored">(() => {
    if (initial === undefined) return "env";
    if ("provider" in initial.credential) return "provider";
    if ("env" in initial.credential) return "env";
    return "stored";
  });
  const [credProvider, setCredProvider] = useState(
    initial !== undefined && "provider" in initial.credential ? initial.credential.provider : "",
  );
  const [credEnv, setCredEnv] = useState(
    initial !== undefined && "env" in initial.credential
      ? initial.credential.env
      : "GEMINI_API_KEY",
  );
  const [secret, setSecret] = useState("");
  const [focus, setFocus] = useState("source");
  const [nested, setNested] = useState<"models" | "provider" | undefined>();
  const [models, setModels] = useState<string[]>();
  const [providers, setProviders] = useState<{ id: string; host?: string | undefined }[]>([]);
  const [notice, setNotice] = useState<string>();
  const [cursor, setCursor] = useState(0);
  const boxes = useRef(new Map<string, DOMElement>());
  const request = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const saving = useRef(false);

  useEffect(() => {
    mounted.current = true;
    void runtime
      .listReviewerProviders()
      .then((list) => {
        if (!mounted.current) return;
        setProviders(list);
        if (credProvider === "" && list[0] !== undefined) setCredProvider(list[0].id);
      })
      .catch(() => undefined);
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, [runtime]);

  const canBorrowProvider =
    source === "jev" && jevEndpoint === "opencode-zen" && providers.length > 0;
  const effectiveCredKind = credKind === "provider" && !canBorrowProvider ? "env" : credKind;
  const isCustom =
    (source === "gemini" && geminiEndpoint === "custom") ||
    (source === "jev" && jevEndpoint === "custom");

  const fields =
    source === "unset"
      ? ["source"]
      : ["source", "endpoint", ...(isCustom ? ["url"] : []), "model", "credential", "value"];
  const order = [...fields, "cancel", "save"];

  const textValue =
    focus === "url"
      ? baseURL
      : focus === "model"
        ? model
        : effectiveCredKind === "env"
          ? credEnv
          : effectiveCredKind === "provider"
            ? credProvider
            : secret;
  const editing =
    focus === "url" || focus === "model" || (focus === "value" && effectiveCredKind !== "provider");

  const switchSource = (next: "unset" | "gemini" | "jev") => {
    setSource(next);
    setNotice(undefined);
    if (next === "gemini") {
      if (credKind === "provider") setCredKind("env");
      if (model.trim() === "" || DEFAULT_MODELS.has(model)) setModel("gemini-decision-1");
      if (credEnv.trim() === "" || DEFAULT_ENVS.has(credEnv)) setCredEnv("GEMINI_API_KEY");
    } else if (next === "jev") {
      if (jevEndpoint !== "opencode-zen" && credKind === "provider") setCredKind("env");
      if (model.trim() === "" || DEFAULT_MODELS.has(model)) {
        setModel(jevEndpoint === "opencode-zen" ? "jev-1.13-free" : "jev-latest");
      }
      if (credEnv.trim() === "" || DEFAULT_ENVS.has(credEnv)) {
        setCredEnv(jevEndpoint === "opencode-zen" ? "OPENCODE_API_KEY" : "TYPESAFE_API_KEY");
      }
    }
  };

  const switchJevEndpoint = (next: JevEndpoint) => {
    setJevEndpoint(next);
    setNotice(undefined);
    if (next !== "opencode-zen" && credKind === "provider") setCredKind("env");
    if (model.trim() === "" || DEFAULT_MODELS.has(model)) {
      setModel(next === "opencode-zen" ? "jev-1.13-free" : "jev-latest");
    }
    if (credEnv.trim() === "" || DEFAULT_ENVS.has(credEnv)) {
      setCredEnv(next === "opencode-zen" ? "OPENCODE_API_KEY" : "TYPESAFE_API_KEY");
    }
  };

  const buildConfig = (): DecisionModelConfig | null | string => {
    if (source === "unset") return null;
    const trimmedModel = model.trim();
    if (trimmedModel === "") return "模型必填";
    if (source === "gemini") {
      if (geminiEndpoint === "custom" && baseURL.trim() === "") return "自定义地址必填";
      const credential =
        effectiveCredKind === "stored"
          ? ({ stored: true } as const)
          : ({ env: credEnv.trim() } as const);
      if ("env" in credential && credential.env === "") return "填写环境变量名";
      return {
        source: "gemini",
        endpoint: geminiEndpoint,
        ...(geminiEndpoint === "custom" ? { baseURL: baseURL.trim() } : {}),
        model: trimmedModel,
        credential,
      };
    }
    if (jevEndpoint === "custom" && baseURL.trim() === "") return "自定义地址必填";
    const credential =
      effectiveCredKind === "provider"
        ? ({ provider: credProvider } as const)
        : effectiveCredKind === "stored"
          ? ({ stored: true } as const)
          : ({ env: credEnv.trim() } as const);
    if ("provider" in credential && credential.provider === "") return "选择沿用哪个服务商的凭据";
    if ("env" in credential && credential.env === "") return "填写环境变量名";
    return {
      source: "jev",
      endpoint: jevEndpoint,
      ...(jevEndpoint === "custom" ? { baseURL: baseURL.trim() } : {}),
      model: trimmedModel,
      credential,
    };
  };

  const openModels = async () => {
    const built = buildConfig();
    if (built === null || typeof built === "string") return;
    setNested("models");
    setModels(undefined);
    setNotice(undefined);
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await runtime.listDecisionModels(built, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setModels(result.models);
      setNotice(result.warning);
    } catch {
      if (!mounted.current || controller.signal.aborted) return;
      const fallback =
        built.source === "gemini"
          ? GEMINI_DECISION_ENDPOINTS[built.endpoint].model
          : JEV_ENDPOINTS[built.endpoint].model;
      setModels([fallback]);
    }
  };

  const apply = () => {
    const built = buildConfig();
    if (typeof built === "string") {
      setNotice(built);
      return;
    }
    try {
      validateSettingsPatch({ decisionModel: built });
    } catch {
      setNotice("请填写有效的接入点、模型和凭据");
      return;
    }
    if (saving.current) return;
    saving.current = true;
    const key =
      built !== null && "stored" in built.credential && secret.trim() !== ""
        ? secret.trim()
        : undefined;
    void onApply(built, key).then((failure) => {
      saving.current = false;
      if (failure === undefined || !mounted.current) return;
      setNotice(`保存失败：${failure}`);
    });
  };

  const setText = (next: string) => {
    if (focus === "url") setBaseURL(next);
    else if (focus === "model") setModel(next);
    else if (effectiveCredKind === "env") setCredEnv(next);
    else if (effectiveCredKind === "stored") setSecret(next);
  };

  const activate = (id: string) => {
    if (id === "cancel") onCancel();
    else if (id === "save") apply();
    else if (id === "source") setFocus(source === "unset" ? "save" : "endpoint");
    else if (id === "endpoint") {
      if (isCustom) {
        setFocus("url");
        setCursor(Array.from(baseURL).length);
      } else {
        setFocus("model");
        setCursor(Array.from(model).length);
      }
    } else if (id === "url") {
      setFocus("model");
      setCursor(Array.from(model).length);
    } else if (id === "model") {
      void openModels();
    } else if (id === "credential") {
      setFocus("value");
    } else if (id === "value") {
      if (effectiveCredKind === "provider") setNested("provider");
      else setFocus("save");
    }
  };

  useInput(
    (input, key) => {
      if (nested !== undefined) return;
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.ctrl && input === "s") {
        apply();
        return;
      }
      if (key.upArrow || key.downArrow || key.tab) {
        const dir = key.upArrow ? "up" : key.downArrow ? "down" : key.shift ? "shiftTab" : "tab";
        const next = moveFocus(order, focus, dir);
        setFocus(next);
        setCursor(
          Array.from(
            next === "url"
              ? baseURL
              : next === "model"
                ? model
                : next === "value"
                  ? effectiveCredKind === "env"
                    ? credEnv
                    : secret
                  : "",
          ).length,
        );
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        const step = key.leftArrow ? -1 : 1;
        if (focus === "source") {
          const i = SOURCES.indexOf(source);
          switchSource(SOURCES[(i + step + SOURCES.length) % SOURCES.length]!);
          return;
        }
        if (focus === "endpoint") {
          if (source === "gemini") {
            const i = GEMINI_EPS.indexOf(geminiEndpoint);
            setGeminiEndpoint(GEMINI_EPS[(i + step + GEMINI_EPS.length) % GEMINI_EPS.length]!);
          } else if (source === "jev") {
            const i = JEV_EPS.indexOf(jevEndpoint);
            switchJevEndpoint(JEV_EPS[(i + step + JEV_EPS.length) % JEV_EPS.length]!);
          }
          return;
        }
        if (focus === "credential") {
          const kinds: readonly ("provider" | "env" | "stored")[] = canBorrowProvider
            ? ["provider", "env", "stored"]
            : ["env", "stored"];
          const i = kinds.indexOf(effectiveCredKind);
          setCredKind(kinds[(i + step + kinds.length) % kinds.length]!);
          return;
        }
        if (focus === "cancel" || focus === "save") {
          setFocus(focus === "cancel" ? "save" : "cancel");
          return;
        }
        if (editing) {
          const chars = Array.from(textValue);
          setCursor(Math.max(0, Math.min(chars.length, cursor + step)));
          return;
        }
      }
      if (key.return) {
        activate(focus);
        return;
      }
      if (editing) {
        const chars = Array.from(textValue);
        const pos = Math.max(0, Math.min(chars.length, cursor));
        if (key.backspace || key.delete) {
          if (pos > 0) {
            chars.splice(pos - 1, 1);
            setText(chars.join(""));
            setCursor(pos - 1);
          }
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          const inserted = Array.from(input);
          chars.splice(pos, 0, ...inserted);
          setText(chars.join(""));
          setCursor(pos + inserted.length);
        }
      }
    },
    { isActive: nested === undefined },
  );

  useInput(
    (_input, key) => {
      if (key.escape) {
        request.current?.abort();
        setNested(undefined);
      }
    },
    { isActive: nested === "models" && models === undefined },
  );

  const framed = width >= 44 && height >= 12;
  const dialogWidth = Math.min(width, 64);
  const dialogHeight = Math.min(height, Math.max(10, fields.length * 2 + 6));
  const left = Math.max(0, Math.floor((width - dialogWidth) / 2));
  const top = Math.max(0, Math.floor((height - dialogHeight) / 2));
  const innerWidth = Math.max(10, dialogWidth - (framed ? 4 : 2));
  const visibleCount = Math.max(1, Math.floor((dialogHeight - 5) / 2));
  const focusIndex = Math.max(0, fields.indexOf(focus));
  const start = Math.max(0, Math.min(fields.length - visibleCount, focusIndex - visibleCount + 1));

  const onBox = (id: string, node: DOMElement | null) => {
    if (node) boxes.current.set(id, node);
    else boxes.current.delete(id);
  };

  useEffect(() => {
    if (!onMouseFrame) return;
    if (nested !== undefined) {
      onMouseFrame(undefined);
      return;
    }
    const hitBoxes: DialogMouseFrame["boxes"] = order.flatMap((id) => {
      const node = boxes.current.get(id);
      if (!node) return [];
      const rect = screenRect(node);
      if (rect.width <= 0 || rect.height <= 0) return [];
      return [{ id, row: rect.row, colStart: rect.col, colEnd: rect.col + rect.width - 1 }];
    });
    onMouseFrame({
      layer: "decisionModel",
      boxes: hitBoxes,
      click: (id) => {
        setFocus(id);
        if (id === "cancel" || id === "save") activate(id);
      },
      wheel: () => undefined,
    });
    return () => {
      onMouseFrame(undefined);
    };
  });

  const credOptions = canBorrowProvider
    ? ["沿用服务商", "环境变量", "单独密钥"]
    : ["环境变量", "单独密钥"];
  const credIndex = canBorrowProvider
    ? effectiveCredKind === "provider"
      ? 0
      : effectiveCredKind === "env"
        ? 1
        : 2
    : effectiveCredKind === "env"
      ? 0
      : 1;

  const endpointOptions =
    source === "gemini"
      ? ["Google AI Studio", "自定义地址"]
      : ["opencode-zen", "typesafe", "自定义地址"];
  const endpointIndex =
    source === "gemini" ? GEMINI_EPS.indexOf(geminiEndpoint) : JEV_EPS.indexOf(jevEndpoint);

  const labels: Record<string, string> = {
    source: "来源",
    endpoint: "接入点",
    url: "自定义地址",
    model: "模型",
    credential: "凭据",
    value:
      effectiveCredKind === "provider"
        ? "沿用服务商"
        : effectiveCredKind === "env"
          ? "环境变量"
          : "单独密钥",
  };
  const values: Record<string, string> = {
    url: baseURL,
    model,
    value:
      effectiveCredKind === "provider"
        ? credProvider
        : effectiveCredKind === "env"
          ? credEnv
          : "*".repeat(Array.from(secret).length),
  };

  const picker =
    nested === "models" ? (
      models ? (
        <PickList
          title="决策模型"
          width={innerWidth}
          active
          items={[
            ...models.map((id) => ({ label: id, value: id })),
            { label: "手动输入", value: "" },
          ]}
          onCancel={() => {
            request.current?.abort();
            setNested(undefined);
          }}
          onPick={(id) => {
            setNested(undefined);
            if (id) {
              setModel(id);
              setFocus("credential");
            } else {
              setFocus("model");
              setCursor(Array.from(model).length);
            }
          }}
        />
      ) : (
        <Text>正在拉取模型列表…（Esc 取消）</Text>
      )
    ) : nested === "provider" ? (
      <PickList
        title="沿用服务商"
        width={innerWidth}
        active
        items={providers.map((entry) => ({
          label: `${entry.id}${entry.host ? ` · ${entry.host}` : ""}`,
          value: entry.id,
        }))}
        onCancel={() => {
          setNested(undefined);
        }}
        onPick={(id) => {
          setCredProvider(id);
          setNested(undefined);
          setFocus("save");
        }}
      />
    ) : undefined;

  return (
    <Box
      width={width}
      height={height}
      flexDirection="column"
      paddingLeft={left}
      paddingTop={top}
      overflow="hidden"
    >
      {width < 12 || height < 5 ? (
        <Text>终端太小，请放大（Esc 返回）</Text>
      ) : (
        <DialogFrame
          title="/settings · 决策模型"
          width={dialogWidth}
          height={dialogHeight}
          framed={framed}
        >
          {picker ?? (
            <>
              <Box flexDirection="column" flexGrow={1} overflow="hidden">
                {fields.slice(start, start + visibleCount).map((id, index) => (
                  <Box
                    key={id}
                    flexDirection="column"
                    flexShrink={0}
                    ref={(node) => {
                      onBox(id, node);
                    }}
                  >
                    <Text color={theme.muted} wrap="truncate">
                      {labels[id]}
                    </Text>
                    {id === "source" || id === "endpoint" || id === "credential" ? (
                      <Segmented
                        options={
                          id === "source"
                            ? ["未设置", "Gemini", "Jev"]
                            : id === "endpoint"
                              ? endpointOptions
                              : credOptions
                        }
                        selected={
                          id === "source"
                            ? SOURCES.indexOf(source)
                            : id === "endpoint"
                              ? endpointIndex
                              : credIndex
                        }
                        focused={focus === id}
                        width={innerWidth}
                        maxLines={1}
                      />
                    ) : (
                      <TextInput
                        value={values[id] ?? ""}
                        cursor={Math.min(cursor, Array.from(values[id] ?? "").length)}
                        focused={focus === id}
                        width={innerWidth}
                      />
                    )}
                    {focus === id && editing ? (
                      <InputCursor
                        active
                        prefix=""
                        text=""
                        width={innerWidth}
                        x={
                          left +
                          (framed ? 2 : 0) +
                          2 +
                          inputWindow(
                            effectiveCredKind === "stored" && id === "value"
                              ? "*".repeat(Array.from(secret).length)
                              : textValue,
                            Math.min(cursor, Array.from(textValue).length),
                            innerWidth,
                          ).column
                        }
                        y={top + (framed ? 1 : 0) + 2 + index * 2 - height}
                      />
                    ) : null}
                  </Box>
                ))}
              </Box>
              {notice ? (
                <Text color={theme.warning} wrap="truncate">
                  {notice}
                </Text>
              ) : null}
              <Buttons focused={focus} readonly={false} width={innerWidth} onBox={onBox} />
            </>
          )}
        </DialogFrame>
      )}
    </Box>
  );
}
