import { createSlidesPluginServer } from "../servers/pptx.js";
import { runDocPluginMcpServer } from "../shared/mcp.js";

await runDocPluginMcpServer(createSlidesPluginServer());
