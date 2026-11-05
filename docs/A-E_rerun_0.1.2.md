# 0.1.2 模型 A–E 补跑记录

本记录是 2026-11-05 外部验收的公开摘要，来自操作者在独立 DSH 环境中的真实模型补跑。原始含会话令牌、测试机路径及完整交互的证据附件**不公开分发**。以下数字属于验收方报告，不代表仓库维护者独立重现了全部 Windows 操作。

## 环境与被测版本

- 发布版本：`0.1.2`；实测包为文档修订后的源码，运行时文件与此前通过 89 条 ToolRuntime 断言的 `0.1.2` 逐字节一致。
- 平台：Windows 11、Node.js `24.19.0`、DSH CLI `0.2.0-rc.2`、`@deepseek-ai/dsh-tools` `0.2.1-rc.5`。
- 真实 `dsh web` + 浏览器自动化，模型：`DeepSeek-V41-Flash`；使用隔离配置，未触及既有 DSH 用户 profile。
- 结果依据为宿主会话日志中实际发生的 `tool/call` 与 `tool/result`，而不是仅采信模型的自然语言回答。

## A–E 结果

| 场景 | 结果 | 可观察行为 |
|---|---|---|
| A 健康检查 | PASS | `sky_recovery_health` 返回 `loaded=true`、`ledgerLocked=true`，受保护清单包含模拟订单工具。 |
| B 成功后重试 | PASS | 同参数重复下单返回 `SKY_ALREADY_EXECUTED`；仅创建一份模拟订单。 |
| C 提交后丢回执 | PASS | 重试返回 `SKY_EXECUTION_UNKNOWN`；独立回读显示 `committed=true`；账本仍保留 `unknown`。 |
| D 权限隔离 | PASS | 宿主暴露给模型的工具列表仅有健康/状态、模拟写入/回读及提问工具，无 shell、文件系统写入、对账及插件管理。 |
| E 遗留锁 | PASS | 健康报告 `ledgerLocked=false`；受保护下单被 `SKY_LEDGER_UNAVAILABLE` 拒绝，只读回读仍可用。 |

**总计：5/5 场景通过，10 次真实工具调用，0 次发现重复副作用。**

交叉核验：B、C 各写入一份模拟订单；执行后 `admin.js list --pending` 只返回 C 场景的一条 `unknown`，B 的 `succeeded` 未被误列入待对账清单。E 的遗留锁为隔离测试账本内人工植入，测试结束后清理。

## 独立的运行时回归与剩余边界

- 同一份 `0.1.2` 运行时代码已由验收方完成 89/89 条 ToolRuntime 断言、Windows 单元测试 51/51 和操作者 CLI 真实账本冒烟。模型 A–E 补跑只补全模型层证据，不替代这些记录。
- R30 社区幂等插件组合仍为 **BLOCKED**；R16 真实运行时结算写盘故障注入为 **NOT_TESTED**（只有单测注入）。
- macOS/Linux、多进程或多主机、实际业务下游、强制断电恢复均未验证；插件缺席时不提供宿主级启动保护。不承诺 exactly-once。
- 此报告是脱敏公开摘要，不包含原始会话、任何 URL 会话 token 或个人目录路径。
