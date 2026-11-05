# 0.1.2 模型 A–E 补跑记录

补跑日期：2026-11-05
被测包：`SKY_Evidence_Recovery_0.1.2_Release_Docs_Fixed.zip`（`package.json` 版本 `0.1.2`）
补跑原因：该包随附的 `docs/RELEASE_NOTES.md` 与 `docs/FINAL_TEST_REPORT.md` 明确写着
“0.1.2 未重跑模型 Web A–E，不能继承旧版模型端到端的 PASS”。本次就是补这个缺口。

## 前置核验：确认这次只改了文档

| 检查 | 结果 |
|---|---|
| 与上一版 0.1.2 包对比 | 仅 8 个文档变化、移除 `docs/SKY_Evidence_Recovery_Cards.html`，无其它新增 |
| 运行时文件逐字节 | `index.js`、`ledger.js`、`admin.js`、`demo.js`、`cordis.patch.yml`、`DSH_本地试跑.ps1`、`启动DSH测试.cmd` 全部 **IDENTICAL** |
| `docs/PUBLIC_SOURCE_MANIFEST.json` | 31 条记录 **31/31** 与实际文件一致（上一版只有 3/30） |
| 版本一致性 | `package.json` 0.1.2 = `manifest.public_version` 0.1.2 |

因此本记录可以直接覆盖上一轮已通过的 89 项运行时断言所针对的同一份运行时代码。

## 环境

Windows `10.0.26200` · Node `24.19.0` · `dsh 0.2.0-rc.2` · `@deepseek-ai/dsh-tools 0.2.1-rc.5`
独立 `DSH_HOME` 与 `sky-web` profile（web 模板，`file:` 安装，运行时包 13 文件、不含 `admin.js`）
Agent 预设收敛为 `persona` + `tool-ask_user`
模型 `DeepSeek-V41-Flash`（`deepseek-account` 路由；不记录任何凭据）
驱动方式：真实 `dsh web`（`127.0.0.1:3301`）+ 无头 Chrome 经 DevTools 协议操作真实界面

## 结果

| 场景 | 状态 | 模型实际发出的调用 | 宿主原始输出 | 订单写入 | 账本状态 |
|---|---|---|---|---|---|
| A 健康检查 | PASS | `sky_recovery_health` | `{"loaded":true,"ledgerLocked":true,"ledgerNote":"","protectedTools":["sky_demo_create_order"],"invalidRules":[]}` | 0 | 正常锁定 |
| B 成功后重试 | PASS | `sky_demo_create_order` ×2（参数完全相同） | ①成功创建 `fix2-b-001` ②`SKY_ALREADY_EXECUTED` | 1 | `succeeded` |
| C 响应丢失 | PASS | `sky_demo_create_order` ×2 + `sky_demo_readback` + `sky_recovery_status` | ①`Error: SIMULATED_RESPONSE_LOST_AFTER_COMMIT` ②`SKY_EXECUTION_UNKNOWN` ③`{"committed":true,...}` ④`{"state":"unknown",...,"ledgerLocked":true}` | 1 | `unknown`，模型未解除 |
| D 权限隔离 | PASS | 无额外调用；取宿主侧证据 | 发给模型的请求头工具集合恰为 5 个：`ask_user_question`、`sky_demo_create_order`、`sky_demo_readback`、`sky_recovery_health`、`sky_recovery_status` | 0 | 不适用 |
| E 锁故障降级 | PASS | `sky_recovery_health`、`sky_demo_create_order`、`sky_demo_readback` | ①`ledgerLocked:false` + `账本锁 .active.lock 已存在，请确认实例退出后人工核查` ②`SKY_LEDGER_UNAVAILABLE: 账本不可用，拒绝执行：…` ③只读回读仍返回 `committed:true` | 0（被拒绝） | 降级 |

合计 **5 场景通过 / 0 失败**，原始 `tool/call` + `tool/result` 共 **10 次**，全部取自 DSH 会话日志
（`session.v4.jsonl.zstd`，多帧 zstd 解出），不是模型自述。

## 交叉核对

- 演示订单目录文件数 = **2**（`fix2-b-001`、`fix2-c-001` 各一份），B 与 C 的重复调用都没有产生第二笔。
- 新版操作者 CLI `list --pending` 对同一账本返回 **1 条**待处理记录（正是 C 场景的 `unknown`），
  `complete=true`；B 的 `succeeded` 不出现在待处理清单里——语义正确。
- E 的遗留锁由验收方在隔离测试账本中人工植入（`owner=planted-stale-instance`），
  不是删账本或改记录让测试变绿；结束后已清除。

## 对包内文档的影响

这两处现在可以更新（原文写的是“未重跑”）：

1. `docs/RELEASE_NOTES.md` 第 8 行末句
   “`0.1.2` 未重跑模型 Web A–E，不能继承旧版模型端到端的 PASS。”
   → 可改为：“`0.1.2` 已在真实 DSH Web 上重跑模型 A–E，5/5 通过、10 次真实 tool/call，见《A–E 补跑记录》。”
2. `docs/FINAL_TEST_REPORT.md` 第 2 段版本注记末句
   “模型 A–E 仅在历史构建上测试，**未对 `0.1.2` 重跑**。”
   → 同样改为已补跑，并指向补跑记录。

其余声明（R30 BLOCKED、R16 运行时注入未验证、macOS/Linux 与多进程未测、运行时代码已实质改动）
**保持原样仍然准确**，本次补跑没有改变这些结论。

## 证据文件

`evidence-012/model-A-D-tools.raw.json`、`evidence-012/model-E-tools.raw.json`、
`evidence-012/model-request-header-tools.txt`、`evidence-012/model-A-D-turns.json`、
`evidence-012/model-E-turns.json`

公开存档已将原始证据位置替换为占位符 <WORKSPACE> 和 <USER_HOME>。
