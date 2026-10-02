import { abortError, constrainedResponseError, ProviderError } from "../errors.js";
import type { ResponsesRequestConstraints } from "../types.js";

const TOOL_NAMESPACE = "functions";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 每个 stream 单独创建：并发请求的完成状态与工具名不能串线。 */
export function constrainResponsesFetch(
  constraints: ResponsesRequestConstraints,
  fetchImpl: typeof fetch,
): { fetch: typeof fetch; completed: () => boolean; failure: () => ProviderError | undefined } {
  let completed = false;
  let failure: ProviderError | undefined;
  const names = new Map<string, string>();
  const namespaceName = (name: string): string => {
    const qualified = `${TOOL_NAMESPACE}.${name}`;
    names.set(qualified, name);
    return qualified;
  };
  const plainName = (name: string): string =>
    name.startsWith(`${TOOL_NAMESPACE}.`) ? name.slice(TOOL_NAMESPACE.length + 1) : name;

  const rewriteRequest = (body: Record<string, unknown>): void => {
    body.store = false;
    body.stream = true;
    const input: unknown[] = Array.isArray(body.input)
      ? body.input
      : typeof body.input === "string"
        ? [{ role: "user", content: body.input }]
        : [];
    body.input = input;
    if (constraints.systemAsInstructions) {
      const instructions: string[] = [];
      if (typeof body.instructions === "string") instructions.push(body.instructions);
      body.input = input.filter((value) => {
        const item = record(value);
        if (item?.role !== "system" && item?.role !== "developer") return true;
        if (typeof item.content === "string") instructions.push(item.content);
        else if (Array.isArray(item.content)) {
          instructions.push(
            item.content
              .map((part: unknown) => record(part)?.text)
              .filter((text): text is string => typeof text === "string")
              .join("\n"),
          );
        }
        return false;
      });
      if (instructions.length > 0) body.instructions = instructions.join("\n\n");
    }
    if (constraints.namespaceTools) {
      const functions: Record<string, unknown>[] = [];
      const others: unknown[] = [];
      if (Array.isArray(body.tools)) {
        for (const tool of body.tools) {
          const item = record(tool);
          if (item?.type === "function" && typeof item.name === "string") {
            namespaceName(item.name);
            functions.push(item);
          } else others.push(tool);
        }
        body.tools =
          functions.length > 0
            ? [
                ...others,
                // 通道要求 namespace 带 description（实测缺少时 400：tools[0].description）
                {
                  type: "namespace",
                  name: TOOL_NAMESPACE,
                  description: "Tools provided by the local coding agent",
                  tools: functions,
                },
              ]
            : others;
      }
      for (const value of input) {
        const item = record(value);
        // 历史里的调用名只允许 [a-zA-Z0-9_-]（实测 400：input[n].name 不匹配），
        // 命名空间放在单独的 namespace 字段，不拼进 name。
        if (item?.type === "function_call" && typeof item.name === "string") {
          item.name = plainName(item.name);
          item.namespace = TOOL_NAMESPACE;
        }
      }
      const choice = record(body.tool_choice);
      if (choice?.type === "function" && typeof choice.name === "string") {
        choice.name = plainName(choice.name);
        choice.namespace = TOOL_NAMESPACE;
      }
    }
    for (const field of constraints.omitFields) Reflect.deleteProperty(body, field);
  };

  const rewriteEvent = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) rewriteEvent(item);
      return;
    }
    const item = record(value);
    if (item === undefined) return;
    if (
      constraints.namespaceTools &&
      item.type === "function_call" &&
      typeof item.name === "string"
    ) {
      item.name = names.get(item.name) ?? plainName(item.name);
      Reflect.deleteProperty(item, "namespace");
    }
    for (const child of Object.values(item)) rewriteEvent(child);
  };

  const wrappedFetch: typeof fetch = async (input, init) => {
    try {
      const raw = init?.body;
      const text =
        typeof raw === "string"
          ? raw
          : raw instanceof Uint8Array
            ? new TextDecoder().decode(raw)
            : undefined;
      if (text === undefined)
        throw new ProviderError({ kind: "invalid_request", message: "Responses 请求格式无效" });
      const body: unknown = JSON.parse(text);
      const request = record(body);
      if (request === undefined)
        throw new ProviderError({ kind: "invalid_request", message: "Responses 请求格式无效" });
      rewriteRequest(request);
      const response = await fetchImpl(input, { ...init, body: JSON.stringify(request) });
      if (!response.ok) {
        const error: unknown = await response.json().catch(() => undefined);
        throw constrainedResponseError(response.status, error);
      }
      if (response.body === null) return response;
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let pending = "";
      const emit = (
        block: string,
        controller: TransformStreamDefaultController<Uint8Array>,
      ): void => {
        const lines = block.split(/\r?\n/);
        const data = lines
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data === "" || data === "[DONE]") {
          controller.enqueue(encoder.encode(`${block}\n\n`));
          return;
        }
        const event: unknown = JSON.parse(data);
        const item = record(event);
        if (item?.type === "error" || item?.type === "response.failed") {
          failure = constrainedResponseError(undefined, record(item.response)?.error ?? item);
          throw failure;
        }
        rewriteEvent(event);
        if (item?.type === "response.completed") completed = true;
        const metadata = lines.filter((line) => !line.startsWith("data:"));
        controller.enqueue(
          encoder.encode(`${[...metadata, `data: ${JSON.stringify(event)}`].join("\n")}\n\n`),
        );
      };
      const transformed = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            pending += decoder.decode(chunk, { stream: true });
            let boundary: RegExpExecArray | null;
            while ((boundary = /\r?\n\r?\n/.exec(pending)) !== null) {
              const block = pending.slice(0, boundary.index);
              pending = pending.slice(boundary.index + boundary[0].length);
              emit(block, controller);
            }
          },
          flush(controller) {
            pending += decoder.decode();
            if (pending.trim() !== "") emit(pending, controller);
          },
        }),
      );
      const headers = new Headers(response.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      return new Response(transformed, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      if (init?.signal?.aborted === true || (error instanceof Error && error.name === "AbortError"))
        throw abortError();
      if (error instanceof ProviderError) throw error;
      throw new ProviderError({ kind: "network", message: "服务商连接中断，请重试" });
    }
  };
  return { fetch: wrappedFetch, completed: () => completed, failure: () => failure };
}
