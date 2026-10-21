@echo off
title Publier StickFlat
cd /d "%~dp0"
echo.

rem GameMaker exporte parfois le jeu a la racine du projet, parfois un dossier au-dessus (Downloads).
rem On le range dans server\public. On verifie que c'est bien NOTRE jeu (fichier vocal tph_ext_voice.js).
set "SRC="
if exist "html5game\tph_ext_voice.js" set "SRC=."
if not defined SRC if exist "..\html5game\tph_ext_voice.js" set "SRC=.."

if defined SRC (
  echo Nouvel export trouve : rangement dans server\public...
  if exist "server\public\html5game" rmdir /s /q "server\public\html5game"
  move /y "%SRC%\html5game" "server\public\" >nul
  if exist "%SRC%\index.html" move /y "%SRC%\index.html" "server\public\" >nul
  if exist "%SRC%\options.ini" move /y "%SRC%\options.ini" "server\public\" >nul
  if "%SRC%"=="." if exist "favicon.ico" move /y "favicon.ico" "server\public\" >nul
  echo.
)

echo Envoi de la nouvelle version sur GitHub...
echo (Render la mettra en ligne automatiquement en 1 a 3 minutes)
echo.
git add -A
git commit -m "Mise a jour du jeu"
git push origin main
echo.
if errorlevel 1 (
  echo Il y a eu un probleme : lis le message ci-dessus.
) else (
  echo C'est envoye ! Le site sera a jour dans quelques minutes :
  echo https://stickflat.onrender.com
)
echo.
pause
