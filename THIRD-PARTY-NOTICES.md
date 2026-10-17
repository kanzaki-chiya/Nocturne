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
| `@agentclientprotocol/sdk` | 1.7.0 | Apache-2.0 |
| `ink` | 7.1.1 | MIT |
| `marked` | 18.0.7 | MIT |
| `node-html-markdown` | 2.0.0 | MIT |
| `react` | 19.3.0 | MIT |
| `react-dom` | 19.3.0 | MIT |
| `scheduler`（手机网页间接依赖） | 0.28.0 | MIT |
| `string-width` | 8.2.2 | MIT |
| `ws` | 8.22.0 | MIT |
| `@tauri-apps/api` | 2.12.0 | Apache-2.0 OR MIT |
| `@tauri-apps/plugin-dialog` | 2.8.0 | MIT OR Apache-2.0 |
| `@tauri-apps/plugin-opener` | 2.6.0 | MIT OR Apache-2.0 |
| `@codemirror/view` | 6.43.14 | MIT |
| `@codemirror/state` | 6.7.6 | MIT |
| `@codemirror/language` | 6.13.1 | MIT |
| `@codemirror/search` | 6.7.2 | MIT |
| `@codemirror/lang-css` | 6.3.1 | MIT |
| `@codemirror/lang-html` | 6.4.12 | MIT |
| `@codemirror/lang-javascript` | 6.2.5 | MIT |
| `@codemirror/lang-json` | 6.0.2 | MIT |
| `@codemirror/lang-markdown` | 6.5.2 | MIT |
| `@codemirror/lang-python` | 6.2.1 | MIT |
| `@codemirror/lang-rust` | 6.0.2 | MIT |
| `@codemirror/lang-xml` | 6.1.0 | MIT |
| `@codemirror/lang-yaml` | 6.1.3 | MIT |
| `@lezer/highlight` | 1.2.5 | MIT |

桌面端第 2 步复用 `marked` **18.0.7**（MIT；2026-07-21 发布，采用时已满 7 天）解析 Markdown token，由 React 元素渲染；不使用其 HTML 输出，不渲染原始 HTML。

桌面端右侧面板的只读文件查看用 CodeMirror 6（上表 `@codemirror/*` 与 `@lezer/highlight`，均为 MIT），按需动态加载，不进手机网页。它们间接带入的 `@codemirror/autocomplete`、`@codemirror/lint`、`@lezer/common`、`@lezer/lr`、各语言的 `@lezer/*` 解析器、`style-mod`、`w3c-keyname`、`crelt`、`@marijn/find-cluster-break` 也都是 MIT。

| 开发与测试依赖 | 版本 | 许可证 |
|---|---:|---|
| `@types/node` | 24.13.5 | MIT |
| `@types/ws` | 8.18.2 | MIT |
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

## 中继包内的手机网页

按 Vite 产物 chunk.modules 核对，手机网页实际内联 `react` 19.3.0、`react-dom` 19.3.0、`scheduler` 0.28.0、`marked` 18.0.7、`zod` 4.6.5，均已列入上表；不包含 Tauri 或 qrcode-generator。中继服务内联本仓库的 remote，`ws` 8.22.0 保留为安装依赖并附带其原始许可。以下保留手机网页第三方代码的版权和许可文本。

### React、React DOM、Scheduler、Zod（MIT）

React、React DOM、Scheduler: Copyright (c) Meta Platforms, Inc. and affiliates.

Zod: Copyright (c) 2025 Colin McDonnell

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### Marked（MIT；附上游 Markdown 声明）

Copyright (c) 2018+, MarkedJS (https://github.com/markedjs/)
Copyright (c) 2011-2018, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

Markdown: Copyright © 2004, John Gruber — http://daringfireball.net/ — All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
* Neither the name “Markdown” nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

This software is provided by the copyright holders and contributors “as is” and any express or implied warranties, including, but not limited to, the implied warranties of merchantability and fitness for a particular purpose are disclaimed. In no event shall the copyright owner or contributors be liable for any direct, indirect, incidental, special, exemplary, or consequential damages (including, but not limited to, procurement of substitute goods or services; loss of use, data, or profits; or business interruption) however caused and on any theory of liability, whether in contract, strict liability, or tort (including negligence or otherwise) arising in any way out of the use of this software, even if advised of the possibility of such damage.

## 内置数据

`packages/core/src/config/models-dev-snapshot.ts` 的模型字段快照来源于 [models.dev](https://github.com/sst/models.dev) 的 `models.json`，上游仓库的 `LICENSE` 声明 MIT License。用 `scripts/update-models-dev-snapshot.mjs` 获取并筛选上游模型数据后生成此文件；运行期默认使用内置快照，只有显式刷新才访问上游。
