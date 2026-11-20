# Installs Sirv Lens for the current user on Windows, then registers it with the browsers.
#
#   irm https://github.com/VKrachun/native-browser-lens/releases/latest/download/install.ps1 | iex
#
# It writes %LOCALAPPDATA%\Programs\Sirv Lens\lens.exe, adds that folder to the user PATH, and
# registers the browsers in HKCU. No administrator rights. Remove Lens with:
#   lens service uninstall; lens unregister; Remove-Item -Recurse "$env:LOCALAPPDATA\Programs\Sirv Lens"
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 runs `irm | iex` by default: no PowerShell 7 syntax below, and TLS 1.2 on.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$repo = if ($env:LENS_REPO) { $env:LENS_REPO } else { 'VKrachun/native-browser-lens' }
$target = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x86_64-pc-windows-msvc' }
    # Windows on ARM runs the x64 build through its emulation; there is no ARM build.
    'ARM64' { 'x86_64-pc-windows-msvc' }
    default { throw "No Lens build for $env:PROCESSOR_ARCHITECTURE" }
}

# LENS_VERSION picks a version; LENS_DOWNLOAD_BASE a local release folder (tests).
$version = $env:LENS_VERSION
if (-not $version) {
    if ($env:LENS_DOWNLOAD_BASE) { throw 'LENS_DOWNLOAD_BASE needs LENS_VERSION' }
    # /releases/latest redirects to the tag: no API call needed.
    $latest = Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$repo/releases/latest" -MaximumRedirection 5
    $final = if ($latest.BaseResponse.ResponseUri) { $latest.BaseResponse.ResponseUri } else { $latest.BaseResponse.RequestMessage.RequestUri }
    $version = $final.AbsolutePath.Split('/')[-1].TrimStart('v')
}
$base = if ($env:LENS_DOWNLOAD_BASE) { $env:LENS_DOWNLOAD_BASE } else { "https://github.com/$repo/releases/download/v$version" }
$asset = "sirv-lens-$version-$target.zip"

$work = Join-Path ([IO.Path]::GetTempPath()) ("lens-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
try {
    Write-Host "Downloading Lens $version for $target"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile "$work\$asset"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile "$work\SHA256SUMS"
    # "hash  file" or "hash *file" (binary mode), depending on the tool that wrote it.
    $line = Get-Content "$work\SHA256SUMS" | Where-Object { $_ -match " \*?$([regex]::Escape($asset))$" }
    if (-not $line) { throw "SHA256SUMS does not list $asset" }
    $expected = ($line -split ' ')[0]
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath "$work\$asset").Hash.ToLower()
    if ($actual -ne $expected) { throw 'The download does not match SHA256SUMS; nothing was installed.' }

    Expand-Archive -LiteralPath "$work\$asset" -DestinationPath $work
    $dir = Join-Path $env:LOCALAPPDATA 'Programs\Sirv Lens'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $exe = Join-Path $dir 'lens.exe'
    if (Test-Path $exe) { & $exe stop 2>$null | Out-Null }
    # The tray (lensw.exe and its lens.exe) keeps running after stop and holds the files.
    Get-Process -Name lens, lensw -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Copy-Item -Force "$work\sirv-lens-$version-$target\lens.exe" $exe
    Copy-Item -Force "$work\sirv-lens-$version-$target\lensw.exe" (Join-Path $dir 'lensw.exe')
    # The speech programs for voice notes, where the release builds them for this computer.
    foreach ($program in @('lens-speech.exe', 'lens-speech-gpu.exe')) {
        $source = "$work\sirv-lens-$version-$target\$program"
        if (Test-Path $source) { Copy-Item -Force $source (Join-Path $dir $program) }
    }

    # The extension, unpacked in a stable folder for Load unpacked until the store listings exist.
    $extensionZip = "sirv-lens-extension-$version-chrome.zip"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$extensionZip" -OutFile "$work\$extensionZip"
        $listed = Get-Content "$work\SHA256SUMS" | Where-Object { $_ -match " \*?$([regex]::Escape($extensionZip))$" }
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath "$work\$extensionZip").Hash.ToLower()
        if ($listed -and (($listed -split ' ')[0] -eq $hash)) {
            $extensionDir = (& $exe paths extension)
            if (Test-Path $extensionDir) { Remove-Item -Recurse -Force $extensionDir }
            Expand-Archive -LiteralPath "$work\$extensionZip" -DestinationPath $extensionDir
        }
    } catch { Write-Host 'The extension package is not in this release; skipped.' }

    $path = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($path -split ';') -notcontains $dir) {
        [Environment]::SetEnvironmentVariable('Path', ($path.TrimEnd(';') + ";$dir").TrimStart(';'), 'User')
    }
    & $exe register
    & $exe service install
    Write-Host ''
    Write-Host "Lens $version is installed in $exe."
    if ([Environment]::UserInteractive -and -not $env:CI) { & $exe setup } else { & $exe doctor }
} finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

# Open setup steps are not an install failure: doctor already printed them.
exit 0
