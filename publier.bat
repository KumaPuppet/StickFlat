@echo off
title Publier Blood on the Moon
cd /d "%~dp0"
echo.

rem Si GameMaker a exporte le jeu ici (a la racine), on le range dans server\public
if exist "index.html" (
  echo Nouvel export trouve : rangement dans server\public...
  if exist "server\public\html5game" rmdir /s /q "server\public\html5game"
  move /y "html5game" "server\public\" >nul
  move /y "index.html" "server\public\" >nul
  if exist "favicon.ico" move /y "favicon.ico" "server\public\" >nul
  if exist "options.ini" move /y "options.ini" "server\public\" >nul
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
  echo https://blood-on-the-moon.onrender.com
)
echo.
pause
