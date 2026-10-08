@echo off
title Serveur Blood on the Clocktower
cd /d "%~dp0server"
if not exist node_modules (
  echo Installation des dependances...
  call npm install
)
echo.
echo Le serveur tourne. Laisse cette fenetre ouverte pendant que tu joues.
echo Pour l'arreter : ferme la fenetre ou appuie sur Ctrl+C.
echo.
node server.js
pause
