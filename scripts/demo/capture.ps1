# Captures the VS Code WINDOW (not the desktop) at 5 fps while the script
# runs, and notes in an index which frame belongs to which shot.
#
# The frames come from PrintWindow on the window itself, not from the screen:
# copying the screen rectangle lets in whatever sits on top of the window, and
# the moment VS Code closes it photographs what was behind it (other windows,
# private ones included). The capture also stops as soon as the window is gone.
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
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
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

# PrintWindow renders the whole window, frame included; the client area is cut
# out of it so neither the border nor the shadow get in.
$frame = New-Object Ventana+RECT
[void][Ventana]::GetWindowRect($h, [ref]$frame)
$rect = New-Object Ventana+RECT
[void][Ventana]::GetClientRect($h, [ref]$rect)
$origen = New-Object Ventana+POINT
[void][Ventana]::ClientToScreen($h, [ref]$origen)
$w = $rect.Right - $rect.Left
$t = $rect.Bottom - $rect.Top
$client = New-Object System.Drawing.Rectangle(($origen.X - $frame.Left), ($origen.Y - $frame.Top), $w, $t)
Write-Host "window $w x $t at ($($origen.X),$($origen.Y))"

$PW_RENDERFULLCONTENT = 2  # without it, a GPU-composited window (Electron) prints black
$bmp = New-Object System.Drawing.Bitmap(($frame.Right - $frame.Left), ($frame.Bottom - $frame.Top))
$g = [System.Drawing.Graphics]::FromImage($bmp)
$indice = @()
$n = 0
$skipped = 0
$fin = Join-Path $Salida 'fin.txt'
$marca = Join-Path $Salida 'plano.txt'
$hasta = (Get-Date).AddSeconds($SegundosMax)

while (-not (Test-Path $fin) -and (Get-Date) -lt $hasta -and [Ventana]::IsWindow($h)) {
    $hdc = $g.GetHdc()
    $ok = [Ventana]::PrintWindow($h, $hdc, $PW_RENDERFULLCONTENT)
    $g.ReleaseHdc($hdc)
    if ($ok -and [Ventana]::IsWindow($h)) {
        $cut = $bmp.Clone($client, $bmp.PixelFormat)
        $cut.Save((Join-Path $Salida ('f{0:d5}.png' -f $n)), [System.Drawing.Imaging.ImageFormat]::Png)
        $cut.Dispose()
        if (Test-Path $marca) {
            $plano = (Get-Content $marca -Raw).Trim()
            if ($plano) { $indice += "$n,$plano" }
        }
        $n++
    } else {
        $skipped++
    }
    Start-Sleep -Milliseconds 200
}

$g.Dispose()
$bmp.Dispose()
$indice | Out-File -FilePath (Join-Path $Salida 'indice.csv') -Encoding utf8
Write-Host "$n frames ($skipped skipped: the window did not print)"
