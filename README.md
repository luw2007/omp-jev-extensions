# omp-jev-extensions

OMP（Oh-My-Pi）extensions for the Typesafe Jev typed-decision API.

## 简介

这是一组 OMP coding agent 扩展，为 OMP 接入 Typesafe Jev 类型化决策 API，覆盖：
路由、进度评估、验收门槛、模型选择、可见度与动态权限。

每个扩展是一个可被 OMP 加载的 TypeScript 入口文件，导出一个接收 `ExtensionAPI` 的默认函数。

## 扩展清单

| 扩展 | 入口 | 作用 |
|------|------|------|
| acceptance-gate | `extensions/acceptance-gate/stop-jev.ts` | 验收门槛：任务结束前由 Jev 评估是否真正完成 |
| foreman | `extensions/foreman/foreman.ts` | 进度评估：heavy gate 模式下自动注入进度检查指令 |
| route-planner | `extensions/route-planner/route-agent.ts` | 子任务路由规划：由 Jev 选择 tier |
| model-selector | `extensions/model-selector/select.ts` | 模型选择策略库：IQ 信任门限、配额、速度排名（纯逻辑库，无独立扩展入口） |
| all-model-router | `extensions/all-model-router/all-model-router.ts` | 全自动路由 + 手动模型控制（`/route` 命令） |

## 安装

将各扩展入口 symlink 到 OMP 扩展目录：

```bash
mkdir -p ~/.omp/agent/extensions
ln -s "$(pwd)/extensions/acceptance-gate/stop-jev.ts"          ~/.omp/agent/extensions/acceptance-gate.ts
ln -s "$(pwd)/extensions/foreman/foreman.ts"                   ~/.omp/agent/extensions/foreman.ts
ln -s "$(pwd)/extensions/route-planner/route-agent.ts"         ~/.omp/agent/extensions/route-planner.ts
ln -s "$(pwd)/extensions/all-model-router/all-model-router.ts" ~/.omp/agent/extensions/all-model-router.ts
```

`model-selector` 是被其他扩展引用的策略库，不需要单独安装。

## 配置

- **all-model-router**：本地配置 `~/.omp/agent/jev-model-router.json`，字段见
  `extensions/all-model-router/config.example.json`（含 candidates、mode、jevUrl、jevModel 等）。
- **model-selector**：模型目录示例见 `extensions/model-selector/catalog.example.ts`。

## 隐私

这些扩展会将任务内容（prompt、工作摘要、`git status`、验收标准）以明文 POST 到
`https://api.typesafe.ai/v1/systemone`。

- API key 通过环境变量 `TYPESAFE_API_KEY` 读取；缺失时 gate 自动放行（fail-open）。
- Jev API URL 可通过环境变量 `JEV_URL` 覆盖（默认即上述地址）。
- 本地审计日志写入 `~/.omp/agent/stop-audit.jsonl` 和 `~/.omp/agent/route-audit.jsonl`。

## 迁移说明

独立客户端 `jev` CLI（含动态上下文管理）已迁出本仓库（另行发布）。本仓库只保留 OMP extensions。详见
[MIGRATION.md](MIGRATION.md)。

## 开发

扩展测试文件：

- `extensions/all-model-router/all-model-router-test.ts`
- `extensions/route-planner/route-test.ts`
- `extensions/model-selector/model-selector-test.ts`
- `extensions/model-selector/task-routing-audit-test.ts`

运行测试：

```bash
bun run test
```

## License

MIT
