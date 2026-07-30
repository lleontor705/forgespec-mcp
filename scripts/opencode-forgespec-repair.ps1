<#
.SYNOPSIS
  Guarded repair for the persisted ForgeSpec OpenCode command.

The script deliberately does not restart or terminate OpenCode. A successful
configuration update requires a manual client restart before the final
connection check.
#>
[CmdletBinding()]
param(
  [string]$ConfigPath = (Join-Path $env:USERPROFILE '.config\opencode\opencode.json'),
  [switch]$Rollback,
  [string]$BackupPath
)

$ErrorActionPreference = 'Stop'
$ExpectedVersion = '1.4.0'
# Authorized exact repair target: forgespec-mcp@1.4.0
$PublicShim = Join-Path $env:LOCALAPPDATA 'Volta\bin\forgespec-mcp.cmd'
# Stable persisted command: $env:LOCALAPPDATA\Volta\bin\forgespec-mcp.cmd
$Mutexes = @()
$ConfigBackup = $null

function Fail([string]$Message) { throw "ForgeSpec repair failed: $Message" }

function Acquire-ResourceLocks {
  foreach ($name in @('ForgeSpec-Volta-forgespec-mcp-1.4.0', 'ForgeSpec-OpenCode-config')) {
    $mutex = [Threading.Mutex]::new($false, $name)
    if (-not $mutex.WaitOne(30000)) { Fail "Could not acquire exclusive resource lock $name" }
    $script:Mutexes += $mutex
  }
}

function Release-ResourceLocks {
  foreach ($mutex in $script:Mutexes) {
    try { $mutex.ReleaseMutex() } catch { }
    $mutex.Dispose()
  }
  $script:Mutexes = @()
}

function Get-PackageManifest {
  $manifest = Join-Path $env:LOCALAPPDATA 'Volta\tools\image\packages\forgespec-mcp\node_modules\forgespec-mcp\package.json'
  if (-not (Test-Path -LiteralPath $manifest)) { return $null }
  return Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json
}

function Test-PublicShim {
  if (-not (Test-Path -LiteralPath $PublicShim -PathType Leaf)) { return $false }
  $resolved = [IO.Path]::GetFullPath($PublicShim)
  if ($resolved -ne [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Volta\bin\forgespec-mcp.cmd'))) { return $false }
  $manifest = Get-PackageManifest
  return $null -ne $manifest -and $manifest.version -eq $ExpectedVersion
}

function Ensure-PublicShim {
  if (Test-PublicShim) { return $false }
  $drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($env:LOCALAPPDATA).TrimEnd('\'))[0]
  if ($drive.Free -lt 200MB) { Fail 'Insufficient disk space for the authorized small Volta package repair' }
  $volta = (Get-Command volta -ErrorAction SilentlyContinue).Source
  if (-not $volta) { Fail 'Volta executable is unavailable' }
  & $volta install "forgespec-mcp@$ExpectedVersion"
  if (-not (Test-PublicShim)) { Fail 'Volta did not create a valid public forgespec-mcp shim' }
  return $true
}

function Invoke-ShimHandshake {
  param([string]$ShimPath)
  $temp = Join-Path ([IO.Path]::GetTempPath()) ('forgespec-repair-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $temp | Out-Null
  try {
    $db = Join-Path $temp 'handshake.db'
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = 'cmd.exe'
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    [void]$psi.ArgumentList.Add('/d'); [void]$psi.ArgumentList.Add('/s'); [void]$psi.ArgumentList.Add('/c'); [void]$psi.ArgumentList.Add($ShimPath)
    [void]$psi.Environment.Add('FORGESPEC_DB', $db)
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $psi
    if (-not $process.Start()) { Fail 'Could not start the public shim' }
    $input = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"repair","version":"1"}}}' + "`n" + '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' + "`n"
    $process.StandardInput.Write($input); $process.StandardInput.Close()
    if (-not $process.WaitForExit(30000)) { $process.Kill(); Fail 'Public shim handshake timed out' }
    $frames = @($process.StandardOutput.ReadToEnd().Trim().Split("`n") | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json })
    $ids = @($frames | Where-Object { $_.jsonrpc -eq '2.0' -and $_.id -in @(1, 2) } | ForEach-Object id)
    if ($process.ExitCode -ne 0 -or $ids -notcontains 1 -or $ids -notcontains 2) { Fail 'Public shim handshake did not produce initialize and tools/list JSON-RPC frames' }
    return $true
  } finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
}

function Write-AtomicConfig([string]$Path, [string]$ShimPath) {
  $raw = [IO.File]::ReadAllBytes($Path)
  $beforeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash
  $script:ConfigBackup = "$Path.bak.$([DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff'))"
  [IO.File]::WriteAllBytes($script:ConfigBackup, $raw)
  $document = [Text.Encoding]::UTF8.GetString($raw) | ConvertFrom-Json
  if (-not $document.mcp.forgespec) { Fail 'OpenCode forgespec configuration is missing' }
  $document.mcp.forgespec.command = @($ShimPath)
  $json = $document | ConvertTo-Json -Depth 100
  $temp = "$Path.tmp.$([Guid]::NewGuid().ToString('N'))"
  [IO.File]::WriteAllText($temp, $json, [Text.UTF8Encoding]::new($false))
  $check = Get-Content -Raw -LiteralPath $temp | ConvertFrom-Json
  $command = [string]$check.mcp.forgespec.command[0]
  if ($command -ne $ShimPath -or $command -match 'npx|Volta[\\/]tools[\\/]image') { Fail 'Atomic config validation rejected the configured command' }
  Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Restore-Config([string]$Path, [string]$Backup) {
  if (-not $Backup -or -not (Test-Path -LiteralPath $Backup)) { Fail 'No byte-exact configuration backup is available for rollback' }
  Copy-Item -LiteralPath $Backup -Destination $Path -Force
}

try {
  Acquire-ResourceLocks
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { Fail 'OpenCode configuration does not exist' }
  if ($Rollback) {
    Restore-Config $ConfigPath $BackupPath
    [pscustomobject]@{ ok = $true; action = 'rollback'; restart_required = $true } | ConvertTo-Json -Compress
    return
  }
  $repaired = Ensure-PublicShim
  $manifest = Get-PackageManifest
  if ($manifest.version -ne $ExpectedVersion) { Fail 'Unexpected ForgeSpec package version' }
  Invoke-ShimHandshake $PublicShim | Out-Null
  Write-AtomicConfig $ConfigPath $PublicShim
  [pscustomobject]@{ ok = $true; action = 'updated'; repaired = $repaired; command = $PublicShim; restart_required = $true } | ConvertTo-Json -Compress
} catch {
  if ($ConfigBackup -and (Test-Path -LiteralPath $ConfigBackup)) {
    try { Restore-Config $ConfigPath $ConfigBackup } catch { }
  }
  Write-Error $_
  exit 1
} finally {
  Release-ResourceLocks
}
