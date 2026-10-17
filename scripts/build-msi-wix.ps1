# Build MSI directly with WiX (own source + heat). Works for all three variants.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\build-msi-wix.ps1 `
#     -ProductName "AI Anime Image Manager NEXT" -ExeName "ai-anime-image-manager-next.exe" `
#     -UpgradeCode "2636577f-..." -Aumid "com.private...." -Version 2.2.3.0
param(
  [string]$ProductName   = "AI Anime Image Manager NEXT",
  [string]$ExeName       = "ai-anime-image-manager-next.exe",
  [string]$UpgradeCode   = "2636577f-93de-46c0-8217-f4a360fa2ebf",
  [string]$Aumid         = "com.private.ai-anime-image-manager-next",
  [string]$Version       = "2.2.3.0",
  [string]$ShortName     = "",
  [string]$Description   = "Local AI image manager: semantic search, duplicate detection, AI tagging, character recognition"
)

$ErrorActionPreference = "Stop"
$Root    = Split-Path -Parent $PSScriptRoot
$AppDir  = Join-Path $Root ("out\" + $ProductName + "-win32-x64")
$OutDir  = Join-Path $Root "msi-out"
$Icon    = Join-Path $Root "assets\icon.ico"
$Dialog  = Join-Path $Root "assets\installers\wix-dialog.jpg"
$Banner  = Join-Path $Root "assets\installers\wix-banner.jpg"
$Wix     = "C:\Users\Sakura\AppData\Local\AIImageManagerBuildTools\wix-3.14.0"
if ([string]::IsNullOrWhiteSpace($ShortName)) { $ShortName = ($ProductName -replace '[^A-Za-z0-9]', '') }

if (-not (Test-Path (Join-Path $AppDir $ExeName))) {
  throw "Packaged app dir not found: $AppDir (run electron-forge package first)"
}
if (-not (Test-Path $Icon)) { throw "Icon not found: $Icon" }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
Set-Location $OutDir

# 1) heat: harvest all files under the packaged app dir
$filesWxs = Join-Path $OutDir "files.wxs"
& (Join-Path $Wix "heat.exe") dir $AppDir -cg AppFiles -dr APPLICATIONROOTDIRECTORY `
  -gg -sfrag -srd -sreg -var var.AppSource -out $filesWxs | Out-Null
if (-not (Test-Path $filesWxs)) { throw "heat failed" }

# 2) Product.wxs
$product = @"
<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*"
           Name="$ProductName"
           Language="2052"
           Version="$Version"
           Manufacturer="Uyoung"
           UpgradeCode="$UpgradeCode">

    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" Platform="x64"
             Description="$Description"
             Comments="$ProductName" />

    <MajorUpgrade AllowSameVersionUpgrades="yes"
                  DowngradeErrorMessage="A newer version of this product is already installed." />
    <MediaTemplate EmbedCab="yes" CompressionLevel="high" />

    <Icon Id="ApplicationIcon" SourceFile="$Icon" />
    <Property Id="ARPPRODUCTICON" Value="ApplicationIcon" />

    <Property Id="WIXUI_INSTALLDIR" Value="APPLICATIONROOTDIRECTORY" />
    <WixVariable Id="WixUIDialogBmp" Value="$Dialog" />
    <WixVariable Id="WixUIBannerBmp" Value="$Banner" />

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="APPLICATIONROOTDIRECTORY" Name="$ProductName" />
      </Directory>
      <Directory Id="ProgramMenuFolder">
        <Directory Id="ApplicationProgramsFolder" Name="$ProductName" />
      </Directory>
      <Directory Id="DesktopFolder" />
    </Directory>

    <DirectoryRef Id="ApplicationProgramsFolder">
      <Component Id="StartMenuShortcut" Guid="*">
        <Shortcut Id="ApplicationStartMenuShortcut"
                  Name="$ProductName"
                  Description="$Description"
                  Target="[APPLICATIONROOTDIRECTORY]$ExeName"
                  WorkingDirectory="APPLICATIONROOTDIRECTORY"
                  Icon="ApplicationIcon" IconIndex="0">
          <ShortcutProperty Key="System.AppUserModel.ID" Value="$Aumid" />
        </Shortcut>
        <RemoveFolder Id="RemoveProgramsFolder" On="uninstall" />
        <RegistryValue Root="HKCU" Key="Software\Uyoung\$ShortName"
                       Name="StartMenuShortcut" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </DirectoryRef>

    <DirectoryRef Id="DesktopFolder">
      <Component Id="DesktopShortcut" Guid="*">
        <Shortcut Id="DesktopShortcutLink"
                  Name="$ProductName"
                  Description="$Description"
                  Target="[APPLICATIONROOTDIRECTORY]$ExeName"
                  WorkingDirectory="APPLICATIONROOTDIRECTORY"
                  Icon="ApplicationIcon" IconIndex="0" />
        <RegistryValue Root="HKCU" Key="Software\Uyoung\$ShortName"
                       Name="DesktopShortcut" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </DirectoryRef>

    <Feature Id="MainFeature" Title="Main Application" Level="1" Display="expand"
             Description="Core files required to run $ProductName.">
      <ComponentGroupRef Id="AppFiles" />
      <ComponentRef Id="StartMenuShortcut" />
      <ComponentRef Id="DesktopShortcut" />
    </Feature>

    <UIRef Id="WixUI_InstallDir" />
  </Product>
</Wix>
"@
$productWxs = Join-Path $OutDir "Product.wxs"
[System.IO.File]::WriteAllText($productWxs, $product, (New-Object System.Text.UTF8Encoding($false)))

# 3) candle + light
& (Join-Path $Wix "candle.exe") -nologo -arch x64 -dAppSource="$AppDir" -out "$OutDir\files.wixobj" $filesWxs | Out-Null
if ($LASTEXITCODE -ne 0) { throw "candle(files) failed" }
& (Join-Path $Wix "candle.exe") -nologo -arch x64 -out "$OutDir\Product.wixobj" $productWxs | Out-Null
if ($LASTEXITCODE -ne 0) { throw "candle(Product) failed" }

$msiPath = Join-Path $OutDir ($ProductName + "-" + $Version + ".msi")
$lightArgs = @("-nologo", "-ext", "WixUIExtension", "-out", $msiPath,
               "$OutDir\Product.wixobj", "$OutDir\files.wixobj")
$loc = Join-Path $Wix "WixUI_zh-CN.wxl"
if (Test-Path $loc) { $lightArgs += @("-loc", $loc) }
& (Join-Path $Wix "light.exe") @lightArgs | Out-Null
if ($LASTEXITCODE -ne 0) { throw "light failed (exit $LASTEXITCODE)" }

$mb = [math]::Round((Get-Item $msiPath).Length / 1MB, 1)
Write-Host ("MSI OK: {0}  {1} MB" -f $msiPath, $mb)
