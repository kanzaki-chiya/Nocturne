import { createSheetsPluginServer } from "../servers/xlsx.js";
import { runDocPluginMcpServer } from "../shared/mcp.js";

await runDocPluginMcpServer(createSheetsPluginServer());
