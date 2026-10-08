@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo ========================================================
echo   家庭收纳 - Windows 一键打包
echo ========================================================
echo.

REM ---------- 1. 检查 Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Node.js。
  echo.
  echo   请先安装：https://nodejs.org/zh-cn
  echo   下载 LTS 版本，安装时保持默认选项即可。
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo [1/4] Node.js 版本 !NODEVER!

REM ---------- 2. 检查依赖 ----------
if not exist "node_modules\electron-builder\cli.js" (
  echo [2/4] 首次运行，正在安装依赖，约 3-5 分钟...
  echo.
  call npm install --registry=https://registry.npmmirror.com
  if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败。请检查网络后重试。
    pause
    exit /b 1
  )
) else (
  echo [2/4] 依赖已就绪
)

REM ---------- 3. 配置镜像 ----------
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set CSC_IDENTITY_AUTO_DISCOVERY=false
echo [3/4] 已配置国内镜像，已跳过代码签名

REM ---------- 4. 处理 winCodeSign 符号链接问题 ----------
REM electron-builder 打包 Windows 安装程序需要几个工具包。
REM 其中 winCodeSign（签名和改图标用）里混有 macOS 文件，
REM libcrypto.dylib 和 libssl.dylib 是符号链接。
REM Windows 普通账户没有创建符号链接的特权，
REM electron-builder 内置解压会中断，报"客户端没有所需的特权"。
REM
REM 这里我们先自己用 7-Zip 的 -snl 参数把它解压到缓存目录，
REM -snl 把符号链接存成普通文件，绕开特权检查。
REM 缓存建好后 electron-builder 检测到会直接复用，不再重复解压。
REM
REM 注意：其余工具包（nsis、nsis-resources）不含符号链接，
REM 让 electron-builder 自己从镜像下载即可，不需要特殊处理。
set CACHE=%LOCALAPPDATA%\electron-builder\Cache

if exist "%CACHE%\winCodeSign\winCodeSign-2.6.0\rcedit-x64.exe" (
  echo [4/4] 构建工具缓存已就绪
  goto :build
)

echo [4/4] 首次打包，正在准备构建工具...
echo.

set PKG=winCodeSign
set DEST=winCodeSign-2.6.0
set ZIP=%TEMP%\hs-winCodeSign.7z

echo       下载 winCodeSign ...
node "scripts\fetch-tool.js" "%PKG%" "%ZIP%"

if not exist "%ZIP%" (
  echo.
  echo [警告] 下载失败，将让 electron-builder 自行尝试。
  echo        如果随后报"客户端没有所需的特权"，
  echo        请检查网络后重试。
  echo.
  goto :build
)

echo       解压 winCodeSign ...
if not exist "%CACHE%\%PKG%" mkdir "%CACHE%\%PKG%"
"node_modules\7zip-bin\win\x64\7za.exe" x "%ZIP%" "-o%CACHE%\%PKG%\%DEST%" -snl -y >nul 2>nul
del "%ZIP%" >nul 2>nul

if exist "%CACHE%\%PKG%\%DEST%\rcedit-x64.exe" (
  echo       winCodeSign 就绪
) else (
  echo.
  echo [警告] 解压未成功。如果接下来打包失败，
  echo        请右键本脚本选"以管理员身份运行"重试。
  echo.
)

:build
echo.
echo ========================================================
echo   开始打包，约 3-10 分钟，请不要关闭这个窗口
echo ========================================================
echo.
node "node_modules\electron-builder\cli.js" --win --x64 --publish never

if errorlevel 1 (
  echo.
  echo ========================================================
  echo   打包失败
  echo ========================================================
  echo.
  echo   如果错误里出现"客户端没有所需的特权"或"symbolic link"，
  echo   请右键本脚本，选"以管理员身份运行"后重试。
  echo.
  echo   如果错误里出现"下载失败"或"timeout"，
  echo   说明网络不通，请检查网络后重试。
  echo.
  pause
  exit /b 1
)

echo.
echo ========================================================
echo   打包完成
echo ========================================================
echo.
for %%f in ("dist\家庭收纳-安装程序-*.exe") do (
  echo   安装程序：dist\%%~nxf
  echo   文件大小：%%~zf 字节
)
echo.
echo   双击 dist 目录下的安装程序即可安装。
echo   安装时可自选路径，会自动创建桌面和开始菜单快捷方式。
echo.
pause
exit /b 0
