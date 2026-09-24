# 迁移说明

- **迁移日期**：2026-09-24
- **迁移内容**：独立客户端 `jev` CLI（含动态上下文管理）从本仓库迁出（另行发布）。
  本仓库此后只保留 OMP extensions。

## 迁出

- `src/`（107 文件）
- `test/`（66 文件）
- `scripts/`
- 客户端配置：`package.json`、`tsconfig.json`、`biome.json`、`vitest.config.ts`、`bun.lock`
- 客户端文档：`docs/CLI-DEV-PLAN.md`、`INTERFACE-SPEC.md`、`IMPLEMENTATION-REPORT.md`、
  `FINAL-ACCEPTANCE-REPORT.md`、`DYNAMIC-CONTEXT-DESIGN.md`、`config-example.json`

## 保留

- `extensions/`：acceptance-gate、foreman、route-planner、model-selector、all-model-router
- `LICENSE`
- `omp-model-selection-flow.html`（OMP 相关流程图）

## 删除

历史评审资料（两仓库都不需要）：`docs/FAST-JEV-COMPACTION-PLAN-*.md`、
`docs/CLI-DEV-PLAN-REVIEW-*.md`。

## all-model-router 核实

`extensions/all-model-router/all-model-router.ts` 导入 `@oh-my-pi/pi-coding-agent`，
是 OMP 扩展，保留在本仓库。

冗长的客户端实现报告不随迁保留。
