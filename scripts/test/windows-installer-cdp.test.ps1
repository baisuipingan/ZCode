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
