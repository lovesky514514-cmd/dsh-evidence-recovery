#requires -Version 5.1
# Windows PowerShell 5.1 needs a BOM for localized messages.
[CmdletBinding()]
param(
    [switch]$ConfigOnly,
    [switch]$IsolatedWeb,
    [string]$DshPath = $env:DSH_CLI
)

$ErrorActionPreference = 'Stop'
$profileName = 'sky-evidence-smoke'
$project = $PSScriptRoot
$runName = 'sky-evidence-smoke-' + [Guid]::NewGuid().ToString('N')
$runDir = Join-Path ([IO.Path]::GetTempPath()) $runName
$testHome = Join-Path $runDir 'home'
$dataDir = Join-Path $runDir 'ledger'
$demoDir = Join-Path $runDir 'orders'
$patch = Join-Path $runDir 'demo.patch.yml'
$previousDshHome = $env:DSH_HOME

function Resolve-Dsh {
    if ($DshPath) {
        if (-not (Test-Path -LiteralPath $DshPath -PathType Leaf)) {
            throw '指定的 DSH CLI 文件不存在。'
        }
        return (Resolve-Path -LiteralPath $DshPath).ProviderPath
    }

    $command = Get-Command dsh.cmd, dsh -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($command) { return $command.Source }

    # Limit discovery to likely installation roots.
    $roots = @(
        (Join-Path $env:LOCALAPPDATA 'Programs'),
        $env:LOCALAPPDATA,
        $env:ProgramFiles,
        ${env:ProgramFiles(x86)}
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) } | Select-Object -Unique
    $installDirs = New-Object System.Collections.Generic.List[string]

    foreach ($root in $roots) {
        $folders = Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '(?i)deepseek|harness|^dsh$' }
        foreach ($folder in $folders) { $installDirs.Add($folder.FullName) }
    }

    # Include desktop installs registered outside the usual roots.
    $uninstallKeys = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    foreach ($key in $uninstallKeys) {
        $entries = Get-ChildItem -Path $key -ErrorAction SilentlyContinue
        foreach ($entry in $entries) {
            $program = Get-ItemProperty -LiteralPath $entry.PSPath -ErrorAction SilentlyContinue
            if ($program.DisplayName -match '(?i)deepseek.*harness|harness.*deepseek') {
                if ($program.InstallLocation) { $installDirs.Add($program.InstallLocation) }
            }
        }
    }

    foreach ($dir in ($installDirs | Select-Object -Unique)) {
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { continue }
        foreach ($relative in @(
            'resources\runtime\cli\bin\dsh.cmd',
            'resources\cli\bin\dsh.cmd',
            'bin\dsh.cmd'
        )) {
            $candidate = Join-Path $dir $relative
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
        $found = Get-ChildItem -LiteralPath $dir -File -Filter dsh.cmd -Recurse -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($found) { return $found.FullName }
    }

    throw ('未自动找到 DSH CLI。请在 PowerShell 运行：' +
        'powershell -NoProfile -ExecutionPolicy Bypass -File .\DSH_本地试跑.ps1 ' +
        '-DshPath "安装目录\resources\runtime\cli\bin\dsh.cmd"；' +
        '或设置 DSH_CLI 为真实的 dsh.cmd 完整路径。')
}

function Invoke-Checked([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "DSH 命令失败，退出码 $LASTEXITCODE。"
    }
}

try {
    $dsh = Resolve-Dsh
    Write-Host "已找到 DSH CLI。" -ForegroundColor Green
    # Desktop builds can supply their own Node runtime.
    if (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) {
        Write-Host '未检测到全局 Node，尝试使用 DSH 桌面版内置运行时。' -ForegroundColor Yellow
    }

    # Use a fresh home and keep the artifacts for manual restart and readback.
    New-Item -ItemType Directory -Path $runDir | Out-Null
    New-Item -ItemType Directory -Path $testHome | Out-Null
    $env:DSH_HOME = $testHome
    Write-Host "[1/4] 准备隔离测试 Profile。测试目录：$runDir" -ForegroundColor Cyan
    Invoke-Checked -Exe $dsh -Arguments @(
        '--profile', $profileName, '--from-default-profile', 'web', '--dump-config'
    ) | Out-Null

    Write-Host '[2/4] 本地安装插件，不上传 GitHub' -ForegroundColor Cyan
    Invoke-Checked -Exe $dsh -Arguments @('plugin', '--profile', $profileName, 'add', ('file:' + $project))

    $jsonDir = ConvertTo-Json -InputObject $dataDir -Compress
    $jsonDemoDir = ConvertTo-Json -InputObject $demoDir -Compress
    $content = @"
# Limit recovery rules to the simulated order tool.
- id: sky-evidence-recovery
  config:
    dataDir: $jsonDir
    rules:
      - tool: sky_demo_create_order
        keyArg: requestId
- insert:
    - id: sky-evidence-recovery-demo
      name: sky-evidence-recovery/demo
      config:
        dataDir: $jsonDemoDir
"@
    [System.IO.File]::WriteAllText($patch, $content, [System.Text.UTF8Encoding]::new($false))

    Write-Host '[3/4] 验证最终配置包含保护规则' -ForegroundColor Cyan
    $dump = & $dsh --profile $profileName --patch $patch --dump-config 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'DSH 配置组合失败，请检查上方错误。' }
    $dumpText = $dump -join "`n"
    if ($dumpText -notmatch 'id:\s*sky-evidence-recovery' -or
        $dumpText -notmatch 'tool:\s*sky_demo_create_order' -or
        $dumpText -notmatch 'id:\s*sky-evidence-recovery-demo') {
        throw '最终配置缺少插件、保护规则或模拟工具，拒绝启动。'
    }
    Write-Host '配置预检通过；这还不能证明插件运行时已经激活。' -ForegroundColor Green
    if ($ConfigOnly -or -not $IsolatedWeb) {
        Write-Host '配置检查完成。仅在宿主已隔离 Agent 权限时，才以 -IsolatedWeb 启动。'
        exit 0
    }

    Write-Host '[4/4] 启动 DSH Web' -ForegroundColor Green
    Write-Host '打开 http://127.0.0.1:3080 后，必须先调用 sky_recovery_health。'
    Write-Host '确认 loaded=true、ledgerLocked=true、protectedTools 包含模拟工具后再测试。'
    & $dsh --profile $profileName --patch $patch --no-open
    if ($LASTEXITCODE -notin @(0, 130)) { throw "DSH 退出码：$LASTEXITCODE" }
} catch {
    Write-Host ('错误：' + $_.Exception.Message) -ForegroundColor Red
    Write-Host '请检查提示，或通过 -DshPath / DSH_CLI 指向桌面版真实 dsh.cmd。' -ForegroundColor Yellow
    exit 1
} finally {
    $env:DSH_HOME = $previousDshHome
}
