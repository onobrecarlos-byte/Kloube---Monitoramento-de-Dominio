@echo off
chcp 65001 >nul
title Kloube Domain Monitor
echo ====================================================
echo   Iniciando Kloube Domain Monitor...
echo   Painel abrindo em: http://localhost:8765
echo ====================================================
start "" "http://localhost:8765"
python "%~dp0server.py"
pause
