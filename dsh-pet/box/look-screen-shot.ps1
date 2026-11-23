# look-screen-shot.ps1 - capture virtual screen, downscale to max edge 1600, save JPEG q82
# 1600 (was 1280): chat text on 1080p screens was ~10px after downscale - vision misread numbers
# (user's "3 yolks" became "5 yolks"); bigger capture = legible digits, modest token cost bump
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$w = $b.Width; $h = $b.Height
$scale = [Math]::Min(1.0, 1600 / [Math]::Max($w, $h))
$nw = [int]($w * $scale); $nh = [int]($h * $scale)
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$out = New-Object System.Drawing.Bitmap($nw, $nh)
$g2 = [System.Drawing.Graphics]::FromImage($out)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($bmp, 0, 0, $nw, $nh)
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]82)
$out.Save("$env:TEMP\lookscreen.jpg", $codec, $ep)
$g.Dispose(); $g2.Dispose(); $bmp.Dispose(); $out.Dispose()
Write-Output "ok"
