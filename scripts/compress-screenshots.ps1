# Converts screenshots to JPEG and reduces their width before upload.
# Usage (from the project folder):
#   powershell -ExecutionPolicy Bypass -File scripts/compress-screenshots.ps1 -InputDir results/integrity-reforestation/2026-10/screenshots/craft -OutputDir scratch/compressed
# Optional: -MaxWidth 1000 -Quality 70
param(
  [Parameter(Mandatory = $true)] [string]$InputDir,
  [Parameter(Mandatory = $true)] [string]$OutputDir,
  [int]$MaxWidth = 1000,
  [int]$Quality = 70
)

Add-Type -AssemblyName System.Drawing

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$encoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)

$files = Get-ChildItem -Path $InputDir -Recurse -Filter *.png
foreach ($file in $files) {
  $src = [System.Drawing.Image]::FromFile($file.FullName)
  try {
    $scale = [Math]::Min(1.0, $MaxWidth / $src.Width)
    $w = [int][Math]::Round($src.Width * $scale)
    $h = [int][Math]::Round($src.Height * $scale)
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::White)
    $g.DrawImage($src, 0, 0, $w, $h)
    $name = [System.IO.Path]::GetFileNameWithoutExtension($file.Name) + '.jpg'
    $out = Join-Path $OutputDir $name
    $bmp.Save($out, $encoder, $encoderParams)
    $g.Dispose(); $bmp.Dispose()
    $before = [Math]::Round($file.Length / 1KB)
    $after = [Math]::Round((Get-Item $out).Length / 1KB)
    Write-Output ("{0}: {1} KB -> {2} KB ({3}x{4})" -f $file.Name, $before, $after, $w, $h)
  } finally {
    $src.Dispose()
  }
}
