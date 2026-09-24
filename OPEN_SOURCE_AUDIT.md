# Open Source Readiness Audit

- **审计日期**: 2026-09-24
- **审计范围**: 全部 tracked 文件（extensions/、README.md、MIGRATION.md、LICENSE、.gitignore、package.json）及完整 Git 历史

## 已确认干净项

- 无硬编码 API key、secret、token、password 或Bearer 凭证（key 通过 `process.env.TYPESAFE_API_KEY` 读取）
- 无邮箱地址
- 无内部公司域名或内网主机名
- 无绝对本地文件路径（用户主目录路径等）
- 无内部模型代号或内部服务标识符
- 第三方衍生文档已从 Git 历史中彻底移除
- 本地私有文件（模型目录、流程图、同步脚本）已通过 .gitignore 排除，不会进入版本库

## 已修复项

### P0（阻断项）
1. **Git 历史重写**: 从全部历史中移除了第三方衍生文档目录（含图片和说明文件），旧 commit 对象已由 filter-repo 清理，`.git/filter-repo/commit-map` 保留旧→新 hash 映射。
2. **dry-run 守卫**: `route-live-dryrun.ts` 的入口调用已包裹在 `import.meta.main` 中，作为模块被 import 时不会触发网络请求或进程退出。
3. **.gitignore 更新**: 排除本地模型目录 (`*.local.ts`)、内部流程图 (`omp-*-flow.html`) 和内部同步脚本。

### P1（改进项）
1. **测试命令**: README 中的测试命令从 `bun test extensions/`（实际跑 0 个测试）修正为 `bun run test`，通过 package.json script 循环执行全部冒烟测试脚本。
2. **package.json**: 新增最小 package.json，声明项目元数据、bun 引擎要求和 test script。
3. **隐私说明**: README 新增隐私段落，明确告知任务内容会 POST 到 Jev API、key 来源、审计日志路径和 fail-open 行为。
4. **失效链接**: 迁移文档中指向外部私有仓库的相对链接改为纯文本说明。
5. **JEV_URL 统一**: 三个扩展入口的硬编码 API URL 改为 `process.env.JEV_URL ?? 默认值`，支持环境变量覆盖，默认值一致。
6. **内部路径注释**: 代码注释中引用的内部仓库文件路径改为泛指描述。

## 发布前清单

- [x] 全部测试通过（4 个冒烟脚本）
- [x] 全部扩展入口 `bun build --no-bundle` 语法检查通过
- [x] 密钥/邮箱/内部域名/本地路径/内部代号扫描：tracked 文件零命中
- [x] Git 历史敏感字符串扫描：无第三方文件内容残留
- [x] 本地私有文件已 gitignore
- [x] 未执行 push
- [ ] **push 前人工确认**: 审查最终 diff，确认无遗漏

## 结论

仓库当前状态可公开。push 前建议最后人工 review 一次 `git log` 和 `git diff origin/master...HEAD`。
