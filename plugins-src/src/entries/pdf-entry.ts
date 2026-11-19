import { createPdfPluginServer } from "../servers/pdf.js";
import { runDocPluginMcpServer } from "../shared/mcp.js";

await runDocPluginMcpServer(createPdfPluginServer());
