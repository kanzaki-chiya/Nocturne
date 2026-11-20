import { createPluginCreatorServer } from "../servers/plugin-creator.js";
import { runDocPluginMcpServer } from "../shared/mcp.js";

await runDocPluginMcpServer(createPluginCreatorServer());
