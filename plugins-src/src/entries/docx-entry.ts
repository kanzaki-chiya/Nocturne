import { createWordPluginServer } from "../servers/docx.js";
import { runDocPluginMcpServer } from "../shared/mcp.js";

await runDocPluginMcpServer(createWordPluginServer());
