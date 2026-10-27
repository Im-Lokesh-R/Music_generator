@echo off
rem VoiceClone launcher: first run sets everything up, then starts http://localhost:8000
setlocal
cd /d "%~dp0"

where ffmpeg >nul 2>nul || (
  echo [!] ffmpeg was not found. Install it with:  winget install Gyan.FFmpeg
  echo     then open a new terminal and run this again.
  pause & exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [setup] Creating Python virtual environment...
  python -m venv .venv || (echo [!] Python 3.10-3.12 is required. & pause & exit /b 1)
)

".venv\Scripts\python.exe" -c "import torch" 2>nul || (
  echo [setup] Installing PyTorch, this downloads ~2.5 GB once...
  ".venv\Scripts\python.exe" -m pip install --upgrade pip
  where nvidia-smi >nul 2>nul && (
    ".venv\Scripts\python.exe" -m pip install torch==2.7.1 torchaudio==2.7.1 --index-url https://download.pytorch.org/whl/cu126
  ) || (
    ".venv\Scripts\python.exe" -m pip install torch==2.7.1 torchaudio==2.7.1
  )
)

".venv\Scripts\python.exe" -c "import TTS, fastapi, uvicorn, multipart, soundfile" 2>nul || (
  echo [setup] Installing Python packages...
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || (pause & exit /b 1)
)

if not exist "data" mkdir data
if not exist "data\.license_accepted" (
  echo.
  echo  The voice model XTTS-v2 is released under the Coqui Public Model License:
  echo  NON-COMMERCIAL use only.  Full text: https://coqui.ai/cpml
  echo.
  set /p AGREE="Do you agree to these terms? [y/N] "
  call :check_agree || (echo Not accepted, exiting. & pause & exit /b 1)
  echo accepted>"data\.license_accepted"
)
set COQUI_TOS_AGREED=1

echo.
echo  VoiceClone is starting at http://localhost:8000
echo  The first start downloads the voice model (~1.8 GB), please wait.
echo.
start "" http://localhost:8000
cd server
"..\.venv\Scripts\python.exe" -m uvicorn app:app --host 127.0.0.1 --port 8000
pause
exit /b

:check_agree
if /i "%AGREE%"=="y" exit /b 0
if /i "%AGREE%"=="yes" exit /b 0
exit /b 1
