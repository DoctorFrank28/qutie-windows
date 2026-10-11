@echo off
rem Builds driver\amd64\QUTIEUI.DLL with Visual Studio 2022 (C++ tools + Windows SDK).
setlocal
cd /d "%~dp0"
if not exist build mkdir build

rem "Program Files (x86)" breaks a for /f command: go through a file instead.
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath > build\vsdir.txt
set "VSDIR="
set /p VSDIR=<build\vsdir.txt
if not defined VSDIR (echo Visual Studio C++ tools not found & exit /b 1)
rem vcvars64 looks for vswhere on PATH and complains harmlessly when it is not there.
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1 || exit /b 1
cd /d "%~dp0"
if not exist ..\driver\amd64 mkdir ..\driver\amd64
rc /nologo /fo build\qutieui.res qutieui.rc || exit /b 1
cl /nologo /O2 /W4 /WX /EHsc /utf-8 /MT /LD /DUNICODE /D_UNICODE /Fobuild\ /Fdbuild\ ^
   qutieui.cpp build\qutieui.res ^
   /link /DEF:qutieui.def /OUT:..\driver\amd64\QUTIEUI.DLL /IMPLIB:build\qutieui.lib ^
   user32.lib shell32.lib ole32.lib uuid.lib || exit /b 1
echo Built ..\driver\amd64\QUTIEUI.DLL
