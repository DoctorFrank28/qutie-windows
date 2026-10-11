<#
.SYNOPSIS
    Installs the "Qutie" printer in Windows (Unidrv driver + Bluetooth COM port).

.DESCRIPTION
    1. Finds the COM port Windows created for the paired Qutie.
    2. Signs the driver with a certificate created on the spot on this PC; the
       private key is deleted right afterwards, so the certificate cannot sign
       anything else.
    3. Installs the driver and creates the "Qutie" printer on the COM port.

    Must run as administrator (the script asks for elevation by itself).

.PARAMETER Port
    COM port to use (e.g. COM11). Found automatically when omitted.

.PARAMETER Name
    Printer name in Windows. Default: Qutie.

.PARAMETER Test
    Print a test label at the end.

.PARAMETER Quiet
    For the setup wizard: no final pause, result in the exit code
    (0 success, 1 error, 2 not elevated) and in the -Log file.

.PARAMETER Log
    File that receives the steps (only with -Quiet).

.PARAMETER Executable
    The Qutie app ("Qutie-Setup.exe") to copy to Program Files as Qutie.exe and
    register in Installed apps (passed by the setup wizard).

.PARAMETER Studio
    1 (default): also install Qutie Studio (Start menu "Qutie Studio", .qutie files).
    0: only the driver (Start menu "Qutie" opens the printer settings). See components.ps1.

.PARAMETER SpoolFile
    Print to this file instead of the COM port: the Qutie app picks each job up,
    shows the preview and sends it to the printer (passed by the setup wizard).
    Without it the printer writes straight to the Bluetooth COM port.
#>
[CmdletBinding()]
param(
    [string]$Port,
    [string]$Name = 'Qutie',
    [switch]$Test,
    [switch]$Quiet,
    [string]$Log,
    [string]$Executable,
    [string]$SpoolFile,
    [int]$Studio = 1
)

$ErrorActionPreference = 'Stop'
$DriverName = 'HPRT Qutie'
$CertSubject = 'CN=Qutie driver (local certificate)'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
    if ($Quiet) { exit 2 }
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Name', "`"$Name`"")
    if ($Port) { $arguments += @('-Port', $Port) }
    if ($Test) { $arguments += '-Test' }
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments -Wait
    exit
}

function Step($text) { Write-Host "`n> $text" -ForegroundColor Cyan }

function Remove-QutieDriver {
    # A removed printer goes away only when no app holds it open (Settings, the Qutie
    # app…), and until then its driver counts as "in use": wait, then restart the spooler.
    if (-not (Get-PrinterDriver -Name $DriverName -ErrorAction SilentlyContinue)) { return }
    for ($i = 1; $i -le 10; $i++) {
        try {
            Remove-PrinterDriver -Name $DriverName -ErrorAction Stop
            return
        }
        catch {
            if ($i -eq 5) { Write-Host '  driver still in use: restarting the print spooler'; Restart-Service Spooler -Force }
            Start-Sleep -Seconds 1
        }
    }
    throw 'The previous Qutie driver is still in use. Close the apps that are printing and retry.'
}

if ($Quiet -and $Log) { Start-Transcript -Path $Log -Force | Out-Null }
$result = 0
try {
    # 1. COM port of the Qutie --------------------------------------------------
    Step 'Looking for the paired Qutie'
    if (-not $Port) {
        $qutie = Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue |
            Where-Object { $_.FriendlyName -match '^(Qutie|HPRT|Q2)' -and $_.InstanceId -match '^BTHENUM\\DEV_([0-9A-F]{12})' }
        if (-not $qutie) {
            throw 'No paired Qutie. Turn it on, pair it in Settings > Bluetooth & devices and run the setup again.'
        }
        $mac = ([regex]::Match(@($qutie)[0].InstanceId, 'DEV_([0-9A-F]{12})')).Groups[1].Value
        $com = Get-PnpDevice -Class Ports -ErrorAction SilentlyContinue |
            Where-Object { $_.InstanceId -match "&$($mac)_" -and $_.FriendlyName -match '\((COM\d+)\)' } |
            Select-Object -First 1
        if (-not $com) {
            throw "The Qutie ($mac) is paired but Windows gave it no COM port. Remove it and pair it again."
        }
        $Port = ([regex]::Match($com.FriendlyName, '\((COM\d+)\)')).Groups[1].Value
        Write-Host "  $(@($qutie)[0].FriendlyName) ($mac) on $Port"
    }
    $portName = "$($Port.TrimEnd(':')):"

    # 2. Sign the driver with a local certificate --------------------------------
    Step 'Signing the driver'
    $work = Join-Path $env:TEMP ("qutie-driver-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $work | Out-Null
    $files = 'qutie.inf', 'QUTIE.GPD', 'QUTIE.INI', 'amd64\QUTIEUI.DLL'
    Copy-Item ($files | ForEach-Object { Join-Path $PSScriptRoot $_ }) $work
    $catalog = Join-Path $work 'qutie.cat'
    New-FileCatalog -Path $work -CatalogFilePath $catalog -CatalogVersion 2.0 | Out-Null

    foreach ($store in 'Root', 'TrustedPublisher') {
        Get-ChildItem "Cert:\LocalMachine\$store" | Where-Object Subject -eq $CertSubject | Remove-Item
    }
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $CertSubject `
        -CertStoreLocation 'Cert:\LocalMachine\My' -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddYears(20)
    try {
        $signature = Set-AuthenticodeSignature -FilePath $catalog -Certificate $cert -HashAlgorithm SHA256
        $public = Join-Path $work 'qutie.cer'
        Export-Certificate -Cert $cert -FilePath $public | Out-Null
        foreach ($store in 'Root', 'TrustedPublisher') {
            Import-Certificate -FilePath $public -CertStoreLocation "Cert:\LocalMachine\$store" | Out-Null
        }
        if ($signature.Status -notin 'Valid', 'UnknownError') { throw "Signing failed: $($signature.StatusMessage)" }
    }
    finally {
        # Without its private key the certificate cannot sign anything else.
        Remove-Item "Cert:\LocalMachine\My\$($cert.Thumbprint)" -DeleteKey
    }
    Write-Host "  catalog signed ($($cert.Thumbprint)), private key deleted"

    # 3. Driver -----------------------------------------------------------------
    Step 'Installing the driver'
    if (Get-Printer -Name $Name -ErrorAction SilentlyContinue) { Remove-Printer -Name $Name }
    Remove-QutieDriver
    # Drop packages left by earlier installs, so the store holds only this one.
    foreach ($package in Get-WindowsDriver -Online | Where-Object { $_.OriginalFileName -like '*\qutie.inf' }) {
        & pnputil.exe /delete-driver $package.Driver /force | Out-Null
        Write-Host "  old package $($package.Driver) removed"
    }
    $output = & pnputil.exe /add-driver (Join-Path $work 'qutie.inf') 2>&1
    Write-Host ($output | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "pnputil could not add the driver (code $LASTEXITCODE)." }
    try {
        Add-PrinterDriver -Name $DriverName
    }
    catch {
        # The spooler logs the real reason in its event log.
        $event = Get-WinEvent -LogName 'Microsoft-Windows-PrintService/Admin' -MaxEvents 5 -ErrorAction SilentlyContinue |
            Where-Object { $_.Id -eq 215 -and $_.TimeCreated -gt (Get-Date).AddMinutes(-2) } | Select-Object -First 1
        $detail = if ($event) { ([xml]$event.ToXml()).Event.UserData.InnerText } else { $_.Exception.Message }
        throw "The spooler refused the driver: $detail"
    }

    # 4. Port and printer -------------------------------------------------------
    $queuePort = $portName
    if ($SpoolFile) {
        # Jobs go to a file that the Qutie app previews and sends. The spooler writes it;
        # signed-in users must be able to move it away, hence Modify for Users.
        $spoolDir = Split-Path $SpoolFile
        New-Item -ItemType Directory -Force -Path $spoolDir | Out-Null
        & icacls.exe $spoolDir /grant '*S-1-5-32-545:(OI)(CI)M' /T /Q | Out-Null
        $queuePort = $SpoolFile
    }
    Step "Creating the '$Name' printer on $queuePort"
    if (-not (Get-PrinterPort -Name $queuePort -ErrorAction SilentlyContinue)) {
        Add-PrinterPort -Name $queuePort
    }
    Add-Printer -Name $Name -DriverName $DriverName -PortName $queuePort `
        -Comment "HPRT Qutie label printer (Bluetooth $portName)"
    Remove-Item $work -Recurse -Force

    # Labels are printed along their length: make landscape the default.
    $ticket = (Get-PrintConfiguration -PrinterName $Name).PrintTicketXML -replace 'psk:Portrait', 'psk:Landscape'
    Set-PrintConfiguration -PrinterName $Name -PrintTicketXml $ticket

    # Link the queue to the Bluetooth device, so Settings shows one "Qutie" entry
    # instead of the printer plus the paired device marked "driver unavailable".
    $serial = Get-PnpDevice -Class Ports -ErrorAction SilentlyContinue |
        Where-Object { $_.FriendlyName -match "\($($Port.TrimEnd(':'))\)" } | Select-Object -First 1
    $macOfPort = if ($serial) { ([regex]::Match($serial.InstanceId, '&([0-9A-F]{12})_C')).Groups[1].Value }
    $device = if ($macOfPort) {
        Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue |
            Where-Object { $_.InstanceId -match "^BTHENUM\\DEV_$macOfPort\\" } | Select-Object -First 1
    }
    if ($device) {
        Step 'Linking the printer to the Bluetooth device'
        $pnpData = "HKLM:\SYSTEM\CurrentControlSet\Control\Print\Printers\$Name\PnPData"
        if (-not (Test-Path $pnpData)) { New-Item -Path $pnpData -Force | Out-Null }
        New-ItemProperty -Path $pnpData -Name DeviceInstanceId -Value $device.InstanceId -PropertyType String -Force | Out-Null
        Restart-Service Spooler -Force
        Write-Host "  $($device.FriendlyName)"
    }

    # 5. Entry in Installed apps ------------------------------------------------
    if ($Executable -and (Test-Path $Executable)) {
        Step 'Registering in Installed apps'
        $folder = Join-Path $env:ProgramFiles 'Qutie'
        New-Item -ItemType Directory -Force -Path $folder | Out-Null
        $exe = Join-Path $folder 'Qutie.exe'
        # A running copy (the app in the background) would lock the file.
        Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force
        if ((Resolve-Path $Executable).Path -ne $exe) { Copy-Item $Executable $exe -Force }
        # Earlier versions installed the app under the setup's name.
        Remove-Item (Join-Path $folder 'Qutie Setup.exe') -Force -ErrorAction SilentlyContinue
        $key = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Qutie'
        New-Item -Path $key -Force | Out-Null
        $values = @{
            DisplayName     = 'Qutie printer'
            DisplayVersion  = '1.2.0'
            Publisher       = 'qutie-driver'
            DisplayIcon     = "$exe,0"
            InstallLocation = $folder
            UninstallString = "`"$exe`" --uninstall"
            Comments        = 'Printer driver for the HPRT Qutie label maker'
        }
        foreach ($v in $values.GetEnumerator()) { New-ItemProperty -Path $key -Name $v.Key -Value $v.Value -Force | Out-Null }
        New-ItemProperty -Path $key -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
        New-ItemProperty -Path $key -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null
        # Start menu entry and .qutie files: Qutie Studio, or the printer settings only.
        & (Join-Path $PSScriptRoot 'components.ps1') -Studio $Studio -Executable $exe -Nested
        Write-Host "  $exe"
    }

    if ($Test) {
        Step 'Test label'
        'Qutie OK' | Out-Printer -Name $Name
    }

    Write-Host "`nDone: the '$Name' printer is ready. Pick the '12 x 40 mm' paper size (or another one) when you print." -ForegroundColor Green
}
catch {
    Write-Host "`nError: $($_.Exception.Message) (install.ps1, line $($_.InvocationInfo.ScriptLineNumber))" -ForegroundColor Red
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
