@echo off
title Construire et publier Blood on the Moon
echo.
echo Pense a enregistrer ton projet dans GameMaker (Ctrl+S) avant de continuer.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0construire.ps1"
echo.
pause
