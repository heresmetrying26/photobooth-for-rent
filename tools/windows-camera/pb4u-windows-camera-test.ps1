# photobooth4u - Windows USB camera test (stage 1)
# Talks to the camera through Windows' OWN camera driver (WPD / MTP), so no
# Zadig / driver switch is needed. If you already switched the camera to
# WinUSB with Zadig, switch it back first (Device Manager -> Uninstall device,
# tick "Delete the driver", replug).
#
# What it does (Nikon first; Canon comes in stage 2):
#   1. lists the cameras Windows sees
#   2. reads the camera's model, supported commands and battery
#   3. Nikon: grabs live view frames (saves liveview.jpg, measures speed)
#   4. Nikon: fires the real shutter and downloads the photo (capture.jpg)
# Photos are saved in a "pb4u-camera-test" folder on the Desktop.

$ErrorActionPreference = 'Stop'
$out = Join-Path ([Environment]::GetFolderPath('Desktop')) 'pb4u-camera-test'
New-Item -ItemType Directory -Force -Path $out | Out-Null

$cs = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Pb4u
{
    [StructLayout(LayoutKind.Sequential)]
    public struct PropertyKey
    {
        public Guid fmtid;
        public uint pid;
        public PropertyKey(Guid g, uint p) { fmtid = g; pid = p; }
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    public struct PropVariant
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public uint uintVal;
    }

    [ComImport, Guid("a1567595-4c2f-4574-a6fa-ecef917b9a40"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPortableDeviceManager
    {
        [PreserveSig] int GetDevices([In, Out, MarshalAs(UnmanagedType.LPArray)] IntPtr[] ids, ref uint count);
        [PreserveSig] int RefreshDeviceList();
        [PreserveSig] int GetDeviceFriendlyName([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr name, ref uint cch);
        [PreserveSig] int GetDeviceDescription([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr desc, ref uint cch);
        [PreserveSig] int GetDeviceManufacturer([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr maker, ref uint cch);
    }

    [ComImport, Guid("625e2df8-6392-4cf0-9ad1-3cfa5f17775c"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPortableDevice
    {
        [PreserveSig] int Open([MarshalAs(UnmanagedType.LPWStr)] string id, IPortableDeviceValues clientInfo);
        [PreserveSig] int SendCommand(uint flags, IPortableDeviceValues parameters, out IPortableDeviceValues results);
        [PreserveSig] int Content(out IntPtr content);
        [PreserveSig] int Capabilities(out IntPtr caps);
        [PreserveSig] int Cancel();
        [PreserveSig] int Close();
    }

    // Full vtable order from PortableDeviceApi.h (unused slots kept as placeholders).
    [ComImport, Guid("6848f6f2-3155-4f86-b6f5-263eeeab3143"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPortableDeviceValues
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, IntPtr key, IntPtr value);
        [PreserveSig] int SetValue(IntPtr key, IntPtr value);
        [PreserveSig] int GetValue(IntPtr key, IntPtr value);
        [PreserveSig] int SetStringValue(ref PropertyKey key, [MarshalAs(UnmanagedType.LPWStr)] string value);
        [PreserveSig] int GetStringValue(ref PropertyKey key, [MarshalAs(UnmanagedType.LPWStr)] out string value);
        [PreserveSig] int SetUnsignedIntegerValue(ref PropertyKey key, uint value);
        [PreserveSig] int GetUnsignedIntegerValue(ref PropertyKey key, out uint value);
        [PreserveSig] int SetSignedIntegerValue(ref PropertyKey key, int value);
        [PreserveSig] int GetSignedIntegerValue(ref PropertyKey key, out int value);
        [PreserveSig] int SetUnsignedLargeIntegerValue(ref PropertyKey key, ulong value);
        [PreserveSig] int GetUnsignedLargeIntegerValue(ref PropertyKey key, out ulong value);
        [PreserveSig] int SetSignedLargeIntegerValue(ref PropertyKey key, long value);
        [PreserveSig] int GetSignedLargeIntegerValue(ref PropertyKey key, out long value);
        [PreserveSig] int SetFloatValue(ref PropertyKey key, float value);
        [PreserveSig] int GetFloatValue(ref PropertyKey key, out float value);
        [PreserveSig] int SetErrorValue(ref PropertyKey key, int value);
        [PreserveSig] int GetErrorValue(ref PropertyKey key, out int value);
        [PreserveSig] int SetKeyValue(ref PropertyKey key, ref PropertyKey value);
        [PreserveSig] int GetKeyValue(ref PropertyKey key, out PropertyKey value);
        [PreserveSig] int SetBoolValue(ref PropertyKey key, int value);
        [PreserveSig] int GetBoolValue(ref PropertyKey key, out int value);
        [PreserveSig] int SetIUnknownValue(ref PropertyKey key, IntPtr value);
        [PreserveSig] int GetIUnknownValue(ref PropertyKey key, out IntPtr value);
        [PreserveSig] int SetGuidValue(ref PropertyKey key, ref Guid value);
        [PreserveSig] int GetGuidValue(ref PropertyKey key, out Guid value);
        [PreserveSig] int SetBufferValue(ref PropertyKey key, [MarshalAs(UnmanagedType.LPArray)] byte[] value, uint cb);
        [PreserveSig] int GetBufferValue(ref PropertyKey key, out IntPtr value, out uint cb);
        [PreserveSig] int SetIPortableDeviceValuesValue(ref PropertyKey key, IntPtr value);
        [PreserveSig] int GetIPortableDeviceValuesValue(ref PropertyKey key, out IntPtr value);
        [PreserveSig] int SetIPortableDevicePropVariantCollectionValue(ref PropertyKey key, IPortableDevicePropVariantCollection value);
        [PreserveSig] int GetIPortableDevicePropVariantCollectionValue(ref PropertyKey key, out IPortableDevicePropVariantCollection value);
        [PreserveSig] int SetIPortableDeviceKeyCollectionValue(ref PropertyKey key, IntPtr value);
        [PreserveSig] int GetIPortableDeviceKeyCollectionValue(ref PropertyKey key, out IntPtr value);
        [PreserveSig] int SetIPortableDeviceValuesCollectionValue(ref PropertyKey key, IntPtr value);
        [PreserveSig] int GetIPortableDeviceValuesCollectionValue(ref PropertyKey key, out IntPtr value);
        [PreserveSig] int RemoveValue(ref PropertyKey key);
        [PreserveSig] int CopyValuesFromPropertyStore(IntPtr store);
        [PreserveSig] int CopyValuesToPropertyStore(IntPtr store);
        [PreserveSig] int Clear();
    }

    [ComImport, Guid("89b2e422-4f1b-4316-bcef-a44afea83eb3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPortableDevicePropVariantCollection
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, ref PropVariant value);
        [PreserveSig] int Add(ref PropVariant value);
        [PreserveSig] int GetVarType(out ushort vt);
        [PreserveSig] int ChangeType(ushort vt);
        [PreserveSig] int Clear();
        [PreserveSig] int RemoveAt(uint index);
    }

    public class Ptp
    {
        public const uint OK = 0x2001, BUSY = 0x2019;
        static readonly Guid CMD = new Guid("F0422A9C-5DC8-4440-B5BD-5DF28835658A");
        static readonly Guid MTPX = new Guid("4d545058-1a2e-4106-a357-771e0819fc56");
        static readonly Guid CLIENT = new Guid("204D9F0C-2292-4080-9F42-40664E70F859");
        PropertyKey kCat = new PropertyKey(CMD, 1001), kId = new PropertyKey(CMD, 1002), kHr = new PropertyKey(CMD, 1003);
        PropertyKey kOp = new PropertyKey(MTPX, 1001), kParams = new PropertyKey(MTPX, 1002), kResp = new PropertyKey(MTPX, 1003);
        PropertyKey kCtx = new PropertyKey(MTPX, 1006), kTotal = new PropertyKey(MTPX, 1007), kToRead = new PropertyKey(MTPX, 1008);
        PropertyKey kRead = new PropertyKey(MTPX, 1009), kData = new PropertyKey(MTPX, 1012);
        IPortableDevice dev;

        static T Create<T>(string clsid) { return (T)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid(clsid))); }
        static void Check(int hr, string what) { if (hr != 0) throw new Exception(what + " failed (0x" + hr.ToString("X8") + ")"); }
        IPortableDeviceValues NewValues() { return Create<IPortableDeviceValues>("0c15d503-d017-47ce-9016-7b3f978721cc"); }

        public static List<KeyValuePair<string, string>> ListDevices()
        {
            var list = new List<KeyValuePair<string, string>>();
            var mgr = Create<IPortableDeviceManager>("0af10cec-2ecd-4b92-9581-34f6ae0637f3");
            mgr.RefreshDeviceList();
            uint n = 0;
            Check(mgr.GetDevices(null, ref n), "List devices");
            if (n == 0) return list;
            var ids = new IntPtr[n];
            Check(mgr.GetDevices(ids, ref n), "List devices");
            for (int i = 0; i < n; i++)
            {
                string id = Marshal.PtrToStringUni(ids[i]);
                Marshal.FreeCoTaskMem(ids[i]);
                list.Add(new KeyValuePair<string, string>(id, Name(mgr, id, 0) + " / " + Name(mgr, id, 1)));
            }
            return list;
        }
        static string Name(IPortableDeviceManager mgr, string id, int which)
        {
            uint cch = 0;
            if (which == 0) mgr.GetDeviceFriendlyName(id, IntPtr.Zero, ref cch); else mgr.GetDeviceManufacturer(id, IntPtr.Zero, ref cch);
            if (cch == 0) return "";
            IntPtr buf = Marshal.AllocHGlobal((int)cch * 2 + 2);
            try
            {
                int hr = which == 0 ? mgr.GetDeviceFriendlyName(id, buf, ref cch) : mgr.GetDeviceManufacturer(id, buf, ref cch);
                return hr == 0 ? Marshal.PtrToStringUni(buf) : "";
            }
            finally { Marshal.FreeHGlobal(buf); }
        }

        public void Open(string id)
        {
            dev = Create<IPortableDevice>("f7c0039a-4762-488a-b4b3-760ef9a1ba9b");
            var info = NewValues();
            var kName = new PropertyKey(CLIENT, 2);
            var kMajor = new PropertyKey(CLIENT, 3);
            var kMinor = new PropertyKey(CLIENT, 4);
            var kRev = new PropertyKey(CLIENT, 5);
            info.SetStringValue(ref kName, "photobooth4u");
            info.SetUnsignedIntegerValue(ref kMajor, 1);
            info.SetUnsignedIntegerValue(ref kMinor, 0);
            info.SetUnsignedIntegerValue(ref kRev, 0);
            Check(dev.Open(id, info), "Open camera");
        }
        public void Close() { if (dev != null) dev.Close(); }

        IPortableDeviceValues Send(uint cmdPid, IPortableDeviceValues v)
        {
            Guid cat = MTPX;
            Check(v.SetGuidValue(ref kCat, ref cat), "Set category");
            Check(v.SetUnsignedIntegerValue(ref kId, cmdPid), "Set command");
            IPortableDeviceValues res;
            Check(dev.SendCommand(0, v, out res), "Send command");
            int hr;
            if (res.GetErrorValue(ref kHr, out hr) == 0 && hr != 0) throw new Exception("Camera command error 0x" + hr.ToString("X8"));
            return res;
        }
        void SetOp(IPortableDeviceValues v, ushort code, uint[] ps)
        {
            Check(v.SetUnsignedIntegerValue(ref kOp, code), "Set op");
            var c = Create<IPortableDevicePropVariantCollection>("08a99e2f-6d6d-4b80-af5a-baf2bcbe4cb9");
            foreach (uint p in ps) { var pv = new PropVariant(); pv.vt = 19; pv.uintVal = p; Check(c.Add(ref pv), "Add param"); }
            Check(v.SetIPortableDevicePropVariantCollectionValue(ref kParams, c), "Set params");
        }
        public uint Op(ushort code, params uint[] ps)
        {
            var v = NewValues();
            SetOp(v, code, ps);
            var r = Send(12, v);
            uint resp; r.GetUnsignedIntegerValue(ref kResp, out resp);
            return resp;
        }
        public uint OpRead(ushort code, out byte[] data, params uint[] ps)
        {
            var v = NewValues();
            SetOp(v, code, ps);
            var r = Send(13, v);
            string ctx; Check(r.GetStringValue(ref kCtx, out ctx), "Transfer context");
            ulong total = 0; r.GetUnsignedLargeIntegerValue(ref kTotal, out total);
            var ms = new MemoryStream();
            ulong got = 0;
            while (got < total)
            {
                uint chunk = (uint)Math.Min(262144UL, total - got);
                var rv = NewValues();
                rv.SetStringValue(ref kCtx, ctx);
                rv.SetUnsignedIntegerValue(ref kToRead, chunk);
                rv.SetBufferValue(ref kData, new byte[chunk], chunk);
                var rr = Send(15, rv);
                IntPtr p; uint cb;
                Check(rr.GetBufferValue(ref kData, out p, out cb), "Read data");
                uint n = 0; rr.GetUnsignedIntegerValue(ref kRead, out n);
                if (n == 0 || n > cb) n = cb;
                var b = new byte[n];
                if (n > 0) Marshal.Copy(p, b, 0, (int)n);
                Marshal.FreeCoTaskMem(p);
                ms.Write(b, 0, (int)n);
                got += n;
                if (n == 0) break;
            }
            var ev = NewValues();
            ev.SetStringValue(ref kCtx, ctx);
            var er = Send(17, ev);
            uint resp; er.GetUnsignedIntegerValue(ref kResp, out resp);
            data = ms.ToArray();
            return resp;
        }
    }

    public class Reader
    {
        byte[] b; int i;
        public Reader(byte[] data) { b = data; i = 0; }
        public ushort U16() { ushort v = (ushort)(b[i] | (b[i + 1] << 8)); i += 2; return v; }
        public uint U32() { uint v = (uint)(b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)); i += 4; return v; }
        public string Str()
        {
            int n = b[i++];
            if (n == 0) return "";
            string s = Encoding.Unicode.GetString(b, i, (n - 1) * 2);
            i += n * 2;
            return s;
        }
        public List<ushort> U16Array() { uint n = U32(); var l = new List<ushort>(); for (uint k = 0; k < n; k++) l.Add(U16()); return l; }
    }

    public static class Test
    {
        static Ptp ptp;
        static string H(uint v) { return "0x" + v.ToString("X4"); }
        static void Log(string s) { Console.WriteLine(s); }

        static bool WaitReady(int ms)
        {
            var sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < ms)
            {
                uint r = ptp.Op(0x90C8);   // Nikon DeviceReady
                if (r == Ptp.OK) return true;
                if (r != Ptp.BUSY) { Log("   DeviceReady answered " + H(r)); return false; }
                Thread.Sleep(100);
            }
            return false;
        }
        static int Jpeg(byte[] d) { for (int k = 0; k + 1 < d.Length; k++) if (d[k] == 0xFF && d[k + 1] == 0xD8) return k; return -1; }

        public static void Run(string outDir)
        {
            Log("photobooth4u Windows camera test (stage 1) - " + DateTime.Now);
            Log("Windows " + Environment.OSVersion.Version + ", 64-bit process: " + Environment.Is64BitProcess);
            var devs = Ptp.ListDevices();
            Log("Devices Windows sees: " + devs.Count);
            string pick = null;
            foreach (var d in devs)
            {
                Log(" - " + d.Value);
                string n = d.Value.ToLowerInvariant();
                if (pick == null && (n.Contains("nikon") || n.Contains("canon") || n.Contains("sony") || n.Contains("fuji") || n.Contains("d5") || n.Contains("eos"))) pick = d.Key;
            }
            if (pick == null)
            {
                Log("No camera found. Check: camera on, USB mode PTP/MTP, cable connected, and NOT switched to WinUSB with Zadig.");
                return;
            }
            ptp = new Ptp();
            ptp.Open(pick);
            Log("Opened camera.");
            try
            {
                byte[] di;
                uint r = ptp.OpRead(0x1001, out di);
                Log("GetDeviceInfo: " + H(r) + ", " + di.Length + " bytes");
                var rd = new Reader(di);
                rd.U16(); uint vendor = rd.U32(); rd.U16(); rd.Str(); rd.U16();
                var ops = rd.U16Array(); rd.U16Array(); var props = rd.U16Array(); rd.U16Array(); rd.U16Array();
                string maker = rd.Str(), model = rd.Str();
                Log("Camera: " + maker + " " + model + " (vendor ext " + vendor + ")");
                Func<ushort, string> has = c => ops.Contains(c) ? "yes" : "no";
                Log("Supports: live view start " + has(0x9201) + ", live view frame " + has(0x9203) + ", capture-to-RAM " + has(0x90C0) + ", standard capture " + has(0x100E) + ", events " + has(0x90C7) + ", Canon remote release " + has(0x9128) + ", Canon live view " + has(0x9153));

                if (props.Contains(0x5001))
                {
                    byte[] bat; r = ptp.OpRead(0x1015, out bat, 0x5001);
                    Log("Battery: " + (r == Ptp.OK && bat.Length > 0 ? bat[0] + "%" : "unknown (" + H(r) + ")"));
                }

                if (vendor != 0x0A) { Log("Not a Nikon: live view / capture tests for this brand come in stage 2. Send this text over."); return; }

                if (ops.Contains(0x9201) && ops.Contains(0x9203))
                {
                    Log("Live view: starting...");
                    r = ptp.Op(0x9201);
                    Log("   StartLiveView: " + H(r));
                    if (WaitReady(6000))
                    {
                        int okFrames = 0; byte[] last = null;
                        var sw = Stopwatch.StartNew();
                        for (int k = 0; k < 20; k++)
                        {
                            byte[] lv; r = ptp.OpRead(0x9203, out lv);
                            if (r == Ptp.OK && Jpeg(lv) >= 0) { okFrames++; last = lv; }
                            else if (k < 3) Log("   frame " + k + ": " + H(r) + ", " + lv.Length + " bytes");
                            if (r != Ptp.OK) Thread.Sleep(150);
                        }
                        double fps = okFrames / (sw.ElapsedMilliseconds / 1000.0);
                        Log("   Live view frames OK: " + okFrames + "/20, about " + fps.ToString("0.0") + " fps");
                        if (last != null)
                        {
                            int s = Jpeg(last);
                            File.WriteAllBytes(Path.Combine(outDir, "liveview.jpg"), SubArray(last, s));
                            Log("   Saved liveview.jpg (" + (last.Length - s) + " bytes, header " + s + " bytes)");
                        }
                    }
                    else Log("   Camera did not become ready for live view.");
                    r = ptp.Op(0x9202);
                    Log("   EndLiveView: " + H(r));
                    WaitReady(4000);
                }

                Log("Capture: firing the shutter...");
                var cw = Stopwatch.StartNew();
                if (ops.Contains(0x90C0)) { r = ptp.Op(0x90C0, 0xFFFFFFFF); Log("   InitiateCaptureRecInSdram: " + H(r)); }
                else { r = ptp.Op(0x100E, 0, 0); Log("   InitiateCapture: " + H(r)); }
                if (r != Ptp.OK) { Log("   Capture was refused (focus? mode dial? card?)."); return; }
                WaitReady(10000);
                uint handle = 0;
                var ew = Stopwatch.StartNew();
                while (handle == 0 && ew.ElapsedMilliseconds < 8000 && ops.Contains(0x90C7))
                {
                    byte[] evd; r = ptp.OpRead(0x90C7, out evd);
                    if (r == Ptp.OK && evd.Length >= 2)
                    {
                        var er = new Reader(evd); int cnt = er.U16();
                        for (int k = 0; k < cnt; k++) { ushort code = er.U16(); uint p = er.U32(); if (code == 0x4002) handle = p; }
                    }
                    if (handle == 0) Thread.Sleep(150);
                }
                if (handle == 0) { handle = 0xFFFF0001; Log("   No ObjectAdded event, trying the in-camera RAM photo 0xFFFF0001"); }
                byte[] img; r = ptp.OpRead(0x1009, out img, handle);
                Log("   GetObject " + H(handle) + ": " + H(r) + ", " + img.Length + " bytes, " + cw.ElapsedMilliseconds + " ms after shutter");
                if (r == Ptp.OK && img.Length > 0)
                {
                    File.WriteAllBytes(Path.Combine(outDir, "capture.jpg"), img);
                    Log("   Saved capture.jpg");
                    Log("RESULT: shutter + download WORK on Windows without Zadig.");
                }
            }
            finally { ptp.Close(); }
        }
        static byte[] SubArray(byte[] a, int from) { var r = new byte[a.Length - from]; Array.Copy(a, from, r, 0, r.Length); return r; }
    }
}
'@

try {
    Add-Type -TypeDefinition $cs -Language CSharp
} catch {
    Write-Host "Could not prepare the test: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host 'Copy the text above and send it. Press Enter to close'
    exit 1
}
try {
    [Pb4u.Test]::Run($out)
} catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    Write-Host "Test stopped: $($e.Message)" -ForegroundColor Red
}
Write-Host ''
Write-Host "Photos (if any) are in: $out"
Read-Host 'Copy ALL the text above and send it over. Press Enter to close'
