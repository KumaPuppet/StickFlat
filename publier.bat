@echo off
title Publier Blood on the Moon
cd /d "%~dp0"
echo.
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
