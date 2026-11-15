# Type-checks and lints the Rust backend for macOS from Windows: cargo clippy against the
# aarch64-apple-darwin target. Nothing is linked, so no macOS SDK is needed; the one crate that
# compiles C (objc2-exception-helper) gets a fake compiler that writes empty objects.
# Usage: powershell -File scripts/check-macos.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$tauri = Join-Path $root "src-tauri"
$tools = Join-Path $tauri "target\maccheck-tools"
New-Item -ItemType Directory -Force $tools | Out-Null
@'
@echo off
:loop
if "%~1"=="" goto :eof
if "%~1"=="-o" ( type nul > "%~2" & shift )
shift
goto loop
'@ | Set-Content -Encoding ascii (Join-Path $tools "cc.cmd")
@'
@echo off
if "%~2"=="" goto :eof
if not exist "%~2" type nul > "%~2"
'@ | Set-Content -Encoding ascii (Join-Path $tools "ar.cmd")
if (-not (rustup target list --installed | Select-String -Quiet "aarch64-apple-darwin")) {
  rustup target add aarch64-apple-darwin
}
$env:CC_aarch64_apple_darwin = Join-Path $tools "cc.cmd"
$env:AR_aarch64_apple_darwin = Join-Path $tools "ar.cmd"
$env:CRATE_CC_NO_DEFAULTS = "1"
Push-Location $tauri
try {
  cargo clippy --target aarch64-apple-darwin --all-targets -- -D warnings
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
