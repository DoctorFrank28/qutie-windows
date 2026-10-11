@echo off
rem Installs the Qutie printer in Windows. Asks for administrator permission.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
