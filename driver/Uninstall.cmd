@echo off
rem Removes the Qutie printer, its driver and the local certificate.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
