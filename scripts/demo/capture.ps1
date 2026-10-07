# Captures the VS Code WINDOW (not the desktop) at 5 fps while the script
# runs, and notes in an index which frame belongs to which shot.
#
# Recording the whole desktop would let in whatever the user has open behind;
# here the window is found by its title, given a fixed size, and only its
# rectangle is copied.
param(
    [Parameter(Mandatory = $true)][string]$Salida,
    [int]$Ancho = 1440,
    [int]$Alto = 900,
    [int]$SegundosMax = 120
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Ventana {
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int t, bool repaint);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@

New-Item -ItemType Directory -Force -Path $Salida | Out-Null

# The window takes a while to exist: wait for it instead of failing.
$limite = (Get-Date).AddSeconds(60)
$ventana = $null
while ((Get-Date) -lt $limite -and $null -eq $ventana) {
    $ventana = Get-Process |
        Where-Object { $_.MainWindowTitle -match 'Extension Development Host' } |
        Select-Object -First 1
    if ($null -eq $ventana) { Start-Sleep -Milliseconds 500 }
}
if ($null -eq $ventana) { Write-Error 'the VS Code window never appeared'; exit 1 }

$h = $ventana.MainWindowHandle
[void][Ventana]::MoveWindow($h, 60, 40, $Ancho, $Alto, $true)
Start-Sleep -Milliseconds 800
[void][Ventana]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 500

# The client area is copied: that way neither the border nor the shadow get in.
$rect = New-Object Ventana+RECT
[void][Ventana]::GetClientRect($h, [ref]$rect)
$origen = New-Object Ventana+POINT
[void][Ventana]::ClientToScreen($h, [ref]$origen)
$w = $rect.Right - $rect.Left
$t = $rect.Bottom - $rect.Top
Write-Host "window $w x $t at ($($origen.X),$($origen.Y))"

$bmp = New-Object System.Drawing.Bitmap($w, $t)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$indice = @()
$n = 0
$fin = Join-Path $Salida 'fin.txt'
$marca = Join-Path $Salida 'plano.txt'
$hasta = (Get-Date).AddSeconds($SegundosMax)

while (-not (Test-Path $fin) -and (Get-Date) -lt $hasta) {
    $g.CopyFromScreen($origen.X, $origen.Y, 0, 0, $bmp.Size)
    $bmp.Save((Join-Path $Salida ('f{0:d5}.png' -f $n)), [System.Drawing.Imaging.ImageFormat]::Png)
    if (Test-Path $marca) {
        $plano = (Get-Content $marca -Raw).Trim()
        if ($plano) { $indice += "$n,$plano" }
    }
    $n++
    Start-Sleep -Milliseconds 200
}

$g.Dispose()
$bmp.Dispose()
$indice | Out-File -FilePath (Join-Path $Salida 'indice.csv') -Encoding utf8
Write-Host "$n frames"
