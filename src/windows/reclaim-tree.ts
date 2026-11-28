import type { BigIntStats } from 'node:fs'

import { fileIndex, volumeSerial } from '../core/filesystem/paths.ts'
import { runPowerShell } from './powershell.ts'

/**
 * The identity fields `Verify` compares, in the unsigned form `GetFileInformationByHandle`
 * reports. Win32 FILETIME counts 100 ns intervals from 1601; Bun's birthtimeNs uses the Unix epoch.
 */
export function nativeEntryIdentity(stats: Pick<BigIntStats, 'dev' | 'ino' | 'birthtimeNs'>): { inode: string; volume: string; created: string } {
    return {
        inode: String(fileIndex(stats)),
        volume: String(volumeSerial(stats)),
        created: String(stats.birthtimeNs / 100n + 116_444_736_000_000_000n)
    }
}

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

/** A path component held without following its final reparse point. */
export interface ReclamationGuard {
    readonly path: string
    readonly identity: string
    readonly junctionTarget?: string
}

// Open with FILE_SHARE_READ only. Conflicting writer handles prevent acquisition;
// held handles block new write/delete opens, and deletion requests force an image-section check.
const native = String.raw`
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Text;
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

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(SafeFileHandle handle, uint code, IntPtr input, uint inputSize, byte[] output, uint outputSize, out uint returned, IntPtr overlapped);

    [DllImport("advapi32.dll")]
    private static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetSecurityDescriptorLength(IntPtr descriptor);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr buffer);

    public static string Security(SafeFileHandle handle) {
        IntPtr owner, group, dacl, sacl, descriptor;
        uint error = GetSecurityInfo(handle, 1, 7, out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception((int)error);
        try {
            if (owner == IntPtr.Zero || group == IntPtr.Zero || dacl == IntPtr.Zero) throw new IOException("Incomplete path security.");
            var bytes = new byte[GetSecurityDescriptorLength(descriptor)];
            Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            return new RawSecurityDescriptor(bytes, 0).GetSddlForm(AccessControlSections.Owner | AccessControlSections.Group | AccessControlSections.Access);
        } finally { LocalFree(descriptor); }
    }

    public static void Guard(SafeFileHandle handle, string identity, string target) {
        FileInfo info;
        if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
        string actual = info.Volume + ":" + (((ulong)info.IndexHigh << 32) | info.IndexLow) + ":" +
            (((decimal)(((ulong)info.CreatedHigh << 32) | info.CreatedLow) - 116444736000000000m) * 100m).ToString("0");
        if (actual != identity || (info.Attributes & 0x10) == 0) throw new IOException("Path identity changed.");
        if (String.IsNullOrEmpty(target)) {
            if ((info.Attributes & 0x400) != 0) throw new IOException("An ancestor became a reparse point.");
        } else {
            var data = new byte[16384];
            uint count;
            if (!DeviceIoControl(handle, 0x000900A8, IntPtr.Zero, 0, data, (uint)data.Length, out count, IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if (count < 16 || BitConverter.ToUInt32(data, 0) != 0xA0000003) throw new IOException("Expected a directory junction tag.");
            int offset = BitConverter.ToUInt16(data, 8), length = BitConverter.ToUInt16(data, 10);
            if ((offset | length) % 2 != 0 || 16 + offset + length > count) throw new IOException("Invalid junction payload.");
            string stored = Encoding.Unicode.GetString(data, 16 + offset, length);
            if (!String.Equals(stored, @"\??\" + Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase))
                throw new IOException("The stored junction target changed.");
        }
        Security(handle);
    }

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
export async function reclaimWindowsTree(
    retiring: readonly ReclamationEntry[],
    survivor: readonly ReclamationEntry[],
    guards: readonly ReclamationGuard[] = [],
    failAfter?: number
): Promise<void> {
    await runPowerShell(
        `
        Add-Type -TypeDefinition $data.native
        $sections = [Security.AccessControl.AccessControlSections]'Owner, Group, Access'
        $locked = [Collections.Generic.List[object]]::new()
        $heldPaths = [Collections.Generic.List[object]]::new()
        $path = $data.retiring[0].path
        try {
            foreach ($guard in $data.guards) {
                $path = $guard.path
                $handle = [HousekeeperReclamation]::Open($path, $false)
                $heldPaths.Add($handle)
                $target = if ($null -ne $guard.junctionTarget) { [string]$guard.junctionTarget } else { $null }
                [HousekeeperReclamation]::Guard($handle, $guard.identity, $target)
            }
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
                }
                if ([HousekeeperReclamation]::Security($item.handle) -cne $entry.permissions) { throw 'Windows permissions changed.' }
            }
            foreach ($item in $locked) {
                $path = $item.entry.path
                if (!$item.entry.directory -and [HousekeeperReclamation]::Hash($item.handle) -ne $item.entry.hash) { throw 'File contents changed.' }
            }
            for ($i = $data.retiring.Count - 1; $i -ge 0; $i--) {
                if ($null -ne $data.failAfter -and $data.retiring.Count - 1 - $i -eq $data.failAfter) { throw 'Simulated late deletion failure.' }
                $item = $locked[$i]
                $path = $item.entry.path
                [HousekeeperReclamation]::Verify($item.handle, $item.entry.directory, $item.entry.inode, $item.entry.volume, $item.entry.created, $item.entry.readOnly)
                [HousekeeperReclamation]::Remove($item.handle)
            }
        } catch {
            throw "Could not safely reclaim the old copy at $($data.retiring[0].path). $($path): $($_.Exception.Message)"
        } finally {
            foreach ($item in $locked) { $item.handle.Dispose() }
            foreach ($handle in $heldPaths) { $handle.Dispose() }
        }
        `,
        { native, retiring, survivor, guards, failAfter },
        60_000
    )
}
