# =============================================================
#  Construit le jeu HTML5 depuis le projet GameMaker (sans ouvrir l'IDE)
#  puis le met en ligne (GitHub -> Render).
#  Utilise : construire-et-publier.bat (double-clic)
#  Option : -SansEnvoi  (construit seulement, n'envoie rien)
# =============================================================
param([switch]$SansEnvoi)
$ErrorActionPreference = "Stop"

$Racine  = $PSScriptRoot
$Projet  = "C:\Users\Slymane\GameMakerProjects\blood on the clecktower\blood on the clecktower.yyp"
$Public  = Join-Path $Racine "server\public"
$Travail = Join-Path $env:TEMP "blood-on-the-moon-build"
$Sortie  = Join-Path $Travail "out"

# Runtime GameMaker le plus recent, et dossier utilisateur (celui qui contient la licence)
$Runtime = Get-ChildItem "C:\ProgramData\GameMakerStudio2-LTS2026\Cache\runtimes" -Directory |
	Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $Runtime) { throw "Runtime GameMaker introuvable. Ouvre GameMaker au moins une fois." }
$Igor = Join-Path $Runtime.FullName "bin\igor\windows\x64\Igor.exe"
$User = Get-ChildItem "$env:APPDATA\GameMakerStudio2-LTS2026" -Directory |
	Where-Object { Test-Path (Join-Path $_.FullName "licence.plist") } | Select-Object -First 1
if (-not $User) { throw "Licence GameMaker introuvable. Connecte-toi dans GameMaker." }

Write-Host ""
Write-Host "1/3  Construction du jeu (HTML5)..." -ForegroundColor Yellow
if (Test-Path $Sortie) { Remove-Item $Sortie -Recurse -Force }
New-Item -ItemType Directory -Force $Sortie | Out-Null
& $Igor -j=8 --project="$Projet" --rp="$($Runtime.FullName)" --uf="$($User.FullName)" `
	--temp="$Travail\temp" --cache="$Travail\cache" --of="$Sortie\index.html" -- HTML5 folder 2>&1 |
	Where-Object { $_ -match "error|Error|ERROR" -and $_ -notmatch "CreateDirectory|ArgumentException|at System|at Igor|empty string" } |
	ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
if (-not (Test-Path (Join-Path $Sortie "index.html")) -or -not (Test-Path (Join-Path $Sortie "html5game"))) {
	throw "La construction a echoue (pas de index.html). Ouvre le projet dans GameMaker pour voir l'erreur."
}

Write-Host "2/3  Mise en place dans server\public..." -ForegroundColor Yellow
if (Test-Path (Join-Path $Public "html5game")) { Remove-Item (Join-Path $Public "html5game") -Recurse -Force }
Copy-Item (Join-Path $Sortie "*") $Public -Recurse -Force

if ($SansEnvoi) { Write-Host "Construit (rien n'a ete envoye)." -ForegroundColor Green; exit 0 }

Write-Host "3/3  Envoi sur GitHub (Render mettra le site a jour en 1 a 3 minutes)..." -ForegroundColor Yellow
Set-Location $Racine
git add -A
git commit -q -m "Mise a jour du jeu" 2>$null
git push origin main
if ($LASTEXITCODE -ne 0) { throw "L'envoi sur GitHub a echoue." }
Write-Host ""
Write-Host "C'est envoye ! Le site sera a jour dans quelques minutes :" -ForegroundColor Green
Write-Host "https://blood-on-the-moon.onrender.com"
