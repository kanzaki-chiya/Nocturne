# 第三方许可说明

Nocturne 自身按仓库根目录 [LICENSE](LICENSE) 中的 GPL-3.0-only 发布。下表记录直接使用的第三方 npm 包及其包元数据声明的许可证；各包的许可证文本、版权信息和进一步的依赖信息随安装包提供。下表不改变这些第三方软件各自的许可条款。

| 运行时依赖 | 版本 | 许可证 |
|---|---:|---|
| `@ai-sdk/anthropic` | 4.0.58 | Apache-2.0 |
| `@ai-sdk/openai-compatible` | 3.0.49 | Apache-2.0 |
| `@jsquash/jpeg` | 1.6.0 | Apache-2.0 |
| `@jsquash/png` | 3.1.1 | Apache-2.0 |
| `@jsquash/resize` | 2.1.1 | Apache-2.0 |
| `@jsquash/webp` | 1.5.0 | Apache-2.0 |
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
| `@codemirror/language-data` | 6.5.2 | MIT |
| `@lezer/highlight` | 1.2.5 | MIT |
| `@xterm/xterm` | 6.0.0 | MIT |
| `@xterm/addon-fit` | 0.11.0 | MIT |
| `@xterm/addon-unicode11` | 0.9.0 | MIT |

安卓原生扫码使用 [ZXing Android Embedded](https://github.com/journeyapps/zxing-android-embedded/tree/v4.3.0) 4.3.0 与 ZXing Core 3.4.1，均为 Apache-2.0。库的版权与许可证保留在各自发行包中；实现使用公开 API，不复制库源码。该路径不依赖 Google Play 服务，AAR / JAR 不含原生 `.so`。

桌面端第 2 步复用 `marked` **18.0.7**（MIT；2026-07-21 发布，采用时已满 7 天）解析 Markdown token，由 React 元素渲染；不使用其 HTML 输出，不渲染原始 HTML。

桌面端右侧面板的只读文件查看用 CodeMirror 6（上表 `@codemirror/*` 与 `@lezer/highlight`，均为 MIT），按需动态加载。`@codemirror/language-data` 6.5.2 及它引入的 `@codemirror/lang-*`、`@codemirror/legacy-modes`、对应 `@lezer/*` 解析器均为 MIT，与 GPL-3.0-only 兼容；语言包通过目录的 `load()` 按需加载。它们间接带入的 `@codemirror/autocomplete`、`@codemirror/lint`、`@lezer/common`、`@lezer/lr`、各语言的 `@lezer/*` 解析器、`style-mod`、`w3c-keyname`、`crelt`、`@marijn/find-cluster-break` 也都是 MIT。

桌面端右侧面板的终端用 xterm.js（上表 `@xterm/xterm`、`@xterm/addon-fit` 与 `@xterm/addon-unicode11`，均为 MIT，无运行时依赖），随终端标签首次打开动态加载，不进手机网页。

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
| `portable-pty` | 0.9.0 | MIT |
| `webview2-com` | 0.39.1 | MIT |
| `rfd` | 0.16.0 | MIT |
| `chrono` | 0.4.45 | MIT OR Apache-2.0 |

`portable-pty`（面板终端，Windows 上走 ConPTY）间接带入的 crate：`filedescriptor` 0.8.3（MIT）、`serial2` 0.2.38（BSD-2-Clause OR Apache-2.0）、`shared_library` 0.1.9（Apache-2.0/MIT）、`shell-words` 1.1.1（MIT/Apache-2.0）、`winreg` 0.10.1（MIT）、`nix` 0.28.0（MIT）、`downcast-rs` 1.2.1（MIT/Apache-2.0）、`lazy_static` 1.5.1（MIT OR Apache-2.0）、`cfg_aliases` 0.1.1（MIT）。

`webview2-com`（面板内置浏览器调用 Tauri 没有包装的 WebView2 接口）与 `rfd`（下载的「另存为」对话框）原本已经是 `wry` 和 `tauri-plugin-dialog` 的间接依赖，这次改为直接依赖，版本与它们一致，没有带入新的 crate。`tauri` 开启了 `unstable` 特性，不改变许可证。

这些是通过各包 `package.json` 核对的直接依赖；间接依赖与完整许可文本可从 `pnpm-lock.yaml` 和安装后的 `node_modules` 查阅。仓库未从参考项目复制第三方源文件，故没有需要附加的来源 NOTICE。

## 电脑操控驱动

Windows 桌面包随附 Cua AI, Inc. 官方签名的 cua-driver `0.40.2` 发布包（MIT，Copyright (c) 2025 Cua AI, Inc.），作为独立 stdio 子进程运行，不链接进 Core。版本、官方发布包地址、压缩包和全部文件的 SHA-256 统一记录在 [computer-release.json](packages/mcp/src/computer-release.json)。下载与打包会校验压缩包、逐文件哈希及可执行文件的 Authenticode 签名，源码仓库不收录二进制。

官方包自带 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`，原样随同全部发布文件安装到 `computer/` 资源目录；其中记录驱动内 Rust、原生及其他第三方组件的声明。驱动与这些组件的许可证、版权和进一步声明以这两个随附文件为准。本项目没有重新编译或修改驱动。

## 中继包内的手机网页

按 Vite 产物 chunk.modules 核对，手机网页实际内联 `react` 19.3.0、`react-dom` 19.3.0、`scheduler` 0.28.0、`marked` 18.0.7、`zod` 4.6.5，均已列入上表；另内联 `mingcute_icon` 2.9.72 的部分线性图标路径数据（Apache-2.0，见下方「界面图标」）；不包含 Tauri 或 qrcode-generator。中继服务内联本仓库的 remote，`ws` 8.22.0 保留为安装依赖并附带其原始许可。以下保留手机网页第三方代码的版权和许可文本。

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

## 项目主页字体

主页自托管 Noto Serif SC 的标题字形子集（Noto Serif CJK 2.003，SC Black）。来源：[notofonts/noto-cjk / Serif2.003](https://github.com/notofonts/noto-cjk/tree/Serif2.003)，固定提交 `9b0f1436e455d902de067a2501422e5dc71ad16b`。© 2017-2024 Adobe (http://www.adobe.com/).，字体按 **SIL Open Font License 1.1** 分发；完整许可随站点保存在 [site/assets/fonts/OFL.txt](site/assets/fonts/OFL.txt)。子集由 `scripts/subset-site-font.mjs` 生成，原始字体不进仓库，字体许可不受项目 GPL 条款替代。

开发依赖 `subset-font` 2.9.0 按 BSD-3-Clause 许可分发，仅用于手动生成字体，不参与站点运行或正常构建。

## 内置数据

`packages/core/src/config/models-dev-snapshot.ts` 的模型字段快照来源于 [models.dev](https://github.com/sst/models.dev) 的 `models.json`，上游仓库的 `LICENSE` 声明 MIT License。用 `scripts/update-models-dev-snapshot.mjs` 获取并筛选上游模型数据后生成此文件；运行期默认使用内置快照，只有显式刷新才访问上游。

## 界面图标（MingCute Icon，Apache-2.0）

`apps/desktop/src/ui/Icon.tsx` 内联收录 [MingCute Icon](https://github.com/Richard9394/MingCute)（npm 包 `mingcute_icon` **2.9.72**，作者 Richard9394，https://www.mingcute.com）中实际用到的 `_line.svg` 图标路径数据，桌面端与手机网页共用，不把整个图标包打进安装包。原包按 **Apache-2.0** 许可分发，以下保留原包 `LICENSE` 全文：

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the boilerplate notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
