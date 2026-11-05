<h1 align="center">SKY Evidence Recovery</h1>

<p align="center"><strong>Durable evidence-backed recovery for opt-in DeepSeek Harness tools</strong></p>

<p align="center">
  <a href="docs/RELEASE_NOTES.md"><img alt="Release 0.1.1" src="https://img.shields.io/badge/release-0.1.1-276DC3?style=flat-square"></a>
  <img alt="Public Beta" src="https://img.shields.io/badge/status-public%20beta-F59E0B?style=flat-square">
  <img alt="Windows 11 validated" src="https://img.shields.io/badge/tested-Windows%2011-1482BA?style=flat-square">
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-2E7D32?style=flat-square"></a>
  <img alt="Node.js 24.9+" src="https://img.shields.io/badge/Node.js-%E2%89%A524.9.0-417E38?style=flat-square">
</p>

<p align="center">
  <a href="README.en.md">English</a> ·
  <a href="README.md">简体中文</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.ja.md">日本語</a>
</p>

面向 **DeepSeek Harness（DSH）** 的轻量执行保护插件：在受保护工具产生副作用**之前**持久记录操作身份；如果成功回执丢失、发生超时或执行结果不确定，阻止 AI 盲目重试。通过独立回读和人工对账，决定是否允许后续操作。

**它不是让 AI 永不犯错的工具，也不承诺 exactly-once。** 仅明确写入 `rules` 的工具受保护；默认空规则不保护任何工具。

## 核心能力

- **持久执行账本：** 记录业务标识哈希、参数指纹、执行代次及结果状态，重启后仍可核查。
- **重复副作用拦截：** 明确成功标为 `succeeded`；取消、超时、异常、回执丢失等不确定状态保留 `unknown`。
- **故障时拒绝执行：** 账本不可用、锁损坏或所有权变化时，对受保护调用返回拒绝，不自动解除。
- **独立证据对账：** 操作者核实下游真实状态后，可离线确认已提交或确实未提交。工具自身错误码不能证明未执行。
- **运行时检查：** `sky_recovery_health` 和 `sky_recovery_status` 提供加载、保护规则与账本状态查询。

## 安装与试跑

要求：DSH 0.2 预发布系列（实测版本见下方）、Node.js ≥24.9.0；在隔离环境中安装并配置。

```powershell
dsh plugin --profile sky-evidence-smoke add "file:$($PWD.Path)"
```

默认 `cordis.patch.yml` 为 `rules: []`，**安装不等于已经启用保护**。启用时按实际工具配置规则，例如：

```yaml
- id: sky-evidence-recovery
  config:
    rules:
      - tool: sky_demo_create_order
        keyArg: requestId
```

此示例需同时启用随附的 `sky-evidence-recovery/demo` 模拟工具。Windows 可双击 `启动DSH测试.cmd` 执行**隔离配置预检**；不会默认启动 Web。启动后实际调用 `sky_recovery_health`，确认 `loaded=true`、`ledgerLocked=true`、`protectedTools` 含目标工具。详见 [DSH 接入验收](DSH_接入验收.md)。

<details>
<summary><strong>技术流程图与设计解释（点击展开）</strong></summary>

```mermaid
flowchart TD
    A[Agent invokes a tool] --> B{Protected by rules?}
    B -->|No| C[Normal DSH dispatch]
    B -->|Yes| D{Ledger healthy and lock owned?}
    D -->|No| E[Reject protected call]
    D -->|Yes| F{Existing identity state?}
    F -->|succeeded or unknown| G[Block duplicate execution]
    F -->|new| H[Persist execution claim]
    H --> I[Dispatch tool once]
    I --> J{Confirmed success?}
    J -->|Yes| K[Persist succeeded]
    J -->|No or uncertain| L[Keep unknown and block retry]
    L --> M[Independent readback + operator reconciliation]
    M --> N{Authoritative outcome?}
    N -->|Committed| K
    N -->|Proven not committed| O[Operator releases for a new attempt]
```

- 记录发生在工具派发**之前**；相同业务身份若已有成功或未知状态，就拒绝重复副作用。
- 只有明确成功才结算为 `succeeded`，其余不确定情形默认 `unknown`；只读回读**不会自动解锁**。
- 对账只允许可信操作者在停止服务并独立核实下游状态之后进行。只有证明既未提交也不会迟到提交，才能允许新一次执行。
- 插件未加载时无法自保；宿主必须单独保证关键工具不会在缺少保护时启动。

</details>

## 已验证范围

2026-11-05 的最终验收针对**执行逻辑相同**的内部候选 `0.1.4-beta.1`；`0.1.1` 是首次公开版本号，保留原验收报告中的历史版本及哈希以便追溯。

| 检查 | 实测结果 |
|---|---|
| Windows `npm run check` | 46 PASS，0 FAIL，0 SKIP |
| Windows PowerShell 5.1 / CMD | 7 PASS |
| 真实 DSH ToolRuntime | 91 条去重断言 PASS，R30 兼容性测试 BLOCKED |
| 真实 Web 模型 A–E | 5 场景 PASS，10 次真实工具调用 |
| 打包检查 | `npm pack --dry-run` PASS，运行时包 13 文件 |

未完成 R16 的真实运行时磁盘结算失败注入；macOS/Linux、多实例、跨机部署、真实业务系统及强制断电恢复未验证。结果依据验收方报告，并非所有原始会话日志都随仓库公开。见 [最终验收报告](docs/FINAL_TEST_REPORT.md)。

## 安全边界与文档

**生产部署必须隔离 Agent 权限**：如果智能体拥有同系统身份下的任意 shell、文件写入或插件管理权限，它可能绕过账本。插件缺席时也不能自动保护其他工具。仅支持已配置工具和单进程本地账本；不承诺 exactly-once。

[安全声明](docs/SECURITY.md) · [完整问题与修复记录](问题与修复记录.md) · [发布说明](docs/RELEASE_NOTES.md) · [开发规范](DSH_PLUGIN_CODE_STANDARDS.md) · [Apache-2.0](LICENSE)

**声明：** SKY Evidence Recovery 是独立社区项目，非 DeepSeek Harness 官方插件，不代表 DeepSeek 官方背书。
