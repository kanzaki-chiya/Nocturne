/* eslint-disable @typescript-eslint/no-deprecated -- Low-level MCP Server exposes raw JSON Schema tools */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

import { DocPluginError, toToolError } from "./errors.js";

export type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

export interface PluginServerSpec {
  readonly name: string;
  readonly version: string;
  readonly tools: readonly Tool[];
  readonly handlers: Readonly<Record<string, ToolHandler>>;
  readonly close: () => Promise<void>;
}

export const PLUGIN_SERVER_VERSION = "0.55.0";

export function jsonTextResult(data: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

export async function runDocPluginMcpServer(spec: PluginServerSpec): Promise<void> {
  const server = new Server(
    { name: spec.name, version: spec.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [...spec.tools],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const handler = spec.handlers[request.params.name];
    if (!handler) {
      return toToolError(
        new DocPluginError("invalid_argument", `Unknown tool: ${request.params.name}`),
      );
    }
    try {
      const args: Record<string, unknown> = request.params.arguments ?? {};
      return await handler(args);
    } catch (error) {
      return toToolError(error);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  let closed = false;
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      if (closed) return;
      closed = true;
      void spec
        .close()
        .catch(() => undefined)
        .finally(() => {
          void server
            .close()
            .catch(() => undefined)
            .finally(resolve);
        });
    };

    transport.onclose = shutdown;
    server.onclose = shutdown;
    process.stdin.once("end", shutdown);
    process.stdin.once("close", shutdown);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
