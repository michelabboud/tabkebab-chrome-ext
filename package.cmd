@echo off
setlocal

:: TabKebab — Chrome Web Store packaging script
:: Run from the TabKebab root directory: package.cmd

set NAME=tabkebab
set VERSION=1.0.0
set OUTDIR=dist
set ZIPFILE=%OUTDIR%\%NAME%-%VERSION%.zip

echo.
echo  TabKebab Packager v%VERSION%
echo  =============================
echo.

:: Read version from manifest.json if PowerShell 7 is available
where pwsh >nul 2>&1
if %ERRORLEVEL%==0 (
    for /f "delims=" %%v in ('pwsh -NoProfile -Command "(Get-Content manifest.json | ConvertFrom-Json).version"') do set VERSION=%%v
    set ZIPFILE=%OUTDIR%\%NAME%-!VERSION!.zip
)

:: Create dist folder
if not exist %OUTDIR% mkdir %OUTDIR%

:: Remove old zip if it exists
if exist %ZIPFILE% del %ZIPFILE%

echo  [1/3] Creating extension package...

:: Use PowerShell to create zip (available on all modern Windows)
pwsh -NoProfile -Command ^
    "$exclude = @('.git', 'dist', 'node_modules', '.gitignore', 'package.cmd', 'PLAN.md', 'BRAND.md', 'store', '*.md');" ^
    "$root = Get-Location;" ^
    "$files = Get-ChildItem -Recurse -File | Where-Object {" ^
    "  $rel = $_.FullName.Substring($root.Path.Length + 1);" ^
    "  $skip = $false;" ^
    "  foreach ($ex in @('.git', 'dist', 'node_modules', 'store')) {" ^
    "    if ($rel.StartsWith($ex + '\') -or $rel -eq $ex) { $skip = $true }" ^
    "  }" ^
    "  if ($rel -eq 'package.cmd') { $skip = $true }" ^
    "  if ($rel -eq 'PLAN.md') { $skip = $true }" ^
    "  if ($rel -eq 'BRAND.md') { $skip = $true }" ^
    "  -not $skip" ^
    "};" ^
    "Compress-Archive -Path $files.FullName -DestinationPath '%ZIPFILE%' -Force;" ^
    "Write-Host ('  Packaged ' + $files.Count + ' files')"

if %ERRORLEVEL% NEQ 0 (
    echo  ERROR: Packaging failed.
    exit /b 1
)

:: Show zip size
for %%A in (%ZIPFILE%) do echo  Output: %ZIPFILE% (%%~zA bytes^)

echo.
echo  [2/3] Checklist
echo  ---------------
echo  [ ] Screenshots (1280x800) in store\ folder
echo  [ ] Promo tile (440x280) in store\ folder
echo  [ ] OAuth2 client_id set in manifest.json (for Google Drive)
echo  [ ] Version bumped if needed (currently %VERSION%)
echo.
echo  [3/3] Upload
echo  ------------
echo  1. Go to https://chrome.google.com/webstore/devconsole
echo  2. Click "New Item" and upload %ZIPFILE%
echo  3. Fill in listing details (see store\listing.txt)
echo  4. Paste privacy policy (see store\privacy-policy.txt)
echo  5. Fill in permission justifications (see store\permissions.txt)
echo  6. Upload screenshots from store\ folder
echo  7. Submit for review
echo.
echo  Done!
endlocal
