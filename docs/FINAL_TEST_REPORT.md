> 公开版：来自独立验收方的报告，测试数据已脱敏。该报告引用的原始 evidence 文件未随此仓库发布；以下运行时与模型结果不能视为本仓库维护者独立复现的全部日志证据。
> **版本注记：** 本文是针对内部候选 `0.1.4-beta.1` 的历史验收报告；首次公开版本 `0.1.1` 使用相同运行时代码，仅变更 `package.json` 版本字段及文档。因此报告中的构建哈希和版本标签**未被改写为 0.1.1**。

# SKY Evidence Recovery — 最终 DSH 验收报告

验收日期：2026-11-05（本机）
报告依据：`README_FIRST.md`、`acceptance/FINAL_DSH_TEST_TASK.md`、`acceptance/GITHUB_RELEASE_GATE.md`
本报告只记录**本轮实际执行**的结果，不继承此前任何 44 / 46 / 103 项历史数字。

## 1. 被测源码

- 包版本：`sky-evidence-recovery@0.1.4-beta.1`
- 被测源码 ZIP SHA-256：见**交付目录**（本报告所在目录）的 `SHA256SUMS.txt`；报告随包更新，故不在正文固定自身哈希。
- `index.js` SHA-256：`8750ce2e356ec69a847875480b77b759befee983c17b7a5a059e08420b8be552`
- `ledger.js` SHA-256：`842d50223fa153824dddaa5b44b294a4a3006665ba78d48e4d5cf1a43436b9aa`
- 是否有代码改动：**无**。源码逐文件哈希与 `acceptance/SOURCE_SHA256.json` 的 24 条记录全部一致（24/24，0 不一致、0 缺失），因此交付 ZIP 内为原样源码。
- DSH CLI 版本：`dsh --version` = `0.2.0-rc.2`
- `@deepseek-ai/dsh-tools` 版本：`0.2.1-rc.5`
- Node / npm / pnpm：`v24.19.0` / `11.17.0` / `11.7.0`（pnpm 由桌面版内置提供）
- OS / PowerShell：Windows `10.0.26200` / Windows PowerShell `5.1.26100.9711`
- 隔离 `DSH_HOME`、profile：**已隔离**。使用独立 `DSH_HOME` 与两个自有 profile（`sky-rt` 跑运行时矩阵，`sky-web` 跑模型测试），未改动用户既有 profile。
- 模型：`DeepSeek-V41-Flash`（经 `deepseek-account` 路由；未记录任何 Key、网关或账户信息）

源码清单核对（A2）：`index.js`、`ledger.js`、`admin.js`、`demo.js`、`cordis.patch.yml`、`package.json`、`LICENSE`、5 个 `test/*.test.js`、`DSH_本地试跑.ps1`、`启动DSH测试.cmd`、`scripts/check-code-style.mjs` 均存在且与清单哈希一致。

## 2. 结果总表

| 层级 | PASS | FAIL | SKIP | BLOCKED | 证据文件名 |
|---|---:|---:|---:|---:|---|
| `npm run check` 单测 | 46 | 0 | 0 | 0 | 本报告 §2.1 |
| `node --check` / 风格检查 | 5 | 0 | 0 | 0 | 本报告 §2.1 |
| `npm pack --dry-run` | 1 | 0 | 0 | 0 | 本报告 §2.2 |
| Windows PS5.1 / CMD 专项 | 7 | 0 | 0 | 0 | 本报告 §2.3 |
| 真实 DSH ToolRuntime R01–R30 | 91 条断言 | 0 | 0 | 1（R30） | `evidence/report-*.json`、`evidence/admin-cli-negatives.log` |
| 真实 Web 模型 C-A–C-E | 5 场景 / 10 次真实工具调用 | 0 | 0 | 0 | `evidence/model-*.json`、`evidence/model-request-header-tools.txt` |
| 安全/权限/私密数据检查 | 8 | 0 | 0 | 0 | 本报告 §2.4 |
| 其他平台（macOS/Linux） | 0 | 0 | 0 | 1 | 无环境，NOT_TESTED |

### 2.1 本地测试（A3）

`npm run check` 退出码 0：

```
ℹ tests 46  ℹ pass 46  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0  ℹ todo 0
```

- 46 ≥ 来源声明的 46 个测试项目，未只跑子集；Windows 上来源报告中被跳过的 4 个 PowerShell 平台用例本轮实际执行并通过。
- `node --check` 对 `index.js`、`ledger.js`、`admin.js`、`demo.js` 全部通过；`scripts/check-code-style.mjs` 通过。
- 说明：`npm run check` 需要派生 Node 测试子进程，必须在不受文件沙箱限制的进程里执行；沙箱内该命令会因管道受限返回 `EPERM`，那是环境限制而非测试失败。

### 2.2 打包（A4）

`npm pack --dry-run` 退出码 0，`:13 files`，26.6 kB（解包 69.7 kB），实际列出：

`DSH_PLUGIN_CODE_STANDARDS.md`、`DSH_接入验收.md`、`DSH_本地试跑.ps1`、`DSH_模型调用验收.md`、`LICENSE`、`README.md`、`启动DSH测试.cmd`、`问题与修复记录.md`、`cordis.patch.yml`、`demo.js`、`index.js`、`ledger.js`、`package.json`

`admin.js`、`test/`、`.env`、账本数据与密钥**均不在运行时包内**。这一点在真实安装里也得到交叉验证：`file:` 安装后的 profile `node_modules` 只有上述 13 个文件。

### 2.3 Windows PowerShell 5.1 与 CMD（A5）

| 检查 | 结果 |
|---|---|
| `DSH_本地试跑.ps1` 文件头 | `EF BB BF`，UTF-8 BOM 存在 |
| `启动DSH测试.cmd` 行尾 | 11 行全部 CRLF，无孤立 LF，文件以 CRLF 结尾 |
| `-ConfigOnly` | 退出码 0，配置预检通过 |
| 默认调用（不加参数） | 退出码 0，仅做预检；Web 需显式 `-IsolatedWeb` 才启动 |
| PATH 外发现 | 未传 `-DshPath` 时经卸载注册表 `InstallLocation` 自动找到 `dsh.cmd` |
| 不存在的 `-DshPath` | 退出码 1，报“指定的 DSH CLI 文件不存在” |
| CMD 成功路径 | `启动DSH测试.cmd` 退出码 0 |
| CMD 失败路径 | 以无效 `DSH_CLI` 运行时退出码 1，并打印失败提示 |

来源标注为“需实机验证”的注册表/内置运行时发现路径，本轮在真实桌面安装版上实测通过。

### 2.4 安全与私密数据（D）

对源码树做了 8 类扫描：API Key 形态、`api_key`/`APIKEY` 赋值、邮箱、`<USER_HOME>`、`<USER_HOME>`、`<WORKSPACE>`、`<WORKSPACE>`、私钥块 —— **全部无命中**。运行时包内无账本数据、无 `.env`、无锁文件。

证据文件已把 `<WORKSPACE>` 与 `<USER_HOME>` 替换为 `<WORKSPACE>` / `<USER_HOME>`。

## 3. ToolRuntime 逐项结果

环境：`sky-rt` profile = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + `sky-evidence-recovery`（`file:` 安装），叠加本地 fixture 与 `demo` 工具。全部经真实 `tools.execute` 派发。

| ID | 状态 | 预期 | 实际结果（原始码） | 证据 |
|---|---|---|---|---|
| R01 | PASS | 真实加载、健康检查 | `loaded=true`、`ledgerLocked=true`、`protectedTools` 含 `sky_demo_create_order` | report-main-f5 |
| R02 | PASS | 空 rules 不宣称保护 | 健康返回 `protectedTools: []`，模拟订单工具不做任何拦截 | report-empty-f2 |
| R03 | PASS | 无效/重复规则拒绝调用 | 重复规则与自引用规则进入 `invalidRules`；调用被 `SKY_INVALID_RULE` 拒绝；插件不卸载 | report-main-f5 |
| R04 | PASS | 成功一次、重试被拦 | 首次成功；重试 `SKY_ALREADY_EXECUTED`；演示订单只写一份 | report-main-f5 |
| R05 | PASS | 同 ID 不同参数 | `SKY_KEY_CONFLICT`；工具体只执行 1 次 | report-main-f5 |
| R06 | PASS | 并发同 ID | 一个放行、一个 `SKY_EXECUTION_UNKNOWN`；副作用 1 次 | report-main-f5 |
| R07 | PASS | 缺业务标识 | `SKY_KEY_MISSING`；工具体 0 次 | report-main-f5 |
| R08 | PASS | 非法/过大参数 | `INVALID_ARGS` 与 `SKY_ARGUMENT_TOO_LARGE`；工具体 0 次 | report-main-f5 |
| R09 | PASS | 已提交但丢回执 | 首次失败；重试 `SKY_EXECUTION_UNKNOWN`；下游记录 1 份 | report-main-f5 |
| R10 | PASS | 伪造完整未派发元数据 | 工具体先落副作用，再抛**真实** `ToolArgsError` / `ToolNotFoundError`；仍为 `unknown`，不释放、不二次执行 | report-main-f5 |
| R11 | PASS | DSH 超时 + 协作取消 | 真实返回 `TOOL_TIMEOUT`；账本 `unknown`；重试被拦；工具体 1 次 | report-main-f5 |
| R12 | PASS | 分发后取消 | 返回 `ABORTED`；账本 `unknown`；重试被拦 | report-main-f5 |
| R13 | PASS | 分发前取消 | 宿主直接返回 `ABORTED_BEFORE_DISPATCH`，SKY **未登记**该次调用（状态 `new`）；记录的是宿主行为，未冒称由 SKY 证明未派发 | report-main-f5 |
| R14 | PASS | 只读回读与状态工具 | 回读 `committed:true`；状态 `unknown`；回读不解除保护 | report-main-f5 |
| R15 | PASS | 未配置只读工具 | 行为与安装前一致 | report-main-f5 |
| R16 | PASS（单测）/NOT_TESTED（运行时） | 结算落盘失败注入 | 打包内单测用注入方式验证“不掩盖真实成功、原登记仍阻断重试”；真实运行时无法在不改源码的前提下注入落盘失败，故运行时层标 NOT_TESTED | `npm run check` 第 26/28 项 |
| R17 | PASS | 重启后状态 | `succeeded` 与 `unknown` 均跨进程保留 | report-restart-f5 |
| R18 | PASS | 卸载、重装 | 卸载后 `sky_recovery_health`/`sky_recovery_status` 均不存在；重装后完整矩阵再次 55/55 通过 | report-uninstalled-f3、report-main-f4 |
| R19 | PASS | 外部锁占用 | 插件仍加载，`ledgerLocked=false`，受保护调用 `SKY_LEDGER_UNAVAILABLE`，外来锁文件原样保留未被抢占 | report-lockext-f2 |
| R20 | PASS | 锁丢失、内容破坏 | 删除锁后下一次健康检查即降级并点名 `.active.lock`，且**永久**降级不自动恢复；锁内容写入 `not-json` 后被识别为损坏并拒绝受保护调用 | report-locklost-f2、report-lockcorrupt-f2 |
| R21 | PASS | 目录丢失/被文件占用/被链接替换 | 数据目录指向普通文件 → fail-closed；把数据目录设为 Windows 目录联接 → 构造阶段抛“账本目录路径包含非目录或链接”；提示信息不含绝对存储路径 | report-datadir-f2、report-datadir-f2-sym |
| R22 | PASS | 正常关停时仍有在途 | 在途期间锁仍在；在途调用正常结算；结算后本进程锁才被释放。注：关停后整个工具服务随树销毁，因此“新调用被拒绝”是由服务消失体现，未单独断言插件的 `closing` 分支 | report-dispose-f4 |
| R23 | PASS | 对账期间仍持有锁 | 操作者 CLI 报“账本锁 .active.lock 已存在，请确认实例退出后人工核查” | admin-cli-negatives.log |
| R24 | PASS | 错误代次/指纹/弱证据/过期证据 | 4 类均被拒：错误执行代次、错误指纹 → “执行代次或参数指纹不匹配”；弱证据、过期 `observedAt` → “证据需要有效 source、summary 及本次执行后的 observedAt” | admin-cli-negatives.log |
| R25 | PASS | 独立读回确认 committed | 离线对账成功置 `succeeded`，重启后仍 `SKY_ALREADY_EXECUTED` | report-restart-f5 |
| R26 | PASS | 独立读回确认 not_committed | 对账后才允许重跑，重跑成功；原代次保留在 `attempts` 审计链中 | report-restart-f5 |
| R27 | PASS | 旧版 `DSH_NOT_DISPATCHED` 历史状态 | 手工构造 legacy `released` 记录后，状态查询显示 `unknown`，再次调用被 `SKY_EXECUTION_UNKNOWN` 拒绝 | report-main-f5 |
| R28 | PASS | 权限隔离（只读审计） | 发给模型的请求头里工具集合恰为 5 个：`ask_user_question`、`sky_demo_create_order`、`sky_demo_readback`、`sky_recovery_health`、`sky_recovery_status`；**无 shell、无文件读写、无管理 CLI、无插件管理**。模型不可能发起不在 schema 中的调用 | model-request-header-tools.txt |
| R29 | PASS | 与 timeout / session checkpoint 策略组合 | 组合顺序：`timeout-policy`(L322) → `session-checkpoint-policy`(L330) → `sky-evidence-recovery`(L1261)，SKY 位于最内层；R11 实测由外层超时策略接管最终结果（`TOOL_TIMEOUT`），而账本保持 `unknown` 并阻止盲重试，同一次登记内没有重复派发副作用 | 本报告 §3 与 report-main-f5 |
| R30 | BLOCKED | 社区幂等插件版本兼容 | 本机离线环境没有任何社区幂等/事务插件可安装，无法开展组合测试；不伪称通过 | 无 |

合计运行时断言 **91 条（按场景去重）全部 PASS，0 FAIL**：main 55、restart 5、empty 3、lockext 4、locklost 5、lockcorrupt 3、datadir 5、datadir-symlink 5、dispose 4、uninstalled 2。其中主矩阵在验收链上实际执行了两次（首轮 55 条，重装后再次 55 条，用于 R18 的重装验证），故执行次数为 110 次、去重后 91 条。另有 5 条操作者 CLI 反例 PASS，1 条 BLOCKED（R30），1 条运行时 NOT_TESTED（R16）。

## 4. 模型 A–E 逐项结果

环境：`sky-web` profile（web 模板）+ 受限 Agent 预设（仅 `persona` 与 `tool-ask-user`），真实 Chrome 无头实例通过 DevTools 协议操作 `127.0.0.1:3301` 的真实 DSH Web 界面，模型 `DeepSeek-V41-Flash`。

| 场景 | 状态 | 模型是否实际发出工具调用 | 宿主原始工具输出 | 订单写入计数 | 账本状态 | 脱敏证据 |
|---|---|---|---|---|---|---|
| A 健康检查 | PASS | 是（`sky_recovery_health`） | `{"loaded":true,"ledgerLocked":true,"ledgerNote":"","protectedTools":["sky_demo_create_order"],"invalidRules":[]}` | 0 | 正常锁定 | model-A-D-tools.raw.json |
| B 成功后重试 | PASS | 是（同一参数 2 次） | 第 1 次成功创建；第 2 次 `SKY_ALREADY_EXECUTED` | 1 | `succeeded` | model-A-D-tools.raw.json |
| C 响应丢失 | PASS | 是（4 次：丢失、重试、回读、状态） | ①`Error: SIMULATED_RESPONSE_LOST_AFTER_COMMIT` ②`SKY_EXECUTION_UNKNOWN` ③`committed:true` ④`state:"unknown"` 且 `ledgerLocked:true` | 1 | `unknown`，未被模型解除 | model-A-D-tools.raw.json |
| D 权限隔离 | PASS | 是（健康调用）+ 宿主侧 schema 证据 | 模型可用工具仅 5 个（见 R28）；模型明确报告无 shell / 无文件读取，并拒绝编造输出 | 0 | 不适用 | model-request-header-tools.txt |
| E 锁故障降级 | PASS | 是（健康、下单、回读 3 次） | ①`{"ledgerLocked":false,"ledgerNote":"账本锁 .active.lock 已存在，请确认实例退出后人工核查"}` ②`SKY_LEDGER_UNAVAILABLE: 账本不可用，拒绝执行：…` ③只读回读仍返回 `committed:true` | 0（被拒绝） | 降级，拒绝受保护调用 | model-E-tools.raw.json |

说明：

- 两段会话共记录 **10 次真实 `tool/call`**，来自 DSH 会话日志（`session.v4.jsonl.zstd`，多帧 zstd 解出）而不是模型自述。
- D 的结论**不是**采信模型“我不会”，而是取自宿主发给模型的请求头工具清单：清单里没有 shell/文件/管理工具，模型在协议上就无法发出这类调用。模型也没有伪造输出。
- E 的遗留锁是我在隔离测试账本里人工植入的（`owner=planted-stale-instance`），不是删账本或改记录让测试变绿。

## 5. 缺陷、修复和复测

**未发现需要修改被测源码的缺陷，本轮没有改动任何源代码。**

过程中出现过三次“先失败、后证伪”的情况，均为验收环境或我自己的编排问题，已排除并重跑，记录在此以免误判：

1. **Windows 目录联接被接受**（首轮 R21 失败）。根因是 DSH 的文件沙箱会给受限进程改变重解析点的 `lstat` 语义：沙箱内 `isDirectory=true/isSymbolicLink=false`，非受限下才是 `isDirectory=false/isSymbolicLink=true`。把整个矩阵改在非受限宿主进程里重跑后，联接被正确拒绝，R21 通过。
2. **`plugin add/remove` 偶发静默失败**（R18 首轮）。pnpm 返回成功但依赖与 bundles 未变更，导致卸载/重装假阴性。改为每次变更后校验 `package.json` 再继续，重跑后通过。
3. **证据文件被后续失败重跑覆盖**（`report-restart-*.json`）。已重建一条自洽链路：`main-f5 → 离线对账 → restart-f5`，并删除被取代的中间报告。

另有一处**验收方法学上的自我修正**：`report-uninstalled-f3.json` 里有一条断言（卸载后用 `sky_demo_create_order` 验证“无保护”）是无效的——该工具随包一起消失，调用只会 `UNKNOWN_TOOL`。已弃用该断言，不把它算作通过；R18 的结论只依赖“健康/状态工具已不存在”与“重装后矩阵再次全绿”。

## 6. 安全声明和发布决定

- 是否证明了插件完全缺席时宿主能阻止副作用工具：**否（NOT_PROVEN）**。插件缺席时它无法自保；宿主级强制激活检查不在本包范围内，这是必须保留的边界。
- 是否证明了 Agent 无任意 shell/文件写或管理对账权限：**是（在本次受限验收 profile 内）**。依据是发给模型的工具清单只有 5 个只读/演示工具，且 web 模板的标准预设已收敛为 `persona` + `tool-ask-user`。这证明的是“该宿主配置下的隔离”，不是插件自身提供隔离。
- 是否有真实模型完整测试：**是**。A–E 在真实 DSH Web 界面由真实模型完成，共 10 次真实工具调用，原始记录已留存。
- 是否保留 `unknown` 并阻止盲重试：**是**。R09/R10/R11/R12/R27 与 C 场景均验证。
- 未覆盖的操作系统、下游、部署方式：macOS/Linux 未测；多进程/多主机共享账本不支持；真实支付/邮件/删除类下游未测；社区幂等插件组合（R30）无环境。
- 是否存在 P0/P1：**无**。

**READY_FOR_GITHUB_BETA: YES**

说明：本轮在 Windows 11 + DSH `0.2.0-rc.2` 上完成了本地测试、Windows 专项、真实 ToolRuntime R01–R29 与真实模型 A–E 的全部适用项，未发现 P0/P1，运行时包干净，报告与脱敏证据可复核。发布时请连带声明以下未验证范围：R16 的运行时注入、R30 的社区插件组合、macOS/Linux、多进程/跨机、真实业务下游，以及“插件完全缺席时宿主不自保”这一硬边界。
