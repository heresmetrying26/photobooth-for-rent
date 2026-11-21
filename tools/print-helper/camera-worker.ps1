# photobooth4u Helper - camera worker (Windows)
# Started by the helper (photobooth4u-print-helper-windows.exe); not run by hand.
# Talks to the camera through Windows' OWN camera driver (WPD / MTP), so no
# Zadig / driver switch is needed: plug the camera in, switch it on, done.
# Connects back to the helper on 127.0.0.1:<Port> and answers one command at a time:
#   request : "<id> <command> [argument]\n"
#   reply   : "<id> <OK|ERR|GONE> <J|B|N> <byte length>\n" + that many bytes
#             (J = JSON text, B = JPEG bytes, N = nothing; ERR/GONE carry a message)
# Nikon DSLRs / mirrorless (D-series, Z-series) and Canon EOS (DSLRs, M, R) and Sony Alpha (PC Remote mode).
param([int]$Port)
$ErrorActionPreference = 'Stop'

$cs = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace Pb4uCam
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

    // The camera went away (unplugged / switched off): the helper reports "GONE".
    public class GoneException : Exception { public GoneException(string m) : base(m) { } }
    // A plain problem the person can fix (focus, card, mode dial...).
    public class CamException : Exception { public CamException(string m) : base(m) { } }

    public class DevInfo { public string Id, Name, Maker; }

    // A device Windows has plugged in on USB (from Device Manager's own list, see UsbScan).
    public class UsbDev
    {
        public string Id = "", Name = "", Maker = "", Class = "", Service = "", VidPid = "";
        public uint Status, Problem;   // Device Manager's state and its problem code (10 = didn't start, 28 = no driver ...)
        public bool Ptp;               // a picture-transfer (PTP, USB class 6) connection: the kind of camera the booth controls
    }

    // What Windows has plugged in on USB. Windows' camera list (WPD) only holds cameras whose driver started, so when that
    // list is empty this tells "nothing plugged in" apart from "a camera is plugged in but Windows' camera driver didn't start
    // for it" (Device Manager then shows a generic "MTP USB Device" and Windows still plays the plug-in sound).
    public static class UsbScan
    {
        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
        static extern int CM_Get_Device_ID_List_SizeW(out uint len, string filter, uint flags);
        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
        static extern int CM_Get_Device_ID_ListW(string filter, char[] buffer, uint len, uint flags);
        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
        static extern int CM_Locate_DevNodeW(out uint devInst, string id, uint flags);
        [DllImport("cfgmgr32.dll")]
        static extern int CM_Get_DevNode_Status(out uint status, out uint problem, uint devInst, uint flags);
        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
        static extern int CM_Get_DevNode_Registry_PropertyW(uint devInst, uint prop, out uint type, byte[] buffer, ref uint len, uint flags);

        const uint FILTER_ENUMERATOR = 0x1, FILTER_PRESENT = 0x100;
        const uint DRP_DEVICEDESC = 0x1, DRP_COMPATIBLEIDS = 0x3, DRP_SERVICE = 0x5, DRP_CLASS = 0x8, DRP_FRIENDLYNAME = 0xD;
        public const uint DN_STARTED = 0x8, DN_HAS_PROBLEM = 0x400;
        // Camera makers' USB vendor IDs (as in the Mac's lib/usbscan.mjs; GoPro and Insta360 have their own paths).
        // "0000" is a device Windows couldn't read at all ("Unknown USB Device (Device Descriptor Request Failed)").
        public static readonly Dictionary<string, string> MAKERS = new Dictionary<string, string> {
            { "04A9", "Canon" }, { "04B0", "Nikon" }, { "054C", "Sony" }, { "04CB", "Fujifilm" },
            { "07B4", "Olympus" }, { "04DA", "Panasonic" }, { "0A17", "Pentax" }, { "0000", "" } };

        static string Prop(uint dn, uint which)
        {
            try
            {
                uint type, len = 0;
                CM_Get_DevNode_Registry_PropertyW(dn, which, out type, null, ref len, 0);
                if (len == 0) return "";
                var b = new byte[len];
                if (CM_Get_DevNode_Registry_PropertyW(dn, which, out type, b, ref len, 0) != 0) return "";
                return Encoding.Unicode.GetString(b, 0, (int)Math.Min(len, (uint)b.Length)).TrimEnd('\0').Replace('\0', '\n');
            }
            catch { return ""; }
        }

        // The USB devices plugged in now; makersOnly: only camera makers' ones (and unreadable ones).
        public static List<UsbDev> Devices(bool makersOnly)
        {
            var list = new List<UsbDev>();
            uint len, flags = FILTER_ENUMERATOR | FILTER_PRESENT;
            int cr = CM_Get_Device_ID_List_SizeW(out len, "USB", flags);
            if (cr != 0) { flags = FILTER_ENUMERATOR; cr = CM_Get_Device_ID_List_SizeW(out len, "USB", flags); }
            if (cr != 0 || len < 2) return list;
            var buf = new char[len];
            if (CM_Get_Device_ID_ListW("USB", buf, len, flags) != 0) return list;
            foreach (string id in new string(buf).Split(new char[] { '\0' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var m = Regex.Match(id, @"^USB\\VID_([0-9A-F]{4})&PID_([0-9A-F]{4})", RegexOptions.IgnoreCase);
                if (!m.Success) continue;
                string vid = m.Groups[1].Value.ToUpperInvariant(), maker;
                if (!MAKERS.TryGetValue(vid, out maker)) { if (makersOnly) continue; maker = ""; }
                uint dn;
                if (CM_Locate_DevNodeW(out dn, id, 0) != 0) continue;   // not plugged in now
                var d = new UsbDev();
                d.Id = id; d.Maker = maker;
                d.VidPid = ("vid_" + vid + "&pid_" + m.Groups[2].Value).ToLowerInvariant();
                uint st, pr;
                if (CM_Get_DevNode_Status(out st, out pr, dn, 0) == 0) { d.Status = st; d.Problem = (st & DN_HAS_PROBLEM) != 0 ? pr : 0; }
                d.Name = Prop(dn, DRP_FRIENDLYNAME);
                if (d.Name == "") d.Name = Prop(dn, DRP_DEVICEDESC);
                d.Class = Prop(dn, DRP_CLASS);
                d.Service = Prop(dn, DRP_SERVICE);
                d.Ptp = Prop(dn, DRP_COMPATIBLEIDS).IndexOf("Class_06", StringComparison.OrdinalIgnoreCase) >= 0;
                list.Add(d);
            }
            return list;
        }

        // Programs that often take hold of a plugged-in camera, as { name shown to the client, start of the program's process name }.
        // Only used to say what to close: a camera that another program holds is still in Windows' camera list, so this
        // is a hint, not the usual cause when that list is empty.
        static readonly string[][] BUSY_APPS = new string[][] {
            new string[] { "EOS Utility", @"^EOS ?Utility" },
            new string[] { "EOS Webcam Utility", @"^EOS ?Webcam" },
            new string[] { "CameraWindow", @"^CameraWindow" },
            new string[] { "Windows Photos", @"^Microsoft\.Photos" },
            new string[] { "Lightroom", @"^Lightroom" },
            new string[] { "Capture One", @"^Capture ?One" },
            new string[] { "digiCamControl", @"^(CameraControl|digiCamControl)" },
            new string[] { "dslrBooth", @"^dslrBooth" },
            new string[] { "LumaBooth", @"^LumaBooth" },
            new string[] { "Sparkbooth", @"^Sparkbooth" },
            new string[] { "Nikon Transfer / NX Tether", @"^(NikonTransfer|NXTether|NX ?Tether)" },
            new string[] { "Imaging Edge", @"^Imaging ?Edge" }
        };

        // The names (from BUSY_APPS) of those programs that are running now, each once.
        public static List<string> BusyApps()
        {
            var found = new List<string>();
            Process[] all = null;
            try { all = Process.GetProcesses(); } catch { return found; }
            try
            {
                foreach (var p in all)
                {
                    string pn;
                    try { pn = p.ProcessName; } catch { continue; }
                    foreach (var a in BUSY_APPS)
                        if (!found.Contains(a[0]) && Regex.IsMatch(pn, a[1], RegexOptions.IgnoreCase)) found.Add(a[0]);
                }
            }
            finally { foreach (var p in all) { try { p.Dispose(); } catch { } } }
            return found;
        }
    }

    // PTP / MTP commands sent through Windows' MTP driver ("MTP extension" commands).
    public class Ptp
    {
        public const uint OK = 0x2001, BUSY = 0x2019;
        static readonly Guid CMD = new Guid("F0422A9C-5DC8-4440-B5BD-5DF28835658A");
        static readonly Guid MTPX = new Guid("4d545058-1a2e-4106-a357-771e0819fc56");
        static readonly Guid CLIENT = new Guid("204D9F0C-2292-4080-9F42-40664E70F859");
        PropertyKey kCat = new PropertyKey(CMD, 1001), kId = new PropertyKey(CMD, 1002), kHr = new PropertyKey(CMD, 1003);
        PropertyKey kOp = new PropertyKey(MTPX, 1001), kParams = new PropertyKey(MTPX, 1002), kResp = new PropertyKey(MTPX, 1003), kRespParams = new PropertyKey(MTPX, 1004);
        PropertyKey kCtx = new PropertyKey(MTPX, 1006), kTotal = new PropertyKey(MTPX, 1007), kToRead = new PropertyKey(MTPX, 1008);
        PropertyKey kRead = new PropertyKey(MTPX, 1009), kToWrite = new PropertyKey(MTPX, 1010), kData = new PropertyKey(MTPX, 1012);
        IPortableDevice dev;
        // For diagnosis: which command is in flight and since when (Worker.Watch logs a call that waits too long),
        // and a log line for calls that were slow but did answer.
        public static Action<string> Slow = null;
        public static volatile int CallSeq = 0, InFlight = 0, InSinceTick = 0;
        public static volatile ushort InOp = 0;
        ushort lastOp = 0;
        int calls = 0;

        static T Create<T>(string clsid) { return (T)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid(clsid))); }
        static void Check(int hr, string what)
        {
            if (hr == 0) return;
            uint u = (uint)hr;
            // Device gone / not connected / disconnected while busy
            if (u == 0x8007048F || u == 0x80070015 || u == 0x8007001F || u == 0x80070006 || u == 0x80070079 || u == 0x8007045D || u == 0x80070490)
                throw new GoneException(what + " failed (0x" + u.ToString("X8") + "): the camera was disconnected or switched off");
            throw new Exception(what + " failed (0x" + u.ToString("X8") + ")");
        }
        IPortableDeviceValues NewValues() { return Create<IPortableDeviceValues>("0c15d503-d017-47ce-9016-7b3f978721cc"); }

        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
        static extern int CM_Get_Device_Interface_List_SizeW(out uint len, ref Guid cls, string devId, uint flags);
        [DllImport("cfgmgr32.dll", CharSet = CharSet.Unicode)]
        static extern int CM_Get_Device_Interface_ListW(ref Guid cls, string devId, char[] buffer, uint len, uint flags);

        static void PtpLog(string s) { try { Console.WriteLine("[camera] " + s); Console.Out.Flush(); } catch { } }

        public static List<DevInfo> ListDevices()
        {
            var list = new List<DevInfo>();
            IPortableDeviceManager mgr = null;
            var ids = new List<string>();

            // WPD sometimes needs a moment after a camera connects — retry up to 3 times.
            for (int attempt = 0; attempt < 3 && ids.Count == 0; attempt++)
            {
                if (attempt > 0) Thread.Sleep(700);
                try
                {
                    mgr = Create<IPortableDeviceManager>("0af10cec-2ecd-4b92-9581-34f6ae0637f3");
                    int rfHr = mgr.RefreshDeviceList();
                    uint n = 0;
                    int hr = mgr.GetDevices(null, ref n);
                    PtpLog("WPD list attempt " + (attempt + 1) + ": RefreshDeviceList=0x" + ((uint)rfHr).ToString("X8") + " GetDevices=0x" + ((uint)hr).ToString("X8") + " count=" + n);
                    if (hr == 0 && n > 0)
                    {
                        var arr = new IntPtr[n];
                        hr = mgr.GetDevices(arr, ref n);
                        for (int i = 0; i < n && hr == 0; i++) { ids.Add(Marshal.PtrToStringUni(arr[i])); Marshal.FreeCoTaskMem(arr[i]); }
                    }
                }
                catch (Exception e) { PtpLog("WPD manager error (attempt " + (attempt + 1) + "): " + e.Message); }
            }

            if (ids.Count == 0)
            {
                // Second way: ask Windows directly for portable-device interfaces.
                Guid wpd = new Guid("6AC27878-A6FA-4155-BA85-F98F491D4F33");
                uint len;
                int cr = CM_Get_Device_Interface_List_SizeW(out len, ref wpd, null, 0);
                PtpLog("CM_Get_Device_Interface_List (WPD): cr=" + cr + " len=" + len);
                if (cr == 0 && len > 1)
                {
                    var buf = new char[len];
                    cr = CM_Get_Device_Interface_ListW(ref wpd, null, buf, len, 0);
                    if (cr == 0)
                        foreach (string id in new string(buf).Split(new char[] { '\0' }, StringSplitOptions.RemoveEmptyEntries)) ids.Add(id);
                }
            }
            if (ids.Count == 0)
            {
                // Third way: ask Windows for Still Image / Imaging device interfaces.
                Guid img = new Guid("6BDD1FC6-810F-11D0-BEC7-08002BE2092F");
                uint len;
                int cr = CM_Get_Device_Interface_List_SizeW(out len, ref img, null, 0);
                PtpLog("CM_Get_Device_Interface_List (Image): cr=" + cr + " len=" + len);
                if (cr == 0 && len > 1)
                {
                    var buf = new char[len];
                    cr = CM_Get_Device_Interface_ListW(ref img, null, buf, len, 0);
                    if (cr == 0)
                        foreach (string id in new string(buf).Split(new char[] { '\0' }, StringSplitOptions.RemoveEmptyEntries)) ids.Add(id);
                }
            }

            PtpLog("WPD devices found: " + ids.Count);
            foreach (string id in ids)
            {
                string lid = (id ?? "").ToLowerInvariant();
                if (lid.Contains("scanner") || lid.Contains("escl") || lid.Contains("wsdprovider") || lid.Contains("root#scanner")) continue;
                var d = new DevInfo();
                d.Id = id;
                string nm = mgr != null ? Name(mgr, id, 0) : "";
                string mk = mgr != null ? Name(mgr, id, 1) : "";
                if (string.IsNullOrEmpty(nm) || nm.Equals("MTP USB Device", StringComparison.OrdinalIgnoreCase))
                {
                    if (lid.Contains("vid_04a9")) { nm = "Canon EOS Camera"; mk = "Canon"; }
                    else if (lid.Contains("vid_04b0")) { nm = "Nikon Camera"; mk = "Nikon"; }
                    else if (lid.Contains("vid_054c")) { nm = "Sony Camera"; mk = "Sony"; }
                    else if (lid.Contains("vid_04cb")) { nm = "Fujifilm Camera"; mk = "Fujifilm"; }
                    else if (string.IsNullOrEmpty(nm)) { nm = "MTP Camera"; mk = "Camera"; }
                }
                else if (string.IsNullOrEmpty(mk))
                {
                    if (lid.Contains("vid_04a9") || nm.IndexOf("canon", StringComparison.OrdinalIgnoreCase) >= 0) mk = "Canon";
                    else if (lid.Contains("vid_04b0") || nm.IndexOf("nikon", StringComparison.OrdinalIgnoreCase) >= 0) mk = "Nikon";
                    else if (lid.Contains("vid_054c") || nm.IndexOf("sony", StringComparison.OrdinalIgnoreCase) >= 0) mk = "Sony";
                }
                d.Name = nm;
                d.Maker = mk;
                PtpLog("WPD device: id=\"" + id + "\" name=\"" + d.Name + "\" maker=\"" + d.Maker + "\"");
                list.Add(d);
            }
            return list;
        }
        static string Name(IPortableDeviceManager mgr, string id, int which)
        {
            try
            {
                uint cch = 0;
                if (which == 0) mgr.GetDeviceFriendlyName(id, IntPtr.Zero, ref cch); else mgr.GetDeviceManufacturer(id, IntPtr.Zero, ref cch);
                if (cch == 0) return "";
                IntPtr buf = Marshal.AllocHGlobal((int)cch * 2 + 2);
                try
                {
                    int hr = which == 0 ? mgr.GetDeviceFriendlyName(id, buf, ref cch) : mgr.GetDeviceManufacturer(id, buf, ref cch);
                    return hr == 0 ? (Marshal.PtrToStringUni(buf) ?? "") : "";
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
            catch { return ""; }
        }

        public virtual void Open(string id)
        {
            dev = Create<IPortableDevice>("f7c0039a-4762-488a-b4b3-760ef9a1ba9b");
            var info = NewValues();
            var kName = new PropertyKey(CLIENT, 2);
            var kMajor = new PropertyKey(CLIENT, 3);
            var kMinor = new PropertyKey(CLIENT, 4);
            var kRev = new PropertyKey(CLIENT, 5);
            info.SetStringValue(ref kName, "photobooth4u");
            info.SetUnsignedIntegerValue(ref kMajor, 1);
            info.SetUnsignedIntegerValue(ref kMinor, 1);
            info.SetUnsignedIntegerValue(ref kRev, 0);
            Check(dev.Open(id, info), "Open camera");
        }
        public virtual void Close() { try { if (dev != null) dev.Close(); } catch { } dev = null; }

        IPortableDeviceValues Send(uint cmdPid, IPortableDeviceValues v)
        {
            Guid cat = MTPX;
            try
            {
                Check(v.SetGuidValue(ref kCat, ref cat), "Set category");
                Check(v.SetUnsignedIntegerValue(ref kId, cmdPid), "Set command");
                IPortableDeviceValues res;
                var sw = Stopwatch.StartNew();
                CallSeq++; InOp = lastOp; InSinceTick = Environment.TickCount; InFlight = 1;
                int hr0;
                try { hr0 = dev.SendCommand(0, v, out res); }
                finally { InFlight = 0; }
                if (sw.ElapsedMilliseconds > 1500 && Slow != null) { try { Slow("Slow camera call: 0x" + lastOp.ToString("X4") + " (step " + cmdPid + ") took " + sw.ElapsedMilliseconds + " ms"); } catch { } }
                Check(hr0, "Camera command");
                int hr;
                if (res.GetErrorValue(ref kHr, out hr) == 0 && hr != 0) Check(hr, "Camera command");
                return res;
            }
            finally
            {
                // The request is spent (callers never reuse it): let go of it now. A long live-view session makes
                // millions of these; now and then collect what is left so memory stays flat for hours.
                try { Marshal.ReleaseComObject(v); } catch { }
                if (++calls % 400 == 0) { GC.Collect(); GC.WaitForPendingFinalizers(); }
            }
        }
        void SetOp(IPortableDeviceValues v, ushort code, uint[] ps)
        {
            lastOp = code;
            Check(v.SetUnsignedIntegerValue(ref kOp, code), "Set op");
            var c = Create<IPortableDevicePropVariantCollection>("08a99e2f-6d6d-4b80-af5a-baf2bcbe4cb9");
            foreach (uint p in ps) { var pv = new PropVariant(); pv.vt = 19; pv.uintVal = p; Check(c.Add(ref pv), "Add param"); }
            Check(v.SetIPortableDevicePropVariantCollectionValue(ref kParams, c), "Set params");
        }
        // Vendor operations Windows' MTP driver will pass to the camera.
        public virtual List<uint> DriverVendorOps()
        {
            var l = new List<uint>();
            var r = Send(11, NewValues());
            var key = new PropertyKey(MTPX, 1005);
            IPortableDevicePropVariantCollection c;
            if (r.GetIPortableDevicePropVariantCollectionValue(ref key, out c) != 0 || c == null) return l;
            uint n; c.GetCount(out n);
            for (uint k = 0; k < n; k++) { var pv = new PropVariant(); if (c.GetAt(k, ref pv) == 0) l.Add(pv.uintVal); }
            return l;
        }
        public virtual uint Op(ushort code, params uint[] ps)
        {
            var v = NewValues();
            SetOp(v, code, ps);
            var r = Send(12, v);
            uint resp = 0; r.GetUnsignedIntegerValue(ref kResp, out resp);
            return resp;
        }
        // Same, and also hands back the camera's answer numbers (Canon RemoteRelease says why it didn't shoot).
        public virtual uint OpP(ushort code, out uint[] answer, params uint[] ps)
        {
            var v = NewValues();
            SetOp(v, code, ps);
            var r = Send(12, v);
            uint resp = 0; r.GetUnsignedIntegerValue(ref kResp, out resp);
            answer = new uint[0];
            IPortableDevicePropVariantCollection c;
            if (r.GetIPortableDevicePropVariantCollectionValue(ref kRespParams, out c) == 0 && c != null)
            {
                uint n; c.GetCount(out n);
                answer = new uint[n];
                for (uint k = 0; k < n; k++) { var pv = new PropVariant(); if (c.GetAt(k, ref pv) == 0) answer[k] = pv.uintVal; }
            }
            return resp;
        }
        public virtual uint OpRead(ushort code, out byte[] data, params uint[] ps)
        {
            var v = NewValues();
            SetOp(v, code, ps);
            var r = Send(13, v);
            string ctx; Check(r.GetStringValue(ref kCtx, out ctx), "Transfer context");
            ulong total = 0; r.GetUnsignedLargeIntegerValue(ref kTotal, out total);
            var ms = new MemoryStream((int)Math.Min(total, 64UL * 1024 * 1024));
            ulong got = 0;
            bool unknown = total == 0;   // size not reported: read until the camera has nothing more
            int reads = 0;
            Exception readErr = null;   // the camera answered with an error code and no data
            try
            {
                while (unknown ? reads < 200 : got < total)
                {
                    reads++;
                    uint chunk = unknown ? 1048576U : (uint)Math.Min(1048576UL, total - got);
                    var rv = NewValues();
                    rv.SetStringValue(ref kCtx, ctx);
                    rv.SetUnsignedIntegerValue(ref kToRead, chunk);
                    rv.SetBufferValue(ref kData, new byte[chunk], chunk);
                    IPortableDeviceValues rr;
                    try { rr = Send(15, rv); }
                    catch (GoneException) { throw; }
                    catch (Exception e) { if (unknown && got > 0) break; readErr = e; break; }
                    IntPtr p; uint cb;
                    Check(rr.GetBufferValue(ref kData, out p, out cb), "Read data");
                    uint n = 0; rr.GetUnsignedIntegerValue(ref kRead, out n);
                    if (n == 0 || n > cb) n = cb;
                    if (n > 0)
                    {
                        var b = new byte[n];
                        Marshal.Copy(p, b, 0, (int)n);
                        ms.Write(b, 0, (int)n);
                    }
                    Marshal.FreeCoTaskMem(p);
                    got += n;
                    if (n == 0 || (unknown && n < chunk)) break;
                }
            }
            finally
            {
                data = ms.ToArray();
            }
            var ev = NewValues();
            ev.SetStringValue(ref kCtx, ctx);
            uint resp = 0;
            try { var er = Send(17, ev); er.GetUnsignedIntegerValue(ref kResp, out resp); }
            catch (GoneException) { throw; }
            catch { if (readErr == null) throw; throw readErr; }
            // An error code (e.g. "not ready yet") is the answer; a failed read with "OK" is a real problem.
            if (readErr != null && (resp == OK || resp == 0)) throw readErr;
            return resp;
        }
        public virtual uint OpWrite(ushort code, byte[] data, params uint[] ps)
        {
            var v = NewValues();
            SetOp(v, code, ps);
            Check(v.SetUnsignedLargeIntegerValue(ref kTotal, (ulong)data.Length), "Set size");
            var r = Send(14, v);
            string ctx; Check(r.GetStringValue(ref kCtx, out ctx), "Transfer context");
            var wv = NewValues();
            wv.SetStringValue(ref kCtx, ctx);
            wv.SetUnsignedIntegerValue(ref kToWrite, (uint)data.Length);
            wv.SetBufferValue(ref kData, data, (uint)data.Length);
            Send(16, wv);
            var ev = NewValues();
            ev.SetStringValue(ref kCtx, ctx);
            var er = Send(17, ev);
            uint resp = 0; er.GetUnsignedIntegerValue(ref kResp, out resp);
            return resp;
        }
    }

    public class Reader
    {
        byte[] b; int i;
        public Reader(byte[] data) { b = data; i = 0; }
        public int Pos { get { return i; } }
        public bool More { get { return i < b.Length; } }
        public byte U8() { return b[i++]; }
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
        // One value of a PTP data type, as text (numbers) or the string itself.
        public string Value(ushort type)
        {
            switch (type)
            {
                case 1: return ((sbyte)U8()).ToString();
                case 2: return U8().ToString();
                case 3: return ((short)U16()).ToString();
                case 4: return U16().ToString();
                case 5: return ((int)U32()).ToString();
                case 6: return U32().ToString();
                case 0xFFFF: return Str();
                default: throw new Exception("type " + type);
            }
        }
    }

    public static class Worker
    {
        static Ptp ptp;
        static string camName = "", camModel = "", camMaker = "", devId = null;
        static uint vendor;
        static bool nikon, canon, sony;
        // Stand-ins for tests; the real thing talks to Windows' camera driver.
        public static Func<Ptp> NewPtp = delegate { return new Ptp(); };
        public static Func<List<DevInfo>> ListDevs = Ptp.ListDevices;
        public static Func<List<UsbDev>> UsbDevs = delegate { return UsbScan.Devices(true); };
        public static Func<List<string>> OpenApps = delegate { return UsbScan.BusyApps(); };
        static string diag = "";
        // Nikons in MTP mode (D3400, D5600...) call themselves a Microsoft/MTP device
        // and may not list their own commands, but they still answer them.
        static readonly ushort[] NIKON_OPS = { 0x90C0, 0x90C1, 0x90C7, 0x90C8, 0x9201, 0x9202, 0x9203, 0x9207 };
        static bool Has(ushort op) { return ops.Contains(op) || (nikon && Array.IndexOf(NIKON_OPS, op) >= 0); }
        static List<ushort> ops = new List<ushort>(), props = new List<ushort>();
        static bool live;
        static string setupNote = "";
        // Set by the helper when it had to restart this program (the camera stopped answering): the Canon is told to
        // leave remote mode before it is switched on again, because the old session ended without a goodbye.
        static bool recoverNext;
        static Stopwatch nikEv = Stopwatch.StartNew();

        static void Log(string s) { try { Console.WriteLine("[camera] " + s); Console.Out.Flush(); } catch { } }
        static string H(uint v) { return "0x" + v.ToString("X4"); }
        static string Js(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (char c in s ?? "")
            {
                if (c == '"' || c == '\\') { sb.Append('\\'); sb.Append(c); }
                else if (c < 32) sb.Append("\\u" + ((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }

        // ---------- camera picking ----------
        static readonly string[] CAMERA_WORDS = {
            "nikon", "canon", "sony", "ilce", "ilme", "alpha", "zv-", "dsc-",
            "fuji", "panasonic", "olympus", "om system", "pentax", "eos", "lumix",
            "rebel", "kiss", "1300", "camera", "mtp", "ptp", "digital still"
        };
        static readonly string[] CAMERA_VIDS = {
            "vid_04a9", "vid_04b0", "vid_054c", "vid_04cb", "vid_07b4", "vid_04da", "vid_0a17"
        };

        static bool LooksLikeCamera(DevInfo d)
        {
            string id = (d.Id ?? "").ToLowerInvariant();
            if (id.Contains("scanner") || id.Contains("escl") || id.Contains("wsdprovider") || id.Contains("root#scanner")) return false;
            string n = ((d.Name ?? "") + " " + (d.Maker ?? "")).ToLowerInvariant();
            if (n.Contains("scanner") || n.Contains("printer")) return false;
            foreach (string v in CAMERA_VIDS) if (id.Contains(v)) return true;
            foreach (string w in CAMERA_WORDS) if (n.Contains(w) || id.Contains(w)) return true;
            // Nikon model names: D5600, D750, Z 6, Z50...
            return System.Text.RegularExpressions.Regex.IsMatch(n, @"\b(d\d{2,4}|z ?\d{1,2}|zf|zfc)\b");
        }

        // Windows' camera list gave the booth no camera it could open. Is a camera plugged in that Windows didn't set up as one?
        // Says what Windows has instead of "plug the camera in" (it is plugged in: Windows even played its sound).
        // listed: what Windows' camera list held (a camera in it has its own messages). null: nothing to add.
        public static string UsbHint(List<DevInfo> listed)
        {
            List<UsbDev> usb;
            try { usb = UsbDevs(); }
            catch (Exception e) { Log("USB check failed: " + e.Message); return null; }
            UsbDev cam = null, unreadable = null;
            foreach (var u in usb)
            {
                bool started = (u.Status & UsbScan.DN_STARTED) != 0;
                Log("USB check: " + (u.Maker == "" ? "" : u.Maker + " ") + "\"" + u.Name + "\" " + u.Id + " class=" + u.Class + " driver=" + u.Service
                    + " ptp=" + (u.Ptp ? "yes" : "no") + " started=" + (started ? "yes" : "no") + (u.Problem != 0 ? " problem=" + u.Problem : ""));
                if (u.Maker == "") { if (u.Problem != 0) unreadable = u; continue; }
                if (!u.Ptp) continue;   // not a camera's picture-transfer connection (a Sony game pad, a card reader ...)
                bool inList = false;
                foreach (var d in listed) if ((d.Id ?? "").ToLowerInvariant().Contains(u.VidPid)) inList = true;
                if (inList) continue;
                if (cam == null || (cam.Problem == 0 && u.Problem != 0)) cam = u;
            }
            if (cam == null)
            {
                if (unreadable == null) return null;
                return "NOCAMERA Windows heard a USB device but couldn't read it (\"" + unreadable.Name + "\"). If that's the camera: use another data USB cable or USB port, plug straight into the laptop (not a hub), and switch the camera on.";
            }
            string svc = (cam.Service ?? "").ToLowerInvariant();
            if (svc == "winusb" || svc.StartsWith("libusb")) return null;   // switched with Zadig: the app's direct USB part takes that one
            string mk = cam.Maker, nm = cam.Name == "" ? mk + " camera" : cam.Name;
            if (cam.Problem == 0 && (cam.Status & UsbScan.DN_STARTED) == 0)
                return "DRIVER Windows is still setting up the " + mk + " camera (\"" + nm + "\"). Wait a few seconds: the booth connects by itself. If it stays like this, switch the camera off and on and plug it in again.";
            string why;
            if (cam.Problem == 10) why = "its camera driver didn't start (code 10)";
            else if (cam.Problem == 28) why = "Windows has no camera driver for it (code 28; on a Windows \"N\" edition, install Microsoft's Media Feature Pack)";
            else if (cam.Problem == 22) return "DRIVER Windows sees the " + mk + " camera on USB (\"" + nm + "\"), but it is disabled in Device Manager (code 22). Right-click \"" + nm + "\" there and choose Enable device.";
            else if (cam.Problem == 43) why = "Windows stopped it after it reported a problem (code 43)";
            else if (cam.Problem != 0) why = "Windows reports a problem with it (code " + cam.Problem + ")";
            else why = "Windows didn't add it to its list of cameras (" + (cam.Class == "" ? "no device type" : cam.Class) + ", driver " + (cam.Service == "" ? "none" : cam.Service) + ")";
            string apps = mk == "Canon" ? "EOS Utility" : mk == "Nikon" ? "Nikon Transfer and NX Tether" : mk == "Sony" ? "Imaging Edge" : "other camera apps";
            // Programs open right now that may be holding the camera: name them instead of guessing.
            List<string> open = null;
            try { open = OpenApps(); } catch (Exception e) { Log("Open-programs check failed: " + e.Message); }
            string close = "Close " + apps + ".";
            if (open != null && open.Count > 0)
            {
                Log("Programs open that may hold the camera: " + string.Join(", ", open.ToArray()));
                string names = open.Count == 1 ? open[0] : string.Join(", ", open.GetRange(0, open.Count - 1).ToArray()) + " and " + open[open.Count - 1];
                close = "Close " + names + " (" + (open.Count == 1 ? "it is" : "they are") + " open now and may be holding the camera).";
            }
            return "DRIVER Windows sees the " + mk + " camera on USB (\"" + nm + "\"), but " + why + ", so the booth can't reach it. Try these in order: "
                + "(1) On the camera, set " + (mk == "Canon" ? "Wi-Fi/NFC" : "Wi-Fi") + " to Disable. "
                + "(2) Use the USB cable that came with the camera (not a third-party one), plugged straight into the laptop with no hub, and charge the battery fully or use the AC adapter: the laptop does not power the camera. "
                + "(3) " + close + " "
                + "(4) Switch the camera off and on and plug it in again. "
                + "If it stays like this: in Device Manager right-click \"" + nm + "\", choose Uninstall device, then plug the camera in again.";
        }

        static string ListJson()
        {
            // An open camera that was unplugged meanwhile: notice it now.
            if (ptp != null) { try { Alive(); } catch { Log("Camera lost"); CloseCamera(); } }
            if (canon && ptp != null && (!pollSw.IsRunning || pollSw.ElapsedMilliseconds > 1500))
            {
                try { CanonPoll(); }
                catch (GoneException) { Log("Camera lost"); CloseCamera(); }
                catch { }
            }
            var sb = new StringBuilder("{\"devices\":[");
            bool first = true;
            foreach (var d in ListDevs())
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"name\":" + Js(d.Name) + ",\"maker\":" + Js(d.Maker) + ",\"camera\":" + (LooksLikeCamera(d) ? "true" : "false") + "}");
            }
            // The booth's Canon guide reads these flags (see brand-canon.js): focusing inside the shot (came after the flash),
            // press without focusing turned off, saving to the card first, an older body without 0x9128, and the lens on MF (0xD108=3).
            bool cn = canon && ptp != null;
            bool mf = cn && CanonLensMf();
            bool older = cn && !Has(0x9128);
            sb.Append("],\"open\":" + (ptp != null ? "true" : "false") + ",\"name\":" + Js(ptp != null ? camName : "") + ",\"shutterMs\":" + lastShutterMs
                + ",\"focusInShot\":" + (cn && canonFocusInShot && !mf ? "true" : "false")
                + ",\"noAfOff\":" + (cn && canonNoAfBad && !mf ? "true" : "false")
                + ",\"toCard\":" + (cn && !canonToHost ? "true" : "false")
                + ",\"olderCanon\":" + (older ? "true" : "false")
                + ",\"lensMf\":" + (mf ? "true" : "false") + "}");
            return sb.ToString();
        }

        static bool ReadInfo()
        {
            byte[] di;
            uint r = ptp.OpRead(0x1001, out di);
            if (r != Ptp.OK && r != 0) return false;
            var rd = new Reader(di);
            rd.U16(); vendor = rd.U32(); rd.U16(); rd.Str(); rd.U16();
            ops = rd.U16Array(); rd.U16Array(); props = rd.U16Array(); rd.U16Array(); rd.U16Array();
            camMaker = rd.Str(); camModel = rd.Str();
            nikon = vendor == 0x0A || camMaker.IndexOf("nikon", StringComparison.OrdinalIgnoreCase) >= 0;
            canon = !nikon && (vendor == 0x0B || camMaker.IndexOf("canon", StringComparison.OrdinalIgnoreCase) >= 0);
            sony = !nikon && !canon && (vendor == 0x11 || camMaker.IndexOf("sony", StringComparison.OrdinalIgnoreCase) >= 0);
            // The commands that matter for this brand: which ones the camera lists, which ones Windows passes on.
            ushort[] mine = canon ? new ushort[] { 0x9114, 0x9115, 0x9116, 0x9153, 0x9110, 0x910F, 0x9128 } : sony ? new ushort[] { 0x9201, 0x9202, 0x9205, 0x9207, 0x9209 } : new ushort[] { 0x9201, 0x9203, 0x90C0, 0x90C7, 0x90C8 };
            var listed = new List<string>();
            foreach (ushort op in mine) if (ops.Contains(op)) listed.Add(op.ToString("X4"));
            string driverOps = "?";
            try
            {
                var dv = ptp.DriverVendorOps();
                var allowed = new List<string>();
                foreach (ushort op in mine) if (dv.Contains(op)) allowed.Add(op.ToString("X4"));
                driverOps = dv.Count + " vendor ops, of ours: " + (allowed.Count > 0 ? string.Join(" ", allowed.ToArray()) : "none");
            }
            catch (GoneException) { throw; }
            catch (Exception e) { driverOps = "n/a (" + e.Message + ")"; }
            diag = "vendor " + vendor + ", " + ops.Count + " ops, lists: " + (listed.Count > 0 ? string.Join(" ", listed.ToArray()) : "none of ours") + "; driver: " + driverOps;
            Log("DeviceInfo " + camMaker + " " + camModel + ": " + diag);
            return true;
        }

        static void CloseCamera()
        {
            if (ptp != null)
            {
                if (nikon && live) { try { ptp.Op(0x9202); } catch { } }
                if (canon)
                {
                    // Hand the camera back: photos on the card again (it would otherwise stay on "computer" and the next photos taken
                    // on the camera itself wouldn't be saved), live view off, out of remote mode.
                    try { CanonToCard(false); } catch { }
                    try { if (live) SetEos(0xD1B0, 0); ptp.Op(0x9115, 0); ptp.Op(0x9114, 0); } catch { }
                }
                if (sony) SonyReleaseButtons(false);
                ptp.Close();
            }
            ptp = null; live = false; devId = null; nikon = false; canon = false; sony = false; sonyClock = null; sonyDestBlocked = false;
        }

        static string Open()
        {
            if (ptp != null)
            {
                // A camera that went to sleep can still be listed and answer "alive" with a dead session. When the booth asks
                // for a clean start (recoverNext), always close and connect again instead of trusting it.
                if (!recoverNext) { try { Alive(); return InfoJson(); } catch { } }
                CloseCamera();
            }
            var all = ListDevs();
            Log("Open: WPD returned " + all.Count + " device(s)" + (all.Count > 0 ? ": " + string.Join(", ", all.ConvertAll(d => "\"" + (d.Name ?? "") + "\"/\"" + (d.Maker ?? "") + "\"").ToArray()) : ""));
            if (all.Count == 0) throw new CamException(UsbHint(all) ?? "NOCAMERA No camera found. Plug the camera into this laptop with a data USB cable and switch it on.");
            // Cameras by name first, then anything else (some cameras show only a model number).
            var order = new List<DevInfo>();
            foreach (var d in all) if (LooksLikeCamera(d)) order.Add(d);
            foreach (var d in all) if (!LooksLikeCamera(d)) order.Add(d);
            string seen = "";
            CamException canonErr = null, sonyErr = null;
            foreach (var d in order)
            {
                var p = NewPtp();
                try
                {
                    p.Open(d.Id);
                    ptp = p;
                    if (!ReadInfo()) { CloseCamera(); continue; }
                    seen += (seen == "" ? "" : ", ") + (camMaker + " " + camModel).Trim();
                    if (nikon)   // Nikon (live view is tried when the booth asks for it)
                    {
                        devId = d.Id;
                        camName = (camMaker.StartsWith("Nikon", StringComparison.OrdinalIgnoreCase) ? "Nikon " : camMaker + " ") + camModel.Replace("NIKON", "").Replace("Nikon", "").Trim();
                        Log("Opened " + camName + " (" + d.Name + ")");
                        Prepare();
                        return InfoJson();
                    }
                    if (canon)   // Canon EOS: remote mode now, live view when the booth asks
                    {
                        devId = d.Id;
                        camName = "Canon " + camModel.Replace("Canon", "").Trim();
                        Log("Opened " + camName + " (" + d.Name + ")");
                        PrepareCanon();
                        return InfoJson();
                    }
                    if (sony)   // Sony Alpha in PC Remote mode: connect now, live view when the booth asks
                    {
                        devId = d.Id;
                        camName = SonyName(camModel);
                        Log("Opened " + camName + " (" + d.Name + ")");
                        PrepareSony();
                        return InfoJson();
                    }
                    CloseCamera();
                }
                catch (Exception e)
                {
                    Log("Skipped " + d.Name + ": " + e.Message);
                    if (canon && e is CamException) canonErr = (CamException)e;
                    else if (canon && e is GoneException) canonErr = new CamException("NOCAMERA The camera disconnected while connecting. Check the USB cable, switch the camera off and on, and try again.");
                    else if (canon) canonErr = new CamException("DRIVER Windows' camera driver didn't pass the remote-control command to the " + (camMaker + " " + camModel).Trim() + " (" + e.Message + "). Close EOS Utility and any photo-import window, unplug the camera, switch it off and on, plug it in again and try again.");
                    if (sony && e is CamException) sonyErr = (CamException)e;
                    else if (sony && e is GoneException) sonyErr = new CamException("NOCAMERA The camera disconnected while connecting. Check the USB cable, switch the camera off and on, and try again.");
                    else if (sony) sonyErr = new CamException("DRIVER Windows' camera driver didn't pass the remote-control command to the " + camName + " (" + e.Message + "). " + SONY_HINT + " [" + diag + "]");
                    if (ptp == p) CloseCamera(); else p.Close();
                }
            }
            if (canonErr != null) throw canonErr;
            if (sonyErr != null) throw sonyErr;
            string usbHint = UsbHint(all);   // e.g. a phone was listed, the camera itself wasn't
            if (usbHint != null) throw new CamException(usbHint);
            if (seen != "") throw new CamException("NOCAMERA Found " + seen + ", but no Nikon, Canon EOS or Sony Alpha camera with live view. Switch the camera on and check its cable.");
            throw new CamException("NOCAMERA No camera found. Plug the camera into this laptop with a data USB cable (not charge-only) and switch it on.");
        }

        static string InfoJson()
        {
            bool canPreFocus = !canon || Has(0x9128);   // Nikon & newer Canon (0x9128) can pre-focus; older Canon (60D, 550D...) focuses inside 0x910F
            bool older = canon && !Has(0x9128);
            bool mf = CanonLensMf();
            return "{\"name\":" + Js(camName) + ",\"model\":" + Js(camModel) + ",\"maker\":" + Js(camMaker) + ",\"brand\":" + Js(nikon ? "nikon" : canon ? "canon" : sony ? "sony" : "") + ",\"vendor\":" + vendor
                + ",\"liveview\":" + (live ? "true" : "false") + ",\"battery\":" + Battery() + ",\"note\":" + Js(setupNote) + ",\"diag\":" + Js(diag)
                + ",\"preFocus\":" + (canPreFocus ? "true" : "false")
                + ",\"olderCanon\":" + (older ? "true" : "false")
                + ",\"lensMf\":" + (mf ? "true" : "false") + "}";
        }

        static int Battery()
        {
            if (canon)
            {
                // EOS battery arrives as property 0xD111 in the event stream: quarter steps (1=Low 6=25% 2=50% 5=75% 3=100%) on most bodies, a percent on some.
                try { if (!pollSw.IsRunning || pollSw.ElapsedMilliseconds > 2000) CanonPoll(); } catch (GoneException) { throw; } catch { }
                uint v;
                if (!eosVals.TryGetValue(0xD111, out v)) return -1;
                if (v == 1) return 10;
                if (v == 6) return 25;
                if (v == 2) return 50;
                if (v == 5) return 75;
                if (v == 3) return 100;
                if (v >= 7 && v <= 100) return (int)v;
                return -1;
            }
            if (sony || !props.Contains(0x5001)) return -1;   // Sony reports battery in steps, not percent
            try { byte[] b; uint r = ptp.OpRead(0x1015, out b, 0x5001); return r == Ptp.OK && b.Length > 0 ? b[0] : -1; }
            catch (GoneException) { throw; }
            catch { return -1; }
        }

        static bool WaitReady(int ms)
        {
            var sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < ms)
            {
                uint r = ptp.Op(0x90C8);   // Nikon DeviceReady
                if (r == Ptp.OK) return true;
                if (r != Ptp.BUSY) return false;
                Thread.Sleep(50);
            }
            return false;
        }
        static uint LastReady()
        {
            return ptp.Op(0x90C8);
        }

        // ---------- photo size: JPEG Fine, smallest size >= ~3900 px wide (fallback to largest) ----------
        // (3900 px is enough for 4R boxes at 675 DPI without enlarging; a camera with no size that big uses its largest)
        static void Prepare()
        {
            setupNote = "";
            // Record to the camera's own memory (RAM), like the Mac booth does, so
            // live view and photos work without an SD card (Nikon RecordingMedia 0xD10B).
            if (nikon)
            {
                try
                {
                    var rm = PropDesc(0xD10B);
                    if (rm != null && rm.Current != "1" && SetProp(0xD10B, rm.Type, "1")) { setupNote += "Records to camera memory. "; Log("Recording media -> camera memory (SDRAM)"); }
                }
                catch (GoneException) { throw; }
                catch (Exception e) { Log("Recording media not changed: " + e.Message); }
            }
            try
            {
                if (props.Contains(0x5004))
                {
                    var q = PropDesc(0x5004);
                    if (q != null)
                    {
                        int cur; int.TryParse(q.Current, out cur);
                        // Nikon: 0 Basic, 1 Normal, 2 Fine (JPEG); higher values include RAW.
                        // Basic and Normal squeeze the JPEG hard: at a high ISO that shows as blocky, pixelated detail. Always use Fine.
                        if ((classicNikon ? cur > 2 : cur != 2) && q.Choices.Contains("2") && SetProp(0x5004, q.Type, "2")) { setupNote += "Set to JPEG Fine. "; Log("Image quality was " + (cur > 2 ? "RAW" : cur == 1 ? "JPEG Normal" : "JPEG Basic") + "; set to JPEG Fine"); }
                    }
                }
                if (props.Contains(0x5003))
                {
                    var s = PropDesc(0x5003);
                    if (s != null && s.Type == 0xFFFF && s.Choices.Count > 1)
                    {
                        string best = null, big = null; int bestW = int.MaxValue, bigW = 0;
                        foreach (string c in s.Choices)
                        {
                            int w = Width(c);
                            if (w >= 3900 && w < bestW) { best = c; bestW = w; }
                            if (w > bigW) { big = c; bigW = w; }
                        }
                        if (best == null) best = big;
                        if (best != null && best != s.Current && SetProp(0x5003, s.Type, best)) { setupNote += "Photo size " + best + ". "; Log("Image size " + s.Current + " -> " + best); }
                    }
                }
            }
            catch (GoneException) { throw; }
            catch (Exception e) { Log("Photo size not changed: " + e.Message); }
        }
        static int Width(string s) { int x = s.IndexOf('x'); int w; return x > 0 && int.TryParse(s.Substring(0, x), out w) ? w : 0; }

        public class Desc { public ushort Type; public byte GetSet; public string Current; public List<string> Choices = new List<string>(); }   // GetSet: 1 = the camera lets us change it right now, 0 = read only
        static Desc PropDesc(ushort code)
        {
            byte[] d; uint r = ptp.OpRead(0x1014, out d, code);
            if (r != Ptp.OK || d.Length < 6) return null;
            var rd = new Reader(d);
            var o = new Desc();
            rd.U16(); o.Type = rd.U16(); o.GetSet = rd.U8();
            rd.Value(o.Type); o.Current = rd.Value(o.Type);
            byte form = rd.U8();
            if (form == 2) { int n = rd.U16(); for (int k = 0; k < n; k++) o.Choices.Add(rd.Value(o.Type)); }
            return o;
        }
        static bool SetProp(ushort code, ushort type, string value)
        {
            byte[] data;
            if (type == 0xFFFF)
            {
                var ms = new MemoryStream();
                ms.WriteByte((byte)(value.Length + 1));
                var b = Encoding.Unicode.GetBytes(value + "\0");
                ms.Write(b, 0, b.Length);
                data = ms.ToArray();
            }
            else
            {
                long v = long.Parse(value);
                int size = (type == 1 || type == 2) ? 1 : (type == 3 || type == 4) ? 2 : 4;
                data = new byte[size];
                for (int k = 0; k < size; k++) data[k] = (byte)((v >> (8 * k)) & 0xFF);
            }
            uint r = ptp.OpWrite(0x1016, data, code);
            WaitReady(2000);
            return r == Ptp.OK;
        }

        // ---------- exposure settings for the booth's Camera check (Nikon; standard PTP properties) ----------
        // 0x500E exposure mode (1 manual, 2 program, 3 aperture priority, 4 shutter priority), 0x500D exposure time in 0.0001 s,
        // 0x5007 f-number x 100, 0x500F ISO. The camera says per property whether it can be changed right now (in aperture priority
        // the shutter is the camera's own): a setting it will not take is reported, never forced. The mode itself is the dial: never set.
        // "props" answers {"supported":false} for any other brand, so the booth hides its Apply button.
        static string Dbl(double v) { return v.ToString("0.######", System.Globalization.CultureInfo.InvariantCulture); }
        static double DescNum(Desc d)
        {
            double v;
            return d != null && double.TryParse(d.Current, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out v) ? v : 0;
        }
        static string CanSet(Desc d) { return d != null && d.GetSet == 1 && d.Choices.Count > 0 ? "true" : "false"; }
        static string ExposureJson()
        {
            if (!nikon) return "{\"supported\":false}";
            Desc m = null, t = null, f = null, i = null;
            try { m = PropDesc(0x500E); t = PropDesc(0x500D); f = PropDesc(0x5007); i = PropDesc(0x500F); }
            catch (GoneException) { throw; }
            catch (Exception e) { Log("Exposure settings not read: " + e.Message); }
            if (t == null && f == null && i == null) return "{\"supported\":false}";
            return "{\"supported\":true,\"program\":" + (int)DescNum(m) + ",\"shutter\":" + Dbl(DescNum(t) * 0.0001) + ",\"f\":" + Dbl(DescNum(f) / 100.0) + ",\"iso\":" + (int)DescNum(i) +
                ",\"set\":{\"shutter\":" + CanSet(t) + ",\"f\":" + CanSet(f) + ",\"iso\":" + CanSet(i) + "}}";
        }
        // The camera's own list, the entry nearest (on a log scale) to what was asked for. Entries that are not real values
        // (Auto / Hi / bulb markers sit at the ends of some lists) are skipped.
        static string NearChoice(Desc d, double want, double scale)
        {
            string best = null; double bestD = double.MaxValue;
            foreach (string c in d.Choices)
            {
                double v;
                if (!double.TryParse(c, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out v)) continue;
                double x = v * scale;
                if (x <= 0 || x > 60000) continue;
                double dd = Math.Abs(Math.Log(x) - Math.Log(want));
                if (dd < bestD) { bestD = dd; best = c; }
            }
            return best;
        }
        // arg: "shutter=0.00625&f=5.6&iso=400" (seconds, f-number, ISO; any subset). Answers the settings now plus, per asked setting,
        // "set" | "same" | "locked" (the camera won't change it in this mode) | "refused" | "unsupported".
        static string SetExposure(string arg)
        {
            if (!nikon) return "{\"supported\":false}";
            var want = new Dictionary<string, double>();
            foreach (string kv in (arg ?? "").Split(new char[] { '&', ' ' }, StringSplitOptions.RemoveEmptyEntries))
            {
                int eq = kv.IndexOf('='); double v;
                if (eq > 0 && double.TryParse(kv.Substring(eq + 1), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out v) && v > 0) want[kv.Substring(0, eq)] = v;
            }
            var res = new List<string>();
            foreach (var spec in new object[][] { new object[] { "shutter", (ushort)0x500D, 0.0001 }, new object[] { "f", (ushort)0x5007, 0.01 }, new object[] { "iso", (ushort)0x500F, 1.0 } })
            {
                string key = (string)spec[0]; ushort code = (ushort)spec[1]; double scale = (double)spec[2];
                double w;
                if (!want.TryGetValue(key, out w)) continue;
                string state;
                try
                {
                    Desc d = PropDesc(code);
                    if (d == null) state = "unsupported";
                    else if (d.GetSet != 1 || d.Choices.Count == 0) state = "locked";
                    else
                    {
                        string pick = NearChoice(d, w, scale);
                        state = pick == null ? "unsupported" : pick == d.Current ? "same" : SetProp(code, d.Type, pick) ? "set" : "refused";
                    }
                }
                catch (GoneException) { throw; }
                catch (Exception e) { Log("Exposure setting " + key + " not changed: " + e.Message); state = "refused"; }
                Log("Exposure " + key + " -> " + Dbl(w) + ": " + state);
                res.Add("\"" + key + "\":\"" + state + "\"");
            }
            string now = ExposureJson();
            return now.Substring(0, now.Length - 1) + ",\"results\":{" + string.Join(",", res.ToArray()) + "}}";
        }

        // ---------- live view ----------
        static void StartLive()
        {
            uint r = ptp.Op(0x9201);
            Log("StartLiveView: " + H(r));
            if (r != Ptp.OK && r != 0xA00B && r != Ptp.BUSY)
                throw new CamException("LIVEVIEW The camera refused live view (" + H(r) + "). Put an SD card in the camera, close its menu, turn the mode dial to P and extend the kit lens, then try again.");
            WaitReady(6000);
            live = true;
        }
        static void StopLive()
        {
            if (!live) return;
            // EndLiveView is refused ("busy") while the camera is still saving the last photo, and the booth asks for live view off right
            // after the last photo. Ignoring that left the camera in live view for good, so ask again until it accepts.
            uint r = 0;
            for (int k = 0; k < 14; k++)
            {
                try { r = ptp.Op(0x9202); } catch (GoneException) { throw; } catch { r = 0xFFFF; }
                if (r == Ptp.OK || r == 0xA00B) { live = false; break; }     // 0xA00B: it was not in live view any more
                Thread.Sleep(300);
            }
            if (live) Log("EndLiveView not accepted (" + H(r) + "): live view may still be on, will ask again");
            else WaitReady(3000);
        }
        static int JpegStart(byte[] d) { for (int k = 0; k + 1 < d.Length && k < 4096; k++) if (d[k] == 0xFF && d[k + 1] == 0xD8) return k; return -1; }
        static byte[] Frame()
        {
            if (!live) StartLive();
            // Events are only read when a photo is taken: over hours of live view the camera's list would keep growing.
            if (nikEv.ElapsedMilliseconds > 3000 && Has(0x90C7)) { nikEv.Restart(); DrainEvents(); }
            var sw = Stopwatch.StartNew();
            int restarts = 0;
            uint last = 0;
            while (sw.ElapsedMilliseconds < 2500)
            {
                byte[] lv; uint r = ptp.OpRead(0x9203, out lv);
                last = r;
                if (r == Ptp.OK)
                {
                    int s = JpegStart(lv);
                    if (s >= 0)
                    {
                        int e = lv.Length;
                        for (int k = lv.Length - 2; k > s; k--) if (lv[k] == 0xFF && lv[k + 1] == 0xD9) { e = k + 2; break; }
                        var o = new byte[e - s];
                        Array.Copy(lv, s, o, 0, o.Length);
                        return o;
                    }
                }
                else if (r == 0xA00B && restarts < 2)   // not in live view (it stops after a photo on some models)
                {
                    restarts++; live = false; StartLive(); continue;
                }
                Thread.Sleep(40);
            }
            if (last != Ptp.OK && last != Ptp.BUSY && last != 0)
                throw new CamException("LIVEVIEW The camera sends no live view (" + H(last) + "). Put an SD card in the camera, close its menu and turn the mode dial to P.");
            return null;
        }

        // ---------- photo ----------
        // "miss" when the last Nikon photo was taken without a focus lock (sent to the booth with the photo).
        static string shotFocus = "";
        // The booth's "Classic Nikon behaviour" switch (sent with open / af / capture): the Nikon keeps its old JPEG and autofocus behaviour.
        static bool classicNikon;
        // Nikon live view autofocus: start it and wait until the camera says it is ready again (not a fixed 1.2 s: a D5300 in
        // dim light needs longer), but never more than ~2 s in all (the booth fires the shutter earlier by the camera's whole
        // delay, and that has a limit). One more try if it reported no focus and there is time. true = focused (or not reported).
        // A camera that refuses at once (lens switch on MF, which the booth's own guide recommends) is not a focus miss.
        static bool afRefusedLogged;
        // The booth focuses once during the countdown ("af"), so the shutter at the end only has to fire. The shot right after a good
        // pre-focus skips its own focusing (Nikon: the live view autofocus before the shot; newer Canon: the half press and its wait),
        // so the photo follows the shutter command at once instead of 1-2 s later. Used once and only within 12 s: any other shot
        // (a test shot, a retake the booth did not pre-focus) focuses exactly as it always did.
        static Stopwatch preFocusSw = new Stopwatch();
        static bool preFocusOk;
        static bool canonNoAfBad;   // a Canon press without focusing gave no photo: not used again until the worker restarts
        static bool canonFocusInShot;   // the last Canon photo was focused inside the shot (not beforehand): it came after the flash
        // 0xD108 = Canon EOS FocusMode (0 One Shot, 1 AI Servo, 2 AI Focus, 3 Manual).
        static bool CanonLensMf()
        {
            uint fm;
            return canon && eosVals.TryGetValue(0xD108, out fm) && fm == 3;
        }
        static long TakePreFocus()   // ms since the pre-focus, or -1 when there was none (or it is old)
        {
            long ago = (preFocusOk && preFocusSw.IsRunning && preFocusSw.ElapsedMilliseconds < 12000) ? preFocusSw.ElapsedMilliseconds : -1;
            preFocusOk = false;
            return ago;
        }
        static bool NikonAf()
        {
            var total = Stopwatch.StartNew();
            for (int attempt = 0; attempt < 2; attempt++)
            {
                var one = Stopwatch.StartNew();
                uint r = ptp.Op(0x90C1);
                if (r == Ptp.OK)
                {
                    Thread.Sleep(250);   // the camera starts moving the lens; a "ready" answer before this means nothing
                    WaitReady((int)Math.Max(300, 2000 - total.ElapsedMilliseconds));
                    DrainEvents();
                    Log("Autofocus" + (attempt > 0 ? " (second try)" : "") + ": done in " + total.ElapsedMilliseconds + " ms");
                    return true;
                }
                Log("Autofocus" + (attempt > 0 ? " (second try)" : "") + ": " + H(r) + " after " + one.ElapsedMilliseconds + " ms");
                if (r != 0xA002 && r != Ptp.BUSY) return true;   // not a focus miss (e.g. not in live view): the shot decides
                if (attempt == 0 && one.ElapsedMilliseconds < 200)
                {
                    // Refused straight away: the lens is on MF (or has no autofocus). Nothing to retry and nothing to warn about.
                    if (!afRefusedLogged) { afRefusedLogged = true; Log("Autofocus refused at once: lens on MF? Shooting with the lens as it is"); }
                    return true;
                }
                if (total.ElapsedMilliseconds > 900) break;   // no time for a second try
                Thread.Sleep(250);
            }
            return false;
        }
        static byte[] Capture()
        {
            var sw = Stopwatch.StartNew();
            uint r;
            shotFocus = "";
            long preAgo = TakePreFocus();
            // Focus first while in live view (contrast AF). It waits for the camera to finish focusing and tries once more
            // if the first try missed; a miss still takes the photo, but the booth is told (shotFocus) so it can warn.
            // Not when the booth focused during the countdown a moment ago: then the shutter fires straight away.
            if (preAgo >= 0) Log("Autofocus skipped: the booth focused " + preAgo + " ms ago");
            else if (live && Has(0x90C1) && classicNikon)
            {
                // Classic: focus, then a fixed 1.2 s wait; a miss is fine, the shot decides.
                try
                {
                    r = ptp.Op(0x90C1);
                    if (r == Ptp.OK)
                    {
                        var afSw = Stopwatch.StartNew();
                        while (afSw.ElapsedMilliseconds < 1200) { Thread.Sleep(80); DrainEvents(); }
                    }
                }
                catch (GoneException) { throw; } catch { }
            }
            else if (live && Has(0x90C1))
            {
                try { if (!NikonAf()) shotFocus = "miss"; }
                catch (GoneException) { throw; } catch { }
            }
            DrainEvents();
            if (Has(0x90C0)) r = ptp.Op(0x90C0, 0xFFFFFFFF);    // InitiateCaptureRecInSdram
            else r = ptp.Op(0x100E, 0, 0);
            if (r == 0xA002 && Has(0x9207))
            {
                if (!classicNikon) shotFocus = "miss";
                Log("Out of focus; shooting without autofocus");
                r = ptp.Op(0x9207, 0xFFFFFFFF, 1);    // InitiateCaptureRecInMedia, no AF, to SDRAM
                if (r != Ptp.OK) r = ptp.Op(0x9207, 0xFFFFFFFF, 0);
            }
            if (r == Ptp.BUSY) { WaitReady(3000); r = ptp.Op(0x90C0, 0xFFFFFFFF); }
            if (r != Ptp.OK)
            {
                if (r == 0xA002) throw new CamException("FOCUS The camera couldn't focus, so it didn't take the photo. Point it at something with detail, or set the lens to MF (manual focus).");
                if (r == 0xA00A || r == 0xA009) throw new CamException("CAPTURE The camera can't take a photo right now (" + H(r) + "). Check the memory card isn't full or locked.");
                throw new CamException("CAPTURE The camera refused the photo (" + H(r) + "). Check the mode dial isn't on video and the camera's menu is closed.");
            }
            WaitReady(10000);
            var handles = new List<uint>();
            var ew = Stopwatch.StartNew();
            while (ew.ElapsedMilliseconds < 8000)
            {
                foreach (uint h in Events()) if (!handles.Contains(h)) handles.Add(h);
                if (handles.Count > 0)
                {
                    // Same figure as the Canon's: from the shutter command (so the autofocus above counts too, it is most of a
                    // Nikon's delay) until the camera reports the photo. The booth fires the shutter that much earlier.
                    lastShutterMs = (int)Math.Min(sw.ElapsedMilliseconds, 10000);
                    Log("Shutter lag " + lastShutterMs + " ms");
                    Thread.Sleep(150); foreach (uint h in Events()) if (!handles.Contains(h)) handles.Add(h); break;
                }
                Thread.Sleep(100);
            }
            if (handles.Count == 0) handles.Add(0xFFFF0001);    // the photo in the camera's memory
            uint pick = handles[0];
            if (handles.Count > 1)
            {
                // RAW + JPEG: take the JPEG
                foreach (uint h in handles)
                {
                    try
                    {
                        byte[] oi; uint rr = ptp.OpRead(0x1008, out oi, h);
                        if (rr == Ptp.OK && oi.Length > 6 && (oi[4] | (oi[5] << 8)) == 0x3801) { pick = h; break; }
                    }
                    catch (GoneException) { throw; }
                    catch { }
                }
            }
            string cd = "handles " + string.Join(",", handles.ConvertAll(h => h.ToString("X")).ToArray());
            uint size = 0;
            try
            {
                byte[] oi; uint ro = ptp.OpRead(0x1008, out oi, pick);
                if (ro == Ptp.OK && oi.Length >= 12) size = (uint)(oi[8] | (oi[9] << 8) | (oi[10] << 16) | (oi[11] << 24));
                cd += "; info " + H(ro) + " " + size + " B";
            }
            catch (GoneException) { throw; }
            catch (Exception e) { cd += "; info failed " + e.Message; }
            byte[] img = new byte[0];
            try { r = ptp.OpRead(0x1009, out img, pick); cd += "; get " + H(r) + " " + img.Length + " B"; }
            catch (GoneException) { throw; }
            catch (Exception e) { r = 0; cd += "; get failed " + e.Message; }
            // Windows' driver sometimes hands back nothing for a big photo: fetch it in 1 MB pieces.
            if ((r != Ptp.OK || img.Length < 4 || (size > 0 && img.Length < size)) && size > 0)
            {
                var ms = new MemoryStream((int)size);
                uint off = 0; uint pr = 0;
                while (off < size)
                {
                    byte[] part; pr = ptp.OpRead(0x101B, out part, pick, off, Math.Min(1048576U, size - off));
                    if (pr != Ptp.OK || part.Length == 0) break;
                    ms.Write(part, 0, part.Length); off += (uint)part.Length;
                }
                cd += "; pieces " + H(pr) + " " + off + " B";
                if (off >= size) { img = ms.ToArray(); r = Ptp.OK; }
            }
            Log("Photo download: " + cd);
            if (r != Ptp.OK || img.Length < 4) throw new CamException("CAPTURE The photo didn't come through from the camera (" + H(r) + "; " + cd + ").");
            if (!(img[0] == 0xFF && img[1] == 0xD8)) throw new CamException("CAPTURE The camera saved a RAW photo. Set Image quality to JPEG on the camera.");
            Log("Photo " + (img.Length / 1024) + " KB in " + sw.ElapsedMilliseconds + " ms");
            // Live view resumes by itself on most models; Frame() restarts it if not.
            return img;
        }
        static void DrainEvents() { try { Events(); } catch (GoneException) { throw; } catch { } }
        // New photo handles from Nikon's event queue (ObjectAdded 0x4002 / 0xC101).
        static List<uint> Events()
        {
            var l = new List<uint>();
            if (!Has(0x90C7)) return l;
            byte[] evd; uint r = ptp.OpRead(0x90C7, out evd);
            if (r == Ptp.OK && evd.Length >= 2)
            {
                var er = new Reader(evd); int cnt = er.U16();
                for (int k = 0; k < cnt && er.Pos + 6 <= evd.Length; k++)
                {
                    ushort code = er.U16(); uint p = er.U32();
                    if (code == 0x4002 || code == 0xC101) l.Add(p);
                }
            }
            return l;
        }

        // Is the open camera still answering? (Throws when it's gone.)
        static void Alive()
        {
            if (nikon) { ptp.Op(0x90C8); return; }
            if (canon && Has(0x911D)) { ptp.Op(0x911D); return; }   // KeepDeviceOn: also stops it sleeping
            byte[] d; ptp.OpRead(0x1001, out d);
        }

        // ================= Canon EOS =================
        // Canon's own PTP commands (the same ones EOS Utility and gphoto2 use):
        // 0x9114 remote mode, 0x9115 event mode, 0x9116 events, 0x9110 set a setting,
        // 0x9153 live view picture, 0x910F / 0x9128-0x9129 shutter, 0x9107 photo in pieces, 0x9117 transfer done.
        const uint NOTREADY = 0xA102;   // Canon: "not ready yet, ask again"
        static Dictionary<ushort, uint> eosVals = new Dictionary<ushort, uint>();
        static List<uint[]> canonNew = new List<uint[]>();   // new files: { handle, event, format, size }
        // "Save to" (0xD11C): where the camera puts a new photo. Bit 1 = the SD card (the default), bit 4 = the computer (the camera's
        // memory; libgphoto2 calls it "Internal RAM"). With the card the camera finishes writing the whole JPEG (and RAW) to the card
        // before it says the photo exists: seconds of "Saving". To the computer, the photo is announced as soon as it is taken.
        const ushort EOS_SAVETO = 0xD11C;
        const uint SAVETO_CARD = 2, SAVETO_HOST = 4;
        static Dictionary<ushort, List<uint>> eosAvail = new Dictionary<ushort, List<uint>>();   // the values the camera says a setting can take
        static bool canonToHost;          // the camera is set to send photos to the computer (put back on the card when we let go of it)
        static bool canonHostGaveUp;      // it didn't work with this camera: photos stay on the card until the worker is restarted
        static bool canonHostWorked;      // a photo has come through that way
        static uint canonDestOrig = SAVETO_CARD;
        // How long the camera took lately from the shutter command to announcing the photo (newest last, the last three). The
        // slowest of them is "how slow this camera is right now": a photo still missing after about twice that is not coming.
        static List<int> canonLags = new List<int>();
        static void CanonNoteLag(int ms) { canonLags.Add(ms); while (canonLags.Count > 3) canonLags.RemoveAt(0); }
        static int CanonLag() { int m = 0; foreach (int v in canonLags) if (v > m) m = v; return m; }
        // How long to wait for the camera to announce the photo before pressing the shutter again. The old limits (6 s on an older
        // EOS, 8 s on a newer one, 8 s after a retry) date from when every photo had to be written to the card first. Once photos
        // come straight to the computer (fast = they have, and at least two recent ones were timed), a photo that is not there after
        // about twice the camera's own delay is not coming: press again sooner. Never under 3.5 s (4.5 s after a retry), never over
        // the old limit; until a couple of photos have shown how fast the camera is, the old limits stay.
        static int CanonWaitLimit(int attempt, bool oldEos, int lagMs, bool fast)
        {
            int old = attempt > 0 ? 8000 : (oldEos ? 6000 : 8000);
            if (!fast || lagMs <= 0) return old;
            int floor = attempt > 0 ? 4500 : 3500;
            return Math.Min(old, Math.Max(floor, lagMs * 2 + 1500));
        }
        // The last photo ended here; the first live view picture after it logs how long the camera took to bring live view back.
        static Stopwatch canonShotEnd = new Stopwatch();
        static bool canonLiveBackPending;        static Stopwatch liveSw = new Stopwatch(), keepSw = new Stopwatch(), pollSw = new Stopwatch();
        static bool gotFrame;
        // How long the last photo took from the shutter command until the camera reported it (focus + exposure + saving);
        // the booth reads it to fire the shutter that much earlier, so the photo lands on "Pose".
        static int lastShutterMs = 0;

        static uint U32(byte[] b, int i) { return (uint)(b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)); }
        static uint U16(byte[] b, int i) { return (uint)(b[i] | (b[i + 1] << 8)); }

        static uint OpRetry(ushort code, params uint[] ps)
        {
            var sw = Stopwatch.StartNew();
            while (true)
            {
                uint r = ptp.Op(code, ps);
                if ((r != Ptp.BUSY && r != NOTREADY) || sw.ElapsedMilliseconds > 3000) return r;
                Thread.Sleep(60);
            }
        }

        // SetDevicePropValueEx: { size 12, setting, value }
        static uint SetEos(ushort prop, uint val)
        {
            var b = new byte[12];
            uint[] w = { 12, prop, val };
            for (int k = 0; k < 12; k++) b[k] = (byte)((w[k / 4] >> (8 * (k % 4))) & 0xFF);
            var sw = Stopwatch.StartNew();
            uint r;
            while (true)
            {
                r = ptp.OpWrite(0x9110, b);
                if ((r != Ptp.BUSY && r != NOTREADY) || sw.ElapsedMilliseconds > 3000) break;
                Thread.Sleep(60);
            }
            Log("Set " + H(prop) + " = " + val + ": " + H(r));
            if (r == Ptp.OK) eosVals[prop] = val;
            return r;
        }

        // The event types the camera sent since the last shutter command (hex, once each), and the last poll answer:
        // when a photo never shows up, camera.log says what the camera did say instead.
        static List<string> evSeen = new List<string>();
        static string lastPollAnswer = "";

        // A photo size read from an event: a camera model with another event layout puts file-name letters where the 60D
        // has the size, which reads as a gigabyte. A size nobody can believe is "unknown" (the real size is asked for later).
        static uint SaneSize(uint s) { return s > 0x10000000 ? 0 : s; }

        // Reads the camera's news: changed settings, and new photos.
        static void CanonPoll()
        {
            pollSw.Restart();
            byte[] d; uint r = ptp.OpRead(0x9116, out d);
            lastPollAnswer = H(r) + (d != null ? " " + d.Length + " B" : "");
            if (r != Ptp.OK || d == null) return;
            int off = 0;
            while (off + 8 <= d.Length)
            {
                uint size = U32(d, off), type = U32(d, off + 4);
                if (size < 8 || off + size > d.Length || type == 0) break;
                int end = off + (int)size;
                if (type != 0xC189 && type != 0xC18A) { string th = type.ToString("X"); if (!evSeen.Contains(th) && evSeen.Count < 24) evSeen.Add(th); }
                if (type == 0xC189 && size >= 16) eosVals[(ushort)U32(d, off + 8)] = U32(d, off + 12);   // a setting changed
                else if (type == 0xC18A && size >= 20) CanonAvail(d, off, (int)size);   // the values a setting can take
                else if ((type == 0xC181 || type == 0xC1A7) && size >= 12)   // a photo was saved on the card
                    canonNew.Add(new uint[] { U32(d, off + 8), type, off + 0x12 <= end ? U16(d, off + 0x10) : 0, off + 0x20 <= end ? SaneSize(U32(d, off + 0x1C)) : 0 });
                else if ((type == 0xC186 || type == 0xC1A9 || type == 0xC1B8) && size >= 12)   // a photo waits in the camera's memory for us (newer bodies use the 64-bit versions of this event, same layout)
                    canonNew.Add(new uint[] { U32(d, off + 8), type, off + 0x0E <= end ? U16(d, off + 0x0C) : 0, off + 0x18 <= end ? SaneSize(U32(d, off + 0x14)) : 0 });
                off = end;
            }
        }

        // 0xC18A: { size, 0xC18A, setting, data type, count, values... }. Only "Save to" is kept; the size of one value comes from the
        // event's own length, so a model that sends 16 bit or 32 bit values reads the same way. Anything odd is ignored.
        static void CanonAvail(byte[] d, int off, int size)
        {
            if ((ushort)U32(d, off + 8) != EOS_SAVETO) return;
            uint cnt = U32(d, off + 16);
            int room = size - 20;
            if (cnt == 0 || cnt > 64 || room <= 0 || room % (int)cnt != 0) return;
            int es = room / (int)cnt;
            if (es != 1 && es != 2 && es != 4) return;
            var l = new List<uint>();
            for (int k = 0; k < (int)cnt; k++)
            {
                int p = off + 20 + k * es;
                l.Add(es == 4 ? U32(d, p) : es == 2 ? U16(d, p) : d[p]);
            }
            eosAvail[EOS_SAVETO] = l;
        }

        // Photos to the computer, not the SD card (see EOS_SAVETO). Never fails the session: a camera that doesn't list the
        // setting, doesn't offer "computer" or refuses it just keeps saving to the card the way it always did.
        static void CanonToHost()
        {
            canonToHost = false;
            if (canonHostGaveUp) return;
            uint cur;
            if (!eosVals.TryGetValue(EOS_SAVETO, out cur)) { Log("Save to: this camera doesn't list it, photos stay on the card"); return; }
            List<uint> av;
            bool known = eosAvail.TryGetValue(EOS_SAVETO, out av);
            string offered = known ? string.Join("/", av.ConvertAll(v => v.ToString()).ToArray()) : "unknown";
            if (cur == SAVETO_HOST)
            {
                // Left that way by a session that never said goodbye: keep it, and put it back on the card at the end.
                canonDestOrig = known && !av.Contains(SAVETO_CARD) && av.Contains(1) ? 1U : SAVETO_CARD;
                canonToHost = true;
                Log("Save to: already the computer (the last session didn't put it back); will return it to the card when done");
                return;
            }
            if (known && !av.Contains(SAVETO_HOST)) { Log("Save to: the camera doesn't offer the computer (offers " + offered + "), photos stay on the card"); return; }
            uint r = SetEos(EOS_SAVETO, SAVETO_HOST);
            if (r != Ptp.OK) { eosVals[EOS_SAVETO] = cur; Log("Save to the computer: the camera refused (" + H(r) + "), photos stay on the card"); return; }
            CanonPoll();   // the camera confirms with a "setting changed" event
            uint now;
            if (eosVals.TryGetValue(EOS_SAVETO, out now) && now != SAVETO_HOST) { Log("Save to the computer: the camera kept " + now + ", photos stay on the card"); return; }
            canonDestOrig = cur;
            canonToHost = true;
            Log("Save to: the computer (was " + cur + "; the camera offers " + offered + "). Photos no longer wait for the SD card");
        }

        // Back to the card: when the camera is let go of, or when sending to the computer proved not to work with this camera.
        static void CanonToCard(bool giveUp)
        {
            if (giveUp) canonHostGaveUp = true;
            if (!canonToHost) return;
            canonToHost = false;
            try { uint r = SetEos(EOS_SAVETO, canonDestOrig); Log("Save to: back to the card: " + H(r)); }
            catch (GoneException) { throw; }
            catch { }
        }

        static void PrepareCanon()
        {
            setupNote = "";
            eosVals.Clear(); eosAvail.Clear(); canonNew.Clear(); gotFrame = false;
            canonToHost = false; canonLags.Clear(); canonLiveBackPending = false; canonFocusInShot = false;
            if (recoverNext)
            {
                recoverNext = false;
                try { ptp.Op(0x9115, 0); } catch (GoneException) { throw; } catch { }
                try { ptp.Op(0x9114, 0); } catch (GoneException) { throw; } catch { }
                Log("Reset the camera's remote mode before connecting (the last session ended without a goodbye)");
                Thread.Sleep(600);
            }
            uint r = OpRetry(0x9114, 1);   // remote mode on
            Log("SetRemoteMode: " + H(r));
            uint r2 = OpRetry(0x9115, 1);  // send events when asked
            Log("SetEventMode: " + H(r2));
            if (r != Ptp.OK && r2 != Ptp.OK)
                throw new CamException("UNSUPPORTED The " + camName + " didn't accept remote control (" + H(r) + "). Canon EOS cameras work; most PowerShot / compact cameras don't. On an EOS: close EOS Utility, switch the camera off and on, and try again.");
            CanonPoll();   // the first batch lists all settings
            ReadInfo();    // in remote mode the camera lists more commands
            CanonPoll();
            if (!Has(0x9153))
                throw new CamException("UNSUPPORTED The " + camName + " doesn't send live view over USB.");
            if (!Has(0x910F) && !Has(0x9128))
                throw new CamException("UNSUPPORTED The " + camName + " doesn't take photos over USB.");
            lastShutterMs = 0;
            CanonSingleShot();
            try { CanonToHost(); }
            catch (GoneException) { throw; }
            catch (Exception e) { Log("Save to the computer not set: " + e.Message); }
            keepSw.Restart();
        }

        // A camera left on its self-timer (the beeps that speed up before the photo) takes the picture 2 or 10 seconds after
        // the shutter command, long after the guests' "Pose". Put it back on single shot; never fails the session if it can't.
        static void CanonSingleShot()
        {
            uint dm;
            if (!eosVals.TryGetValue(0xD106, out dm)) return;
            bool timer = dm == 0x07 || (dm >= 0x10 && dm <= 0x1F);
            if (!timer) return;
            try
            {
                uint r = SetEos(0xD106, 0);
                Log("Drive mode was a self-timer (" + dm + "): set to single shot: " + H(r));
                if (r == Ptp.OK) setupNote += "Camera was on self-timer; set to single shot. ";
                else setupNote += "Camera is on self-timer: switch its drive mode to single shot. ";
            }
            catch (GoneException) { throw; }
            catch (Exception e) { Log("Drive mode not changed: " + e.Message); }
        }

        // Every few seconds: read news (keeps the camera's list short) and keep it awake.
        static void CanonKeep()
        {
            if (!pollSw.IsRunning || pollSw.ElapsedMilliseconds > 2000) CanonPoll();
            // Not only when the camera lists KeepDeviceOn: some older EOS (60D) don't list it but still stay awake when it is sent.
            if (keepSw.ElapsedMilliseconds > 10000) { try { ptp.Op(0x911D); } catch (GoneException) { throw; } catch { } keepSw.Restart(); }
        }

        static void CanonLiveOn()
        {
            bool started = false;
            if (Has(0x9151)) { uint ri = OpRetry(0x9151); Log("InitiateViewfinder: " + H(ri)); started = ri == Ptp.OK; }
            if (eosVals.ContainsKey(0xD1B1) && eosVals[0xD1B1] != 1) SetEos(0xD1B1, 1);   // live view mode
            uint r = SetEos(0xD1B0, 2);   // live view to the computer (mirror up)
            // Still saving the last photo (a RAW + JPEG on a slow card can take several seconds): not an error, the next frame asks again.
            if (r != Ptp.OK && !started && (r == Ptp.BUSY || r == NOTREADY)) { live = false; Log("Live view: camera still busy (" + H(r) + "), will ask again"); return; }
            if (r != Ptp.OK && !started)
                throw new CamException("LIVEVIEW The camera refused live view (" + H(r) + "). On the camera: Menu, Live View shoot: Enable; close the menu; mode dial on P, Tv, Av or M. Then try again.");
            live = true; gotFrame = false; liveSw.Restart();
        }
        static void CanonLiveOff()
        {
            if (!live) return;
            try { SetEos(0xD1B0, 0); if (Has(0x9152)) ptp.Op(0x9152); }
            catch (GoneException) { throw; }
            catch { }
            live = false;
        }
        // The camera ended live view by itself (after a photo, its own timeout, a sleep): the "live" flag still says it is
        // on, so start it again from the beginning (not only the live view mode) instead of waiting for frames that never come.
        static void CanonRestartLive()
        {
            Log("Live view stopped: starting it again");
            live = false;
            CanonLiveOn();
        }

        // The live view data is a list of blocks { length, type, data }; one of them is the JPEG.
        static byte[] EosJpeg(byte[] d)
        {
            if (d == null || d.Length < 12) return null;
            int off = 0;
            while (off + 8 <= d.Length)
            {
                int len = (int)U32(d, off);
                if (len < 8 || off + len > d.Length) break;
                if (len > 12 && d[off + 8] == 0xFF && d[off + 9] == 0xD8)
                {
                    var o = new byte[len - 8];
                    Array.Copy(d, off + 8, o, 0, o.Length);
                    return o;
                }
                off += len;
            }
            int s = JpegStart(d);
            if (s < 0) return null;
            int e = d.Length;
            for (int k = d.Length - 2; k > s; k--) if (d[k] == 0xFF && d[k + 1] == 0xD9) { e = k + 2; break; }
            var o2 = new byte[e - s];
            Array.Copy(d, s, o2, 0, o2.Length);
            return o2;
        }

        static byte[] CanonFrame()
        {
            if (!live) { CanonLiveOn(); if (!live) { Thread.Sleep(400); return null; } }   // camera still busy: no picture yet, ask again
            var sw = Stopwatch.StartNew();
            uint last = 0;
            bool kicked = false, rearmed = false;
            while (sw.ElapsedMilliseconds < 3000)
            {
                CanonKeep();
                byte[] d; uint r = ptp.OpRead(0x9153, out d, 0x00100000);
                last = r;
                if (r == Ptp.OK)
                {
                    var j = EosJpeg(d);
                    if (j != null)
                    {
                        gotFrame = true;
                        if (canonLiveBackPending) { canonLiveBackPending = false; Log("Live view back " + canonShotEnd.ElapsedMilliseconds + " ms after the photo"); }
                        return j;
                    }
                }
                else if (r != Ptp.BUSY && r != NOTREADY)
                {
                    // The camera ended live view by itself (heat, its time limit, a photo from its own button): switch it back on once.
                    if (gotFrame && !rearmed)
                    {
                        rearmed = true;
                        Log("Live view was stopped by the camera (" + H(r) + "): switching it back on");
                        try { CanonLiveOn(); } catch (GoneException) { throw; } catch (CamException) { throw; } catch { }
                        Thread.Sleep(150);
                        continue;
                    }
                    break;
                }
                // Some models leave live view after a photo or a camera timeout and then only answer "busy" or nothing:
                // start it again from the beginning, once per request.
                if (!kicked && sw.ElapsedMilliseconds > 1200 && liveSw.ElapsedMilliseconds > 4000) { kicked = true; CanonRestartLive(); }
                Thread.Sleep(50);
            }
            if (last != Ptp.OK && last != Ptp.BUSY && last != NOTREADY && last != 0)
                throw new CamException("LIVEVIEW The camera sends no live view (" + H(last) + "). On the camera: Menu, Live View shoot: Enable; close the menu; mode dial on P, Tv, Av or M.");
            if (!gotFrame && liveSw.ElapsedMilliseconds > 9000)
                throw new CamException("LIVEVIEW The camera isn't sending live view. On the camera: Menu, Live View shoot: Enable (on the 60D / 70D it's in the red camera menu); close the menu; mode dial on P, Tv, Av or M. Then try again.");
            return null;
        }

        static CamException CanonShotError(uint r, uint res)
        {
            if (res == 1) return new CamException("FOCUS The camera couldn't focus, so it didn't take the photo. Point it at something with detail, or set the lens to MF (manual focus).");
            if (res == 3) return new CamException("CAPTURE The camera wasn't ready to shoot (its mirror was still up for live view). Try again in a moment; if it keeps happening, switch the camera off and on.");
            if (res == 8) return new CamException("CAPTURE The camera can't save the photo: its SD card is locked (write-protect switch). Slide the switch on the side of the card up, or use another card.");
            if (res == 7) return new CamException("CAPTURE The camera can't save the photo (result " + res + "). Check there's an SD card in the camera and it isn't full or locked.");
            if (r == Ptp.BUSY || r == NOTREADY) return new CamException("CAPTURE The camera is busy (still saving the last photo?). Try again in a moment.");
            return new CamException("CAPTURE The camera refused the photo (" + H(r) + (res != 0 ? ", result " + res : "") + "). Close the camera's menu, set the mode dial to P, Tv, Av or M (not video), and check the SD card.");
        }

        // A mirrorless EOS (R, RP, R5/R6/R7/R8/R10/R50..., M-series) or a DSLR (6D, 70D, 5D, 7D, Rebel...). libgphoto2 (the
        // reference for these cameras) shoots a DSLR with half press, wait for focus, full press, release; the one-command
        // "full press" (3) is only its way for the EOS M. Model unknown: treated as mirrorless (the way it always worked).
        static bool CanonIsDslr()
        {
            string m = ((camName ?? "") + " " + (camModel ?? "")).ToUpperInvariant();
            if (m.IndexOf("EOS") < 0) return false;
            return !Regex.IsMatch(m, @"\bEOS (R\d*|RP|RA|M\d*)\b");
        }

        // How to press the shutter on a newer EOS (it lists 0x9128):
        //   0 = half press, wait for focus, full press, release (DSLR)
        //   1 = one "full press" command (3), falling back to the DSLR sequence if the camera refuses it (mirrorless)
        //   2 = full press without waiting for autofocus (the last resort when it keeps failing to focus on a dim or plain scene)
        static uint CanonFireNew(int mode)
        {
            if (mode == 0) return CanonHalfFull();
            uint r = OpRetry(0x9128, 3, mode == 2 ? 1U : 0U);
            Log("RemoteReleaseOn(" + (mode == 2 ? "no AF" : "full") + "): " + H(r));
            if (r == Ptp.OK) { try { OpRetry(0x9129, 3); } catch (GoneException) { throw; } catch { } }
            else if (mode == 1) r = CanonHalfFull();
            return r;
        }

        static uint CanonHalfFull()
        {
            uint h = OpRetry(0x9128, 1, 0);   // half press (focus)
            if (h == Ptp.OK)
            {
                // Give the autofocus a moment (libgphoto2 waits up to 500 ms) before the full press.
                var fw = Stopwatch.StartNew();
                while (fw.ElapsedMilliseconds < 550) { CanonPoll(); Thread.Sleep(60); }
            }
            uint f = h == Ptp.OK ? OpRetry(0x9128, 2, 0) : h;   // full press
            try { OpRetry(0x9129, 2); OpRetry(0x9129, 1); } catch (GoneException) { throw; } catch { }
            Log("Half / full press: " + H(h) + " / " + H(f));
            return f;
        }

        static byte[] CanonCapture()
        {
            var sw = Stopwatch.StartNew();
            CanonPoll();
            CanonSingleShot();   // the operator may have turned the self-timer on since the session started
            canonNew.Clear();
            evSeen.Clear();
            sw.Restart();        // the shutter lag is counted from the shutter command
            uint r;
            int baseMode = CanonIsDslr() ? 0 : 1;   // see CanonFireNew
            // The booth focused during the countdown a moment ago: a newer EOS is then shot without focusing again (in live view the
            // half press refocuses, which takes up to a second after the shutter moment). If that press ever gives no photo, or is
            // refused, the camera goes back to focusing in the shot and the shortcut is not used again (canonNoAfBad).
            long preAgo = TakePreFocus();
            bool lensMf = CanonLensMf();
            bool noAf = (preAgo >= 0 || lensMf) && ops.Contains(0x9128) && !canonNoAfBad;
            int firstMode = noAf ? 2 : baseMode;
            if (lensMf) Log("Lens is on MF: shooting without autofocus");
            else if (noAf) Log("Focused " + preAgo + " ms ago: pressing the shutter without focusing again");
            if (ops.Contains(0x9128))
            {
                // Newer EOS: a DSLR (6D, 70D...) is shot the way libgphoto2 does it (half press, focus, full press); a mirrorless one with the one-command press.
                r = CanonFireNew(firstMode);
                if (r != Ptp.OK && noAf)
                {
                    Log("The press without focusing was refused (" + H(r) + "): focusing and shooting the usual way");
                    noAf = false; canonNoAfBad = true;
                    r = CanonFireNew(baseMode);
                }
                if (r != Ptp.OK) throw CanonShotError(r, 0);
            }
            else
            {
                // Older EOS (60D, 7D, 550D...): one command; its answer says if it fired.
                uint[] ans;
                r = ptp.OpP(0x910F, out ans);
                if (r == Ptp.BUSY || r == NOTREADY) { Thread.Sleep(400); r = ptp.OpP(0x910F, out ans); }
                uint res = ans.Length > 0 ? ans[0] : 0;
                Log("RemoteRelease: " + H(r) + ", result " + res);
                if (r == Ptp.OK && res == 3)
                {
                    // Result 3 = the mirror is still up (live view): end live view and press again once.
                    Log("Mirror still up (result 3): ending live view and pressing again");
                    try { SetEos(0xD1B0, 0); if (Has(0x9152)) ptp.Op(0x9152); }
                    catch (GoneException) { throw; }
                    catch { }
                    live = false;
                    Thread.Sleep(600);
                    r = ptp.OpP(0x910F, out ans);
                    if (r == Ptp.BUSY || r == NOTREADY) { Thread.Sleep(400); r = ptp.OpP(0x910F, out ans); }
                    res = ans.Length > 0 ? ans[0] : 0;
                    Log("RemoteRelease (after mirror down): " + H(r) + ", result " + res);
                }
                if (r != Ptp.OK || res != 0) throw CanonShotError(r, res);
            }
            canonFocusInShot = !noAf && !lensMf;   // the booth's Canon guide: a camera that focuses inside the shot takes its photo after the flash
            // Wait for the camera to say where the photo is (RAW + JPEG: two files).
            var files = new List<uint[]>();
            var ew = Stopwatch.StartNew();
            long firstAt = -1;
            // Older EOS (60D...): a photo that is going to come reports itself within a few seconds, so don't leave the guest
            // waiting 15 s. If the camera said OK but never fired (live view focus lost on a moving guest), end live view and
            // press the shutter once more: out of live view the camera focuses with its fast viewfinder sensor.
            // Newer EOS (6D...): the same, with up to two more tries: 1) live view off, the shutter again (the camera then focuses
            // with its viewfinder sensor, which a dim or plain scene doesn't stop the way it stops live view focus);
            // 2) the shutter without waiting for autofocus. A photo that came late from an earlier try is still used.
            bool oldEos = !ops.Contains(0x9128);
            int attempt = 0, maxAttempt = oldEos ? 1 : 2;
            bool skipWait = false;   // the camera refused the last try: nothing to wait for, go on to the next one
            while (true)
            {
                int limit = CanonWaitLimit(attempt, oldEos, CanonLag(), canonHostWorked && canonLags.Count >= 2);
                if (attempt == 0 && noAf) limit = Math.Min(limit, 3500);   // no focusing to wait for: a photo that is not there by now is not coming
                while (!skipWait && ew.ElapsedMilliseconds < limit)
                {
                    CanonPoll();
                    foreach (var o in canonNew) if (o[2] != 0x3001) files.Add(o);   // not folders
                    canonNew.Clear();
                    // A retried photo's time includes the wait for the first try: it is not the camera's real delay, never learn it.
                    if (files.Count > 0 && firstAt < 0) { firstAt = ew.ElapsedMilliseconds; if (attempt == 0) { lastShutterMs = (int)Math.Min(sw.ElapsedMilliseconds, 10000); CanonNoteLag(lastShutterMs); Log("Shutter lag " + lastShutterMs + " ms"); } }
                    if (firstAt >= 0 && ew.ElapsedMilliseconds - firstAt > 350) break;
                    Thread.Sleep(80);
                }
                skipWait = false;
                if (files.Count > 0 || attempt >= maxAttempt) break;
                attempt++;
                if (attempt == 1)
                {
                    Log((oldEos ? "Older EOS" : "EOS") + ": no photo " + ew.ElapsedMilliseconds + " ms after the shutter (last poll " + lastPollAnswer + "; events seen: " + (evSeen.Count > 0 ? string.Join(" ", evSeen.ToArray()) : "none") + "). Ending live view and pressing the shutter once more");
                    try { SetEos(0xD1B0, 0); if (Has(0x9152)) ptp.Op(0x9152); }
                    catch (GoneException) { throw; }
                    catch { }
                    live = false;
                    Thread.Sleep(500);
                    CanonPoll(); canonNew.Clear();
                }
                else Log("EOS: still no photo " + ew.ElapsedMilliseconds + " ms after the shutter. Pressing it once more without waiting for autofocus");
                if (oldEos)
                {
                    uint[] ans2;
                    uint r2 = ptp.OpP(0x910F, out ans2);
                    if (r2 == Ptp.BUSY || r2 == NOTREADY) { Thread.Sleep(400); r2 = ptp.OpP(0x910F, out ans2); }
                    uint res2 = ans2.Length > 0 ? ans2[0] : 0;
                    Log("RemoteRelease (second try): " + H(r2) + ", result " + res2);
                    // "Busy" = the camera is still working on the first press (a slow focus, not a lost one): wait for its photo
                    // like before instead of failing the shot.
                    if (r2 == Ptp.BUSY || r2 == NOTREADY) Log("The camera is still busy with the first press: waiting for its photo");
                    else if (r2 != Ptp.OK || res2 != 0) throw CanonShotError(r2, res2);
                }
                else
                {
                    uint r2 = CanonFireNew(attempt >= 2 ? 2 : baseMode);
                    bool busy2 = r2 == Ptp.BUSY || r2 == NOTREADY;   // still working on the last press: wait for its photo, don't press on
                    if (busy2) Log("The camera is still busy with the last press: waiting for its photo");
                    else if (r2 != Ptp.OK && attempt >= maxAttempt) throw CanonShotError(r2, 0);
                    skipWait = r2 != Ptp.OK && !busy2;
                }
                ew.Restart();
            }
            if (noAf && attempt > 0) { canonNoAfBad = true; Log("The press without focusing gave no photo: from now on this camera focuses in the shot again"); }
            if (files.Count == 0)
            {
                Log("No photo from the camera after " + (attempt + 1) + " tries (last poll " + lastPollAnswer + "; events seen: " + (evSeen.Count > 0 ? string.Join(" ", evSeen.ToArray()) : "none") + ")");
                // Never leave the shutter button held down: the next live view / photo would be refused.
                try { ptp.Op(0x9129, 3); } catch (GoneException) { throw; } catch { }
                // Sending photos to the computer has never delivered one on this camera: it may be the cause, so go back to the card.
                if (canonToHost && !canonHostWorked) { Log("No photo yet since the camera was set to send photos to the computer: putting it back on the card"); CanonToCard(true); }
                throw new CamException("FOCUS The camera didn't take a photo. It may not have focused: point it at something with detail, or set the lens to MF (manual focus). Also check there's an SD card in the camera and it isn't full or locked.");
            }
            long eventMs = firstAt;   // from the shutter command (or the last retry) to the camera announcing the photo
            // Where the camera put it: 0xC186 / 0xC1A9 / 0xC1B8 = waiting in its memory for us; 0xC181 / 0xC1A7 = already on the card.
            bool ramPhoto = false, cardPhoto = false;
            foreach (var o in files) { if (o[1] == 0xC186 || o[1] == 0xC1A9 || o[1] == 0xC1B8) ramPhoto = true; else cardPhoto = true; }
            if (canonToHost && !ramPhoto && cardPhoto)
            {
                // Set to "computer" but the camera still wrote to the card: it ignores the setting. Put it back, don't try again.
                Log("The camera reported the photo on its card although it was set to send it to the computer: putting it back on the card");
                CanonToCard(true);
            }
            string cd = (ramPhoto ? "sent to computer" : "on card") + " files " + string.Join(",", files.ConvertAll(o => o[0].ToString("X") + "/" + o[2].ToString("X")).ToArray());
            var dlSw = Stopwatch.StartNew();
            // JPEG first, then anything else that isn't RAW (CRW / CR2 / CR3).
            var order = new List<uint[]>();
            foreach (var o in files) if (o[2] == 0x3801) order.Add(o);
            foreach (var o in files) if (o[2] != 0x3801 && o[2] != 0xB101 && o[2] != 0xB103 && o[2] != 0xB108) order.Add(o);
            byte[] img = null;
            try
            {
                foreach (var o in order)
                {
                    var b = CanonDownload(o[0], o[3], ref cd);
                    if (b.Length > 4 && b[0] == 0xFF && b[1] == 0xD8) { img = b; break; }
                }
            }
            finally
            {
                // Photos waiting in the camera's memory: tell it we're done so it frees them.
                foreach (var o in files) if (o[1] == 0xC186 || o[1] == 0xC1A9 || o[1] == 0xC1B8) { try { ptp.Op(0x9117, o[0]); } catch (GoneException) { throw; } catch { } }
            }
            Log("Photo download: " + cd);
            if (img == null)
            {
                // A photo the camera held in its memory for us that never came through: don't leave the setting on.
                if (ramPhoto && canonToHost && !canonHostWorked) { Log("The photo didn't come through from the camera's memory: putting it back on the card"); CanonToCard(true); }
                if (order.Count == 0) throw new CamException("CAPTURE The camera saved a RAW photo. Set Image quality to JPEG on the camera (L, M or S; RAW + JPEG also works).");
                throw new CamException("CAPTURE The photo didn't come through from the camera (" + cd + ").");
            }
            if (ramPhoto && canonToHost) canonHostWorked = true;
            Log("Photo " + (img.Length / 1024) + " KB in " + sw.ElapsedMilliseconds + " ms (announced after " + eventMs + " ms, download " + dlSw.ElapsedMilliseconds + " ms, " + (ramPhoto ? "sent to computer" : "via card") + ")");
            return img;
        }

        static byte[] CanonDownload(uint h, uint size, ref string cd)
        {
            if (size == 0)
            {
                try { byte[] oi; uint ro = ptp.OpRead(0x1008, out oi, h); if (ro == Ptp.OK && oi.Length >= 12) size = U32(oi, 8); cd += "; info " + H(ro) + " " + size + " B"; }
                catch (GoneException) { throw; }
                catch (Exception e) { cd += "; info failed " + e.Message; }
            }
            byte[] img = new byte[0];
            uint r;
            try { r = ptp.OpRead(0x1009, out img, h); cd += "; get " + H(r) + " " + img.Length + " B"; }
            catch (GoneException) { throw; }
            catch (Exception e) { r = 0; cd += "; get failed " + e.Message; }
            if ((r != Ptp.OK || img.Length < 4 || (size > 0 && img.Length < size)) && size > 0)
            {
                // In 1 MB pieces (Canon's own command, then the standard one).
                ushort piece = Has(0x9107) ? (ushort)0x9107 : (ushort)0x101B;
                var ms = new MemoryStream((int)size);
                uint off = 0, pr = 0;
                while (off < size)
                {
                    byte[] part; pr = ptp.OpRead(piece, out part, h, off, Math.Min(1048576U, size - off));
                    if (pr != Ptp.OK || part.Length == 0) break;
                    ms.Write(part, 0, part.Length); off += (uint)part.Length;
                }
                cd += "; pieces " + H(piece) + " " + H(pr) + " " + off + " B";
                if (off >= size) { img = ms.ToArray(); r = Ptp.OK; }
            }
            return r == Ptp.OK ? img : new byte[0];
        }

        // ================= Sony Alpha (PC Remote mode) =================
        // Sony's own PTP commands (the same ones gphoto2 and Sony's remote tools use):
        // connect 0x9201 (phases 1, 2, 3), extended device info 0x9202, all properties 0x9209,
        // set property 0x9205, buttons 0x9207 (shutter half press 0xD2C1, full press 0xD2C2),
        // live view = object 0xFFFFC002, a new photo = property 0xD215 >= 0x8000, then object 0xFFFFC001.
        const uint SONY_LV = 0xFFFFC002, SONY_PHOTO = 0xFFFFC001;
        const string SONY_HINT = "On the camera set PC Remote: On (MENU > Network > PC Remote Function) and USB Connection to PC Remote (MENU > Setup > USB), close Imaging Edge and other camera apps, switch the camera off and on, unplug and replug the USB cable, then try again.";
        static int sonyVer = 2;
        static Stopwatch sonyClock;
        static bool sonyDestBlocked = false;

        static string SonyName(string model)
        {
            string key = (model ?? "").ToUpperInvariant().Replace("SONY", "").Trim();
            string[] map = {
                "ILCE-7M2", "A7 II", "ILCE-7M3", "A7 III", "ILCE-7M4", "A7 IV", "ILCE-7M5", "A7 V",
                "ILCE-7RM2", "A7R II", "ILCE-7RM3", "A7R III", "ILCE-7RM3A", "A7R IIIA", "ILCE-7RM4", "A7R IV", "ILCE-7RM4A", "A7R IVA", "ILCE-7RM5", "A7R V",
                "ILCE-7SM2", "A7S II", "ILCE-7SM3", "A7S III", "ILCE-7C", "A7C", "ILCE-7CM2", "A7C II", "ILCE-7CR", "A7CR",
                "ILCE-9", "A9", "ILCE-9M2", "A9 II", "ILCE-9M3", "A9 III", "ILCE-1", "A1",
                "ILCE-6100", "A6100", "ILCE-6400", "A6400", "ILCE-6600", "A6600", "ILCE-6700", "A6700" };
            for (int k = 0; k + 1 < map.Length; k += 2) if (key == map[k]) return "Sony " + map[k + 1];
            return "Sony " + (key == "" ? "camera" : key);
        }

        // Commands that answer with data; some drivers skip the data phase when it is empty.
        static uint SonyGet(ushort code, out byte[] data, params uint[] ps)
        {
            data = new byte[0];
            try { return ptp.OpRead(code, out data, ps); }
            catch (GoneException) { throw; }
            catch (Exception) { data = new byte[0]; return ptp.Op(code, ps); }
        }

        static CamException SonyFail(string what, uint r)
        {
            return new CamException("DRIVER The " + camName + " didn't accept remote control (" + what + ", " + H(r) + "). " + SONY_HINT + " [" + diag + "]");
        }

        static void EnsureSonySaveDest(byte[] props)
        {
            // Photos go straight to the computer ("PC Only"), so no memory card is needed: with PC + Camera or
            // Camera Only some bodies refuse to shoot when the card is missing. 1 = PC Only, 0x11 = PC + Camera, 0x10 = Camera Only.
            long dest; ushort dtype;
            if (!SonyPropInfo(props, 0xD222, out dest, out dtype)) return;
            if (dest >= 0 && dest != 0x01 && !sonyDestBlocked)
            {
                bool ok = false;
                foreach (ushort want in new ushort[] { 0x01, 0x11 })
                {
                    try
                    {
                        if (ptp.OpWrite(0x9205, SonyScalarBytes(want, dtype), 0xD222) != Ptp.OK) continue;
                        if (SonyVal(SonyProps(), 0xD222) != want) continue;     // the camera must really have taken it
                        ok = true;
                        setupNote += want == 0x01 ? "Photos go to the computer only (no memory card needed). " : "Photos go to the computer and the card. ";
                        Log("Save destination 0x" + dest.ToString("X") + " -> 0x" + want.ToString("X"));
                        break;
                    }
                    catch (GoneException) { throw; }
                    catch (Exception e) { Log("Save destination not changed: " + e.Message); }
                }
                if (!ok)
                {
                    sonyDestBlocked = true;
                    Log("Could not change the save destination (it is 0x" + dest.ToString("X") + "); photos may need a memory card");
                }
            }
        }

        static void PrepareSony()
        {
            setupNote = "";
            sonyClock = null;
            sonyDestBlocked = false;
            if (!ops.Contains(0x9201) || !ops.Contains(0x9202))
                throw new CamException("MODE The " + camName + " is connected as a file-transfer drive, not for remote control. " + SONY_HINT + " [" + diag + "]");
            byte[] b; uint r;
            r = SonyConnectPhase(1); if (r != Ptp.OK) throw SonyFail("connect 1", r);
            r = SonyConnectPhase(2); if (r != Ptp.OK) throw SonyFail("connect 2", r);
            bool isA7M3 = (camModel ?? "").IndexOf("ILCE-7M3", StringComparison.OrdinalIgnoreCase) >= 0;
            sonyVer = isA7M3 ? 3 : 2;
            // Older/mid Alpha bodies (e.g. A6400) expect protocol 0xC8 (200); newer/A7 III bodies use 0x12C (300).
            bool preferV2 = !isA7M3 && (camModel ?? "").IndexOf("6400", StringComparison.OrdinalIgnoreCase) >= 0;
            uint vFirst = preferV2 ? 0xC8U : 0x12CU, vSecond = preferV2 ? 0x12CU : 0xC8U;
            for (int t = 0; t < 20; t++)
            {
                r = SonyGet(0x9202, out b, vFirst, 1);
                if (r == Ptp.OK && b.Length >= 2) { sonyVer = (b[0] | (b[1] << 8)) >= 0x12C ? 3 : 2; break; }
                if (!isA7M3 && r != Ptp.BUSY)
                {
                    byte[] b2; uint r2 = SonyGet(0x9202, out b2, vSecond, 1);
                    if (r2 == Ptp.OK && b2.Length >= 2) { sonyVer = (b2[0] | (b2[1] << 8)) >= 0x12C ? 3 : 2; break; }
                }
                Thread.Sleep(100);
            }
            r = SonyConnectPhase(3); if (r != Ptp.OK) throw SonyFail("connect 3", r);
            sonyClock = Stopwatch.StartNew();
            SonyReleaseButtons(true);
            diag += "; sony protocol " + sonyVer;
            Log("Sony connected, protocol " + sonyVer);
            // Remote control wins over the camera's own buttons ("application" priority).
            try { ptp.OpWrite(0x9205, new byte[] { 1 }, 0xD25A); }
            catch (GoneException) { throw; }
            catch (Exception e) { Log("Priority mode not set: " + e.Message); }
            // Several bodies (A7 III, A7R IV, ZV-1...) only take photos about 3 s after connecting:
            // wait here, while the booth shows "connecting", not during the first guest's photo.
            byte[] props = new byte[0];
            while (sonyClock.ElapsedMilliseconds < 3000)
            {
                byte[] cur = SonyProps();
                if (cur.Length > 0) props = cur;
                Thread.Sleep(150);
            }
            if (props.Length == 0) props = SonyProps();
            // Ensure Single Shooting mode (0x5013 = 1) so continuous/bracket drive doesn't fire bursts.
            long scm; ushort scmType;
            if (SonyPropInfo(props, 0x5013, out scm, out scmType) && scm >= 0 && scm != 1)
            {
                try
                {
                    uint sr = ptp.OpWrite(0x9205, SonyScalarBytes(1, scmType), 0x5013);
                    if (sr == Ptp.OK) Log("Still capture mode " + scm + " -> 1");
                }
                catch (GoneException) { throw; }
                catch (Exception e) { Log("Still capture mode not changed: " + e.Message); }
            }
            EnsureSonySaveDest(props);
            live = true;    // Sony live view has no start command: the frames are simply there
        }

        static byte[] SonyProps()
        {
            byte[] b;
            uint r = SonyGet(0x9209, out b);
            return r == Ptp.OK ? b : new byte[0];
        }
        static int SonyScalarSize(ushort dtype)
        {
            if (dtype == 1 || dtype == 2) return 1;
            if (dtype == 3 || dtype == 4) return 2;
            if (dtype == 5 || dtype == 6) return 4;
            if (dtype == 7 || dtype == 8) return 8;
            return 0;
        }
        static bool SonyReadInt(byte[] d, ref int off, ushort dtype, out long val)
        {
            val = -1;
            int sz = SonyScalarSize(dtype);
            if (sz == 0 || off + sz > d.Length) return false;
            if (dtype == 1) val = (sbyte)d[off];
            else if (dtype == 2) val = d[off];
            else if (dtype == 3) val = (short)(d[off] | (d[off + 1] << 8));
            else if (dtype == 4) val = (ushort)(d[off] | (d[off + 1] << 8));
            else if (dtype == 5) val = (int)U32(d, off);
            else if (dtype == 6) val = U32(d, off);
            else { long u = 0; for (int k = 0; k < 8; k++) u |= (long)d[off + k] << (8 * k); val = u; }
            off += sz;
            return true;
        }
        static bool SonySkipValue(byte[] d, ref int off, ushort dtype)
        {
            if (dtype == 0xFFFF)
            {
                if (off >= d.Length) return false;
                int n = d[off++];
                if (off + n * 2 > d.Length) return false;
                off += n * 2;
                return true;
            }
            if (dtype >= 0x4001 && dtype <= 0x4008)
            {
                if (off + 4 > d.Length) return false;
                uint n = U32(d, off); off += 4;
                int esz = SonyScalarSize((ushort)(dtype & 0x0FFF));
                if (esz == 0 || n > 4096 || off + (long)n * esz > d.Length) return false;
                off += (int)n * esz;
                return true;
            }
            int sz = SonyScalarSize(dtype);
            if (sz == 0 || off + sz > d.Length) return false;
            off += sz;
            return true;
        }
        // Current value and scalar type of one property in the 0x9209 blob:
        // header is count(4) reserved(4); each entry is code(2) type(2) getset(1) enabled(1) default cur form ...
        static bool SonyPropInfo(byte[] d, ushort code, out long val, out ushort dtype)
        {
            val = -1;
            dtype = 0;
            if (d == null || d.Length < 8) return false;
            uint count = U32(d, 0), reserved = U32(d, 4);
            if (reserved != 0 || count > 8192) return false;
            int off = 8;
            for (uint idx = 0; idx < count && off + 6 <= d.Length; idx++)
            {
                ushort pcode = (ushort)(d[off] | (d[off + 1] << 8));
                ushort pt = (ushort)(d[off + 2] | (d[off + 3] << 8));
                byte getSet = d[off + 4], enabled = d[off + 5];
                off += 6;
                if (getSet > 0x84 || enabled > 2) break;
                if (!SonySkipValue(d, ref off, pt)) break;
                long curVal; bool hasCur;
                if (pt >= 1 && pt <= 8) hasCur = SonyReadInt(d, ref off, pt, out curVal);
                else { curVal = -1; hasCur = false; if (!SonySkipValue(d, ref off, pt)) break; }
                if (pcode == code)
                {
                    if (!hasCur) return false;
                    val = curVal;
                    dtype = pt;
                    return true;
                }
                if (off >= d.Length) break;
                byte form = d[off++];
                if (form == 1)
                {
                    if (!SonySkipValue(d, ref off, pt) || !SonySkipValue(d, ref off, pt) || !SonySkipValue(d, ref off, pt)) break;
                }
                else if (form == 2)
                {
                    if (off + 2 > d.Length) break;
                    int n1 = d[off] | (d[off + 1] << 8); off += 2;
                    for (int k = 0; k < n1; k++) if (!SonySkipValue(d, ref off, pt)) return false;
                    if (sonyVer >= 3 && off + 2 <= d.Length)
                    {
                        int n2 = d[off] | (d[off + 1] << 8); off += 2;
                        for (int k = 0; k < n2; k++) if (!SonySkipValue(d, ref off, pt)) return false;
                    }
                }
                else if (form != 0) break;
            }
            return false;
        }
        static long SonyVal(byte[] d, ushort code)
        {
            long val; ushort dtype;
            return SonyPropInfo(d, code, out val, out dtype) ? val : -1;
        }
        static byte[] SonyScalarBytes(uint val, ushort dtype)
        {
            int sz = SonyScalarSize(dtype);
            if (sz <= 0 || sz > 8) sz = 2;
            byte[] buf = new byte[sz];
            for (int k = 0; k < sz && k < 4; k++) buf[k] = (byte)((val >> (8 * k)) & 0xFF);
            return buf;
        }
        // Sony "buttons": 1 = released, 2 = pressed.
        static uint SonyButton(ushort prop, ushort value)
        {
            return ptp.OpWrite(0x9207, new byte[] { (byte)(value & 0xFF), (byte)(value >> 8) }, prop);
        }
        static void SonyReleaseButtons(bool throwGone)
        {
            try { SonyButton(0xD2C2, 1); SonyButton(0xD2C1, 1); }
            catch (GoneException) { if (throwGone) throw; }
            catch { }
        }
        static uint SonyConnectPhase(uint phase)
        {
            byte[] b; uint r = Ptp.OK;
            for (int t = 0; t < 12; t++)
            {
                r = SonyGet(0x9201, out b, phase, 0, 0);
                if (r != Ptp.BUSY) break;
                Thread.Sleep(150);
            }
            return r;
        }

        static byte[] SonyJpeg(byte[] d)
        {
            if (d == null || d.Length <= 8) return null;
            uint off = U32(d, 0);    // header has JPEG offset + size; 8 zero bytes = no frame ready yet
            uint fsize = U32(d, 4);
            if (off == 0 && fsize == 0) return null;
            int s = -1;
            if (off >= 8 && off + 1 < (uint)d.Length && d[off] == 0xFF && d[off + 1] == 0xD8) s = (int)off;
            if (s < 0) s = JpegStart(d);
            if (s < 0) return null;
            int limit = (fsize > 0 && (long)s + fsize <= d.Length) ? (int)(s + fsize) : d.Length;
            int e = -1;
            for (int k = limit - 2; k > s; k--) if (d[k] == 0xFF && d[k + 1] == 0xD9) { e = k + 2; break; }
            if (e <= s || e - s > 524288) return null;
            var o = new byte[e - s];
            Array.Copy(d, s, o, 0, o.Length);
            return o;
        }

        static byte[] SonyFrame()
        {
            live = true;
            var sw = Stopwatch.StartNew();
            uint last = 0;
            while (sw.ElapsedMilliseconds < 2500)
            {
                byte[] lv;
                uint r = ptp.OpRead(0x1009, out lv, SONY_LV);
                last = r;
                if (r == Ptp.OK)
                {
                    if (lv != null && lv.Length > 8)
                    {
                        var j = SonyJpeg(lv);
                        if (j != null) return j;
                    }
                    Thread.Sleep(25);
                    continue;
                }
                if (r == 0x2009) { Thread.Sleep(50); continue; }   // InvalidObjectHandle: not ready yet
                Thread.Sleep(r == 0x200F ? 20 : 40);    // AccessDenied: asked too fast
            }
            if (last != Ptp.OK && last != Ptp.BUSY && last != 0 && last != 0x2009)
                throw new CamException("LIVEVIEW The camera sends no live view (" + H(last) + "). Check it is in PC Remote mode, the lens cap is off and the camera's menu is closed.");
            return null;
        }

        static void SonyInfo(out ushort fmt, out uint size, out uint ro)
        {
            fmt = 0; size = 0; ro = 0;
            try
            {
                byte[] oi; ro = ptp.OpRead(0x1008, out oi, SONY_PHOTO);
                if (ro == Ptp.OK && oi.Length >= 12)
                {
                    fmt = (ushort)(oi[4] | (oi[5] << 8));
                    size = U32(oi, 8);
                }
            }
            catch (GoneException) { throw; }
            catch (Exception e) { Log("Sony info failed: " + e.Message); }
        }

        static byte[] SonyCapture()
        {
            var sw = Stopwatch.StartNew();
            string cd = "";
            // The first photo right after connecting has to wait for the camera to settle.
            while (sonyClock != null && sonyClock.ElapsedMilliseconds < 3000) { SonyProps(); Thread.Sleep(150); }
            if (!sonyDestBlocked) EnsureSonySaveDest(SonyProps());
            // A photo left in the camera's memory by an earlier attempt would be handed over instead of this one.
            for (int k = 0; k < 4; k++)
            {
                if (SonyVal(SonyProps(), 0xD215) < 0x8000) break;
                string junk = "";
                CanonDownload(SONY_PHOTO, 0, ref junk);
                Log("Cleared an old photo from the camera's memory");
            }
            // Half press, full press (the camera focuses, then shoots).
            var lagSw = Stopwatch.StartNew();   // the booth fires the shutter that much earlier (see lastShutterMs)
            uint r = SonyButton(0xD2C1, 2);
            if (r == Ptp.OK) r = SonyButton(0xD2C2, 2);
            if (r != Ptp.OK)
            {
                SonyReleaseButtons(true);
                throw new CamException("CAPTURE The camera refused the shutter (" + H(r) + "). Check the mode dial isn't on video, the camera's menu is closed and it is in PC Remote mode.");
            }
            try
            {
                // Hold until focus is found (1 s at most). Manual focus needs no wait.
                if (SonyVal(SonyProps(), 0x500A) != 1)
                {
                    var hold = Stopwatch.StartNew();
                    while (hold.ElapsedMilliseconds < 1000)
                    {
                        byte[] p = SonyProps();
                        long ff = SonyVal(p, 0xD213), om = SonyVal(p, 0xD215);
                        if (ff == 2 || ff == 3 || om >= 0x8000) break;
                        Thread.Sleep(50);
                    }
                }
            }
            finally
            {
                SonyReleaseButtons(true);
            }
            // Wait for the photo to appear in the camera's memory.
            long mem = -1;
            var ew = Stopwatch.StartNew();
            while (ew.ElapsedMilliseconds < 15000)
            {
                mem = SonyVal(SonyProps(), 0xD215);
                if (mem >= 0x8000) { lastShutterMs = (int)Math.Min(lagSw.ElapsedMilliseconds, 10000); Log("Shutter lag " + lastShutterMs + " ms"); break; }
                Thread.Sleep(100);
            }
            cd = "memory " + (mem < 0 ? "?" : "0x" + mem.ToString("X"));
            if (mem < 0x8000)
            {
                Log("No photo appeared: " + cd);
                throw new CamException("FOCUS The camera didn't take the photo. Point it at something with detail or set the lens to MF (manual focus), and check the camera's Still Img. Save Dest. is PC Only and its Release w/o Card setting is Enable.");
            }
            // RAW+JPEG bodies can queue RAW (0x3000/0xB101) before or after JPEG (0x3801): peek format and skip RAW.
            ushort fmt = 0; uint size = 0, ro = 0; bool sawRaw = false;
            byte[] img = new byte[0];
            for (int attempt = 0; attempt < 3; attempt++)
            {
                SonyInfo(out fmt, out size, out ro);
                cd += "; info " + H(ro) + " fmt " + H(fmt) + " " + size + " B";
                if (fmt != 0 && fmt != 0x3801)
                {
                    sawRaw = true;
                    string junk = "";
                    CanonDownload(SONY_PHOTO, size, ref junk);
                    Log("Skipped non-JPEG Sony object " + H(fmt) + " (" + size + " B)");
                    var waitNext = Stopwatch.StartNew();
                    bool more = false;
                    while (waitNext.ElapsedMilliseconds < 4000)
                    {
                        if (SonyVal(SonyProps(), 0xD215) >= 0x8000) { more = true; break; }
                        Thread.Sleep(60);
                    }
                    if (!more) break;
                    continue;
                }
                img = CanonDownload(SONY_PHOTO, size, ref cd);   // whole photo, or in 1 MB pieces
                if (img.Length >= 4 && img[0] == 0xFF && img[1] == 0xD8) break;
                sawRaw = img.Length >= 4 || sawRaw;
            }
            // Drain any trailing queued RAW object so the next shot starts clean.
            try
            {
                for (int k = 0; k < 2; k++)
                {
                    if (SonyVal(SonyProps(), 0xD215) < 0x8000) break;
                    ushort dfmt; uint dsize, dro;
                    SonyInfo(out dfmt, out dsize, out dro);
                    if (dro != Ptp.OK || (dfmt != 0 && dfmt != 0x3801))
                    {
                        string junk = "";
                        CanonDownload(SONY_PHOTO, dsize, ref junk);
                        Log("Drained trailing Sony object " + H(dfmt));
                    }
                    else break;
                }
            }
            catch (GoneException) { throw; }
            catch { }
            Log("Photo download: " + cd);
            if (img.Length < 4)
            {
                if (sawRaw) throw new CamException("CAPTURE The camera saved a RAW photo. Set File Format to JPEG (or RAW + JPEG) on the camera.");
                throw new CamException("CAPTURE The photo didn't come through from the camera (" + cd + ").");
            }
            if (!(img[0] == 0xFF && img[1] == 0xD8)) throw new CamException("CAPTURE The camera saved a RAW photo. Set File Format to JPEG (or RAW + JPEG) on the camera.");
            Log("Photo " + (img.Length / 1024) + " KB in " + sw.ElapsedMilliseconds + " ms");
            return img;
        }

        // Says in the log when one camera call has been waiting a long time (the helper restarts this program after ~10 s),
        // so a hang shows which command it was stuck on.
        static void Watch()
        {
            int loggedSeq = -1;
            while (true)
            {
                Thread.Sleep(1000);
                try
                {
                    int seq = Ptp.CallSeq;
                    if (Ptp.InFlight == 1 && seq != loggedSeq)
                    {
                        int waited = unchecked(Environment.TickCount - Ptp.InSinceTick);
                        if (waited >= 3000)
                        {
                            loggedSeq = seq;
                            Log("Camera call 0x" + Ptp.InOp.ToString("X4") + " has waited " + (waited / 1000) + " s with no answer (the camera may be stuck: switch it off and on)");
                        }
                    }
                }
                catch { }
            }
        }

        // ---------- command loop ----------
        public static void Run(int port)
        {
            var client = new TcpClient();
            client.NoDelay = true;
            client.Connect("127.0.0.1", port);
            var net = client.GetStream();
            var reader = new StreamReader(net, new UTF8Encoding(false));
            Log("Camera worker ready");
            Ptp.Slow = Log;
            var watcher = new Thread(Watch); watcher.IsBackground = true; watcher.Start();
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                line = line.Trim();
                if (line == "") continue;
                string[] parts = line.Split(new char[] { ' ' }, 3);
                string id = parts[0], cmd = parts.Length > 1 ? parts[1] : "", arg = parts.Length > 2 ? parts[2] : "";
                string status = "OK", kind = "N";
                if (cmd == "open" || cmd == "af" || cmd == "capture") classicNikon = arg.IndexOf("classic") >= 0;
                byte[] body = new byte[0];
                try
                {
                    switch (cmd)
                    {
                        case "ping": kind = "J"; body = Encoding.UTF8.GetBytes("{\"ok\":true}"); break;
                        case "list": kind = "J"; body = Encoding.UTF8.GetBytes(ListJson()); break;
                        case "open": recoverNext = arg.IndexOf("recover") >= 0; kind = "J"; body = Encoding.UTF8.GetBytes(Open()); break;
                        case "info": Need(); kind = "J"; body = Encoding.UTF8.GetBytes(InfoJson()); break;
                        case "battery": Need(); kind = "J"; body = Encoding.UTF8.GetBytes("{\"battery\":" + Battery() + "}"); break;
                        case "props": Need(); kind = "J"; body = Encoding.UTF8.GetBytes(ExposureJson()); break;
                        case "setprops": Need(); kind = "J"; body = Encoding.UTF8.GetBytes(SetExposure(arg)); break;
                        case "af":
                            Need();
                            if (nikon)
                            {
                                if (!live) StartLive();
                                bool afOk = true;
                                if (Has(0x90C1) && classicNikon)
                                {
                                    uint afR = ptp.Op(0x90C1);
                                    var afSw = Stopwatch.StartNew();
                                    while (afSw.ElapsedMilliseconds < 1400) { Thread.Sleep(80); DrainEvents(); }
                                    afOk = afR == Ptp.OK;
                                }
                                else if (Has(0x90C1)) afOk = NikonAf();
                                preFocusOk = afOk; preFocusSw.Restart();   // the shot that follows skips its own focus
                                kind = "J"; body = Encoding.UTF8.GetBytes("{\"ok\":" + (afOk ? "true" : "false") + "}");
                            }
                            else if (canon)
                            {
                                uint afR = 0x2005;   // an older EOS (60D...) has no separate focus command: it focuses inside the shot
                                if (CanonLensMf())
                                {
                                    afR = Ptp.OK;    // lens switch is on MF: skip the 800 ms AF pause so live view stays smooth
                                }
                                else if (Has(0x9128))
                                {
                                    afR = OpRetry(0x9128, 1, 0);
                                    Thread.Sleep(800);
                                    try { OpRetry(0x9129, 1); } catch { }
                                }
                                preFocusOk = afR == Ptp.OK; preFocusSw.Restart();   // the shot that follows skips its own focus
                                kind = "J"; body = Encoding.UTF8.GetBytes("{\"ok\":" + (afR == Ptp.OK ? "true" : "false") + "}");
                            }
                            else
                            {
                                kind = "J"; body = Encoding.UTF8.GetBytes("{\"ok\":true}");
                            }
                            break;
                        case "live":
                            Need();
                            if (arg == "off") { if (canon) CanonLiveOff(); else if (sony) live = false; else StopLive(); }
                            else if (canon) CanonRestartLive();   // "on" is also how the booth asks for live view again when frames stopped
                            else if (!live) { if (sony) live = true; else StartLive(); }
                            break;
                        case "frame":
                            {
                                Need();
                                var f = canon ? CanonFrame() : sony ? SonyFrame() : Frame();
                                if (f != null) { kind = "B"; body = f; }
                                break;
                            }
                        case "capture":
                            Need(); kind = "B";
                            // A Canon often leaves live view after a photo: the next frame request starts it again right away.
                            if (canon) { try { body = CanonCapture(); } finally { live = false; canonShotEnd.Restart(); canonLiveBackPending = true; } }
                            else body = sony ? SonyCapture() : Capture();
                            break;
                        case "close": CloseCamera(); break;
                        case "quit": CloseCamera(); return;
                        default: throw new CamException("BAD Unknown command " + cmd);
                    }
                }
                catch (Exception e0)
                {
                    Exception e = e0;
                    while (e.InnerException != null && !(e is GoneException) && !(e is CamException)) e = e.InnerException;
                    if (e is GoneException || (e is COMException))
                    {
                        // Is the camera still there?
                        bool alive = false;
                        if (!(e is GoneException) && ptp != null) { try { Alive(); alive = true; } catch { } }
                        if (!alive) { Log("Camera lost: " + e.Message); CloseCamera(); status = "GONE"; }
                        else status = "ERR";
                    }
                    else status = "ERR";
                    kind = "N";
                    body = Encoding.UTF8.GetBytes(e.Message);
                }
                // A fifth word is optional: "focus-miss" = a Nikon photo that was taken without a focus lock.
                string flags = (cmd == "capture" && status == "OK" && nikon && shotFocus == "miss") ? " focus-miss" : "";
                byte[] head = Encoding.ASCII.GetBytes(id + " " + status + " " + kind + " " + body.Length + flags + "\n");
                net.Write(head, 0, head.Length);
                if (body.Length > 0) net.Write(body, 0, body.Length);
                net.Flush();
            }
            CloseCamera();
        }
        static void Need()
        {
            if (ptp == null) throw new GoneException("NOCAMERA The camera isn't connected.");
        }
    }
}
'@

try {
    Add-Type -TypeDefinition $cs -Language CSharp
} catch {
    Write-Output "[camera] Could not start the camera part: $($_.Exception.Message)"
    exit 2
}
try {
    [Pb4uCam.Worker]::Run($Port)
} catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    Write-Output "[camera] stopped: $($e.Message)"
    exit 1
}
