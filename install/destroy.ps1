# townhall - cleanup for Windows - delete the Hetzner server and volume that provision.ps1 created.
#
# The same as destroy.sh, for Windows PowerShell (5.1 or 7). Hetzner bills by the hour
# until both are gone, so run this when you are done testing:
#
#   $env:HCLOUD_TOKEN="your_token"; irm https://raw.githubusercontent.com/townhall-fc/townhall/main/install/destroy.ps1 | iex
#
# It asks you to type the server name before deleting anything. Your Farcaster account is
# not touched; to also revoke the app key, use Settings -> Revoke in the client first.
#
# Options: $env:NAME (default: townhall), $env:YES="1" to skip the prompt.
& {
  $ErrorActionPreference = 'Stop'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  function Say($m) { Write-Host "> $m" -ForegroundColor White }
  function Fail($m) { Write-Host "x $m" -ForegroundColor Red; throw 'townhall: stopped' }
  function Opt($name, $default) { $v = [Environment]::GetEnvironmentVariable($name); if ($v) { $v } else { $default } }

  $Api = Opt 'HCLOUD_API' 'https://api.hetzner.cloud/v1'
  $Token = Opt 'HCLOUD_TOKEN' ''
  $Name = Opt 'NAME' 'townhall'
  if (-not $Token) { Fail 'Set HCLOUD_TOKEN first: $env:HCLOUD_TOKEN="your_token" (the same Read & Write token you used for provision.ps1).' }

  function Hc($method, $path) {
    try { Invoke-RestMethod -Method $method -Uri "$Api$path" -Headers @{ Authorization = "Bearer $Token" } }
    catch {
      $msg = $_.ErrorDetails.Message
      try { $msg = ($msg | ConvertFrom-Json).error.message } catch { }
      if (-not $msg) { $msg = $_.Exception.Message }
      Fail "Hetzner API $method $path -> $msg"
    }
  }

  $server = (Hc GET "/servers?name=$Name").servers | Select-Object -First 1
  $volume = (Hc GET "/volumes?name=$Name-data").volumes | Select-Object -First 1
  if (-not $server -and -not $volume) { Write-Host "Nothing named '$Name' or '$Name-data' in this project. Nothing to delete."; return }

  Write-Host 'This will permanently delete, in this Hetzner project:'
  if ($server) { Write-Host "  server  $Name  ($($server.public_net.ipv4.ip))" }
  if ($volume) { Write-Host "  volume  $Name-data  ($($volume.size) GB, with the node's data)" }
  if ((Opt 'YES' '') -ne '1') {
    $answer = Read-Host "Type the server name ($Name) to confirm"
    if ($answer -ne $Name) { Fail 'Not confirmed. Nothing deleted.' }
  }

  if ($server) {
    Say "Deleting server $Name"
    Hc DELETE "/servers/$($server.id)" | Out-Null
  }
  if ($volume) {
    Say 'Waiting for the volume to detach'
    for ($i = 0; $i -lt 60; $i++) {
      if (-not (Hc GET "/volumes/$($volume.id)").volume.server) { break }
      Start-Sleep -Seconds 3
    }
    Say "Deleting volume $Name-data"
    Hc DELETE "/volumes/$($volume.id)" | Out-Null
  }

  Write-Host ''
  Write-Host 'OK. Hetzner stops billing for both from now. Check the console (Servers, Volumes) if you want to be sure.' -ForegroundColor Green
}
