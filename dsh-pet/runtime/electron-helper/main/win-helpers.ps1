# win-helpers.ps1 - window helpers: fg / track / list / push (perch & push features)
# Usage:
#   win-helpers.ps1 fg                 -> one JSON line of foreground window, exit
#   win-helpers.ps1 track <hwnd>       -> stream rect JSON every 200ms; prints {"dead":true} and exits when closed/minimized/maximized
#   win-helpers.ps1 list               -> list pushable windows (visible/non-max/non-min/titled/not self), JSON lines, exit
#   win-helpers.ps1 push <hwnd> <dx>   -> move window horizontally by dx px (8 steps), prints pushed, exit
param(
  [Parameter(Position = 0)][string]$Mode = 'fg',
  [Parameter(Position = 1)][Int64]$Hwnd = 0,
  [Parameter(Position = 2)][int]$Dx = 80
)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class WH {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int h2, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  public static string Sanitize(string s) {
    if (s == null) return "";
    var sb = new StringBuilder(s.Length);
    foreach (char c in s) {
      if (c == '"' || c == '\\' || c == '\n' || c == '\r' || c == '\t') sb.Append(' ');
      else sb.Append(c);
    }
    return sb.ToString();
  }

  public static string RectJsonOf(IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    StringBuilder sb = new StringBuilder(256);
    GetWindowText(h, sb, 256);
    uint p; GetWindowThreadProcessId(h, out p);
    bool ok = IsWindowVisible(h) && !IsIconic(h) && !IsZoomed(h);
    return "{\"hwnd\":" + h.ToInt64() + ",\"x\":" + r.L + ",\"y\":" + r.T +
           ",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T) +
           ",\"pid\":" + p + ",\"zoomed\":" + (IsZoomed(h) ? "true" : "false") +
           ",\"iconic\":" + (IsIconic(h) ? "true" : "false") +
           ",\"usable\":" + (ok ? "true" : "false") +
           ",\"title\":\"" + Sanitize(sb.ToString()) + "\"}";
  }

  public static List<string> ListPushable(int selfPid) {
    List<string> result = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || IsIconic(h) || IsZoomed(h)) return true;
      RECT r; GetWindowRect(h, out r);
      int w = r.R - r.L, ht = r.B - r.T;
      if (w < 240 || ht < 160 || GetWindowTextLength(h) <= 0) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == (uint)selfPid) return true;
      result.Add(RectJsonOf(h));
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
"@

switch ($Mode) {
  'fg' {
    $h = [WH]::GetForegroundWindow()
    if ($h -ne [IntPtr]::Zero) { [WH]::RectJsonOf($h) } else { '{"dead":true}' }
  }
  'list' {
    $self = [System.Diagnostics.Process]::GetCurrentProcess().Id
    [WH]::ListPushable($self) | ForEach-Object { $_ }
  }
  'track' {
    $h = [IntPtr]$Hwnd
    while ($true) {
      if (-not [WH]::IsWindow($h) -or [WH]::IsIconic($h) -or [WH]::IsZoomed($h)) { '{"dead":true}'; break }
      [WH]::RectJsonOf($h)
      [Console]::Out.Flush()
      Start-Sleep -Milliseconds 200
    }
  }
  'push' {
    $h = [IntPtr]$Hwnd
    $r = New-Object WH+RECT
    [WH]::GetWindowRect($h, [ref]$r) | Out-Null
    $steps = 8
    for ($i = 1; $i -le $steps; $i++) {
      $nx = $r.L + [Math]::Round([double]$Dx * $i / $steps)
      [WH]::SetWindowPos($h, [IntPtr]::Zero, $nx, $r.T, ($r.R - $r.L), ($r.B - $r.T), 0x0004) | Out-Null
      Start-Sleep -Milliseconds 70
    }
    '{"pushed":true}'
  }
}
