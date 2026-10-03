import { Box, Text, useInput, type DOMElement } from "ink";
import { useEffect, useRef, useState } from "react";
import {
  JEV_ENDPOINTS,
  jevBaseURL,
  validateSettingsPatch,
  type JevReviewerConfig,
  type Runtime,
  type SecurityReviewerConfig,
} from "@nocturne/core";
import { DialogFrame } from "./dialog/dialog-frame.js";
import { Buttons } from "./dialog/buttons.js";
import stringWidth from "string-width";
import { Segmented, segmentedLines } from "./dialog/segmented.js";
import { TextInput, inputWindow } from "./dialog/text-input.js";
import { moveFocus } from "./dialog/focus.js";
import { screenRect, type DialogMouseFrame } from "./dialog/mouse.js";
import { InputCursor } from "./input-cursor.js";
import { ModelPicker } from "./model-picker.js";
import { PickList } from "./pick-list.js";
import { useTheme } from "../theme.js";

const BACKENDS = ["off", "jev", "model"] as const;
const ENDPOINTS = ["opencode-zen", "typesafe", "custom"] as const;

export function ReviewerDialog({
  runtime,
  initial,
  initialKey,
  disclosureAccepted = false,
  width,
  height,
  onApply,
  onCancel,
  onMouseFrame,
}: {
  runtime: Runtime;
  initial: SecurityReviewerConfig | undefined;
  initialKey?: string | undefined;
  disclosureAccepted?: boolean | undefined;
  width: number;
  height: number;
  /** 保存即落盘：返回错误文案则留在对话框内显示，成功返回 undefined 由调用方关闭 */
  onApply: (
    reviewer: SecurityReviewerConfig,
    key?: string,
    disclosure?: boolean,
  ) => Promise<string | undefined>;
  onCancel: () => void;
  onMouseFrame?: ((frame: DialogMouseFrame | undefined) => void) | undefined;
}): React.JSX.Element {
  const theme = useTheme();
  const [backend, setBackend] = useState(initial?.backend ?? "off");
  const [jev, setJev] = useState<JevReviewerConfig>(() =>
    initial?.backend === "jev"
      ? initial
      : {
          backend: "jev",
          endpoint: "opencode-zen",
          model: JEV_ENDPOINTS["opencode-zen"].model,
          credential: { env: JEV_ENDPOINTS["opencode-zen"].env },
          minConfidence: 0.7,
        },
  );
  const [model, setModel] = useState(initial?.backend === "model" ? initial.model : undefined);
  const [secret, setSecret] = useState(initialKey ?? "");
  const [threshold, setThreshold] = useState(String(jev.minConfidence ?? 0.7));
  const [focus, setFocus] = useState("backend");
  const [nested, setNested] = useState<
    "models" | "model" | "credential" | "provider" | undefined
  >();
  const [manual, setManual] = useState(false);
  const [models, setModels] = useState<string[]>();
  const [providers, setProviders] = useState<{ id: string; host?: string | undefined }[]>([]);
  const [matching, setMatching] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [disclosure, setDisclosure] = useState(false);
  const [accepted, setAccepted] = useState(disclosureAccepted);
  const [cursor, setCursor] = useState(0);
  const boxes = useRef(new Map<string, DOMElement>());
  const request = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const saving = useRef(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      mounted.current = false;
      request.current?.abort();
    },
    [],
  );
  const fields =
    backend === "jev"
      ? [
          "backend",
          "endpoint",
          ...(jev.endpoint === "custom" ? ["url"] : []),
          "model",
          "credential",
          "value",
          "threshold",
        ]
      : backend === "model"
        ? ["backend", "model"]
        : ["backend"];
  const order = [...fields, "cancel", "save"];
  const textValue =
    focus === "url"
      ? (jev.baseURL ?? "")
      : focus === "threshold"
        ? threshold
        : focus === "model"
          ? jev.model
          : "env" in jev.credential
            ? jev.credential.env
            : "provider" in jev.credential
              ? jev.credential.provider
              : secret;
  const editing =
    focus === "url" ||
    focus === "threshold" ||
    (focus === "model" && manual) ||
    (focus === "value" && !("provider" in jev.credential));
  const credentialLabel =
    "provider" in jev.credential
      ? `借用服务商 · ${jev.credential.provider}`
      : "env" in jev.credential
        ? "环境变量"
        : "单独密钥（凭据库）";
  const credentialValue =
    "provider" in jev.credential
      ? jev.credential.provider
      : "env" in jev.credential
        ? jev.credential.env
        : secret
          ? "*".repeat(Array.from(secret).length)
          : "输入密钥 / 留空保留已有密钥";
  const chooseEndpoint = async (endpoint: JevReviewerConfig["endpoint"], baseURL?: string) => {
    const current = ++generation.current;
    setMatching(true);
    setNotice("正在匹配可借用的服务商…");
    try {
      const config = await runtime.defaultReviewer(endpoint, baseURL);
      if (!mounted.current || current !== generation.current) return;
      setMatching(false);
      setJev(config);
      setSecret("");
      setManual(false);
      setNotice(undefined);
    } catch {
      if (mounted.current && current === generation.current) {
        setMatching(false);
        setNotice("无法读取服务商，请选择环境变量或单独密钥");
      }
    }
  };
  const openModels = async () => {
    if (matching) return;
    if (backend === "model") {
      setNested("model");
      return;
    }
    setNested("models");
    setModels(undefined);
    setNotice(undefined);
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await runtime.listReviewerModels(jev, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setModels(result.models);
      setNotice(result.warning);
    } catch {
      if (!mounted.current || controller.signal.aborted) return;
      setModels([JEV_ENDPOINTS[jev.endpoint].model]);
      setNotice("模型列表拉取失败，已退回默认模型；也可手动输入");
    }
  };
  const apply = (confirmed = accepted) => {
    if (matching) return;
    if (backend === "model" && !model) {
      setNotice("请选择审查模型");
      setFocus("model");
      return;
    }
    const selected: SecurityReviewerConfig =
      backend === "jev"
        ? { ...jev, minConfidence: Number(threshold) }
        : backend === "model" && model
          ? { backend, model }
          : { backend: "off" };
    try {
      validateSettingsPatch({ "permission.reviewer": selected });
    } catch {
      setNotice("请填写有效的接入点、模型、凭据和 0–1 置信度阈值");
      return;
    }
    if (
      backend === "jev" &&
      runtime.getPreference("jevDisclosureAccepted") !== "yes" &&
      !confirmed
    ) {
      setDisclosure(true);
      setFocus("cancel");
      return;
    }
    if (saving.current) return;
    saving.current = true;
    setNotice("正在保存…");
    void onApply(
      selected,
      backend === "jev" && "stored" in jev.credential && secret ? secret : undefined,
      backend === "jev" && confirmed,
    ).then((failure) => {
      saving.current = false;
      if (failure === undefined || !mounted.current) return;
      setDisclosure(false);
      setNotice(`保存失败：${failure}`);
    });
  };
  const activate = (id: string) => {
    if (id === "cancel") {
      if (disclosure) setDisclosure(false);
      else onCancel();
    } else if (id === "save") {
      if (disclosure) {
        setAccepted(true);
        apply(true);
      } else apply();
    } else if (id === "backend") {
      if (backend === "model") void openModels();
      else if (backend === "jev") setFocus("endpoint");
      else setFocus("save");
    } else if (id === "endpoint") {
      if (jev.endpoint === "custom") {
        setFocus("url");
        setCursor(Array.from(jev.baseURL ?? "").length);
      } else void openModels();
    } else if (id === "url") {
      void chooseEndpoint("custom", jev.baseURL).then(() => {
        setFocus("model");
      });
    } else if (id === "model") {
      if (manual) setFocus("credential");
      else void openModels();
    } else if (id === "credential") setNested("credential");
    else if (id === "value" && "provider" in jev.credential) {
      void runtime
        .listReviewerProviders()
        .then((entries) => {
          if (mounted.current) {
            setProviders(entries);
            if (entries.length) setNested("provider");
            else {
              setNested(undefined);
              setNotice("没有可借用的服务商，请选择环境变量或单独密钥");
            }
          }
        })
        .catch(() => {
          if (mounted.current) setNotice("无法读取服务商清单");
        });
    } else if (id === "value") setFocus("threshold");
    else if (id === "threshold") setFocus("save");
  };
  useInput(
    (input, key) => {
      if (nested) return;
      if (key.escape || (key.ctrl && (input === "c" || input === "d"))) {
        if (disclosure) setDisclosure(false);
        else onCancel();
        return;
      }
      if (key.tab || key.upArrow || key.downArrow) {
        const next = moveFocus(
          disclosure ? ["cancel", "save"] : order,
          focus,
          key.tab ? (key.shift ? "shiftTab" : "tab") : key.upArrow ? "up" : "down",
        );
        setFocus(next);
        setCursor(9999);
        return;
      }
      if (key.return || (input === " " && (!editing || disclosure))) {
        activate(focus);
        return;
      }
      if (!disclosure && focus === "backend" && (key.leftArrow || key.rightArrow)) {
        const next = BACKENDS[(BACKENDS.indexOf(backend) + (key.leftArrow ? 2 : 1)) % 3] ?? "off";
        setBackend(next);
        if (next === "jev" && initial?.backend !== "jev")
          void chooseEndpoint(jev.endpoint, jev.baseURL);
        return;
      }
      if (!disclosure && focus === "endpoint" && (key.leftArrow || key.rightArrow)) {
        const next =
          ENDPOINTS[(ENDPOINTS.indexOf(jev.endpoint) + (key.leftArrow ? 2 : 1)) % 3] ??
          "opencode-zen";
        void chooseEndpoint(next);
        return;
      }
      if (editing && !disclosure) {
        const chars = Array.from(textValue);
        const position = Math.min(cursor, chars.length);
        if (key.leftArrow || key.rightArrow) {
          setCursor(Math.max(0, Math.min(chars.length, position + (key.leftArrow ? -1 : 1))));
          return;
        }
        if (key.ctrl && input === "u") {
          chars.splice(0);
          setCursor(0);
        } else if (key.backspace || key.delete) {
          if (position > 0) chars.splice(position - 1, 1);
          setCursor(Math.max(0, position - 1));
        } else if (!key.ctrl && !key.meta && input && !/[\x00-\x1f\x7f]/.test(input)) {
          chars.splice(position, 0, ...Array.from(input));
          setCursor(position + Array.from(input).length);
        } else return;
        const value = chars.join("");
        if (focus === "url") setJev({ ...jev, baseURL: value });
        else if (focus === "threshold") setThreshold(value);
        else if (focus === "model") setJev({ ...jev, model: value });
        else if ("env" in jev.credential) setJev({ ...jev, credential: { env: value } });
        else setSecret(value);
        return;
      }
      if (key.leftArrow || key.rightArrow)
        setFocus(
          moveFocus(
            disclosure ? ["cancel", "save"] : order,
            focus,
            key.leftArrow ? "left" : "right",
          ),
        );
    },
    { isActive: !nested },
  );
  const outerWidth = Math.max(1, Math.min(72, width - 4));
  const framed = outerWidth >= 36 && height >= 12;
  const dialogWidth = framed ? outerWidth : width;
  const dialogHeight = framed ? Math.min(height - 2, 8 + fields.length * 2) : height;
  const left = framed ? Math.floor((width - dialogWidth) / 2) : 0;
  const top = framed ? Math.floor((height - dialogHeight) / 2) : 0;
  const innerWidth = Math.max(1, dialogWidth - (framed ? 4 : 0));
  const visibleCount = Math.max(1, Math.floor((dialogHeight - (framed ? 7 : 5)) / 2));
  const start = Math.max(
    0,
    Math.min(fields.length - visibleCount, fields.indexOf(focus) - visibleCount + 1),
  );
  const onBox = (id: string, node: DOMElement | null) => {
    if (node) boxes.current.set(id, node);
    else boxes.current.delete(id);
  };
  useEffect(() => {
    if (!onMouseFrame || nested) return;
    const hits = [...boxes.current].flatMap(([id, node]) => {
      const rect = screenRect(node);
      if (disclosure && id !== "cancel" && id !== "save") return [];
      if (id === "backend" || id === "endpoint") {
        const options = id === "backend" ? ["关闭", "Jev", "小模型"] : [...ENDPOINTS];
        const selected =
          id === "backend" ? BACKENDS.indexOf(backend) : ENDPOINTS.indexOf(jev.endpoint);
        const line = segmentedLines(options, selected, innerWidth, 1)[0] ?? "";
        let offset = 2;
        return (
          line.startsWith("<") ? [line.split(" / ")[0] ?? ""] : (line.match(/\[[^\]]*\]/g) ?? [])
        ).map((token, index) => {
          const hit = {
            id: `${id}:${line.startsWith("<") ? "next" : index}`,
            row: rect.row + 1,
            colStart: rect.col + offset,
            colEnd: rect.col + offset + stringWidth(token) - 1,
          };
          offset += stringWidth(token) + 1;
          return hit;
        });
      }
      const textField =
        id === "url" ||
        id === "threshold" ||
        (id === "model" && manual) ||
        (id === "value" && !("provider" in jev.credential));
      return Array.from({ length: textField ? 1 : rect.height }, (_, row) => ({
        id,
        row: rect.row + row + (textField ? 1 : 0),
        colStart: rect.col,
        colEnd: rect.col + rect.width - 1,
      }));
    });
    onMouseFrame({
      layer: "reviewer",
      boxes: hits.filter((hit) => hit.row > top && hit.row < top + dialogHeight),
      click: (id, event) => {
        const [field = "", index] = id.split(":");
        setFocus(field);
        setCursor(9999);
        if (field === "backend") {
          const next =
            BACKENDS[index === "next" ? (BACKENDS.indexOf(backend) + 1) % 3 : Number(index)] ??
            "off";
          setBackend(next);
          if (next === "jev" && initial?.backend !== "jev")
            void chooseEndpoint(jev.endpoint, jev.baseURL);
        } else if (field === "endpoint")
          void chooseEndpoint(
            ENDPOINTS[
              index === "next" ? (ENDPOINTS.indexOf(jev.endpoint) + 1) % 3 : Number(index)
            ] ?? "opencode-zen",
          );
        else if (
          field === "url" ||
          field === "threshold" ||
          (field === "model" && manual) ||
          (field === "value" && !("provider" in jev.credential))
        ) {
          const rect = screenRect(boxes.current.get(field));
          const raw = values[field] ?? "";
          const window = inputWindow(
            raw,
            field === focus ? Math.min(cursor, Array.from(raw).length) : Array.from(raw).length,
            rect.width,
          );
          let column = 0;
          let position = window.start;
          for (const ch of Array.from(window.text)) {
            if (column + stringWidth(ch) > event.x - rect.col - 2) break;
            column += stringWidth(ch);
            position++;
          }
          setCursor(position);
        } else activate(field);
      },
      wheel: (event) => {
        if (
          event.x < left ||
          event.x >= left + dialogWidth ||
          event.y < top ||
          event.y >= top + dialogHeight
        )
          return;
        setFocus(
          moveFocus(
            disclosure ? ["cancel", "save"] : order,
            focus,
            event.dir === "up" ? "up" : "down",
          ),
        );
      },
    });
    return () => {
      onMouseFrame(undefined);
    };
  });
  const labels: Record<string, string> = {
    backend: "后端",
    endpoint: "接入点",
    url: "自定义 baseURL",
    model: "模型（Enter 拉取 / 选择）",
    credential: "凭据来源（Enter 选择）",
    value: "凭据（密钥不会写入设置）",
    threshold: "最低置信度",
  };
  const values: Record<string, string> = {
    url: jev.baseURL ?? "",
    model:
      backend === "model" ? (model ? `${model.provider}/${model.model}` : "选择小模型") : jev.model,
    credential: credentialLabel,
    value: credentialValue,
    threshold,
  };
  const picker =
    nested === "model" ? (
      <ModelPicker
        models={runtime.listModels()}
        recents={runtime.listRecentModels()}
        providers={[]}
        presets={[]}
        current={model}
        defaultModel={undefined}
        wizard={undefined}
        onStartWizard={() => {
          setNested(undefined);
        }}
        selectionOnly
        onPick={(ref) => {
          const slash = ref.indexOf("/");
          setModel({ provider: ref.slice(0, slash), model: ref.slice(slash + 1) });
          setNested(undefined);
          setFocus("save");
        }}
        onClose={() => {
          setNested(undefined);
        }}
        width={innerWidth}
        height={Math.max(1, dialogHeight - 4)}
        active
      />
    ) : nested === "models" ? (
      models ? (
        <PickList
          title="选择 Jev 审查模型"
          width={innerWidth}
          active
          items={[
            ...models.map((id) => ({ label: id, value: id })),
            { label: "手动输入模型 id", value: "" },
          ]}
          onCancel={() => {
            request.current?.abort();
            setNested(undefined);
          }}
          onPick={(id) => {
            setNested(undefined);
            setManual(id === "");
            if (id) {
              setJev({ ...jev, model: id });
              setFocus("credential");
            } else {
              setFocus("model");
              setCursor(Array.from(jev.model).length);
            }
          }}
        />
      ) : (
        <Text>正在拉取模型列表…（Esc 取消）</Text>
      )
    ) : nested === "credential" ? (
      <PickList
        title="选择凭据来源"
        width={innerWidth}
        active
        items={[
          {
            label: `借用已有服务商${"provider" in jev.credential ? ` · ${jev.credential.provider}` : ""}`,
            value: "provider",
          },
          { label: "环境变量", value: "env" },
          { label: "单独输入密钥（凭据库）", value: "stored" },
        ]}
        onCancel={() => {
          setNested(undefined);
        }}
        onPick={(value) => {
          setNested(undefined);
          setFocus("value");
          setCursor(9999);
          if (value === "env")
            setJev({ ...jev, credential: { env: JEV_ENDPOINTS[jev.endpoint].env } });
          else if (value === "stored") {
            setJev({ ...jev, credential: { stored: true } });
            setSecret("");
          } else {
            void runtime
              .listReviewerProviders()
              .then((entries) => {
                if (mounted.current) {
                  setProviders(entries);
                  if (entries.length) setNested("provider");
                  else {
                    setNested(undefined);
                    setNotice("没有可借用的服务商，请选择环境变量或单独密钥");
                  }
                }
              })
              .catch(() => {
                if (mounted.current) setNotice("无法读取服务商清单");
              });
          }
        }}
      />
    ) : nested === "provider" ? (
      <PickList
        title="借用服务商凭据"
        width={innerWidth}
        active
        items={providers.map((entry) => ({
          label: `${entry.id} · ${entry.host ?? ""}`,
          value: entry.id,
        }))}
        onCancel={() => {
          setNested(undefined);
        }}
        onPick={(id) => {
          setJev({ ...jev, credential: { provider: id } });
          setNested(undefined);
          setFocus("threshold");
        }}
      />
    ) : undefined;
  // 加载期间仍允许 Escape 取消请求。
  useInput(
    (_input, key) => {
      if (key.escape) {
        request.current?.abort();
        setNested(undefined);
      }
    },
    { isActive: nested === "models" && models === undefined },
  );
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
          title={nested === "model" ? "/settings · 安全审查模型" : "/settings · 安全审查"}
          width={dialogWidth}
          height={dialogHeight}
          framed={framed}
        >
          {picker ?? (
            <>
              <Box flexDirection="column" flexGrow={1} overflow="hidden">
                {disclosure ? (
                  <>
                    <Text>首次开启 Jev</Text>
                    <Text>将发送待确认操作的类别、目标/命令、工作目录和最近三条用户消息。</Text>
                    <Text>
                      接收方：{JEV_ENDPOINTS[jev.endpoint].recipient}。地址：{jevBaseURL(jev)}
                      ；可能包含任务代码或命令文本。
                    </Text>
                    <Text>确认后保存即生效。</Text>
                  </>
                ) : (
                  fields.slice(start, start + visibleCount).map((id, index) => (
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
                      {id === "backend" || id === "endpoint" ? (
                        <Segmented
                          options={id === "backend" ? ["关闭", "Jev", "小模型"] : [...ENDPOINTS]}
                          selected={
                            id === "backend"
                              ? BACKENDS.indexOf(backend)
                              : ENDPOINTS.indexOf(jev.endpoint)
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
                              "stored" in jev.credential && id === "value"
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
                  ))
                )}
              </Box>
              <Text color={notice ? theme.warning : theme.muted} wrap="truncate">
                {notice ?? "Tab/↑↓ 移动 · ←→ 选择 · Enter 打开 · Esc 取消"}
              </Text>
              <Buttons
                focused={focus}
                readonly={false}
                width={innerWidth}
                onBox={onBox}
                {...(disclosure
                  ? {
                      items: [
                        ["cancel", "取消"],
                        ["save", "确认启用"],
                      ] as const,
                    }
                  : {})}
              />
            </>
          )}
          {picker && notice ? <Text color={theme.warning}>{notice}</Text> : null}
        </DialogFrame>
      )}
    </Box>
  );
}
