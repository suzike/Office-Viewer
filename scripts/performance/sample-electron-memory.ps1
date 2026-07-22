param(
  [Parameter(Mandatory = $true)]
  [int]$RootProcessId,

  [Parameter(Mandatory = $true)]
  [string]$ProcessMapPath,

  [ValidateRange(50, 5000)]
  [int]$IntervalMilliseconds = 100
)

$ErrorActionPreference = 'SilentlyContinue'
$trackedRoles = @{}
$trackedRoles[$RootProcessId] = 'main'
$lastMapWrite = [DateTime]::MinValue

while ($null -ne (Get-Process -Id $RootProcessId)) {
  $mapFile = Get-Item -LiteralPath $ProcessMapPath
  if ($null -ne $mapFile -and $mapFile.LastWriteTimeUtc -gt $lastMapWrite) {
    try {
      $map = Get-Content -Raw -LiteralPath $ProcessMapPath | ConvertFrom-Json
      foreach ($property in $map.PSObject.Properties) {
        $trackedRoles[[int]$property.Name] = [string]$property.Value
      }
      $lastMapWrite = $mapFile.LastWriteTimeUtc
    } catch {
      # Retain the previous map if the tiny JSON update is observed mid-write.
    }
  }

  [int64]$mainBytes = 0
  [int64]$rendererBytes = 0
  [int64]$totalBytes = 0
  $processCount = 0
  $rendererCount = 0
  foreach ($trackedProcessId in @($trackedRoles.Keys)) {
    $process = Get-Process -Id $trackedProcessId
    if ($null -eq $process) {
      continue
    }
    [int64]$workingSet = $process.WorkingSet64
    $totalBytes += $workingSet
    $processCount += 1
    if ([int]$trackedProcessId -eq $RootProcessId) {
      $mainBytes = $workingSet
    } elseif ($trackedRoles[$trackedProcessId] -eq 'renderer') {
      $rendererBytes += $workingSet
      $rendererCount += 1
    }
  }

  [pscustomobject]@{
    timestampUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    mainBytes = $mainBytes
    rendererBytes = $rendererBytes
    totalBytes = $totalBytes
    processCount = $processCount
    rendererCount = $rendererCount
  } | ConvertTo-Json -Compress

  Start-Sleep -Milliseconds $IntervalMilliseconds
}
