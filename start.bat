@echo off
cd /d "%~dp0"
echo Spoustim planner...
start "" http://localhost:5173
npm run dev
pause
