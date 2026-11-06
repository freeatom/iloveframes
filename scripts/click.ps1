param([int]$x, [int]$y)
Add-Type @"
using System; using System.Runtime.InteropServices;
public class M { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(int f, int dx, int dy, int d, int e); }
"@
[M]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 300
[M]::mouse_event(2, 0, 0, 0, 0); Start-Sleep -Milliseconds 60; [M]::mouse_event(4, 0, 0, 0, 0)
