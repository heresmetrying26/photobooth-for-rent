# Sends a ready-made print job file (.prn) to a Windows printer as RAW data, with no driver processing.
# Usage:  powershell -File send-raw.ps1 -Printer "EPSON L3210 Series" -File job.prn
# The printer must be switched on and have 4x6 in photo paper loaded (glossy for the jobs made with the glossy templates).
param(
  [Parameter(Mandatory = $true)][string]$Printer,
  [Parameter(Mandatory = $true)][string]$File
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $File)) { throw "File not found: $File" }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RawPrint {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool OpenPrinter(string name, out IntPtr h, IntPtr pd);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] public static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool WritePrinter(IntPtr h, byte[] buf, int len, out int written);
  public static void Send(string printer, string docName, byte[] data) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) throw new Exception("OpenPrinter failed: " + Marshal.GetLastWin32Error());
    try {
      var di = new DOCINFO { pDocName = docName, pOutputFile = null, pDataType = "RAW" };
      if (StartDocPrinter(h, 1, di) == 0) throw new Exception("StartDocPrinter failed: " + Marshal.GetLastWin32Error());
      try {
        StartPagePrinter(h);
        int off = 0;
        while (off < data.Length) {
          int n = Math.Min(65536, data.Length - off); byte[] chunk = new byte[n]; Array.Copy(data, off, chunk, 0, n);
          int w; if (!WritePrinter(h, chunk, n, out w) || w != n) throw new Exception("WritePrinter failed: " + Marshal.GetLastWin32Error());
          off += n;
        }
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
'@
$bytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $File))
[RawPrint]::Send($Printer, 'pb4u-raster-job', $bytes)
"Sent $($bytes.Length) bytes to '$Printer'."
