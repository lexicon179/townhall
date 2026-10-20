# townhall - step 0 for Windows - provision a server for a Snapchain read node.
#
# The same as provision.sh, for Windows PowerShell (5.1 or 7). Runs on YOUR computer.
# Creates a Hetzner Cloud server plus a volume, installs your SSH key, and prints the
# two commands for steps 1 and 2. Open PowerShell (not cmd) and run:
#
#   $env:HCLOUD_TOKEN="your_token"; irm https://raw.githubusercontent.com/townhall-fc/townhall/main/install/provision.ps1 | iex
#
# Options, set the same way before running ($env:NAME="..."):
#   HCLOUD_TOKEN   required. Hetzner Cloud -> your project -> Security -> API tokens (Read & Write)
#   SERVER_TYPE    default: cheapest type with >= 4 vCPU and >= 16 GB RAM
#   LOCATION       default: fsn1 (Falkenstein). Others: nbg1, hel1
#   VOLUME_GB      default: 2000; falls back to 1000, then 500, if your account's limit is lower
#   NAME           default: townhall
#
# Needs the OpenSSH client, which Windows 10 and 11 include (Settings -> Optional features).
& {
  $ErrorActionPreference = 'Stop'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  function Say($m) { Write-Host "> $m" -ForegroundColor White }
  function Fail($m) { Write-Host "x $m" -ForegroundColor Red; throw 'townhall: stopped' }
  function Opt($name, $default) { $v = [Environment]::GetEnvironmentVariable($name); if ($v) { $v } else { $default } }

  $Api = Opt 'HCLOUD_API' 'https://api.hetzner.cloud/v1'
  $Token = Opt 'HCLOUD_TOKEN' ''
  $Name = Opt 'NAME' 'townhall'
  $Location = Opt 'LOCATION' 'fsn1'
  $VolumeGb = [int](Opt 'VOLUME_GB' '2000')
  $Raw = Opt 'REPO_RAW' 'https://raw.githubusercontent.com/townhall-fc/townhall/main'
  $KeyFile = Opt 'SSH_KEY_FILE' (Join-Path $HOME '.ssh\id_ed25519')

  if (-not $Token) { Fail 'Set HCLOUD_TOKEN first: $env:HCLOUD_TOKEN="your_token" (Hetzner Cloud -> project -> Security -> API tokens, Read & Write).' }
  foreach ($c in 'ssh', 'ssh-keygen') {
    if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { Fail "'$c' not found. Install the OpenSSH client: Settings -> Apps -> Optional features -> OpenSSH Client." }
  }

  # Hetzner API call. Returns $null on an error when -Soft is set, otherwise stops with Hetzner's message.
  function Hc($method, $path, $body, [switch]$Soft) {
    $p = @{ Method = $method; Uri = "$Api$path"; Headers = @{ Authorization = "Bearer $Token" }; ContentType = 'application/json' }
    if ($body) { $p.Body = ($body | ConvertTo-Json -Depth 8 -Compress) }
    try { Invoke-RestMethod @p }
    catch {
      $msg = $_.ErrorDetails.Message
      try { $msg = ($msg | ConvertFrom-Json).error.message } catch { }
      if (-not $msg) { $msg = $_.Exception.Message }
      if ($Soft) { Write-Host "  $msg"; return $null }
      Fail "Hetzner API $method $path -> $msg"
    }
  }

  # 1. SSH key
  $Pub = "$KeyFile.pub"
  if (-not (Test-Path $Pub)) {
    Say "No SSH key at $Pub, creating one. Press Enter twice for no passphrase."
    New-Item -ItemType Directory -Force -Path (Split-Path $KeyFile) | Out-Null
    ssh-keygen -t ed25519 -f "$KeyFile"
    if (-not (Test-Path $Pub)) { Fail 'ssh-keygen did not create a key.' }
  }
  $PubText = (Get-Content $Pub -Raw).Trim()
  $blob = [Convert]::FromBase64String(($PubText -split '\s+')[1])
  $md5 = [Security.Cryptography.MD5]::Create().ComputeHash($blob)
  $Fp = ($md5 | ForEach-Object { $_.ToString('x2') }) -join ':'
  $key = (Hc GET "/ssh_keys?fingerprint=$Fp").ssh_keys | Select-Object -First 1
  if (-not $key) {
    Say 'Uploading your SSH key to Hetzner'
    $key = (Hc POST /ssh_keys @{ name = "$Name-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"; public_key = $PubText }).ssh_key
  }

  # 2. Server type: cheapest x86 type available here with >= 4 cores and >= 16 GB RAM
  $Type = Opt 'SERVER_TYPE' ''
  if (-not $Type) {
    $Type = (Hc GET '/server_types?per_page=50').server_types |
      Where-Object { -not $_.deprecation -and -not $_.deprecated -and $_.architecture -eq 'x86' -and $_.cores -ge 4 -and $_.memory -ge 16 } |
      ForEach-Object { $t = $_; $p = $t.prices | Where-Object { $_.location -eq $Location } | Select-Object -First 1
        if ($p) { [pscustomobject]@{ name = $t.name; price = [double]$p.price_monthly.gross } } } |
      Sort-Object price | Select-Object -First 1 -ExpandProperty name
    if (-not $Type) { Fail "No server type with 4 vCPU / 16 GB found in $Location. Try `$env:LOCATION=`"nbg1`" or hel1." }
  }

  # 3. Firewall: SSH, HTTP(S) for the client, UDP 3382 for Snapchain gossip
  $fw = (Hc GET "/firewalls?name=$Name").firewalls | Select-Object -First 1
  if (-not $fw) {
    $any = @('0.0.0.0/0', '::/0')
    $fw = (Hc POST /firewalls @{ name = $Name; rules = @(
      @{ direction = 'in'; protocol = 'tcp'; port = '22'; source_ips = $any; description = 'ssh' },
      @{ direction = 'in'; protocol = 'tcp'; port = '80'; source_ips = $any; description = 'http (certificate)' },
      @{ direction = 'in'; protocol = 'tcp'; port = '443'; source_ips = $any; description = 'https (client)' },
      @{ direction = 'in'; protocol = 'udp'; port = '3382'; source_ips = $any; description = 'snapchain gossip' }) }).firewall
  }

  Write-Host '  This is billed by Hetzner while it exists. Delete it with destroy.ps1 when you are done.'

  # 4. Server. Re-running is safe: an existing server with this name is reused.
  $server = (Hc GET "/servers?name=$Name").servers | Select-Object -First 1
  if ($server) {
    Say "Using your existing server '$Name'"
  } else {
    # A location can be temporarily out of a server type; try the others too.
    foreach ($loc in @($Location) + (@('fsn1', 'nbg1', 'hel1') | Where-Object { $_ -ne $Location })) {
      Say "Creating server '$Name' ($Type, $loc, Ubuntu 24.04)"
      $r = Hc POST /servers @{ name = $Name; server_type = $Type; location = $loc; image = 'ubuntu-24.04'
        ssh_keys = @($key.id); firewalls = @(@{ firewall = $fw.id }); start_after_create = $true } -Soft
      if ($r) { $server = $r.server; break }
    }
    if (-not $server) { Fail "No capacity for $Type right now. Try again in a while, or set `$env:SERVER_TYPE (e.g. cpx42)." }
  }
  $Ip = $server.public_net.ipv4.ip

  # 5. Volume. New accounts have a limit on total volume size: fall back to smaller sizes.
  $vol = (Hc GET "/volumes?name=$Name-data").volumes | Select-Object -First 1
  if ($vol) {
    Say "Using your existing volume '$Name-data'"
  } else {
    $made = 0
    foreach ($size in @($VolumeGb, 1000, 500)) {
      if ($size -gt $VolumeGb) { continue }
      $r = Hc POST /volumes @{ name = "$Name-data"; size = $size; server = $server.id; automount = $true; format = 'ext4' } -Soft
      if ($r) { $made = $size; break }
    }
    if (-not $made) { Fail 'Could not create a volume. Raise your volume limit in the Hetzner console (Limits) and run this again.' }
    Say "Attached a $made GB volume"
    if ($made -lt 2000) { Write-Host "  ! Snapchain recommends 2 TB free. $made GB is enough to sync today (see the guide)." }
  }

  Say 'Waiting for the server to boot'
  $ErrorActionPreference = 'Continue' # ssh writes to stderr while the server is still booting
  for ($i = 0; $i -lt 60; $i++) {
    ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -o BatchMode=yes "root@$Ip" true 2>$null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 5
  }

  Write-Host ''
  Write-Host "OK. Server ready: $Ip" -ForegroundColor Green
  Write-Host ''
  Write-Host 'Next, two commands, in this PowerShell window (each takes a few minutes; the node then syncs on its own):'
  Write-Host ''
  Write-Host "  ssh root@$Ip 'curl -fsSL $Raw/install/node.sh | bash'"
  Write-Host "  ssh root@$Ip 'curl -fsSL $Raw/install/client.sh | bash'"
  Write-Host ''
}
