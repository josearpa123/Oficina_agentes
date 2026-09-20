@echo off
rem Lanza Gemini CLI reportando su estado a la oficina. Uso: gemini-o [args de gemini]
rem (al ser .cmd evita el bloqueo de scripts .ps1 de PowerShell)
node "%~dp0..\connectors\run-agent.js" --agent gemini -- gemini %*
