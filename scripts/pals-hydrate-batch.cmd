@echo off
setlocal enabledelayedexpansion

rem PALS licence hydration — one-shot operator runbook (queue-cockpit Phase A0).
rem Wraps the 3 manual steps into one double-clickable / cmd-runnable batch:
rem   1. export the seed list of un-enriched Pierce permits
rem   2. drive the real PALS SPA in Chromium to capture their headers
rem   3. ingest the captures (stamps organizations.contractor_registration,
rem      then registry-link binds contractor_number_exact deterministically)
rem
rem Usage:  pals-hydrate-batch.cmd [limit]
rem   limit defaults to 250 (~25-35 minutes: a full page load per permit plus
rem   the script's 2.5s+jitter pace). Pass a smaller number for a quick run:
rem     scripts\pals-hydrate-batch.cmd 20
rem
rem Self-locating: works from any starting directory, including a double-click
rem in Explorer, because every path is built from this file's own location
rem (%~dp0), not the caller's current directory. Everything runs from repo
rem ROOT (a single pushd below) — @playwright/test is a ROOT devDependency for
rem exactly this reason: Node's ESM resolver walks up from the SCRIPT's own
rem path, not cwd, so scripts/pals-header-capture.mjs needs an ancestor
rem node_modules, not a sibling one (apps/web does not qualify).
rem
rem Owner-approved scale (2026-07-24) — see config/sources.yaml and
rem scripts/pals-header-capture.mjs for the authorization chain. This script
rem performs no new authorization; it only sequences the three already-approved
rem steps so a re-run doesn't require re-typing paths from memory.

for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "LIMIT=%~1"
if "%LIMIT%"=="" set "LIMIT=250"
set "OTN_CAPTURE_DIR=%ROOT%\captures"

echo ============================================================
echo  PALS licence hydration batch — limit=%LIMIT%
echo  Repo root:    %ROOT%
echo  Capture dir:  %OTN_CAPTURE_DIR%
echo ============================================================
echo.

pushd "%ROOT%"

echo [1/3] Exporting seed list of un-enriched Pierce permits...
call pnpm --filter @otn/worker pals:hydrate:export "--limit=%LIMIT%"
if errorlevel 1 (
  echo.
  echo [FAILED] pals:hydrate:export — see error above. Nothing was captured.
  popd
  pause
  exit /b 1
)
echo.

if not exist "%ROOT%\apps\worker\pals-hydrate-seed.json" (
  echo [FAILED] Expected seed file not found at apps\worker\pals-hydrate-seed.json
  popd
  pause
  exit /b 1
)

echo [2/3] Opening Chromium to capture PALS permit headers — a browser
echo       window will open and step through permits automatically.
echo       This is a genuine-visitor session (its own reCAPTCHA token,
echo       ~2.5s+ pause per permit) — do not close the window early.
echo.
call node scripts\pals-header-capture.mjs "--list=apps\worker\pals-hydrate-seed.json" "--out=%OTN_CAPTURE_DIR%\pierce_pals_contractor"
if errorlevel 1 (
  echo.
  echo [WARNING] Capture step reported failures for every permit attempted —
  echo           nothing new to ingest. Check the summary above ^(PALS may be
  echo           declining this session, or the seed file may be stale^). If
  echo           the message above says "Cannot resolve @playwright/test", run
  echo           "pnpm install" at the repo root once and retry.
  popd
  pause
  exit /b 1
)
echo.

echo [3/3] Ingesting captured headers ^(stamps contractor licences, then
echo       registry-link binds deterministically on the next resolve pass^)...
call pnpm --filter @otn/worker source:run:operator-local
if errorlevel 1 (
  echo.
  echo [FAILED] source:run:operator-local — see error above.
  echo          Captured files are safe in %OTN_CAPTURE_DIR% ^(re-run this
  echo          script to retry ingest — already-captured permits are skipped
  echo          on re-capture, so it will not re-open the browser needlessly^).
  popd
  pause
  exit /b 1
)
popd

echo.
echo ============================================================
echo  Batch complete. Captured headers are staged permanently at
echo  %OTN_CAPTURE_DIR% — safe to re-run this script for the next
echo  batch of %LIMIT% permits (already-captured ones are skipped).
echo ============================================================
echo.
pause
