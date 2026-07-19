@echo off
setlocal EnableExtensions EnableDelayedExpansion

where powershell.exe >nul 2>&1
if errorlevel 1 (
    if exist "dist\" del /q "dist\tabkebab-*.zip" >nul 2>&1
    >&2 echo ERROR: Windows PowerShell is required.
    exit /b 1
)

powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference = 'Stop';" ^
    "$exitCode = 0;" ^
    "$primaryError = $null;" ^
    "$cleanupError = $null;" ^
    "$outputCleanupError = $null;" ^
    "$staging = $null;" ^
    "$dist = $null;" ^
    "$version = $null;" ^
    "$fileCount = $null;" ^
    "$zipPath = $null;" ^
    "$zipSize = $null;" ^
    "function Remove-OwnedPackages([string]$directory) {" ^
    "  if ($null -ne $directory -and (Test-Path -LiteralPath $directory -PathType Container)) {" ^
    "    Get-ChildItem -LiteralPath $directory -File -Filter 'tabkebab-*.zip' -ErrorAction Stop | Remove-Item -Force -ErrorAction Stop;" ^
    "  }" ^
    "}" ^
    "try {" ^
    "  $root = (Get-Location).Path;" ^
    "  $dist = Join-Path $root 'dist';" ^
    "  if ((Test-Path -LiteralPath $dist) -and -not (Test-Path -LiteralPath $dist -PathType Container)) { throw 'dist exists but is not a directory.' }" ^
    "  Remove-OwnedPackages $dist;" ^
    "  $fileEntries = @('VERSION', 'manifest.json', 'service-worker.js');" ^
    "  $directoryEntries = @('core', 'sidepanel', 'icons');" ^
    "  foreach ($entry in $fileEntries) {" ^
    "    $path = Join-Path $root $entry;" ^
    "    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw ('Missing required file: ' + $entry) }" ^
    "    if ((Get-Item -LiteralPath $path).Length -eq 0) { throw ('Required file is empty: ' + $entry) }" ^
    "  }" ^
    "  foreach ($entry in $directoryEntries) {" ^
    "    $path = Join-Path $root $entry;" ^
    "    if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw ('Missing required directory: ' + $entry) }" ^
    "    if ($null -eq (Get-ChildItem -LiteralPath $path -Recurse -Force -File | Select-Object -First 1)) { throw ('Required directory is empty: ' + $entry) }" ^
    "  }" ^
    "  $version = [IO.File]::ReadAllText((Join-Path $root 'VERSION')).Trim();" ^
    "  if ($version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'VERSION must contain one plain semantic version.' }" ^
    "  $manifest = Get-Content -LiteralPath (Join-Path $root 'manifest.json') -Raw | ConvertFrom-Json;" ^
    "  $manifestVersion = [string]$manifest.version;" ^
    "  if ($manifestVersion -cne $version) { throw ('Version mismatch: VERSION=' + $version + ', manifest.json=' + $manifestVersion) }" ^
    "  [IO.Directory]::CreateDirectory($dist) | Out-Null;" ^
    "  $zipPath = Join-Path $dist ('tabkebab-' + $version + '.zip');" ^
    "  $staging = Join-Path ([IO.Path]::GetTempPath()) ('tabkebab-' + [guid]::NewGuid().ToString('N'));" ^
    "  [IO.Directory]::CreateDirectory($staging) | Out-Null;" ^
    "  foreach ($entry in @('manifest.json', 'service-worker.js', 'core', 'sidepanel', 'icons')) {" ^
    "    Copy-Item -LiteralPath (Join-Path $root $entry) -Destination $staging -Recurse -Force -ErrorAction Stop;" ^
    "  }" ^
    "  $fileCount = @(Get-ChildItem -LiteralPath $staging -Recurse -Force -File).Count;" ^
    "  if ($fileCount -eq 0) { throw 'Allowlisted package is empty.' }" ^
    "  Add-Type -AssemblyName System.IO.Compression;" ^
    "  Add-Type -AssemblyName System.IO.Compression.FileSystem;" ^
    "  $archive = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create);" ^
    "  try {" ^
    "    foreach ($file in Get-ChildItem -LiteralPath $staging -Recurse -Force -File | Sort-Object FullName) {" ^
    "      $entryName = $file.FullName.Substring($staging.Length + 1).Replace('\', '/');" ^
    "      if ($entryName.StartsWith('/') -or $entryName.Contains('\') -or $entryName -match '(^|/)\.\.(/|$)') { throw ('Unsafe archive entry: ' + $entryName) }" ^
    "      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $entryName, [IO.Compression.CompressionLevel]::Optimal) | Out-Null;" ^
    "    }" ^
    "  } finally {" ^
    "    $archive.Dispose();" ^
    "  }" ^
    "  if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) { throw 'Package archive was not created.' }" ^
    "  $zipSize = (Get-Item -LiteralPath $zipPath).Length;" ^
    "  if ($zipSize -eq 0) { throw 'Package archive is empty.' }" ^
    "} catch {" ^
    "  $exitCode = 1;" ^
    "  $primaryError = $_.Exception.Message;" ^
    "} finally {" ^
    "  if ($null -ne $staging -and (Test-Path -LiteralPath $staging)) {" ^
    "    try { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction Stop }" ^
    "    catch { $cleanupError = $_.Exception.Message; if ($exitCode -eq 0) { $exitCode = 1 } }" ^
    "  }" ^
    "  if ($exitCode -ne 0) {" ^
    "    try { Remove-OwnedPackages $dist }" ^
    "    catch { $outputCleanupError = $_.Exception.Message }" ^
    "  }" ^
    "}" ^
    "if ($null -ne $primaryError) { [Console]::Error.WriteLine('ERROR: ' + $primaryError) }" ^
    "if ($null -ne $cleanupError) { [Console]::Error.WriteLine('ERROR: Failed to remove staging directory: ' + $cleanupError) }" ^
    "if ($null -ne $outputCleanupError) { [Console]::Error.WriteLine('ERROR: Failed to remove package output: ' + $outputCleanupError) }" ^
    "if ($exitCode -ne 0) { exit $exitCode }" ^
    "Write-Output ('Version: ' + $version);" ^
    "Write-Output ('Allowlisted files: ' + $fileCount);" ^
    "Write-Output ('Output: ' + $zipPath);" ^
    "Write-Output ('Size: ' + $zipSize + ' bytes');"

set "EXIT_CODE=!ERRORLEVEL!"
if not "!EXIT_CODE!"=="0" if exist "dist\" del /q "dist\tabkebab-*.zip" >nul 2>&1
exit /b !EXIT_CODE!
