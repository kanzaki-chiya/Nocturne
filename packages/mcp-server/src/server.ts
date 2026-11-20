/* eslint-disable @typescript-eslint/no-deprecated -- 使用底层 Server 注册原始 JSON Schema 工具与进度通知 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { McpBridge, type McpBridgeOptions } from "./bridge.js";

export const NOCTURNE_MCP_TOOLS: readonly Tool[] = [
  {
    name: "nocturne_list_sessions",
    description: "列出 Nocturne 桌面端最近会话（可按工作目录过滤）。",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "可选工作区或子目录路径，过滤该目录下的会话。",
        },
        limit: {
          type: "number",
          description: "最多返回的会话条数（默认 20）。",
        },
      },
    },
  },
  {
    name: "nocturne_read_session",
    description:
      "读取指定 Nocturne 会话的状态、最近 N 轮用户消息与最终回复，以及工具调用单行摘要。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "目标会话 ID。",
        },
        turns: {
          type: "number",
          description: "返回最近几轮对话（默认 3）。",
        },
        lastTurns: {
          type: "number",
          description: "turns 的别名：返回最近几轮对话（默认 3）。",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "nocturne_list_models",
    description: "列出 Nocturne 当前可用模型与默认模型。",
    inputSchema: {
      type: "object",
      properties: {
        workspaceRoot: {
          type: "string",
          description: "可选工作区根路径。",
        },
      },
    },
  },
  {
    name: "nocturne_start_session",
    description: "在指定工作目录新建 Nocturne 会话并发送首条任务，可选等待本轮完成。",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "会话工作目录（须为已信任或已有会话使用过的工作区）。",
        },
        prompt: {
          type: "string",
          description: "首条任务提示词。",
        },
        title: {
          type: "string",
          description: "可选会话标题。传入后在会话建立后设为标题，不被首条消息的自动标题覆盖。",
        },
        model: {
          type: "string",
          description: "可选模型引用（provider/model）。",
        },
        permissionPreset: {
          type: "string",
          enum: ["read-only", "default", "auto-edit", "smart", "guarded", "bypass"],
          description: "会话权限预设（不得高于本外部 agent 登记的权限上限）。",
        },
        reasoningEffort: {
          type: "string",
          description: "可选思考档位。",
        },
        wait: {
          type: "boolean",
          description: "是否等待本轮完成或暂停（默认 true）。",
        },
        timeoutSeconds: {
          type: "number",
          description: "等待超时秒数（默认 300，上限 600）。",
        },
      },
      required: ["cwd", "prompt"],
    },
  },
  {
    name: "nocturne_send",
    description:
      "向已有 Nocturne 会话追加消息。走 enqueueInput 的 queue 模式：从不打断，忙时排到下一轮，空闲时立即开始。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "目标会话 ID。",
        },
        prompt: {
          type: "string",
          description: "要发送的消息内容。",
        },
        wait: {
          type: "boolean",
          description: "是否等待执行完成或暂停（默认 true）。",
        },
        timeoutSeconds: {
          type: "number",
          description: "等待超时秒数（默认 300，上限 600）。",
        },
      },
      required: ["sessionId", "prompt"],
    },
  },
  {
    name: "nocturne_wait",
    description:
      "等待一个或多个正在运行的 Nocturne 会话完成当前轮次（含正常接续的排队轮次），或在等待用户审批权限 / 回答提问 / 队列暂停时立即返回。传 sessionId 等单个会话，传 sessionIds 同时等多个会话（任一满足停止条件即返回）。返回增量单行工具摘要。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "单个目标会话 ID（与 sessionIds 二选一）。",
        },
        sessionIds: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description:
            "多个目标会话 ID 列表（与 sessionId 二选一）。任意一个会话满足停止条件即立即返回。",
        },
        timeoutSeconds: {
          type: "number",
          description: "等待超时秒数（默认 300，上限 600）。超时返回 running，不中断会话。",
        },
      },
    },
  },
  {
    name: "nocturne_interrupt",
    description: "中断指定 Nocturne 会话当前正在运行的轮次。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "目标会话 ID。",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "nocturne_answer",
    description:
      "回答 Nocturne 会话当前挂起的提问（ask_user）。仅限本外部 agent 自己创建的会话；作答后可选等待本轮继续执行完成或进入下一次暂停。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "目标会话 ID（必须由本外部 agent 创建）。",
        },
        requestId: {
          type: "string",
          description: "待回答提问的 requestId（取自 pendingQuestion.requestId）。",
        },
        answers: {
          type: "array",
          description:
            "按提问顺序一一对应的答案数组。每项为 { selected: string[], text?: string }（选中项 label 列表，自由文本题可传 selected: [] 或省略 selected 并附 text），或 { declined: true } 表示放弃回答该题。",
          items: {
            type: "object",
            properties: {
              selected: {
                type: "array",
                items: { type: "string" },
                description: "该题选中的选项 label 列表（自由文本题可传空数组 [] 或省略）。",
              },
              text: {
                type: "string",
                description: "可选补充文字或自由文本回答。",
              },
              declined: {
                type: "boolean",
                description: "设为 true 表示放弃回答该题（不可与 selected / text 同时提供）。",
              },
            },
          },
        },
        wait: {
          type: "boolean",
          description: "作答后是否等待执行完成或下一次暂停（默认 true）。",
        },
        timeoutSeconds: {
          type: "number",
          description: "等待超时秒数（默认 300，上限 600）。",
        },
      },
      required: ["sessionId", "requestId", "answers"],
    },
  },
  {
    name: "nocturne_respond_permission",
    description:
      "回复 Nocturne 会话当前挂起的权限审批（含子代理转发的审批）。仅限本外部 agent 自己创建的会话（子代理审批按父会话归属判定）；拒绝在任意上限下均可用，允许（本次或本会话）仅在权限上限为 bypass 时可用，持久授权（project / always）由服务端一律拒绝。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "目标会话 ID（处理子代理转发审批时为父会话 ID；必须由本外部 agent 创建）。",
        },
        requestId: {
          type: "string",
          description: "待审批请求的 requestId（取自 pendingPermissions[].requestId）。",
        },
        childSessionId: {
          type: "string",
          description:
            "可选；处理子代理转发的审批时传入子会话 ID（取自 pendingPermissions[].childSessionId），走 session.respondSubagentPermission。",
        },
        reply: {
          type: "object",
          description: "权限审批回复，结构沿用 PermissionReply。",
          properties: {
            decision: {
              type: "string",
              enum: ["allow", "deny"],
              description: "审批决定：allow（允许，需最高档上限 bypass）或 deny（拒绝）。",
            },
            remember: {
              type: "string",
              enum: ["session", "project", "always"],
              description:
                "decision 为 allow 时可选；仅 session（本会话内允许）可用，project / always 等持久授权由服务端一律拒绝。",
            },
            stop: {
              type: "boolean",
              description: "decision 为 deny 时可选；设为 true 表示拒绝并停止当前轮次。",
            },
            feedback: {
              type: "string",
              description: "decision 为 deny 时可选；附带给模型的拒绝原因反馈。",
            },
          },
          required: ["decision"],
        },
        wait: {
          type: "boolean",
          description: "回复后是否等待执行完成或下一次暂停（默认 true）。",
        },
        timeoutSeconds: {
          type: "number",
          description: "等待超时秒数（默认 300，上限 600）。",
        },
      },
      required: ["sessionId", "requestId", "reply"],
    },
  },
];

export interface NocturneMcpServerOptions extends McpBridgeOptions {
  version?: string | undefined;
}

export interface NocturneMcpServerHandle {
  readonly server: Server;
  readonly bridge: McpBridge;
  close(): Promise<void>;
}

const SERVER_VERSION = "0.56.0";

export function createNocturneMcpServer(
  options: NocturneMcpServerOptions = {},
): NocturneMcpServerHandle {
  const bridge = new McpBridge(options);
  const server = new Server(
    {
      name: "nocturne",
      version: options.version ?? SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.oninitialized = () => {
    const clientVersion = server.getClientVersion();
    if (clientVersion?.name) {
      bridge.setHostClientName(clientVersion.name);
    }
    void bridge.tryPreconnect();
  };

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...NOCTURNE_MCP_TOOLS],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const clientVersion = server.getClientVersion();
    if (clientVersion?.name) {
      bridge.setHostClientName(clientVersion.name);
    }
    const progressToken = request.params._meta?.progressToken;
    const result = await bridge.callTool(
      request.params.name,
      request.params.arguments,
      progressToken !== undefined
        ? {
            onProgress: (update) => {
              void server
                .notification({
                  method: "notifications/progress",
                  params: {
                    progressToken,
                    progress: update.progress,
                    ...(update.total !== undefined ? { total: update.total } : {}),
                    message: update.message,
                  },
                })
                .catch(() => undefined);
            },
          }
        : undefined,
    );
    return {
      content: result.content,
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
      ...(result.isError !== undefined ? { isError: result.isError } : {}),
    };
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await bridge.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  };

  server.onclose = () => {
    void bridge.close();
  };

  return {
    server,
    bridge,
    close,
  };
}

export async function runNocturneMcpStdioServer(
  options: NocturneMcpServerOptions = {},
): Promise<void> {
  const handle = createNocturneMcpServer(options);
  const transport = new StdioServerTransport();
  await handle.server.connect(transport);
  await new Promise<void>((resolve) => {
    const done = (): void => {
      void handle.close().finally(resolve);
    };
    transport.onclose = done;
    process.stdin.once("end", done);
    process.stdin.once("close", done);
  });
}
