import { runPowerShell } from './powershell.ts'

export interface ReclamationEntry {
    readonly path: string
    readonly directory: boolean
    readonly inode: string
    readonly volume: string
    readonly created: string
    readonly hash: string | null
    readonly readOnly: boolean
    readonly permissions: string
    readonly children: readonly string[]
}

// Open with FILE_SHARE_READ only. Conflicting writer handles prevent acquisition;
// held handles block new write/delete opens, and deletion requests force an image-section check.
const native = String.raw`
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

public static class HousekeeperReclamation {
    [StructLayout(LayoutKind.Sequential)]
    private struct FileInfo {
        public uint Attributes, CreatedLow, CreatedHigh, AccessedLow, AccessedHigh, WrittenLow, WrittenHigh;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int informationClass, ref uint flags, uint size);

    public static SafeFileHandle Open(string path, bool retiring) {
        const uint genericRead = 0x80000000, delete = 0x00010000, shareRead = 1, openExisting = 3;
        const uint backupSemantics = 0x02000000, openReparsePoint = 0x00200000;
        var handle = CreateFileW(path, genericRead | (retiring ? delete : 0), shareRead, IntPtr.Zero, openExisting,
            backupSemantics | openReparsePoint, IntPtr.Zero);
        if (handle.IsInvalid) {
            var error = new Win32Exception(Marshal.GetLastWin32Error());
            handle.Dispose();
            throw error;
        }
        return handle;
    }

    public static void Verify(SafeFileHandle handle, bool directory, string inode, string volume, string created, bool readOnly) {
        FileInfo info;
        if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory ||
            (((ulong)info.IndexHigh << 32) | info.IndexLow).ToString() != inode || info.Volume.ToString() != volume ||
            (((ulong)info.CreatedHigh << 32) | info.CreatedLow).ToString() != created ||
            (!directory && (info.Links != 1 || ((info.Attributes & 1) != 0) != readOnly)))
            throw new IOException("The entry's identity, type, links, or attributes changed.");
    }

    public static string Hash(SafeFileHandle handle) {
        using (var borrowed = new SafeFileHandle(handle.DangerousGetHandle(), false))
        using (var stream = new FileStream(borrowed, FileAccess.Read))
        using (var sha = SHA256.Create()) {
            return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "");
        }
    }

    public static void Remove(SafeFileHandle handle) {
        const int fileDispositionInfoEx = 21;
        const uint delete = 1, posix = 2, forceImageSectionCheck = 4, ignoreReadOnly = 16;
        uint flags = delete | posix | forceImageSectionCheck | ignoreReadOnly;
        if (!SetFileInformationByHandle(handle, fileDispositionInfoEx, ref flags, sizeof(uint)))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        handle.Dispose();
    }
}
`

/** Validates pinned entries and deletes only the retiring handles, children first. */
export async function reclaimWindowsTree(retiring: readonly ReclamationEntry[], survivor: readonly ReclamationEntry[]): Promise<void> {
    await runPowerShell(
        `
        Add-Type -TypeDefinition $data.native
        $sections = [Security.AccessControl.AccessControlSections]'Owner, Group, Access'
        $locked = [Collections.Generic.List[object]]::new()
        $path = $data.retiring[0].path
        try {
            foreach ($entry in @($data.retiring) + @($data.survivor)) {
                $path = $entry.path
                $remove = $locked.Count -lt $data.retiring.Count
                $handle = [HousekeeperReclamation]::Open($path, $remove)
                $locked.Add(@{ entry = $entry; handle = $handle })
                [HousekeeperReclamation]::Verify($handle, $entry.directory, $entry.inode, $entry.volume, $entry.created, $entry.readOnly)
            }
            foreach ($item in $locked) {
                $entry = $item.entry
                $path = $entry.path
                if ($entry.directory) {
                    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
                    foreach ($child in $entry.children) { $null = $expected.Add($child) }
                    foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($path)) {
                        if (!$expected.Remove([IO.Path]::GetFileName($child))) { throw "Unexpected entry $child" }
                    }
                    if ($expected.Count) { throw 'A verified child disappeared.' }
                    $acl = [IO.Directory]::GetAccessControl($path, $sections)
                } else {
                    $acl = [IO.File]::GetAccessControl($path, $sections)
                }
                if ($acl.GetSecurityDescriptorSddlForm($sections) -cne $entry.permissions) { throw 'Windows permissions changed.' }
            }
            foreach ($item in $locked) {
                $path = $item.entry.path
                if (!$item.entry.directory -and [HousekeeperReclamation]::Hash($item.handle) -ne $item.entry.hash) { throw 'File contents changed.' }
            }
            for ($i = $data.retiring.Count - 1; $i -ge 0; $i--) {
                $item = $locked[$i]
                $path = $item.entry.path
                [HousekeeperReclamation]::Verify($item.handle, $item.entry.directory, $item.entry.inode, $item.entry.volume, $item.entry.created, $item.entry.readOnly)
                [HousekeeperReclamation]::Remove($item.handle)
            }
        } catch {
            throw "Could not safely reclaim the old copy at $($data.retiring[0].path). $($path): $($_.Exception.Message)"
        } finally {
            foreach ($item in $locked) { $item.handle.Dispose() }
        }
        `,
        { native, retiring, survivor },
        60_000
    )
}
