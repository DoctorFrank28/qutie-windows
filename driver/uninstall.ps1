<#
.SYNOPSIS
    Removes the "Qutie" printer, its driver, the local certificate and the Installed apps entry.

.PARAMETER Quiet
    For the setup wizard: no final pause, result in the exit code.

.PARAMETER Log
    File that receives the steps (only with -Quiet).
#>
[CmdletBinding()]
param(
    [string]$Name = 'Qutie',
    [switch]$Quiet,
    [string]$Log
)

$ErrorActionPreference = 'Stop'
$DriverName = 'HPRT Qutie'
$CertSubject = 'CN=Qutie driver (local certificate)'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    if ($Quiet) { exit 2 }
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Name', "`"$Name`"")
    exit
}

function Step($text) { Write-Host "`n> $text" -ForegroundColor Cyan }

if ($Quiet -and $Log) { Start-Transcript -Path $Log -Force | Out-Null }
$result = 0
try {
    Step 'Removing the printer'
    if (Get-Printer -Name $Name -ErrorAction SilentlyContinue) {
        $port = (Get-Printer -Name $Name).PortName
        Remove-Printer -Name $Name
        Write-Host "  printer '$Name' removed"
        # The COM port belongs to Windows: only drop the spooler entry, if nothing else uses it.
        if ($port -and -not (Get-Printer | Where-Object PortName -eq $port)) {
            Remove-PrinterPort -Name $port -ErrorAction SilentlyContinue
        }
    }
    else { Write-Host "  no '$Name' printer" }

    Step 'Removing the driver'
    if (Get-PrinterDriver -Name $DriverName -ErrorAction SilentlyContinue) {
        # The removed printer may still be held open by an app: wait, then restart the spooler.
        for ($i = 1; $i -le 10; $i++) {
            try { Remove-PrinterDriver -Name $DriverName -ErrorAction Stop; break }
            catch {
                if ($i -eq 10) { throw }
                if ($i -eq 5) { Restart-Service Spooler -Force }
                Start-Sleep -Seconds 1
            }
        }
        Write-Host '  driver removed from the spooler'
    }
    foreach ($package in Get-WindowsDriver -Online | Where-Object { $_.OriginalFileName -like '*\qutie.inf' }) {
        & pnputil.exe /delete-driver $package.Driver /uninstall /force | Out-Null
        Write-Host "  package $($package.Driver) removed from the driver store"
    }

    Step 'Removing the local certificate'
    foreach ($store in 'Root', 'TrustedPublisher') {
        Get-ChildItem "Cert:\LocalMachine\$store" | Where-Object Subject -eq $CertSubject | Remove-Item
    }
    Write-Host '  done'

    Step 'Removing the print queue folder'
    $data = Join-Path $env:ProgramData 'Qutie'
    if (Test-Path $data) { Remove-Item $data -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Host '  done'

    Step 'Removing from Installed apps'
    $key = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Qutie'
    if (Test-Path $key) { Remove-Item $key -Recurse -Force }
    foreach ($link in 'Qutie.lnk', 'Qutie Studio.lnk') {
        $shortcut = Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs\$link"
        if (Test-Path $shortcut) { Remove-Item $shortcut -Force }
    }
    foreach ($k in 'HKLM:\SOFTWARE\Classes\.qutie', 'HKLM:\SOFTWARE\Classes\Qutie.Label') {
        if (Test-Path $k) { Remove-Item $k -Recurse -Force }
    }
    $folder = Join-Path $env:ProgramFiles 'Qutie'
    if (Test-Path $folder) {
        # The executable may still be running: the folder goes as soon as it closes.
        Start-Process -FilePath 'cmd.exe' -WindowStyle Hidden `
            -ArgumentList "/c for /l %i in (1,1,60) do (rmdir /s /q `"$folder`" 2>nul & if not exist `"$folder`" exit & ping -n 3 127.0.0.1 >nul)"
    }
    Write-Host "`nQutie uninstalled." -ForegroundColor Green
}
catch {
    Write-Host "`nError: $($_.Exception.Message) (uninstall.ps1, line $($_.InvocationInfo.ScriptLineNumber))" -ForegroundColor Red
    $result = 1
}
finally {
    if ($Quiet) {
        if ($Log) { Stop-Transcript | Out-Null }
    }
    elseif ($Host.Name -eq 'ConsoleHost') {
        Read-Host "`nPress Enter to close" | Out-Null
    }
}
exit $result
