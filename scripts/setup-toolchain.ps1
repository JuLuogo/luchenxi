# 本机工具链安装：Rust + JDK17 + Android SDK（全部 portable 到 D:\app，无需 UAC）
#
#   pwsh -File scripts\setup-toolchain.ps1 [-Only rust|jdk|android]
#
# 为什么 portable：winget/choco 装 MSI 会弹 UAC，而本会话无法点确认；
# 解压式安装同样能用，且随时可整体删除。

param(
  [string]$Only = 'all',
  [string]$AppRoot = 'D:\app',
  [string]$RustRoot = 'D:\app\rust',
  [string]$JdkRoot = 'D:\app\jdk17',
  [string]$AndroidRoot = 'D:\app\android-sdk'
)

$ErrorActionPreference = 'Stop'
$env:ProgressPreference = 'SilentlyContinue'   # 让 Invoke-WebRequest 快很多
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Step($msg) { Write-Output ""; Write-Output "▶ $msg" }
function Done($msg) { Write-Output "  ✔ $msg" }
function Warn($msg) { Write-Output "  ! $msg" }

# 原生命令（rustup / rustc / sdkmanager / java）会把进度写到 stderr；
# 在 $ErrorActionPreference='Stop' 下这会被当成"致命错误"直接打断脚本（本轮就踩到了）。
# 因此统一走这个包装：临时放宽错误策略，并返回退出码。
function Native($exe, [string[]]$argv) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $exe @argv 2>&1 | ForEach-Object { "    $_" }
    return $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
}

function Download($url, $dest) {
  if ((Test-Path $dest) -and (Get-Item $dest).Length -gt 0) { Warn "已存在，跳过下载: $dest"; return }
  $dir = Split-Path -Parent $dest
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  Write-Output "  下载 $url"
  Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
  Done ("下载完成 {0:N1} MB → {1}" -f ((Get-Item $dest).Length / 1MB), $dest)
}

# ---------------------------------------------------------------- Rust
if ($Only -eq 'all' -or $Only -eq 'rust') {
  Step "Rust（rustup + stable 工具链，host = x86_64-pc-windows-msvc）"
  $rustup = Join-Path $env:TEMP 'rustup-init.exe'
  Download 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' $rustup

  $env:RUSTUP_HOME = Join-Path $RustRoot 'rustup'
  $env:CARGO_HOME = Join-Path $RustRoot 'cargo'
  Write-Output "  RUSTUP_HOME=$env:RUSTUP_HOME"
  Write-Output "  CARGO_HOME=$env:CARGO_HOME"
  # -y 全自动；--no-modify-path 之后我们自己写环境变量，避免动到用户 PATH 的其它部分
  Native $rustup @('-y', '--no-modify-path', '--default-toolchain', 'stable', '--profile', 'default',
                   '--default-host', 'x86_64-pc-windows-msvc') | Out-Null

  $cargoBin = Join-Path $env:CARGO_HOME 'bin'
  if (Test-Path (Join-Path $cargoBin 'cargo.exe')) {
    Done "cargo: $(Join-Path $cargoBin 'cargo.exe')"
    Native (Join-Path $cargoBin 'cargo.exe') @('--version') | Out-Null
  } else { throw "cargo 安装失败" }
  # 工具链没装上时 rustup 会在运行时提示 —— 这里显式兜底
  Native (Join-Path $cargoBin 'rustup.exe') @('default', 'stable') | Out-Null

  # Android 交叉编译目标（学生端 APK 需要）
  Step "Rust Android 交叉编译目标"
  foreach ($t in 'aarch64-linux-android','armv7-linux-androideabi','x86_64-linux-android','i686-linux-android') {
    Native (Join-Path $cargoBin 'rustup.exe') @('target', 'add', $t) | Out-Null
    Write-Output "    $t 已处理"
  }
}

# ---------------------------------------------------------------- JDK 17
if ($Only -eq 'all' -or $Only -eq 'jdk') {
  Step "Temurin JDK 17（Android Gradle 需要 17）"
  if (Test-Path (Join-Path $JdkRoot 'bin\java.exe')) {
    Done "已存在: $JdkRoot"
  } else {
    $zip = Join-Path $env:TEMP 'temurin17.zip'
    Download 'https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse' $zip
    $tmp = Join-Path $env:TEMP ('jdk-extract-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    Write-Output "  解压…"
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (Test-Path $JdkRoot) { Remove-Item -Recurse -Force $JdkRoot }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $JdkRoot) | Out-Null
    Move-Item $inner.FullName $JdkRoot
    Remove-Item -Recurse -Force $tmp, $zip -ErrorAction SilentlyContinue
    Done "JDK → $JdkRoot"
  }
  & (Join-Path $JdkRoot 'bin\java.exe') -version 2>&1 | ForEach-Object { "    $_" }
}

# ---------------------------------------------------------------- Android SDK + NDK
if ($Only -eq 'all' -or $Only -eq 'android') {
  Step "Android 命令行工具（cmdline-tools）"
  $sdk = $AndroidRoot
  $cmdline = Join-Path $sdk 'cmdline-tools\latest'
  if (Test-Path (Join-Path $cmdline 'bin\sdkmanager.bat')) {
    Done "已存在: $cmdline"
  } else {
    $zip = Join-Path $env:TEMP 'cmdline-tools.zip'
    Download 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' $zip
    $tmp = Join-Path $env:TEMP ('cmdline-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $sdk 'cmdline-tools') | Out-Null
    # 官方要求目录名必须是 latest（否则 sdkmanager 会报 "Could not determine SDK root"）
    if (Test-Path $cmdline) { Remove-Item -Recurse -Force $cmdline }
    Move-Item (Join-Path $tmp 'cmdline-tools') $cmdline
    Remove-Item -Recurse -Force $tmp, $zip -ErrorAction SilentlyContinue
    Done "cmdline-tools → $cmdline"
  }

  $env:ANDROID_HOME = $sdk
  $env:ANDROID_SDK_ROOT = $sdk
  $env:JAVA_HOME = $JdkRoot
  $sdkmanager = Join-Path $cmdline 'bin\sdkmanager.bat'

  Step "接受许可并安装 platform-tools / platform 34 / build-tools 34 / NDK 26.1"
  # sdkmanager 需要 JDK：把 JAVA_HOME 塞进当前进程环境
  $env:Path = (Join-Path $JdkRoot 'bin') + ';' + $env:Path
  'y' * 30 -split '' | Where-Object { $_ } | Out-Null   # 该行仅用于避免空管道告警
  $null = cmd /c "echo y| `"$sdkmanager`" --licenses" 2>&1
  & $sdkmanager --install 'platform-tools' 'platforms;android-34' 'build-tools;34.0.0' 'ndk;26.1.10909125' 2>&1 |
    Select-Object -Last 12 | ForEach-Object { "    $_" }
  Done "Android SDK → $sdk"
}

# ---------------------------------------------------------------- 环境变量（用户级，免管理员）
Step "写入用户环境变量"
function SetUserEnv($name, $value) {
  $cur = [Environment]::GetEnvironmentVariable($name, 'User')
  if ($cur -ne $value) {
    [Environment]::SetEnvironmentVariable($name, $value, 'User')
    Done "$name = $value"
  } else { Warn "$name 已是 $value" }
}
$cargoBin = Join-Path $RustRoot 'cargo\bin'
SetUserEnv 'CARGO_HOME' (Join-Path $RustRoot 'cargo')
SetUserEnv 'RUSTUP_HOME' (Join-Path $RustRoot 'rustup')
if ($Only -eq 'all' -or $Only -eq 'rust') {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath -notlike "*$cargoBin*") {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $cargoBin), 'User')
    Done "PATH += $cargoBin"
  } else { Warn "PATH 已包含 cargo" }
}
if ($Only -eq 'all' -or $Only -eq 'jdk') { SetUserEnv 'JAVA_HOME' $JdkRoot }
if ($Only -eq 'all' -or $Only -eq 'android') {
  SetUserEnv 'ANDROID_HOME' $AndroidRoot
  SetUserEnv 'ANDROID_SDK_ROOT' $AndroidRoot
  SetUserEnv 'NDK_HOME' (Join-Path $AndroidRoot 'ndk\26.1.10909125')
}

Write-Output ""
Write-Output "完成。新开一个终端后生效（当前会话可直接用绝对路径）。"
