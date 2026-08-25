# Does the player behave like a Windows Media Player window?
#
# Drives the real application the way a person would and checks each step
# against the rectangle Windows reports for mpv's own window, so a pass means
# the video really moved — not that a control was drawn.

param(
  # The development folder by default; pass a packaged MediaLibrary.exe to test a build.
  [string]$AppPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'desktop'),
  # Where the library lives, for a run that must not touch the real one.
  [string]$DataRoot = ''
)

$ErrorActionPreference = 'Stop'
$scratch = $env:TEMP   # where the screenshot of the finished state is written
$log = "$env:TEMP\window-suite.log"

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public struct RECT { public int Left, Top, Right, Bottom; }
public class Win {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  private delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr p);

  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  private static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  private static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);

  // mpv's MainWindowHandle points at a hidden helper window, so the video
  // window is found by its class name instead. A minimised window is parked at
  // -32000, which is neither visible nor worth measuring.
  public static IntPtr VideoWindow(uint wanted) {
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != wanted || !IsWindowVisible(h)) return true;
      var cls = new System.Text.StringBuilder(64);
      GetClassNameW(h, cls, 64);
      if (cls.ToString() != "mpv") return true;
      RECT r; if (!GetWindowRect(h, out r)) return true;
      if (r.Left <= -30000) return true;
      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  /**
   * The frontmost window covering a point, ignoring the app's own overlay.
   *
   * Sampling pixel brightness is not enough to know the video is on screen: any
   * bright window sitting where the video should be passes that test. Asking
   * which window is actually in front at that point cannot be fooled.
   * EnumWindows walks the z-order from front to back, so the first match wins.
   */
  public static string TopAt(int x, int y) {
    string answer = "(nothing)";
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      RECT r; if (!GetWindowRect(h, out r)) return true;
      if (r.Left <= -30000) return true;            // minimised
      if (x < r.Left || x >= r.Right || y < r.Top || y >= r.Bottom) return true;
      var cls = new System.Text.StringBuilder(64);
      GetClassNameW(h, cls, 64);
      string name = cls.ToString();
      // Skip the desktop and the shell's own backdrop windows.
      if (name == "WorkerW" || name == "Progman" || name == "SysShadow") return true;
      var title = new System.Text.StringBuilder(200);
      GetWindowTextW(h, title, 200);
      // A window with no size on screen cannot be covering anything.
      if (r.Right - r.Left < 40 || r.Bottom - r.Top < 40) return true;
      // The app's own controls are transparent, so they are drawn over the
      // picture rather than instead of it. Look past them to the window that
      // actually decides whether the video is visible.
      if (title.ToString() == "Player") return true;
      answer = name + " [" + title + "]";
      return false;
    }, IntPtr.Zero);
    return answer;
  }

  /** Every window the process owns, for when the video window is not found. */
  public static List<string> Describe(uint wanted) {
    var lines = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != wanted) return true;
      var cls = new System.Text.StringBuilder(64);
      GetClassNameW(h, cls, 64);
      RECT r; GetWindowRect(h, out r);
      lines.Add("hwnd=" + h + " vis=" + IsWindowVisible(h) + " class=" + cls
        + " rect=" + r.Left + "," + r.Top + " " + (r.Right - r.Left) + "x" + (r.Bottom - r.Top));
      return true;
    }, IntPtr.Zero);
    return lines;
  }
}
"@

$results = @()
function Check($name, $ok, $detail) {
  $script:results += [pscustomobject]@{ name = $name; ok = $ok }
  $mark = if ($ok) { 'PASS' } else { 'FAIL' }
  Write-Output ("[" + $mark + "] " + $name + "  " + $detail)
}

# The rectangle Windows reports for mpv's video window.
function VideoRect() {
  $mpv = Get-Process mpv -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $mpv) { return $null }
  $h = [Win]::VideoWindow([uint32]$mpv.Id)
  if ($h -eq [IntPtr]::Zero) {
    Write-Output '  (no mpv video window; the process owns:)'
    [Win]::Describe([uint32]$mpv.Id) | ForEach-Object { Write-Output ('    ' + $_) }
    return $null
  }
  $r = New-Object RECT
  if (-not [Win]::GetWindowRect($h, [ref]$r)) { return $null }
  return [pscustomobject]@{
    X = $r.Left; Y = $r.Top
    Width = $r.Right - $r.Left; Height = $r.Bottom - $r.Top
  }
}

function Show($r) {
  if (-not $r) { return '(no window)' }
  return ('' + $r.X + ',' + $r.Y + ' ' + $r.Width + 'x' + $r.Height)
}

# Fraction of sampled pixels inside a rectangle that are not black, which is how
# a picture is told apart from a blank window.
function Lit($r) {
  if (-not $r) { return 0 }
  $b = New-Object System.Drawing.Bitmap $r.Width, $r.Height
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.CopyFromScreen($r.X, $r.Y, 0, 0, $b.Size)
  $lit = 0; $n = 0
  for ($x = [int]($r.Width * 0.15); $x -lt [int]($r.Width * 0.85); $x += 25) {
    for ($y = [int]($r.Height * 0.15); $y -lt [int]($r.Height * 0.6); $y += 25) {
      $p = $b.GetPixel($x, $y); $n++
      if ($p.R + $p.G + $p.B -gt 60) { $lit++ }
    }
  }
  $g.Dispose(); $b.Dispose()
  if ($n -eq 0) { return 0 }
  return [math]::Round(100 * $lit / $n, 1)
}

# Which window is actually in front where the video should be. Anything other
# than "mpv" means the picture is hidden behind something, however bright the
# pixels sampled there happen to be.
function InFront($r) {
  if (-not $r) { return '(no window)' }
  return [Win]::TopAt($r.X + [int]($r.Width / 2), $r.Y + [int]($r.Height / 2))
}

# The transparent controls are looked past, so the window reported here is the
# one that really decides what is on screen. Only mpv means the video is visible.
function ShowingVideo($front) {
  return $front -like 'mpv*'
}

function Wake($r) {
  foreach ($i in 1..8) {
    [Win]::SetCursorPos($r.X + [int]($r.Width / 2), $r.Y + [int]($r.Height / 2) + ($i % 2) * 10) | Out-Null
    Start-Sleep -Milliseconds 110
  }
  Start-Sleep -Milliseconds 600
}

function Drag($fromX, $fromY, $toX, $toY) {
  [Win]::SetCursorPos($fromX, $fromY) | Out-Null
  Start-Sleep -Milliseconds 400
  [Win]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)   # left down
  Start-Sleep -Milliseconds 250
  # Move in steps, the way a hand does, so every pointer event is delivered.
  foreach ($i in 1..24) {
    $x = [int]($fromX + ($toX - $fromX) * $i / 24)
    $y = [int]($fromY + ($toY - $fromY) * $i / 24)
    [Win]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 40
  }
  Start-Sleep -Milliseconds 300
  [Win]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)   # left up
  Start-Sleep -Milliseconds 1200
}

function Key($k) {
  [System.Windows.Forms.SendKeys]::SendWait($k)
  Start-Sleep -Milliseconds 1500
}

function ClickAt($x, $y) {
  [Win]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 400
  [Win]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  [Win]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 1200
}

# Keys go to whichever window Windows considers foreground, so the player has
# to be clicked first. The title bar is the safe place: a click that does not
# travel is deliberately ignored.
function FocusPlayer($r) {
  Wake $r
  ClickAt ($r.X + [int]($r.Width / 2)) ($r.Y + 30)
}

# ---------------------------------------------------------------- start ---
function StopUnderTest() {
  Get-Process electron, mpv -ErrorAction SilentlyContinue | Stop-Process -Force
  if ($AppPath -like '*.exe') {
    Get-Process MediaLibrary -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -eq $AppPath } | Stop-Process -Force
  }
}
StopUnderTest
Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3

[Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $null)
$env:ELECTRON_RUN_AS_NODE = $null
$env:MEDIA_START_VIEW = 'play/3c66eebb44eae4f1'
$env:MEDIA_MUTE = '1'
if ($DataRoot) { $env:MEDIA_DATA_ROOT = $DataRoot }

# A packaged build is its own executable; a development build is a folder
# handed to Electron. Both are driven identically from here.
if ($AppPath -like '*.exe') {
  Start-Process -FilePath $AppPath -RedirectStandardOutput $log -RedirectStandardError "$env:TEMP\window-suite-err.log" | Out-Null
} else {
  $electron = Join-Path (Split-Path -Parent $PSScriptRoot) 'node_modules\electron\dist\electron.exe'
  Start-Process -FilePath $electron -ArgumentList "`"$AppPath`"" -RedirectStandardOutput $log -RedirectStandardError "$env:TEMP\window-suite-err.log" | Out-Null
}
Start-Sleep -Seconds 26

$screens = [System.Windows.Forms.Screen]::AllScreens
Write-Output ("  (" + $screens.Count + " displays)")

# 1. playback started, covering a whole display
$full = VideoRect
Check 'video window opens fullscreen' `
  ($null -ne $full -and ($screens | Where-Object { $_.Bounds.Width -eq $full.Width -and $_.Bounds.Height -eq $full.Height }).Count -gt 0) `
  (Show $full)

# 2. the picture is actually being drawn
$litFull = Lit $full
$frontFull = InFront $full
Check 'picture is drawn fullscreen' (($litFull -gt 1) -and (ShowingVideo $frontFull)) ("$litFull% lit, in front: $frontFull")

# 3. clicking the title bar must not disturb a fullscreen window
FocusPlayer $full
$afterClick = VideoRect
Check 'clicking the control bar leaves the window alone' `
  ($null -ne $afterClick -and $afterClick.Width -eq $full.Width -and $afterClick.X -eq $full.X) `
  (Show $afterClick)

# 4. the transport controls respond to a click
Wake $full
$pausedBefore = (Get-Content $log | Select-String 'pause -> True' | Measure-Object).Count
ClickAt ($full.X + 57) ($full.Y + $full.Height - 50)
Start-Sleep -Seconds 2
$pausedAfter = (Get-Content $log | Select-String 'pause -> True' | Measure-Object).Count
Check 'the pause button pauses' ($pausedAfter -gt $pausedBefore) ('mpv reported pause ' + $pausedBefore + ' -> ' + $pausedAfter + ' times')
ClickAt ($full.X + 57) ($full.Y + $full.Height - 50)   # resume
Start-Sleep -Seconds 1

# 5. the fullscreen button leaves fullscreen
Wake $full
ClickAt ($full.X + $full.Width - 102) ($full.Y + 40)
Start-Sleep -Seconds 2
$byButton = VideoRect
Check 'the fullscreen button leaves fullscreen' (($null -ne $byButton) -and ($byButton.Width -lt $full.Width) -and ($byButton.Width -gt 300)) ('windowed: ' + (Show $byButton))

# ...and f puts it back, so key and button agree
Wake $byButton
Key 'f'
Start-Sleep -Seconds 2
$backFull = VideoRect
Check 'f returns to fullscreen from the button state' (($null -ne $backFull) -and ($backFull.Width -eq $full.Width)) (Show $backFull)

# 6. f leaves fullscreen and gives a smaller, movable window
Wake $backFull
Key 'f'
Start-Sleep -Seconds 2
$win = VideoRect
Check 'f leaves fullscreen' `
  ($null -ne $win -and $win.Width -lt $full.Width -and $win.Width -gt 300) `
  ("windowed: " + (Show $win))

# 4. the picture survives being resized
$litWin = Lit $win
$frontWin = InFront $win
Check 'picture survives resizing' (($litWin -gt 1) -and (ShowingVideo $frontWin)) ("$litWin% lit, in front: $frontWin")

# 7. the corner grip resizes the window, keeping the video shape
Wake $win
$beforeResize = VideoRect
$aspectBefore = $beforeResize.Width / $beforeResize.Height
$gx = $beforeResize.X + $beforeResize.Width - 12
$gy = $beforeResize.Y + $beforeResize.Height - 12
Drag $gx $gy ($gx + 200) ($gy + 120)
$afterResize = VideoRect
$grew = ($null -ne $afterResize) -and ($afterResize.Width -gt $beforeResize.Width + 100)
$aspectAfter = if ($afterResize) { $afterResize.Width / $afterResize.Height } else { 0 }
$keptShape = [math]::Abs($aspectAfter - $aspectBefore) -lt 0.05
Check 'the corner grip resizes the window' ($grew -and $keptShape) ((Show $beforeResize) + ' -> ' + (Show $afterResize) + ' aspect ' + [math]::Round($aspectBefore,2) + ' -> ' + [math]::Round($aspectAfter,2))

# 8. dragging the control bar moves the video window
Wake $win
$before = VideoRect
$grabX = $before.X + [int]($before.Width / 2)
$grabY = $before.Y + 30
Drag $grabX $grabY ($grabX + 260) ($grabY + 170)
$after = VideoRect
$moved = ($null -ne $after) -and ([math]::Abs($after.X - $before.X) -gt 150)
Check 'dragging moves the video' $moved ("before " + (Show $before) + " -> after " + (Show $after))

# 9. and the picture is still there afterwards
$litMoved = Lit $after
$frontMoved = InFront $after
Check 'picture survives dragging' (($litMoved -gt 1) -and (ShowingVideo $frontMoved)) ("$litMoved% lit, in front: $frontMoved")

# 10. dragged onto a second display, the video goes with it
if ($screens.Count -gt 1) {
  $other = $screens | Where-Object { $_.Bounds.X -ne [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.X } | Select-Object -First 1
  $target = $other.Bounds
  $now = VideoRect
  $gx = $now.X + [int]($now.Width / 2)
  $gy = $now.Y + 30
  Drag $gx $gy ($target.X + [int]($target.Width / 2)) ($target.Y + 200)
  $landed = VideoRect
  $onOther = ($null -ne $landed) -and ($landed.X + $landed.Width / 2 -ge $target.X) -and
             ($landed.X + $landed.Width / 2 -lt $target.X + $target.Width)
  Check 'video can be dragged to another screen' $onOther `
    ("target display x=" + $target.X + " -> " + (Show $landed))
  $litOther = Lit $landed
  $frontOther = InFront $landed
  Check 'picture survives the move to another screen' (($litOther -gt 1) -and (ShowingVideo $frontOther)) ("$litOther% lit, in front: $frontOther")
} else {
  Write-Output '  (only one display; skipping the cross-screen drag)'
}

# 11. f returns to fullscreen, on whichever display it now sits
$here = VideoRect
Wake $here
Key 'f'
Start-Sleep -Seconds 2
$again = VideoRect
Check 'f returns to fullscreen' `
  ($null -ne $again -and ($screens | Where-Object { $_.Bounds.Width -eq $again.Width -and $_.Bounds.Height -eq $again.Height }).Count -gt 0) `
  (Show $again)

$frontAgain = InFront $again
Check 'the video stays in front after returning to fullscreen' (ShowingVideo $frontAgain) ("in front: $frontAgain")

# A screenshot of the finished state, for the controls to be looked at.
$shot = New-Object System.Drawing.Bitmap $again.Width, $again.Height
$sg = [System.Drawing.Graphics]::FromImage($shot)
Wake $again
$sg.CopyFromScreen($again.X, $again.Y, 0, 0, $shot.Size)
$shot.Save("$scratch\suite-final.png", [System.Drawing.Imaging.ImageFormat]::Png)
$sg.Dispose(); $shot.Dispose()

# 12. closing returns to the library
Wake $again
Key '{ESC}'
Start-Sleep -Seconds 2
Key '{ESC}'
Start-Sleep -Seconds 3
$stillRunning = Get-Process mpv -ErrorAction SilentlyContinue
Check 'escape closes the player' (-not $stillRunning) `
  ($(if ($stillRunning) { 'mpv still running' } else { 'mpv exited' }))

Write-Output ''
Write-Output ('passed ' + ($results | Where-Object { $_.ok }).Count + ' of ' + $results.Count)
StopUnderTest
