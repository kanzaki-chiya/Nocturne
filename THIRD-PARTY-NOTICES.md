# 第三方许可说明

Nocturne 自身按仓库根目录 [LICENSE](LICENSE) 中的 GPL-3.0-only 发布。下表记录直接使用的第三方 npm 包及其包元数据声明的许可证；各包的许可证文本、版权信息和进一步的依赖信息随安装包提供。下表不改变这些第三方软件各自的许可条款。

| 运行时依赖 | 版本 | 许可证 |
|---|---:|---|
| `@ai-sdk/anthropic` | 4.0.58 | Apache-2.0 |
| `@ai-sdk/openai-compatible` | 3.0.49 | Apache-2.0 |
| `ai` | 7.0.102 | Apache-2.0 |
| `ajv` | 8.20.0 | MIT |
| `zod` | 4.6.5 | MIT |
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT |
| `ink` | 7.1.1 | MIT |
| `marked` | 18.0.7 | MIT |
| `node-html-markdown` | 2.0.0 | MIT |
| `react` | 19.3.0 | MIT |
| `react-dom` | 19.3.0 | MIT |
| `string-width` | 8.2.2 | MIT |
| `@tauri-apps/api` | 2.12.0 | Apache-2.0 OR MIT |
| `@tauri-apps/plugin-dialog` | 2.8.0 | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-opener` | 2.6.0 | MIT OR Apache-2.0 |

桌面端第 2 步复用 `marked` **18.0.7**（MIT；2026-07-21 发布，采用时已满 7 天）解析 Markdown token，由 React 元素渲染；不使用其 HTML 输出，不渲染原始 HTML。

| 开发与测试依赖 | 版本 | 许可证 |
|---|---:|---|
| `@types/node` | 24.13.5 | MIT |
| `@types/react` | 19.3.0 | MIT |
| `@types/react-dom` | 19.3.0 | MIT |
| `@testing-library/dom` | 10.4.2 | MIT |
| `@testing-library/react` | 16.3.3 | MIT |
| `dependency-cruiser` | 18.3.1 | MIT |
| `eslint` | 10.10.0 | MIT |
| `eslint-config-prettier` | 10.1.8 | MIT |
| `ink-testing-library` | 4.0.0 | MIT |
| `jsdom` | 30.1.1 | MIT |
| `prettier` | 3.9.6 | MIT |
| `tsdown` | 0.23.0 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `typescript-eslint` | 8.70.0 | MIT |
| `vite` | 8.3.0 | MIT |
| `vitest` | 5.0.1 | MIT |
| `@vitejs/plugin-react` | 6.1.1 | MIT |
| `@tauri-apps/cli` | 2.12.0 | Apache-2.0 OR MIT |

桌面端 `apps/desktop/src-tauri` 的直接 Rust crate（`cargo build`/`cargo test` 使用，打包进桌面安装包）：

| 桌面端 Rust 依赖 | 版本 | 许可证 |
|---|---:|---|
| `tauri` | 2.12.0 | Apache-2.0 OR MIT |
| `tauri-build` | 2.7.0 | Apache-2.0 OR MIT |
| `tauri-plugin-dialog` | 2.8.0 | Apache-2.0 OR MIT |
| `tauri-plugin-opener` | 2.6.0 | Apache-2.0 OR MIT |
| `serde` | 1.0.229 | MIT OR Apache-2.0 |
| `windows-sys` | 0.61.2 | MIT OR Apache-2.0 |

这些是通过各包 `package.json` 核对的直接依赖；间接依赖与完整许可文本可从 `pnpm-lock.yaml` 和安装后的 `node_modules` 查阅。仓库未从参考项目复制第三方源文件，故没有需要附加的来源 NOTICE。

## 内置数据

`packages/core/src/config/models-dev-snapshot.ts` 的模型字段快照来源于 [models.dev](https://github.com/sst/models.dev) 的 `models.json`，上游仓库的 `LICENSE` 声明 MIT License。用 `scripts/update-models-dev-snapshot.mjs` 获取并筛选上游模型数据后生成此文件；运行期默认使用内置快照，只有显式刷新才访问上游。
