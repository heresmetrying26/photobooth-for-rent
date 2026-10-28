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

        public static List<DevInfo> ListDevices()
        {
            var list = new List<DevInfo>();
            var mgr = Create<IPortableDeviceManager>("0af10cec-2ecd-4b92-9581-34f6ae0637f3");
            mgr.RefreshDeviceList();
            uint n = 0;
            int hr = mgr.GetDevices(null, ref n);
            var ids = new List<string>();
            if (hr == 0 && n > 0)
            {
                var arr = new IntPtr[n];
                hr = mgr.GetDevices(arr, ref n);
                for (int i = 0; i < n && hr == 0; i++) { ids.Add(Marshal.PtrToStringUni(arr[i])); Marshal.FreeCoTaskMem(arr[i]); }
            }
            if (ids.Count == 0)
            {
                // Second way: ask Windows directly for portable-device interfaces.
                Guid wpd = new Guid("6AC27878-A6FA-4155-BA85-F98F491D4F33");
                uint len;
                int cr = CM_Get_Device_Interface_List_SizeW(out len, ref wpd, null, 0);
                if (cr == 0 && len > 1)
                {
                    var buf = new char[len];
                    cr = CM_Get_Device_Interface_ListW(ref wpd, null, buf, len, 0);
                    if (cr == 0)
                        foreach (string id in new string(buf).Split(new char[] { '\0' }, StringSplitOptions.RemoveEmptyEntries)) ids.Add(id);
                }
            }
            foreach (string id in ids)
            {
                var d = new DevInfo();
                d.Id = id; d.Name = Name(mgr, id, 0); d.Maker = Name(mgr, id, 1);
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
            Check(v.SetGuidValue(ref kCat, ref cat), "Set category");
            Check(v.SetUnsignedIntegerValue(ref kId, cmdPid), "Set command");
            IPortableDeviceValues res;
            Check(dev.SendCommand(0, v, out res), "Camera command");
            int hr;
            if (res.GetErrorValue(ref kHr, out hr) == 0 && hr != 0) Check(hr, "Camera command");
            return res;
        }
        void SetOp(IPortableDeviceValues v, ushort code, uint[] ps)
        {
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
        static string diag = "";
        // Nikons in MTP mode (D3400, D5600...) call themselves a Microsoft/MTP device
        // and may not list their own commands, but they still answer them.
        static readonly ushort[] NIKON_OPS = { 0x90C0, 0x90C1, 0x90C7, 0x90C8, 0x9201, 0x9202, 0x9203, 0x9207 };
        static bool Has(ushort op) { return ops.Contains(op) || (nikon && Array.IndexOf(NIKON_OPS, op) >= 0); }
        static List<ushort> ops = new List<ushort>(), props = new List<ushort>();
        static bool live;
        static string setupNote = "";

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
        static readonly string[] CAMERA_WORDS = { "nikon", "canon", "sony", "ilce", "ilme", "alpha", "zv-", "dsc-", "fuji", "panasonic", "olympus", "om system", "pentax", "eos", "lumix" };
        static bool LooksLikeCamera(DevInfo d)
        {
            string n = ((d.Name ?? "") + " " + (d.Maker ?? "")).ToLowerInvariant();
            foreach (string w in CAMERA_WORDS) if (n.Contains(w)) return true;
            // Nikon model names: D5600, D750, Z 6, Z50...
            return System.Text.RegularExpressions.Regex.IsMatch(n, @"\b(d\d{2,4}|z ?\d{1,2}|zf|zfc)\b");
        }

        static string ListJson()
        {
            // An open camera that was unplugged meanwhile: notice it now.
            if (ptp != null) { try { Alive(); } catch { Log("Camera lost"); CloseCamera(); } }
            var sb = new StringBuilder("{\"devices\":[");
            bool first = true;
            foreach (var d in ListDevs())
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"name\":" + Js(d.Name) + ",\"maker\":" + Js(d.Maker) + ",\"camera\":" + (LooksLikeCamera(d) ? "true" : "false") + "}");
            }
            sb.Append("],\"open\":" + (ptp != null ? "true" : "false") + ",\"name\":" + Js(ptp != null ? camName : "") + "}");
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
                    // Hand the camera back: live view off, out of remote mode.
                    try { if (live) SetEos(0xD1B0, 0); ptp.Op(0x9115, 0); ptp.Op(0x9114, 0); } catch { }
                }
                ptp.Close();
            }
            ptp = null; live = false; devId = null; nikon = false; canon = false; sony = false; sonyClock = null;
        }

        static string Open()
        {
            if (ptp != null)
            {
                try { Alive(); return InfoJson(); } catch { }
                CloseCamera();
            }
            var all = ListDevs();
            if (all.Count == 0) throw new CamException("NOCAMERA No camera found. Plug the camera into this laptop with a data USB cable and switch it on.");
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
            if (seen != "") throw new CamException("NOCAMERA Found " + seen + ", but no Nikon, Canon EOS or Sony Alpha camera with live view. Switch the camera on and check its cable.");
            throw new CamException("NOCAMERA No camera found. Plug the camera into this laptop with a data USB cable (not charge-only) and switch it on.");
        }

        static string InfoJson()
        {
            return "{\"name\":" + Js(camName) + ",\"model\":" + Js(camModel) + ",\"maker\":" + Js(camMaker) + ",\"brand\":" + Js(nikon ? "nikon" : canon ? "canon" : sony ? "sony" : "") + ",\"vendor\":" + vendor
                + ",\"liveview\":" + (live ? "true" : "false") + ",\"battery\":" + Battery() + ",\"note\":" + Js(setupNote) + ",\"diag\":" + Js(diag) + "}";
        }

        static int Battery()
        {
            if (canon || sony || !props.Contains(0x5001)) return -1;   // Sony reports battery in steps, not percent
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

        // ---------- photo size: JPEG, the smallest size still >= ~2900 px wide ----------
        // (the booth uses at most 3000 px; smaller files come over USB much faster)
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
                        if (cur > 2 && q.Choices.Contains("2") && SetProp(0x5004, q.Type, "2")) { setupNote += "Set to JPEG Fine. "; Log("Image quality was RAW; set to JPEG Fine"); }
                    }
                }
                if (props.Contains(0x5003))
                {
                    var s = PropDesc(0x5003);
                    if (s != null && s.Type == 0xFFFF && s.Choices.Count > 1)
                    {
                        string best = null; int bestW = int.MaxValue;
                        foreach (string c in s.Choices)
                        {
                            int w = Width(c);
                            if (w >= 2900 && w < bestW) { best = c; bestW = w; }
                        }
                        if (best != null && best != s.Current && SetProp(0x5003, s.Type, best)) { setupNote += "Photo size " + best + ". "; Log("Image size " + s.Current + " -> " + best); }
                    }
                }
            }
            catch (GoneException) { throw; }
            catch (Exception e) { Log("Photo size not changed: " + e.Message); }
        }
        static int Width(string s) { int x = s.IndexOf('x'); int w; return x > 0 && int.TryParse(s.Substring(0, x), out w) ? w : 0; }

        public class Desc { public ushort Type; public string Current; public List<string> Choices = new List<string>(); }
        static Desc PropDesc(ushort code)
        {
            byte[] d; uint r = ptp.OpRead(0x1014, out d, code);
            if (r != Ptp.OK || d.Length < 6) return null;
            var rd = new Reader(d);
            var o = new Desc();
            rd.U16(); o.Type = rd.U16(); rd.U8();
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
            try { ptp.Op(0x9202); } catch (GoneException) { throw; } catch { }
            WaitReady(3000);
            live = false;
        }
        static int JpegStart(byte[] d) { for (int k = 0; k + 1 < d.Length && k < 4096; k++) if (d[k] == 0xFF && d[k + 1] == 0xD8) return k; return -1; }
        static byte[] Frame()
        {
            if (!live) StartLive();
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
        static byte[] Capture()
        {
            var sw = Stopwatch.StartNew();
            uint r;
            // Focus first while in live view (contrast AF); a miss is fine, the shot decides.
            if (live && Has(0x90C1))
            {
                try { r = ptp.Op(0x90C1); if (r == Ptp.OK) WaitReady(3000); } catch (GoneException) { throw; } catch { }
            }
            DrainEvents();
            if (Has(0x90C0)) r = ptp.Op(0x90C0, 0xFFFFFFFF);    // InitiateCaptureRecInSdram
            else r = ptp.Op(0x100E, 0, 0);
            if (r == 0xA002 && Has(0x9207))
            {
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
                if (handles.Count > 0) { Thread.Sleep(150); foreach (uint h in Events()) if (!handles.Contains(h)) handles.Add(h); break; }
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
        static Stopwatch liveSw = new Stopwatch(), keepSw = new Stopwatch(), pollSw = new Stopwatch();
        static bool gotFrame;

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

        // Reads the camera's news: changed settings, and new photos.
        static void CanonPoll()
        {
            pollSw.Restart();
            byte[] d; uint r = ptp.OpRead(0x9116, out d);
            if (r != Ptp.OK || d == null) return;
            int off = 0;
            while (off + 8 <= d.Length)
            {
                uint size = U32(d, off), type = U32(d, off + 4);
                if (size < 8 || off + size > d.Length || type == 0) break;
                int end = off + (int)size;
                if (type == 0xC189 && size >= 16) eosVals[(ushort)U32(d, off + 8)] = U32(d, off + 12);   // a setting changed
                else if ((type == 0xC181 || type == 0xC1A7) && size >= 12)   // a photo was saved on the card
                    canonNew.Add(new uint[] { U32(d, off + 8), type, off + 0x12 <= end ? U16(d, off + 0x10) : 0, off + 0x20 <= end ? U32(d, off + 0x1C) : 0 });
                else if (type == 0xC186 && size >= 12)   // a photo waits in the camera's memory for us
                    canonNew.Add(new uint[] { U32(d, off + 8), type, off + 0x0E <= end ? U16(d, off + 0x0C) : 0, off + 0x18 <= end ? U32(d, off + 0x14) : 0 });
                off = end;
            }
        }

        static void PrepareCanon()
        {
            setupNote = "";
            eosVals.Clear(); canonNew.Clear(); gotFrame = false;
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
            keepSw.Restart();
        }

        // Every few seconds: read news (keeps the camera's list short) and keep it awake.
        static void CanonKeep()
        {
            if (!pollSw.IsRunning || pollSw.ElapsedMilliseconds > 2000) CanonPoll();
            if (keepSw.ElapsedMilliseconds > 20000 && Has(0x911D)) { ptp.Op(0x911D); keepSw.Restart(); }
        }

        static void CanonLiveOn()
        {
            bool started = false;
            if (Has(0x9151)) { uint ri = OpRetry(0x9151); Log("InitiateViewfinder: " + H(ri)); started = ri == Ptp.OK; }
            if (eosVals.ContainsKey(0xD1B1) && eosVals[0xD1B1] != 1) SetEos(0xD1B1, 1);   // live view mode
            uint r = SetEos(0xD1B0, 2);   // live view to the computer (mirror up)
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
            if (!live) CanonLiveOn();
            var sw = Stopwatch.StartNew();
            uint last = 0;
            bool kicked = false;
            while (sw.ElapsedMilliseconds < 3000)
            {
                CanonKeep();
                byte[] d; uint r = ptp.OpRead(0x9153, out d, 0x00100000);
                last = r;
                if (r == Ptp.OK)
                {
                    var j = EosJpeg(d);
                    if (j != null) { gotFrame = true; return j; }
                }
                else if (r != Ptp.BUSY && r != NOTREADY) break;
                // Some models leave live view after a photo: switch it back on once.
                if (!kicked && sw.ElapsedMilliseconds > 1200 && liveSw.ElapsedMilliseconds > 4000) { kicked = true; SetEos(0xD1B0, 2); }
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
            if (res == 7 || res == 3) return new CamException("CAPTURE The camera can't save the photo (result " + res + "). Check there's an SD card in the camera and it isn't full or locked.");
            if (r == Ptp.BUSY || r == NOTREADY) return new CamException("CAPTURE The camera is busy (still saving the last photo?). Try again in a moment.");
            return new CamException("CAPTURE The camera refused the photo (" + H(r) + (res != 0 ? ", result " + res : "") + "). Close the camera's menu, set the mode dial to P, Tv, Av or M (not video), and check the SD card.");
        }

        static byte[] CanonCapture()
        {
            var sw = Stopwatch.StartNew();
            CanonPoll();
            canonNew.Clear();
            uint r;
            if (ops.Contains(0x9128))
            {
                // Newer EOS: press the shutter all the way (it focuses, then shoots), then let go.
                r = OpRetry(0x9128, 3, 0);
                Log("RemoteReleaseOn: " + H(r));
                if (r == Ptp.OK) { try { OpRetry(0x9129, 3); } catch (GoneException) { throw; } catch { } }
                else
                {
                    uint h = OpRetry(0x9128, 1, 0);   // half press (focus)
                    uint f = h == Ptp.OK ? OpRetry(0x9128, 2, 0) : h;   // full press
                    try { OpRetry(0x9129, 2); OpRetry(0x9129, 1); } catch (GoneException) { throw; } catch { }
                    Log("Half / full press: " + H(h) + " / " + H(f));
                    r = f;
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
                if (r != Ptp.OK || res != 0) throw CanonShotError(r, res);
            }
            // Wait for the camera to say where the photo is (RAW + JPEG: two files).
            var files = new List<uint[]>();
            var ew = Stopwatch.StartNew();
            long firstAt = -1;
            while (ew.ElapsedMilliseconds < 15000)
            {
                CanonPoll();
                foreach (var o in canonNew) if (o[2] != 0x3001) files.Add(o);   // not folders
                canonNew.Clear();
                if (files.Count > 0 && firstAt < 0) firstAt = ew.ElapsedMilliseconds;
                if (firstAt >= 0 && ew.ElapsedMilliseconds - firstAt > 350) break;
                Thread.Sleep(80);
            }
            if (files.Count == 0)
                throw new CamException("FOCUS The camera didn't take a photo. It may not have focused: point it at something with detail, or set the lens to MF (manual focus). Also check there's an SD card in the camera and it isn't full or locked.");
            string cd = "files " + string.Join(",", files.ConvertAll(o => o[0].ToString("X") + "/" + o[2].ToString("X")).ToArray());
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
                foreach (var o in files) if (o[1] == 0xC186) { try { ptp.Op(0x9117, o[0]); } catch (GoneException) { throw; } catch { } }
            }
            Log("Photo download: " + cd);
            if (img == null)
            {
                if (order.Count == 0) throw new CamException("CAPTURE The camera saved a RAW photo. Set Image quality to JPEG on the camera (L, M or S; RAW + JPEG also works).");
                throw new CamException("CAPTURE The photo didn't come through from the camera (" + cd + ").");
            }
            Log("Photo " + (img.Length / 1024) + " KB in " + sw.ElapsedMilliseconds + " ms");
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
        const string SONY_HINT = "On the camera set USB Connection to PC Remote (MENU > Setup > USB), close Imaging Edge and other camera apps, switch the camera off and on, unplug and replug the USB cable, then try again.";
        static int sonyVer = 2;
        static Stopwatch sonyClock;

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

        static void PrepareSony()
        {
            setupNote = "";
            sonyClock = null;
            if (!ops.Contains(0x9201) || !ops.Contains(0x9202))
                throw new CamException("MODE The " + camName + " is connected as a file-transfer drive, not for remote control. " + SONY_HINT + " [" + diag + "]");
            byte[] b; uint r;
            r = SonyGet(0x9201, out b, 1, 0, 0); if (r != Ptp.OK) throw SonyFail("connect 1", r);
            r = SonyGet(0x9201, out b, 2, 0, 0); if (r != Ptp.OK) throw SonyFail("connect 2", r);
            sonyVer = 2;
            for (int t = 0; t < 20; t++)
            {
                r = SonyGet(0x9202, out b, 0x12C, 1);
                if (r == Ptp.OK && b.Length >= 2) { sonyVer = (b[0] | (b[1] << 8)) == 0x12C ? 3 : 2; break; }
                Thread.Sleep(100);
            }
            r = SonyGet(0x9201, out b, 3, 0, 0); if (r != Ptp.OK) throw SonyFail("connect 3", r);
            sonyClock = Stopwatch.StartNew();
            diag += "; sony protocol " + sonyVer;
            Log("Sony connected, protocol " + sonyVer);
            // Remote control wins over the camera's own buttons ("application" priority).
            try { ptp.OpWrite(0x9205, new byte[] { 1 }, 0xD25A); }
            catch (GoneException) { throw; }
            catch (Exception e) { Log("Priority mode not set: " + e.Message); }
            // Several bodies (A7 III, A7R IV, ZV-1...) only take photos about 3 s after connecting:
            // wait here, while the booth shows "connecting", not during the first guest's photo.
            byte[] props = new byte[0];
            while (sonyClock.ElapsedMilliseconds < 3000) { props = SonyProps(); Thread.Sleep(150); }
            // Photos go straight to the computer ("PC Only"), so no memory card is needed: with PC + Camera or
            // Camera Only some bodies refuse to shoot when the card is missing. 1 = PC Only, 0x11 = PC + Camera, 0x10 = Camera Only.
            long dest = SonyVal(props, 0xD222);
            if (dest >= 0 && dest != 0x01)
            {
                bool ok = false;
                foreach (ushort want in new ushort[] { 0x01, 0x11 })
                {
                    try
                    {
                        if (ptp.OpWrite(0x9205, new byte[] { (byte)(want & 0xFF), (byte)(want >> 8) }, 0xD222) != Ptp.OK) continue;
                        if (SonyVal(SonyProps(), 0xD222) != want) continue;     // the camera must really have taken it
                        ok = true;
                        setupNote += want == 0x01 ? "Photos go to the computer only (no memory card needed). " : "Photos go to the computer and the card. ";
                        Log("Save destination 0x" + dest.ToString("X") + " -> 0x" + want.ToString("X"));
                        break;
                    }
                    catch (GoneException) { throw; }
                    catch (Exception e) { Log("Save destination not changed: " + e.Message); }
                }
                if (!ok) Log("Could not change the save destination (it is 0x" + dest.ToString("X") + "); photos may need a memory card");
            }
            live = true;    // Sony live view has no start command: the frames are simply there
        }

        static byte[] SonyProps()
        {
            byte[] b;
            uint r = SonyGet(0x9209, out b);
            return r == Ptp.OK ? b : new byte[0];
        }
        // Current value of one property in the 0x9209 blob (-1 when it isn't there):
        // entries are  code(2) type(2) getset(1) enabled(1) default(size) current(size) ...
        static long SonyVal(byte[] d, ushort code)
        {
            for (int i = 8; i + 8 <= d.Length; i++)
            {
                if (d[i] != (byte)(code & 0xFF) || d[i + 1] != (byte)(code >> 8)) continue;
                int type = d[i + 2] | (d[i + 3] << 8);
                int size = (type == 1 || type == 2) ? 1 : (type == 3 || type == 4) ? 2 : (type == 5 || type == 6) ? 4 : 0;
                if (size == 0 || d[i + 4] > 0x84 || d[i + 5] > 2) continue;
                int cur = i + 6 + size;
                if (cur + size > d.Length) continue;
                long v = 0;
                for (int k = 0; k < size; k++) v |= (long)d[cur + k] << (8 * k);
                return v;
            }
            return -1;
        }
        // Sony "buttons": 1 = released, 2 = pressed.
        static uint SonyButton(ushort prop, ushort value)
        {
            return ptp.OpWrite(0x9207, new byte[] { (byte)(value & 0xFF), (byte)(value >> 8) }, prop);
        }

        static byte[] SonyJpeg(byte[] d)
        {
            int s = -1;
            if (d.Length > 8)
            {
                uint off = U32(d, 0);    // the frame starts with the offset of the JPEG inside it
                if (off + 1 < (uint)d.Length && d[off] == 0xFF && d[off + 1] == 0xD8) s = (int)off;
            }
            if (s < 0) s = JpegStart(d);
            if (s < 0) return null;
            int e = d.Length;
            for (int k = d.Length - 2; k > s; k--) if (d[k] == 0xFF && d[k + 1] == 0xD9) { e = k + 2; break; }
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
                uint r;
                try { byte[] oi; r = ptp.OpRead(0x1008, out oi, SONY_LV); }
                catch (GoneException) { throw; }
                catch (Exception) { r = Ptp.OK; }
                if (r == 0x2009) { last = r; Thread.Sleep(50); continue; }   // InvalidObjectHandle: not ready yet (up to 1 s on some bodies)
                byte[] lv;
                r = ptp.OpRead(0x1009, out lv, SONY_LV);
                last = r;
                if (r == Ptp.OK && lv.Length > 8)
                {
                    var j = SonyJpeg(lv);
                    if (j != null) return j;
                }
                Thread.Sleep(r == 0x200F ? 20 : 40);    // AccessDenied: asked too fast
            }
            if (last != Ptp.OK && last != Ptp.BUSY && last != 0 && last != 0x2009)
                throw new CamException("LIVEVIEW The camera sends no live view (" + H(last) + "). Check it is in PC Remote mode, the lens cap is off and the camera's menu is closed.");
            return null;
        }

        static byte[] SonyCapture()
        {
            var sw = Stopwatch.StartNew();
            string cd = "";
            // The first photo right after connecting has to wait for the camera to settle.
            while (sonyClock != null && sonyClock.ElapsedMilliseconds < 3000) { SonyProps(); Thread.Sleep(150); }
            // A photo left in the camera's memory by an earlier attempt would be handed over instead of this one.
            for (int k = 0; k < 4; k++)
            {
                if (SonyVal(SonyProps(), 0xD215) != 0x8001) break;
                string junk = "";
                CanonDownload(SONY_PHOTO, 0, ref junk);
                Log("Cleared an old photo from the camera's memory");
            }
            // Half press, full press (the camera focuses, then shoots).
            uint r = SonyButton(0xD2C1, 2);
            if (r == Ptp.OK) r = SonyButton(0xD2C2, 2);
            if (r != Ptp.OK)
            {
                try { SonyButton(0xD2C2, 1); SonyButton(0xD2C1, 1); } catch (GoneException) { throw; } catch { }
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
                try { SonyButton(0xD2C2, 1); SonyButton(0xD2C1, 1); } catch (GoneException) { throw; } catch { }
            }
            // Wait for the photo to appear in the camera's memory.
            long mem = -1;
            var ew = Stopwatch.StartNew();
            while (ew.ElapsedMilliseconds < 15000)
            {
                mem = SonyVal(SonyProps(), 0xD215);
                if (mem >= 0x8000) break;
                Thread.Sleep(100);
            }
            cd = "memory " + (mem < 0 ? "?" : "0x" + mem.ToString("X"));
            if (mem < 0x8000)
            {
                Log("No photo appeared: " + cd);
                throw new CamException("FOCUS The camera didn't take the photo. Point it at something with detail or set the lens to MF (manual focus), and check the camera's Still Img. Save Dest. is PC Only and its Release w/o Card setting is Enable.");
            }
            uint size = 0;
            try
            {
                byte[] oi; uint ro = ptp.OpRead(0x1008, out oi, SONY_PHOTO);
                if (ro == Ptp.OK && oi.Length >= 12) size = U32(oi, 8);
                cd += "; info " + H(ro) + " " + size + " B";
            }
            catch (GoneException) { throw; }
            catch (Exception e) { cd += "; info failed " + e.Message; }
            byte[] img = CanonDownload(SONY_PHOTO, size, ref cd);   // whole photo, or in 1 MB pieces
            Log("Photo download: " + cd);
            if (img.Length < 4) throw new CamException("CAPTURE The photo didn't come through from the camera (" + cd + ").");
            if (!(img[0] == 0xFF && img[1] == 0xD8)) throw new CamException("CAPTURE The camera saved a RAW photo. Set File Format to JPEG (or RAW + JPEG) on the camera.");
            Log("Photo " + (img.Length / 1024) + " KB in " + sw.ElapsedMilliseconds + " ms");
            return img;
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
            string line;
            while ((line = reader.ReadLine()) != null)
            {
                line = line.Trim();
                if (line == "") continue;
                string[] parts = line.Split(new char[] { ' ' }, 3);
                string id = parts[0], cmd = parts.Length > 1 ? parts[1] : "", arg = parts.Length > 2 ? parts[2] : "";
                string status = "OK", kind = "N";
                byte[] body = new byte[0];
                try
                {
                    switch (cmd)
                    {
                        case "ping": kind = "J"; body = Encoding.UTF8.GetBytes("{\"ok\":true}"); break;
                        case "list": kind = "J"; body = Encoding.UTF8.GetBytes(ListJson()); break;
                        case "open": kind = "J"; body = Encoding.UTF8.GetBytes(Open()); break;
                        case "info": Need(); kind = "J"; body = Encoding.UTF8.GetBytes(InfoJson()); break;
                        case "battery": Need(); kind = "J"; body = Encoding.UTF8.GetBytes("{\"battery\":" + Battery() + "}"); break;
                        case "live":
                            Need();
                            if (arg == "off") { if (canon) CanonLiveOff(); else if (sony) live = false; else StopLive(); }
                            else if (!live) { if (canon) CanonLiveOn(); else if (sony) live = true; else StartLive(); }
                            break;
                        case "frame":
                            {
                                Need();
                                var f = canon ? CanonFrame() : sony ? SonyFrame() : Frame();
                                if (f != null) { kind = "B"; body = f; }
                                break;
                            }
                        case "capture": Need(); kind = "B"; body = canon ? CanonCapture() : sony ? SonyCapture() : Capture(); break;
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
                byte[] head = Encoding.ASCII.GetBytes(id + " " + status + " " + kind + " " + body.Length + "\n");
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
