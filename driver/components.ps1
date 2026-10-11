<#
.SYNOPSIS
    Adds or removes Qutie Studio next to the driver (the driver always stays).

.DESCRIPTION
    With -Studio 1: Start menu entry "Qutie Studio" (opens the Studio) and .qutie files
    opened by Qutie.exe. With -Studio 0: Start menu entry "Qutie" (opens the printer
    settings) and no file association. The choice is recorded as the "Studio" value of
    the app's entry in Installed apps, where the app reads it.

    install.ps1 runs it with -Nested; the setup wizard runs it on its own (elevated) to
    change the choice later.

.PARAMETER Studio
    1 to install Qutie Studio, 0 to keep only the driver.

.PARAMETER Executable
    Path of Qutie.exe. Default: Program Files\Qutie\Qutie.exe.

.PARAMETER Nested
    Called by install.ps1: already elevated, no transcript of its own.
#>
[CmdletBinding()]
param(
    [int]$Studio = 1,
    [string]$Executable,
    [switch]$Nested,
    [switch]$Quiet,
    [string]$Log
)

$ErrorActionPreference = 'Stop'

if (-not $Nested) {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        if ($Quiet) { exit 2 }
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait `
            -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Studio', $Studio)
        exit
    }
    if ($Quiet -and $Log) { Start-Transcript -Path $Log -Force | Out-Null }
}

function Step($text) { Write-Host "`n> $text" -ForegroundColor Cyan }

$result = 0
try {
    if (-not $Executable) { $Executable = Join-Path $env:ProgramFiles 'Qutie\Qutie.exe' }
    $programs = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'
    $settingsLink = Join-Path $programs 'Qutie.lnk'
    $studioLink = Join-Path $programs 'Qutie Studio.lnk'
    $classes = 'HKLM:\SOFTWARE\Classes'
    $shell = New-Object -ComObject WScript.Shell

    if ($Studio) {
        Step 'Adding Qutie Studio'
        $s = $shell.CreateShortcut($studioLink)
        $s.TargetPath = $Executable
        $s.Arguments = '--studio'
        $s.IconLocation = "$Executable,0"
        $s.Description = 'Qutie Studio: design and print labels on the HPRT Qutie'
        $s.Save()
        if (Test-Path $settingsLink) { Remove-Item $settingsLink -Force }
        # .qutie files open in the Studio. The .NET API opens each key for writing; the
        # registry provider's New-Item -Force / '(default)' failed here with "access denied".
        $root = [Microsoft.Win32.Registry]::LocalMachine
        $ext = $root.CreateSubKey('SOFTWARE\Classes\.qutie')
        $ext.SetValue('', 'Qutie.Label')
        $ext.Close()
        $prog = $root.CreateSubKey('SOFTWARE\Classes\Qutie.Label')
        $prog.SetValue('', 'Qutie label')
        $icon = $prog.CreateSubKey('DefaultIcon')
        $icon.SetValue('', "$Executable,0")
        $icon.Close()
        $command = $prog.CreateSubKey('shell\open\command')
        $command.SetValue('', "`"$Executable`" --studio `"%1`"")
        $command.Close()
        $prog.Close()
        Write-Host "  Start menu: Qutie Studio; .qutie files open in the Studio"
    }
    else {
        Step 'Driver only'
        $s = $shell.CreateShortcut($settingsLink)
        $s.TargetPath = $Executable
        $s.Arguments = '--app'
        $s.IconLocation = "$Executable,0"
        $s.Description = 'Qutie label printer: status, settings and print preview'
        $s.Save()
        if (Test-Path $studioLink) { Remove-Item $studioLink -Force }
        foreach ($k in "$classes\.qutie", "$classes\Qutie.Label") {
            if (Test-Path $k) { Remove-Item $k -Recurse -Force }
        }
        Write-Host '  Start menu: Qutie (printer settings)'
    }

    $key = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Qutie'
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -Path $key -Name Studio -Value ([int][bool]$Studio) -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $key -Name DisplayName -Value $(if ($Studio) { 'Qutie Studio and printer' } else { 'Qutie printer' }) -Force | Out-Null
}
catch {
    Write-Host "`nError: $($_.Exception.Message) (components.ps1, line $($_.InvocationInfo.ScriptLineNumber))" -ForegroundColor Red
    $result = 1
    if ($Nested) { throw }
}
finally {
    if (-not $Nested -and $Quiet -and $Log) { Stop-Transcript | Out-Null }
}
if (-not $Nested) { exit $result }
