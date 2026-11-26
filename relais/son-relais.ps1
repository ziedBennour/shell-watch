# shell-watch : plays on this PC the sound when Claude is done that a session on a
# remote machine (SSH, a VPS) asks for. The SSH tunnel brings its request here:
#   Host vps
#       RemoteForward 127.0.0.1:47823 127.0.0.1:47823
# The sound is the one /son chose on this PC (the mod's store), else Windows' own.
# It listens on this PC's loopback alone; one copy runs, a second start leaves at once.
param([int]$Port = 47823)

$mutex = New-Object System.Threading.Mutex($false, 'Local\shell-watch-son-relais')
if (-not $mutex.WaitOne(0)) { exit }
Add-Type -AssemblyName PresentationCore

$store = Join-Path $HOME '.claude\plugins\store'
$default = Join-Path $env:WINDIR 'Media\Windows Notify System Generic.wav'
$player = $null

function Get-Sound {
  $f = Get-ChildItem -LiteralPath $store -Filter 'shell-watch_*.json' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($f) {
    try {
      $p = (Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json).'sound-file-1'.path
      if ($p -and (Test-Path -LiteralPath $p -PathType Leaf)) { return $p }
    } catch {}
  }
  $default
}

function Invoke-Sound {
  $path = Get-Sound
  if ($path -match '\.wav$') { (New-Object Media.SoundPlayer $path).Play(); return }
  # Kept in a script variable: a player let go stops playing.
  $script:player = New-Object System.Windows.Media.MediaPlayer
  $script:player.Open([uri]$path)
  $script:player.Play()
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
$answer = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 204 No Content`r`nConnection: close`r`n`r`n")
while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream()
    $stream.ReadTimeout = 2000
    $buf = New-Object byte[] 4096
    try { [void]$stream.Read($buf, 0, $buf.Length) } catch {}
    $stream.Write($answer, 0, $answer.Length)
    $stream.Flush()
  } catch {} finally { $client.Close() }
  try { Invoke-Sound } catch {}
}
