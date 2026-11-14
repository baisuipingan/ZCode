#requires -Version 7.4
[CmdletBinding()]
param([string]$SocketUrl = '')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$sourcePath = Join-Path $PSScriptRoot '..\windows-installer-acceptance.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw ($parseErrors | Out-String) }
$definition = $ast.Find({
    param($node)
    $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Cdp'
}, $true)
if (-not $definition) { throw 'Acceptance transport function was not found.' }

function Assert-CdpResult([object[]]$Values, [string]$Scenario) {
    if ($Values.Count -ne 1 -or $Values[0] -isnot [hashtable]) {
        $types = @($Values | ForEach-Object { $_.GetType().FullName }) -join ', '
        throw "$Scenario returned $($Values.Count) outputs ($types); expected one Hashtable."
    }
    if (-not $Values[0].ContainsKey('result') -or $Values[0].result.value.Length -ne 70000) {
        throw "$Scenario did not return the complete matching CDP reply."
    }
}

# 运行时可能只在 Windows 暴露 VoidTaskResult；注入同样非空的 Task 完成值，稳定复现成功流污染。
# 只替换 socket 工厂，待测 Invoke-Cdp 的异步等待、分片与过滤逻辑均直接读取正式脚本。
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
public sealed class MiloCdpFixtureSocket : IDisposable {
    public sealed class CompletionMarker { }
    public static int ConnectCount;
    public static int SendCount;
    public static int ReceiveCount;
    public static int DisposeCount;
    private readonly Queue<byte[]> messages = new Queue<byte[]>();
    private byte[] current;
    private int offset;
    public MiloCdpFixtureSocket() {
        messages.Enqueue(Encoding.UTF8.GetBytes("{\"method\":\"Runtime.executionContextCreated\",\"params\":{}}"));
        messages.Enqueue(Encoding.UTF8.GetBytes("{\"id\":99,\"result\":{}}"));
        messages.Enqueue(Encoding.UTF8.GetBytes("{\"id\":1,\"result\":{\"result\":{\"value\":\"" + new string('x', 70000) + "\"}}}"));
    }
    public async Task<object> ConnectAsync(Uri url, CancellationToken cancel) {
        ConnectCount++;
        await Task.Delay(1, cancel);
        return new CompletionMarker();
    }
    public async Task<object> SendAsync(ArraySegment<byte> bytes, WebSocketMessageType type, bool end, CancellationToken cancel) {
        SendCount++;
        await Task.Delay(1, cancel);
        return new CompletionMarker();
    }
    public async Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> buffer, CancellationToken cancel) {
        ReceiveCount++;
        await Task.Delay(1, cancel);
        if (current == null) { current = messages.Dequeue(); offset = 0; }
        int count = Math.Min(16384, Math.Min(buffer.Count, current.Length - offset));
        Array.Copy(current, offset, buffer.Array, buffer.Offset, count);
        offset += count;
        bool end = offset == current.Length;
        if (end) { current = null; }
        return new WebSocketReceiveResult(count, WebSocketMessageType.Text, end);
    }
    public void Dispose() { DisposeCount++; }
}
'@
$factory = '[Net.WebSockets.ClientWebSocket]::new()'
if ($definition.Extent.Text.Split($factory).Count -ne 2) { throw 'Expected one socket factory in the transport.' }
Invoke-Expression $definition.Extent.Text.Replace($factory, '[MiloCdpFixtureSocket]::new()')
$values = @(Invoke-Cdp 'ws://127.0.0.1:1' 'Runtime.evaluate' @{ expression = 'fixture' })
Assert-CdpResult $values 'Injected asynchronous completion values'
if ([MiloCdpFixtureSocket]::ConnectCount -ne 1 -or [MiloCdpFixtureSocket]::SendCount -ne 1 -or
    [MiloCdpFixtureSocket]::ReceiveCount -lt 7 -or [MiloCdpFixtureSocket]::DisposeCount -ne 1) {
    throw 'Injected socket did not exercise asynchronous operations, events, unrelated responses, fragments and disposal.'
}
Write-Host 'PASS: only one Hashtable with nonempty async completion values, events, unrelated IDs and >64 KiB fragments.'

if ($SocketUrl) {
    Invoke-Expression $definition.Extent.Text
    $values = @(Invoke-Cdp $SocketUrl 'Runtime.evaluate' @{ expression = 'fixture' })
    Assert-CdpResult $values 'Real loopback WebSocket'
    Write-Host 'PASS: real loopback WebSocket returns one complete Hashtable.'
}

foreach ($name in @('Test-MainRendererTarget', 'Read-RendererProbe', 'Read-PaintedRendererProbe', 'Test-RendererLoginReady')) {
    $functionAst = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    if (-not $functionAst) { throw "Acceptance function was not found: $name" }
    Invoke-Expression $functionAst.Extent.Text
}
$main = [pscustomobject]@{ id = 'main'; type = 'page'; title = 'MiloCode'; url = 'file:///D:/MiloCode/resources/app.asar/out/renderer/index.html?restoreSession=true' }
$update = [pscustomobject]@{ id = 'update'; type = 'page'; title = 'MiloCode'; url = 'file:///D:/MiloCode/resources/app.asar/out/renderer/index.html?windowKind=update-status' }
foreach ($fixture in @(@{ targets = @($main) }, @{ targets = @($main, $update) })) {
    # 模拟 Invoke-RestMethod 的 NoEnumerate 数组返回，正式表达式必须得到逐个 target。
    $pages = @(Write-Output -NoEnumerate $fixture.targets | ForEach-Object { $_ })
    if ($pages.Count -ne $fixture.targets.Count -or @($pages | Select-Object id)[0].id -ne 'main') { throw 'CDP target array was not flattened.' }
    $mainPages = @($pages | Where-Object { Test-MainRendererTarget $_ })
    if ($mainPages.Count -ne 1 -or $mainPages[0].id -ne 'main') { throw 'The update-status page was admitted as a main renderer.' }
}
if (Test-MainRendererTarget ([pscustomobject]@{ type = 'page'; url = 'https://example.invalid/out/renderer/index.html' })) {
    throw 'A remote page was admitted as a packaged main renderer.'
}

$readyProbe = @{
    state = 'complete'; title = 'MiloCode'; rootChildren = 1; textLength = 100; controls = 1
    staticLoadingPresent = $false; startupLoadingPresent = $false
    loginVisible = $true; loginEnabled = $true; loginInViewport = $true; loginClickable = $true
    visibleErrors = @()
}
$waitingProbe = $readyProbe.Clone(); $waitingProbe.startupLoadingPresent = $true; $waitingProbe.loginClickable = $false
$script:rendererReplies = [Collections.Generic.Queue[object]]::new()
foreach ($reply in @($waitingProbe, $readyProbe, $readyProbe, $readyProbe)) { $script:rendererReplies.Enqueue($reply) }
$script:rendererCalls = [Collections.Generic.List[string]]::new()
function Invoke-Cdp([string]$SocketUrl, [string]$Method, [hashtable]$Parameters) {
    if ($SocketUrl -ne 'ws://127.0.0.1:2') { throw 'Paint probe changed its current target.' }
    $script:rendererCalls.Add($Method)
    if ($Method -eq 'Runtime.evaluate') { return @{ result = @{ value = $script:rendererReplies.Dequeue() } } }
    if ($Method -eq 'Page.captureScreenshot') { return @{ data = [Convert]::ToBase64String([byte[]](1, 2, 3)) } }
    if ($Method -eq 'Page.bringToFront') { return @{} }
    throw "Unexpected paint probe request: $Method"
}
$fixtureDir = Join-Path ([IO.Path]::GetTempPath()) ('milocode-renderer-probe-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureDir | Out-Null
try {
    $null = Invoke-Cdp 'ws://127.0.0.1:2' 'Page.bringToFront' @{}
    $first = Read-PaintedRendererProbe 'ws://127.0.0.1:2' 'fixture' (Join-Path $fixtureDir 'renderer-latest.png')
    $final = Read-PaintedRendererProbe 'ws://127.0.0.1:2' 'fixture' (Join-Path $fixtureDir 'installed-renderer.png')
    if ((Test-RendererLoginReady $first.before) -or -not (Test-RendererLoginReady $first.after) -or
        -not (Test-RendererLoginReady $final.before) -or -not (Test-RendererLoginReady $final.after)) {
        throw 'Paint probes lost the waiting-to-login transition or final strict readiness.'
    }
    $expected = 'Page.bringToFront,Runtime.evaluate,Page.captureScreenshot,Runtime.evaluate,Runtime.evaluate,Page.captureScreenshot,Runtime.evaluate'
    if (($script:rendererCalls -join ',') -ne $expected -or $script:rendererReplies.Count -ne 0) { throw 'Paint probe call order or distinct replies were incorrect.' }
    foreach ($name in @('renderer-latest.png', 'installed-renderer.png')) {
        if ([IO.File]::ReadAllBytes((Join-Path $fixtureDir $name)).Length -ne 3) { throw 'Paint screenshot was not saved.' }
    }
    foreach ($key in @('staticLoadingPresent', 'startupLoadingPresent', 'loginVisible', 'loginEnabled', 'loginInViewport', 'loginClickable')) {
        $blocked = $readyProbe.Clone(); $blocked[$key] = -not $blocked[$key]
        if (Test-RendererLoginReady $blocked) { throw "Strict readiness gate was weakened for $key." }
    }
} finally { Remove-Item -LiteralPath $fixtureDir -Recurse -Force }
Write-Host 'PASS: single/multiple targets, main-page isolation, distinct paint replies, screenshot order and unchanged strict login gates.'
