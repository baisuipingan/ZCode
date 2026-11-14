#requires -Version 7.4
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [string]$Sha256 = '',
    [string]$ManifestPath = (Join-Path $PSScriptRoot '..\windows-installer-acceptance.json'),
    [string]$WorkRoot = (Join-Path $env:RUNNER_TEMP ('milocode-acceptance-' + [guid]::NewGuid().ToString('N')))
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This acceptance script must run on Windows.' }
if (-not $env:RUNNER_TEMP) { throw 'RUNNER_TEMP is required for an isolated acceptance run.' }
$tempRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
$WorkRoot = [IO.Path]::GetFullPath($WorkRoot)
if (-not $WorkRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'WorkRoot must be a child of RUNNER_TEMP.'
}
if (Test-Path -LiteralPath $WorkRoot) { throw 'WorkRoot must not already exist; use a fresh directory.' }
$evidence = Join-Path $WorkRoot 'evidence'
$installDir = Join-Path $WorkRoot 'MiloCode'
$profileDir = Join-Path $WorkRoot 'profile'
New-Item -ItemType Directory -Path $evidence, $profileDir -Force | Out-Null
$owned = @{}
$stages = [Collections.Generic.List[object]]::new()
$report = [ordered]@{
    schemaVersion = 1; status = 'running'; startedAt = [DateTime]::UtcNow.ToString('o')
    finishedAt = $null; error = $null; errorDetail = $null; cleanupError = $null; stages = $stages
}
$reportPath = Join-Path $evidence 'result.json'

function Save-Report {
    $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $reportPath -Encoding utf8
}
function Record-Stage([string]$Name, [object]$Details) {
    $stages.Add([ordered]@{ name = $Name; at = [DateTime]::UtcNow.ToString('o'); details = $Details })
    Save-Report
    Write-Host "[acceptance] $Name"
}
function Remember-Process([Diagnostics.Process]$Process) {
    try { $owned[$Process.Id] = $Process.StartTime.ToUniversalTime().Ticks } catch { }
}
function Update-OwnedProcesses {
    # 只从本次已记录的 PID 扩展后代；退出后 PID 被复用也不能误杀别的应用。
    $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
    $liveOwners = @{}
    foreach ($processId in @($owned.Keys)) {
        try {
            $process = Get-Process -Id $processId -ErrorAction Stop
            if ($process.StartTime.ToUniversalTime().Ticks -eq $owned[$processId]) { $liveOwners[$processId] = $true }
        } catch { }
    }
    do {
        $added = $false
        foreach ($row in $rows) {
            $childId = [int]$row.ProcessId
            if ($liveOwners.ContainsKey([int]$row.ParentProcessId) -and -not $owned.ContainsKey($childId)) {
                try {
                    $child = Get-Process -Id $childId -ErrorAction Stop
                    if ($child.StartTime.ToUniversalTime().Ticks -ge $owned[[int]$row.ParentProcessId]) {
                        Remember-Process $child
                        $liveOwners[$childId] = $true
                        $added = $true
                    }
                } catch { }
            }
        }
    } while ($added)
}
function Stop-OwnedProcesses {
    Update-OwnedProcesses
    # 不按应用名筛选，不使用 taskkill /IM；逐一比对启动时间后才退出进程。
    foreach ($processId in @($owned.Keys | Sort-Object { $owned[$_] } -Descending)) {
        try {
            $process = Get-Process -Id $processId -ErrorAction Stop
            if ($process.StartTime.ToUniversalTime().Ticks -eq $owned[$processId]) {
                Stop-Process -InputObject $process -Force -ErrorAction Stop
                $process.WaitForExit(10000) | Out-Null
            }
        } catch [Microsoft.PowerShell.Commands.ProcessCommandException] { }
    }
    $owned.Clear()
}
function Start-OwnedProcess([string]$FilePath, [string[]]$Arguments, [hashtable]$Environment = @{}, [string]$RawArguments = '') {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $FilePath
    $start.UseShellExecute = $false
    $start.WorkingDirectory = $WorkRoot
    if ($RawArguments) { $start.Arguments = $RawArguments }
    else { foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) } }
    foreach ($key in $Environment.Keys) { $start.Environment[$key] = [string]$Environment[$key] }
    $process = [Diagnostics.Process]::Start($start)
    Remember-Process $process
    return $process
}
function Wait-OwnedExit([Diagnostics.Process]$Process, [int]$Seconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while (-not $Process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        Update-OwnedProcesses
        Start-Sleep -Milliseconds 400
        $Process.Refresh()
    }
    if (-not $Process.HasExited) { throw "Process $($Process.Id) timed out after $Seconds seconds." }
    $Process.WaitForExit()
    if ($Process.ExitCode -ne 0) { throw "Process $($Process.Id) exited with code $($Process.ExitCode)." }
    return $Process.ExitCode
}
function Invoke-Cdp([string]$SocketUrl, [string]$Method, [hashtable]$Parameters) {
    $socketUri = [uri]$SocketUrl
    if ($socketUri.Scheme -ne 'ws' -or $socketUri.Host -notin @('127.0.0.1', 'localhost', '[::1]')) {
        throw 'Only loopback CDP sockets are allowed.'
    }
    $socket = [Net.WebSockets.ClientWebSocket]::new()
    $cancel = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(15))
    try {
        # Windows/.NET 可能把内部 VoidTaskResult 写入成功流；只返回 CDP result，不能混入异步完成值。
        $null = $socket.ConnectAsync($socketUri, $cancel.Token).GetAwaiter().GetResult()
        $message = @{ id = 1; method = $Method; params = $Parameters } | ConvertTo-Json -Depth 12 -Compress
        $bytes = [Text.Encoding]::UTF8.GetBytes($message)
        $null = $socket.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, $cancel.Token).GetAwaiter().GetResult()
        do {
            $stream = [IO.MemoryStream]::new()
            try {
                do {
                    $buffer = [byte[]]::new(65536)
                    $received = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), $cancel.Token).GetAwaiter().GetResult()
                    if ($received.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) { throw 'CDP socket closed before replying.' }
                    $stream.Write($buffer, 0, $received.Count)
                    if ($stream.Length -gt 16MB) { throw 'CDP reply exceeded the acceptance size limit.' }
                } while (-not $received.EndOfMessage)
                $reply = [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json -AsHashtable
            } finally { $stream.Dispose() }
        } while (-not $reply.ContainsKey('id') -or $reply.id -ne 1)
        if ($reply.ContainsKey('error')) { throw "CDP failed: $($reply.error | ConvertTo-Json -Compress)" }
        return $reply.result
    } finally { $socket.Dispose(); $cancel.Dispose() }
}
function Test-MainRendererTarget([object]$Target) {
    $uri = $null
    if (-not [uri]::TryCreate([string]$Target.url, [UriKind]::Absolute, [ref]$uri)) { return $false }
    return $Target.type -eq 'page' -and $uri.Scheme -eq 'file' -and
        $uri.AbsolutePath -match '/out/renderer/index\.html$' -and
        $uri.Query -notmatch '(?:\?|&)windowKind=update-status(?:&|$)'
}
function Read-RendererProbe([string]$SocketUrl, [string]$Expression) {
    $evaluation = Invoke-Cdp $SocketUrl 'Runtime.evaluate' @{ expression = $Expression; returnByValue = $true }
    if ($evaluation.ContainsKey('exceptionDetails')) { throw 'Renderer readiness probe threw an exception.' }
    $value = $evaluation.result.value
    if ($value.visibleErrors.Count -gt 0) { throw "Renderer displayed an error: $($value.visibleErrors -join '; ')" }
    return $value
}
function Read-PaintedRendererProbe([string]$SocketUrl, [string]$Expression, [string]$ScreenshotPath) {
    $beforeAt = [DateTime]::UtcNow.ToString('o')
    $before = Read-RendererProbe $SocketUrl $Expression
    $shot = Invoke-Cdp $SocketUrl 'Page.captureScreenshot' @{ format = 'png'; captureBeyondViewport = $false }
    [IO.File]::WriteAllBytes($ScreenshotPath, [Convert]::FromBase64String($shot.data))
    $paintedAt = [DateTime]::UtcNow.ToString('o')
    $after = Read-RendererProbe $SocketUrl $Expression
    return [ordered]@{
        beforeAt = $beforeAt; before = $before; paintedAt = $paintedAt
        afterAt = [DateTime]::UtcNow.ToString('o'); after = $after
        screenshot = [IO.Path]::GetFileName($ScreenshotPath)
    }
}
function Test-RendererLoginReady([object]$Value) {
    return $Value.state -eq 'complete' -and $Value.title -match 'MiloCode' -and
        $Value.rootChildren -gt 0 -and $Value.textLength -gt 10 -and $Value.controls -gt 0 -and
        -not $Value.staticLoadingPresent -and -not $Value.startupLoadingPresent -and
        $Value.loginVisible -and $Value.loginEnabled -and $Value.loginInViewport -and $Value.loginClickable
}

function Invoke-ComputerUseAcceptance([string]$ApplicationPath) {
    $fixtureRoot = Join-Path $evidence 'computer-use'
    New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
    $fixtureName = 'MiloCodeCuaFixture-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
    $fixtureSource = Join-Path $fixtureRoot ($fixtureName + '.cs')
    $fixtureExecutable = Join-Path $fixtureRoot ($fixtureName + '.exe')
    $echoPath = Join-Path $fixtureRoot 'fixture-echo.txt'
    $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'Windows .NET Framework compiler is required for the isolated fixture.' }
    # 仅本次进程建立的独立窗口可被控制；输入回显与截图不包含用户工作内容。
    @'
using System;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;
public static class MiloCodeCuaFixture {
    [STAThread]
    public static void Main(string[] args) {
        if (args.Length != 2) throw new ArgumentException("Expected echo path and unique window title");
        string echoPath = args[0];
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        var window = new Form();
        window.Text = args[1];
        window.Width = 650;
        window.Height = 230;
        window.StartPosition = FormStartPosition.CenterScreen;
        window.Font = new Font("Segoe UI", 11);
        var label = new Label();
        label.Text = "MiloCode Computer Use acceptance - temporary test window only";
        label.SetBounds(20, 20, 595, 40);
        var input = new TextBox();
        input.Name = "MiloCodeCuaInput";
        input.AccessibleName = "MiloCode CUA test input";
        input.SetBounds(20, 85, 595, 35);
        input.TextChanged += delegate { File.WriteAllText(echoPath, input.Text, new UTF8Encoding(false)); };
        window.Controls.Add(label);
        window.Controls.Add(input);
        File.WriteAllText(echoPath, "", new UTF8Encoding(false));
        Application.Run(window);
    }
}
'@ | Set-Content -LiteralPath $fixtureSource -Encoding utf8
    & $compiler '/nologo' '/target:winexe' "/out:$fixtureExecutable" '/reference:System.Windows.Forms.dll' '/reference:System.Drawing.dll' $fixtureSource
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $fixtureExecutable -PathType Leaf)) { throw 'Compiling the isolated Computer Use fixture failed.' }
    $fixture = Start-OwnedProcess $fixtureExecutable @($echoPath, $fixtureName)
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $fixture.Refresh()
        if ($fixture.HasExited) { throw 'Computer Use fixture exited before showing its window.' }
        if ($fixture.MainWindowHandle -ne [IntPtr]::Zero -and $fixture.MainWindowTitle -eq $fixtureName) { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($fixture.MainWindowHandle -eq [IntPtr]::Zero -or $fixture.MainWindowTitle -ne $fixtureName) { throw 'The isolated Computer Use fixture did not show its window.' }
    $smokeScript = Join-Path $PSScriptRoot 'windows-computer-use-acceptance.mjs'
    $smoke = Start-OwnedProcess $ApplicationPath @(
        $smokeScript, '--application', $ApplicationPath, '--work-root', $fixtureRoot,
        '--fixture-app', $fixtureName, '--echo-path', $echoPath
    ) @{ ELECTRON_RUN_AS_NODE = '1' }
    $null = Wait-OwnedExit $smoke 150
    $nativeReport = Get-Content -LiteralPath (Join-Path $fixtureRoot 'computer-use-result.json') -Raw | ConvertFrom-Json
    if ($nativeReport.status -ne 'passed') { throw 'Final-package Computer Use acceptance did not pass.' }
    $fixture.Refresh()
    if ($fixture.HasExited -or $fixture.MainWindowTitle -ne $fixtureName) { throw 'Fixture exited before final visual evidence.' }
    $rect = [MiloInstallerWindowProbe+Rect]::new()
    if (-not [MiloInstallerWindowProbe]::GetWindowRect($fixture.MainWindowHandle, [ref]$rect)) { throw 'Cannot read fixture window bounds.' }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -lt 200 -or $height -lt 100) { throw 'Computer Use fixture bounds are invalid.' }
    $bitmap = [Drawing.Bitmap]::new($width, $height)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
        $bitmap.Save((Join-Path $fixtureRoot 'fixture-after.png'), [Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
    Record-Stage 'computer-use-verified' @{
        report = 'computer-use/computer-use-result.json'; fixture = $fixtureName
        installedNodeReplAndSdk = $true; nativeInputAndIndependentEcho = $true
    }
    Stop-OwnedProcesses
}

Save-Report
try {
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.repository -ne 'baisuipingan/ZCode' -or
        $manifest.releaseTag -ne 'milocode-v3.17.8' -or $manifest.version -ne '3.17.8' -or
        $manifest.assetName -ne 'MiloCode-3.17.8-win-x64.exe') { throw 'Unexpected final release manifest.' }
    $InstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
    if ([IO.Path]::GetFileName($InstallerPath) -ne $manifest.assetName) { throw 'Installer filename differs from the final release asset.' }
    $expectedHash = $(if ($Sha256) { $Sha256 } else { $manifest.sha256 }).Trim().ToLowerInvariant()
    if ($expectedHash -notmatch '^[0-9a-f]{64}$') { throw 'A final SHA256 is required; the publisher must populate the manifest or dispatch input.' }
    $actualHash = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) { throw "Final installer SHA256 mismatch: $actualHash" }
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($InstallerPath)
    if ($version.ProductVersion -notmatch '^3\.17\.8(?:\.0)?$' -or $version.ProductName -ne 'MiloCode') {
        throw "Unexpected installer identity: $($version.ProductName) $($version.ProductVersion)"
    }
    Record-Stage 'asset-verified' @{ sha256 = $actualHash; bytes = (Get-Item -LiteralPath $InstallerPath).Length; version = $version.ProductVersion }

    Add-Type -AssemblyName System.Drawing
    # 读取本次向导的 Win32 控件，不依赖 runner 额外安装 UI Automation 或浏览器驱动。
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class MiloInstallerWindowProbe {
    public struct Rect { public int Left, Top, Right, Bottom; }
    private delegate bool EnumWindowProc(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr handle, EnumWindowProc callback, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr handle, StringBuilder buffer, int length);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder buffer, int length);
    public static string[] ReadButtons(IntPtr handle) {
        var result = new List<string>();
        EnumChildWindows(handle, (child, unused) => {
            var kind = new StringBuilder(128);
            var text = new StringBuilder(1024);
            GetClassName(child, kind, kind.Capacity);
            if (kind.ToString() == "Button" && IsWindowVisible(child)) {
                GetWindowText(child, text, text.Capacity);
                result.Add(text.ToString());
            }
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
}
'@
    $wizard = Start-OwnedProcess $InstallerPath @('/currentuser')
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    $window = $null
    while (-not $window -and [DateTime]::UtcNow -lt $deadline) {
        Update-OwnedProcesses
        foreach ($processId in @($owned.Keys)) {
            $candidate = Get-Process -Id $processId -ErrorAction SilentlyContinue
            if ($candidate -and $candidate.MainWindowHandle -ne [IntPtr]::Zero) {
                if ($candidate.MainWindowTitle -match 'MiloCode' -and [MiloInstallerWindowProbe]::IsWindowVisible($candidate.MainWindowHandle)) {
                    $window = $candidate
                    break
                }
            }
        }
        if (-not $window) { Start-Sleep -Milliseconds 300 }
    }
    if (-not $window) { throw 'No visible MiloCode installer wizard appeared.' }
    $buttonNames = @([MiloInstallerWindowProbe]::ReadButtons($window.MainWindowHandle))
    if ($buttonNames.Count -lt 2 -or -not ($buttonNames -match '(?i)(next|install|下一步|安装)')) {
        throw 'Installer window did not expose normal Next/Install wizard controls.'
    }
    $rect = [MiloInstallerWindowProbe+Rect]::new()
    if (-not [MiloInstallerWindowProbe]::GetWindowRect($window.MainWindowHandle, [ref]$rect)) { throw 'Cannot read installer wizard bounds.' }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -lt 200 -or $height -lt 100) { throw 'Installer wizard has an invalid window size.' }
    $bitmap = [Drawing.Bitmap]::new($width, $height)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
        $bitmap.Save((Join-Path $evidence 'installer-wizard.png'), [Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
    Record-Stage 'wizard-visible' @{ title = $window.MainWindowTitle; buttons = $buttonNames; width = $width; height = $height }
    Stop-OwnedProcesses

    # NSIS 官方规则要求 /D 最后且不能带引号，即使路径有空格；此处不使用会自动加引号的 ArgumentList。
    $installer = Start-OwnedProcess -FilePath $InstallerPath -Arguments @() -RawArguments "/S /currentuser /D=$installDir"
    $installExit = Wait-OwnedExit $installer 240
    $appPath = Join-Path $installDir 'MiloCode.exe'
    if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) { throw 'The installed MiloCode.exe is missing.' }
    $uninstallers = @(Get-ChildItem -LiteralPath $installDir -Filter '*Uninstall*.exe' -File)
    if ($uninstallers.Count -ne 1) { throw 'Expected exactly one installed uninstaller.' }
    $shell = New-Object -ComObject WScript.Shell
    $shortcutRows = @()
    foreach ($shortcutRoot in @([Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('Programs'))) {
        foreach ($link in @(Get-ChildItem -LiteralPath $shortcutRoot -Filter '*MiloCode*.lnk' -File -Recurse -ErrorAction SilentlyContinue)) {
            $target = $shell.CreateShortcut($link.FullName).TargetPath
            if ($target -eq $appPath) { $shortcutRows += @{ path = $link.FullName; target = $target } }
        }
    }
    if ($shortcutRows.Count -lt 1) { throw 'No current-user shortcut points to this installed application.' }
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
    Record-Stage 'installed' @{ exitCode = $installExit; application = $appPath; uninstaller = $uninstallers[0].Name; shortcuts = $shortcutRows }

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    $runtimeEnv = @{
        ZCODE_DESKTOP_USER_DATA_DIR = (Join-Path $profileDir 'user-data')
        ZCODE_DESKTOP_SESSION_DATA_DIR = (Join-Path $profileDir 'session-data')
        ZCODE_DESKTOP_HOME_DIR = (Join-Path $profileDir 'home')
        ZCODE_DATA_BASE_DIR = (Join-Path $profileDir 'data')
        ZCODE_HOME = (Join-Path $profileDir 'data\.zcode')
        ZCODE_DESKTOP_APPLICATION_NAME = 'MiloCode Installer Acceptance'
    }
    foreach ($directory in $runtimeEnv.Values) {
        if ($directory.StartsWith($profileDir, [StringComparison]::OrdinalIgnoreCase)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    }
    $app = Start-OwnedProcess $appPath @("--remote-debugging-port=$port", '--remote-debugging-address=127.0.0.1', "--user-data-dir=$($runtimeEnv.ZCODE_DESKTOP_USER_DATA_DIR)") $runtimeEnv
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    $ready = $null
    $pageSocket = $null
    $lastPageSocket = $null
    $lastRendererTarget = $null
    $lastRendererProbe = $null
    $lastRendererPaint = $null
    $lastPageTargets = @()
    $frontedTargetIds = @{}
    $lastProbeError = ''
    $expression = @'
(() => {
  const root = document.querySelector('#root');
  const login = root?.querySelector('[data-testid="brand-account-submit"]');
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.display !== 'none' &&
      style.visibility !== 'hidden' && style.opacity !== '0' &&
      !element.closest('[hidden],[inert],[aria-hidden="true"]');
  };
  const box = login?.getBoundingClientRect();
  const x = box ? box.left + box.width / 2 : -1;
  const y = box ? box.top + box.height / 2 : -1;
  const loginVisible = visible(login);
  const loginEnabled = login instanceof HTMLButtonElement && !login.disabled &&
    login.getAttribute('aria-disabled') !== 'true';
  const loginInViewport = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
  const hit = loginInViewport ? document.elementFromPoint(x, y) : null;
  const loginClickable = loginVisible && loginEnabled && loginInViewport &&
    getComputedStyle(login).pointerEvents !== 'none' && !!hit && login.contains(hit);
  const staticLoadingPresent = !!document.querySelector('#loading');
  const startupLoadingPresent = !!document.querySelector('[data-testid="root-startup-loading"]');
  return {
    state: document.readyState,
    title: document.title,
    url: location.href,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    rootChildren: root?.childElementCount ?? 0,
    textLength: root?.innerText?.trim().length ?? 0,
    rootText: root?.innerText?.trim().slice(0, 2000) ?? '',
    controls: root?.querySelectorAll('button,input,[role="button"]').length ?? 0,
    startupStates: Array.from(document.querySelectorAll(
      '[data-testid="root-startup-loading"],[data-testid="database-startup-silent"],[data-testid="database-startup-status"]'
    )).map(element => ({
      testId: element.getAttribute('data-testid'),
      phase: element.getAttribute('data-phase'),
      databasePhase: element.getAttribute('data-database-phase'),
      errorCode: element.getAttribute('data-error-code'),
      visible: visible(element)
    })),
    staticLoadingPresent,
    startupLoadingPresent,
    loginSelector: '[data-testid="brand-account-submit"]',
    loginVisible,
    loginEnabled,
    loginInViewport,
    loginClickable,
    loginReady: !staticLoadingPresent && !startupLoadingPresent && loginClickable,
    loginText: login?.innerText?.trim() ?? '',
    visibleErrors: Array.from(root?.querySelectorAll('[role="alert"]') ?? [])
      .filter(visible).map(element => element.innerText.trim()).filter(Boolean)
  };
})()
'@
    while (-not $ready -and [DateTime]::UtcNow -lt $deadline) {
        Update-OwnedProcesses
        try {
            # Invoke-RestMethod 会保留 JSON 数组，先显式展平，避免把数组误当成一个 target。
            $pages = @(Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 3 | ForEach-Object { $_ })
            $lastPageTargets = @($pages | Select-Object id, type, title, url)
            foreach ($page in $pages) {
                if (-not (Test-MainRendererTarget $page) -or -not $page.webSocketDebuggerUrl) { continue }
                $lastPageSocket = $page.webSocketDebuggerUrl
                $lastRendererTarget = $page | Select-Object id, type, title, url
                $lastRendererProbe = $null
                $lastRendererPaint = $null
                if (-not $frontedTargetIds.ContainsKey($page.id)) {
                    $null = Invoke-Cdp $page.webSocketDebuggerUrl 'Page.bringToFront' @{}
                    $frontedTargetIds[$page.id] = $true
                }
                # runner 可见截图与旧 DOM 曾不一致；先提交可见帧，再用相同严格条件读取真实登录态。
                $lastRendererPaint = Read-PaintedRendererProbe $page.webSocketDebuggerUrl $expression (Join-Path $evidence 'renderer-latest.png')
                $value = $lastRendererPaint.after
                $lastRendererProbe = $value
                # 启动遮罩也有文本和按钮；全新 profile 必须实际进入可点击的品牌登录页。
                if (Test-RendererLoginReady $value) {
                    $lastRendererPaint = Read-PaintedRendererProbe $page.webSocketDebuggerUrl $expression (Join-Path $evidence 'installed-renderer.png')
                    $lastRendererProbe = $lastRendererPaint.after
                    if (-not (Test-RendererLoginReady $lastRendererProbe)) { throw 'Renderer login readiness changed after final screenshot.' }
                    $value = $lastRendererProbe
                    $ready = $value
                    $pageSocket = $page.webSocketDebuggerUrl
                    break
                }
                $lastProbeError = $value | ConvertTo-Json -Depth 6 -Compress
            }
        } catch {
            if ($_.Exception.Message -eq 'Renderer readiness probe threw an exception.' -or
                $_.Exception.Message.StartsWith('Renderer displayed an error:')) { throw }
            $lastProbeError = $_.Exception.Message
        }
        if (-not $ready) { Start-Sleep -Milliseconds 700 }
    }
    if (-not $ready) {
        # Host ready 不等于当前页面可用；失败前保留目标、DOM 阶段和截图，不能靠放宽门槛掩盖问题。
        $diagnostic = [ordered]@{
            observedAt = [DateTime]::UtcNow.ToString('o')
            targets = $lastPageTargets; target = $lastRendererTarget; probe = $lastRendererProbe
            paint = $lastRendererPaint
            error = $lastProbeError; screenshot = $null; screenshotError = $null
        }
        if ($lastPageSocket) {
            try {
                $failedShot = Invoke-Cdp $lastPageSocket 'Page.captureScreenshot' @{ format = 'png'; captureBeyondViewport = $false }
                [IO.File]::WriteAllBytes((Join-Path $evidence 'renderer-failed.png'), [Convert]::FromBase64String($failedShot.data))
                $diagnostic.screenshot = 'renderer-failed.png'
            } catch { $diagnostic.screenshotError = $_.Exception.Message }
        }
        try {
            $diagnostic | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath (Join-Path $evidence 'renderer-last-probe.json') -Encoding utf8
        } catch { Write-Warning "Could not save renderer diagnostics: $($_.Exception.Message)" }
        throw "Installed application renderer did not become ready. Last probe: $lastProbeError"
    }
    [ordered]@{ target = $lastRendererTarget; targets = $lastPageTargets; paint = $lastRendererPaint } |
        ConvertTo-Json -Depth 15 | Set-Content -LiteralPath (Join-Path $evidence 'renderer-ready-probe.json') -Encoding utf8
    Record-Stage 'renderer-ready' $ready
    Stop-OwnedProcesses

    # 真实桌面控制必须在同一最终安装目录验证；任何 CUA 失败都会阻止发布。
    Invoke-ComputerUseAcceptance $appPath

    $uninstaller = Start-OwnedProcess -FilePath $uninstallers[0].FullName -Arguments @() -RawArguments "/S /currentuser _?=$installDir"
    $uninstallExit = Wait-OwnedExit $uninstaller 120
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    while ((Test-Path -LiteralPath $appPath) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 300 }
    if (Test-Path -LiteralPath $appPath) { throw 'MiloCode.exe remains after uninstall.' }
    foreach ($shortcut in $shortcutRows) {
        if (Test-Path -LiteralPath $shortcut.path) { throw "Installed shortcut remains after uninstall: $($shortcut.path)" }
    }
    Record-Stage 'uninstalled' @{ exitCode = $uninstallExit; applicationRemoved = $true; shortcutsRemoved = $true }
    $report.status = 'passed'
} catch {
    $report.status = 'failed'
    $report.error = $_.Exception.Message
    $report.errorDetail = $_.ToString()
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
} finally {
    try { Stop-OwnedProcesses } catch { $report.cleanupError = $_.Exception.Message; $report.status = 'failed' }
    $report.finishedAt = [DateTime]::UtcNow.ToString('o')
    Save-Report
}
if ($report.status -ne 'passed') { exit 1 }
Write-Host "Final Windows installer acceptance passed. Evidence: $evidence"
