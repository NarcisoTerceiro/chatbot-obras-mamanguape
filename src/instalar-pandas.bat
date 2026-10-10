@echo off
cd /d "%~dp0"
py -3 -m pip install -r requirements-pandas.txt
if errorlevel 1 echo Falha. Confira se o Python esta instalado e o comando py funciona.
pause
