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

## 安装失败或重启后仍是旧版

`ERR_PNPM_UNEXPECTED_STORE` 表示 Profile 的 `node_modules` 链接到了与本次命令所用路径不同的 pnpm store。DSH 外部复测在切换命令工作目录后遇到此错误。先回到该 Profile 首次安装时所用的固定目录和 pnpm 配置，再执行 `dsh plugin add/remove`。源码升级时传入解压目录的绝对路径，避免为了指向新源码而切换工作目录。

以下示例用于隔离 Profile。先将 `$installDir` 设为固定的安装工作目录，`$sourceDir` 设为新源码的绝对路径，并确认当前 `DSH_HOME` 指向目标测试环境。

```powershell
$profile = 'sky-evidence-smoke'
Push-Location -LiteralPath $installDir
try {
    dsh plugin --profile $profile add "file:$sourceDir"
    if ($LASTEXITCODE -ne 0) { throw '安装失败，请检查 DSH 输出指向的 pnpm 日志。' }
} finally {
    Pop-Location
}

$installed = Join-Path $env:DSH_HOME "profiles/$profile/node_modules/sky-evidence-recovery/package.json"
$expected = (Get-Content -Raw -LiteralPath (Join-Path $sourceDir 'package.json') | ConvertFrom-Json).version
$actual = (Get-Content -Raw -LiteralPath $installed | ConvertFrom-Json).version
if (!$expected -or $actual -ne $expected) { throw '已安装版本与目标源码不一致。' }
```

版本确认后重启目标 Profile，检查设置页能读到账本，并用 `sky_recovery_health` 核对保护规则和锁。原安装环境无法恢复时，优先用新名称创建一次性测试 Profile。现有 Profile 的配置、会话和账本应保留。 [pnpm 错误说明](https://pnpm.io/errors#err_pnpm_unexpected_store)


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

已知业务标识时，用 `node admin.js lookup --data-dir $ledgerDir --tool $tool` 在操作者终端查找对应记录。遇到锁故障，运行 `node admin.js lock-status --data-dir $ledgerDir`，检查结果与人工恢复步骤见 [操作者恢复](README.md#操作者恢复)。

## DSH Web 向导复测

本轮实测 Windows 桌面版 DSH 0.2.0-rc.2 和 npm DSH 0.2.1-rc.5。浏览器复测使用 Windows、Node.js 24.19、Playwright 和 Chromium。先创建一次性测试根目录 `$testRoot`，将 `DSH_HOME` 指向其 `home` 子目录。复测使用模拟账本与回读证据，无需配置模型或下游账户。

```powershell
$env:DSH_HOME = Join-Path $testRoot 'home'
& $dsh --profile sky-web-audit --from-default-profile web --dump-config
& $dsh plugin --profile sky-web-audit add "file:$($PWD.Path)"
```

以下命令用 Node 启动 npm 版 DSH。将 `$dshEntry` 设为对应 CLI 包的 `lib/bin.js`，将 `$playwrightPath` 设为测试用 Playwright 模块的绝对路径。使用 Playwright 自带 Chromium 时可省略 `--browser`。

```powershell
node scripts/verify-dsh-web.mjs --root $testRoot --executable (Get-Command node).Source `
  --entry $dshEntry --playwright $playwrightPath --browser $browserExe
```

npm DSH 0.2.1-rc.5 可加 --guest-peer，在同一宿主内创建测试 Peer，验证网关拒绝非所有者。验证桌面版内置宿主时，使用 `--electron`，把 `--executable` 指向 Electron 可执行文件，把 `--entry` 指向随桌面版打包的 `@deepseek-ai/dsh-desktop-host/lib/cli.js`。脚本只连接临时启动的回环服务，下载测试证据后正常关停宿主，再走离线 CLI 写入。卸载后以同样参数加 `--removed` 检查设置入口。


## 与其他策略组合

宿主的工具超时策略负责取消和回执，SKY Evidence Recovery 负责持久化阻止不确定结果的再次执行。应对具备协作取消能力的模拟工具测试两者的实际组合，确认超时后工具体收敛、重复执行被拦截。若启用了幂等或重试中间件，分别检查成功缓存、并发合并、未知结果、错误码保留和中间件顺序。任何能在一次已登记调用内重复派发工具体的策略都需要由宿主禁用或调整。

直接调用真实宿主工具运行时可以验收加载和拦截。模型自然语言与 Web 端流程另按 [DSH 模型调用验收](DSH_模型调用验收.md) 记录。
