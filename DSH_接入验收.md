# SKY Evidence Recovery 接入验收

`0.1.2` 候选的实机复测见 [问题与修复记录](问题与修复记录.md)。首次公开版 `0.1.1` 的历史结果见 [最终验收报告](docs/FINAL_TEST_REPORT.md)。

## 准备 Windows 测试环境

用真实 DSH CLI 或桌面版内置 CLI 执行：

```powershell
npm run check
powershell -NoProfile -ExecutionPolicy Bypass -File .\DSH_本地试跑.ps1 -ConfigOnly
```

可用 `-DshPath` 或 `DSH_CLI` 指定 CLI。双击 `启动DSH测试.cmd` 同样执行配置预检，成功时关闭窗口，失败时停留显示错误。每次启动脚本都会创建一个新的独立测试目录。手动重启须沿用同一目录，才能验证账本持久化。

`--dump-config` 验证 bundle 的配置合并。实际启动后，调用 `sky_recovery_health`，确认 `loaded` 和 `ledgerLocked` 为真、`invalidRules` 为空，且 `protectedTools` 包含模拟创建工具。仅在 Agent 权限已被宿主隔离后，使用 `-IsolatedWeb` 或手动启动 Web。

```powershell
$smokeRoot = '脚本显示的隔离测试目录'
$env:DSH_HOME = Join-Path $smokeRoot 'home'
$demoPatch = Join-Path $smokeRoot 'demo.patch.yml'
dsh --profile sky-evidence-smoke --patch $demoPatch --no-open
```

## 验收路径

| 操作 | 预期结果 |
| --- | --- |
| 安装、预检、调用健康工具 | 本地 bundle 加载，运行时可查询实际配置和锁状态 |
| 提交同一模拟订单两次，或复用标识修改参数 | 依次为成功、`SKY_ALREADY_EXECUTED`，改参返回 `SKY_KEY_CONFLICT` |
| 注入提交后响应丢失、伪造未派发元数据、取消、超时 | 拒绝重复执行，状态保留为 `unknown` |
| 启动时存在遗留锁、账本路径失效，或运行时锁被替换 | 健康查询可用，受保护调用返回 `SKY_LEDGER_UNAVAILABLE` |
| 在隔离配置中添加重复或保留名称规则 | 启动告警提示检查 `invalidRules`，重复保护规则拒绝派发 |
| 已提交但丢失回执后走操作者恢复 | 待处理清单和按 ID 查询定位同一代次。独立读回后预览不写账本，带预览值的正式对账持锁重查。 |
| 停机对账并重启 | 占用锁、错误执行代次或弱证据被拒绝。已提交的对账结果跨重启保留 |
| 停机、卸载、启动、重装并重新配置 | 卸载后工具消失。重装后健康与保护恢复，原账本继续拦截重复调用 |

卸载与重装用 `dsh plugin --profile sky-evidence-smoke remove sky-evidence-recovery` 和 `dsh plugin --profile sky-evidence-smoke add "file:$($PWD.Path)"`。卸载后的启动使用无 SKY 引用的配置层。只在明确隔离的测试目录制造锁或磁盘故障。

## 与其他策略组合

宿主的工具超时策略负责取消和回执，SKY Evidence Recovery 负责持久化阻止不确定结果的再次执行。应对具备协作取消能力的模拟工具测试两者的实际组合，确认超时后工具体收敛、重复执行被拦截。若启用了幂等或重试中间件，分别检查成功缓存、并发合并、未知结果、错误码保留和中间件顺序。任何能在一次已登记调用内重复派发工具体的策略都需要由宿主禁用或调整。

直接调用真实宿主工具运行时可以验收加载和拦截。模型自然语言与 Web 端流程另按 [DSH 模型调用验收](DSH_模型调用验收.md) 记录。
