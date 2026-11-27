// Use the same SCM handle to verify and change a service. While the handle is open, a deletion
// cannot complete and a replacement service cannot take over that name. No service-control API
// for starting or stopping services is exposed here.
export const serviceConfigInterop = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Housekeeper {
    public sealed class ServiceHandle : SafeHandleZeroOrMinusOneIsInvalid {
        private ServiceHandle() : base(true) {}

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool CloseServiceHandle(IntPtr handle);

        protected override bool ReleaseHandle() { return CloseServiceHandle(handle); }
    }

    public static class ServiceConfig {
        private const uint QueryConfig = 1;
        private const uint ChangeConfig = 2;
        private const uint NoChange = 0xffffffff;
        private const uint DelayedStartInfo = 3;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct Configuration {
            public uint Type;
            public uint Start;
            public uint ErrorControl;
            public string ImagePath;
            public string LoadOrderGroup;
            public uint TagId;
            public IntPtr Dependencies; // MULTI_SZ, unused
            public string Account;
            public string DisplayName;
        }

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern ServiceHandle OpenSCManager(string machine, string database, uint access);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern ServiceHandle OpenService(ServiceHandle manager, string name, uint access);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool QueryServiceConfig(ServiceHandle service, IntPtr config, uint size, out uint needed);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool QueryServiceConfig2(ServiceHandle service, uint level, out int info, uint size, out uint needed);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool ChangeServiceConfig(ServiceHandle service, uint type, uint start, uint errorControl, string imagePath,
            string loadOrderGroup, IntPtr tagId, string dependencies, string account, string password, string displayName);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool ChangeServiceConfig2(ServiceHandle service, uint level, ref int info);

        public static ServiceHandle Open(string name) {
            using (var manager = OpenSCManager(null, null, 1)) { // SC_MANAGER_CONNECT
                if (manager.IsInvalid) throw new Win32Exception();
                var service = OpenService(manager, name, QueryConfig | ChangeConfig);
                if (!service.IsInvalid) return service;
                int error = Marshal.GetLastWin32Error();
                service.Dispose();
                if (error == 1060) return null; // ERROR_SERVICE_DOES_NOT_EXIST
                throw new Win32Exception(error);
            }
        }

        public static Configuration Read(ServiceHandle service) {
            const int size = 8192; // Maximum QUERY_SERVICE_CONFIG buffer size.
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try {
                uint needed;
                if (!QueryServiceConfig(service, buffer, size, out needed)) throw new Win32Exception();
                return Marshal.PtrToStructure<Configuration>(buffer);
            } finally {
                Marshal.FreeHGlobal(buffer);
            }
        }

        public static bool IsDelayed(ServiceHandle service) {
            uint needed;
            int delayed;
            if (!QueryServiceConfig2(service, DelayedStartInfo, out delayed, sizeof(int), out needed)) throw new Win32Exception();
            return delayed != 0;
        }

        public static void SetStart(ServiceHandle service, uint start) {
            if (!ChangeServiceConfig(service, NoChange, start, NoChange, null, null, IntPtr.Zero, null, null, null, null)) {
                throw new Win32Exception();
            }
        }

        public static void SetDelayed(ServiceHandle service, bool delayed) {
            int value = delayed ? 1 : 0;
            if (!ChangeServiceConfig2(service, DelayedStartInfo, ref value)) throw new Win32Exception();
        }
    }
}
`
