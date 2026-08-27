$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

Write-Host '== DP11 Windows validation receipt =='
Write-Host "Repository: $repo"
Write-Host "PowerShell: $($PSVersionTable.PSVersion)"
node --version
npm --version
dotnet --version

Write-Host '== Install TypeScript test dependencies =='
npm install --ignore-scripts
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '== Focused DP11/Windows TypeScript compile =='
if (Test-Path 'dist-windows') { Remove-Item -Recurse -Force 'dist-windows' }
npx tsc -p tsconfig.windows.json
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '== Focused DP11/Windows tests =='
$tests = @(
  'dist-windows/tests/consequenceAuthority.test.js',
  'dist-windows/tests/dp11Foundations.test.js',
  'dist-windows/tests/computerTaskCheckpointReview.test.js',
  'dist-windows/tests/computerUseEvaluation.test.js'
)
$tests += Get-ChildItem 'dist-windows/tests/windows*.test.js' | ForEach-Object { $_.FullName }
node --test $tests
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$native = 'native/windows/Ossa.ComputerUse.WindowsHost/Ossa.ComputerUse.WindowsHost.csproj'
Write-Host '== Native host Debug build =='
dotnet build $native -c Debug --nologo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host '== Native host Release build =='
dotnet build $native -c Release --nologo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$smoke = 'native/windows/Ossa.ComputerUse.WindowsSmoke/Ossa.ComputerUse.WindowsSmoke.csproj'
Write-Host '== Windows embodiment smoke target Release build =='
dotnet build $smoke -c Release --nologo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host 'DP11 Windows validation receipt: PASS'
