# 第三方许可说明

Nocturne 自身按仓库根目录 [LICENSE](LICENSE) 中的 GPL-3.0-only 发布。下表记录 v0.1.0 直接使用的第三方 npm 包及其包元数据声明的许可证；各包的许可证文本、版权信息和进一步的依赖信息随安装包提供。下表不改变这些第三方软件各自的许可条款。

| 运行时依赖 | 版本 | 许可证 |
|---|---:|---|
| `@ai-sdk/anthropic` | 4.0.58 | Apache-2.0 |
| `@ai-sdk/openai-compatible` | 3.0.49 | Apache-2.0 |
| `ai` | 7.0.102 | Apache-2.0 |
| `ajv` | 8.20.0 | MIT |
| `zod` | 4.6.5 | MIT |
| `@modelcontextprotocol/sdk` | 1.30.0 | MIT |
| `ink` | 7.1.1 | MIT |
| `react` | 19.3.0 | MIT |
| `string-width` | 8.2.2 | MIT |

| 开发与测试依赖 | 版本 | 许可证 |
|---|---:|---|
| `@types/node` | 24.13.5 | MIT |
| `@types/react` | 19.3.0 | MIT |
| `dependency-cruiser` | 18.3.1 | MIT |
| `eslint` | 10.10.0 | MIT |
| `eslint-config-prettier` | 10.1.8 | MIT |
| `ink-testing-library` | 4.0.0 | MIT |
| `prettier` | 3.9.6 | MIT |
| `tsdown` | 0.23.0 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `typescript-eslint` | 8.70.0 | MIT |
| `vitest` | 5.0.1 | MIT |

这些是通过各包 `package.json` 核对的直接依赖；间接依赖与完整许可文本可从 `pnpm-lock.yaml` 和安装后的 `node_modules` 查阅。仓库未从参考项目复制第三方源文件，故没有需要附加的来源 NOTICE。
