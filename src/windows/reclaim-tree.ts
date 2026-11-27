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

export interface ReparseLink {
    readonly kind: 'junction' | 'symlink'
    readonly payload: string
}

export interface ReclamationEntry {
    readonly path: string
    readonly directory: boolean
    readonly inode: string
    readonly volume: string
    readonly created: string
    readonly hash: string | null
    readonly readOnly: boolean
    readonly links?: number
    readonly link?: ReparseLink
    readonly permissions: string
    readonly children: readonly string[]
}

/** A path component held without following its final reparse point. */
export interface ReclamationGuard {
    readonly path: string
    readonly identity: string
    readonly junctionTarget?: string
    readonly link?: ReparseLink
}

// Ordinary entries use FILE_SHARE_READ only. An alias group uses write-denying readers
// and opens just one verified name for deletion at a time.
const native = String.raw`
using System;
using System.ComponentModel;
using System.Collections.Generic;
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

    private static void VerifyReparse(SafeFileHandle handle, string kind, string payload) {
        var data = new byte[16384];
        uint count;
        if (!DeviceIoControl(handle, 0x000900A8, IntPtr.Zero, 0, data, (uint)data.Length, out count, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        bool junction = kind == "junction";
        if (!junction && kind != "symlink") throw new IOException("Unsupported reparse kind.");
        int header = junction ? 16 : 20;
        uint tag = junction ? 0xA0000003u : 0xA000000Cu;
        if (count < header || count != 8 + BitConverter.ToUInt16(data, 4) || BitConverter.ToUInt32(data, 0) != tag)
            throw new IOException("The reparse tag or buffer changed.");
        int offset = BitConverter.ToUInt16(data, 8), length = BitConverter.ToUInt16(data, 10);
        uint flags = junction ? 0 : BitConverter.ToUInt32(data, 16);
        if ((offset | length) % 2 != 0 || length == 0 || header + offset + length > count || flags > 1)
            throw new IOException("Invalid reparse payload.");
        string stored = Encoding.Unicode.GetString(data, header + offset, length);
        string ntPrefix = new string((char)92, 1) + "??" + (char)92;
        string longPrefix = new string((char)92, 2) + "?" + (char)92;
        if (payload.StartsWith(longPrefix, StringComparison.Ordinal)) payload = payload.Substring(longPrefix.Length);
        if (flags == 0 && payload.Length >= 3 && payload[1] == ':' && payload[2] == (char)92) payload = ntPrefix + payload;
        if (!String.Equals(stored, payload, StringComparison.Ordinal))
            throw new IOException("The stored reparse target changed.");
    }

    public static void Guard(SafeFileHandle handle, string identity, string kind, string payload) {
        FileInfo info;
        if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
        string actual = info.Volume + ":" + (((ulong)info.IndexHigh << 32) | info.IndexLow) + ":" +
            (((decimal)(((ulong)info.CreatedHigh << 32) | info.CreatedLow) - 116444736000000000m) * 100m).ToString("0");
        bool attached = !String.IsNullOrEmpty(kind);
        if (actual != identity || ((info.Attributes & 0x10) != 0) != (kind != "symlink") ||
            ((info.Attributes & 0x400) != 0) != attached) throw new IOException("Path identity or type changed.");
        if (attached) VerifyReparse(handle, kind, payload);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder name, uint size, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindFirstFileNameW(string path, uint flags, ref uint length, StringBuilder name);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool FindNextFileNameW(IntPtr handle, ref uint length, StringBuilder name);

    [DllImport("kernel32.dll")]
    private static extern bool FindClose(IntPtr handle);

    public static SafeFileHandle Open(string path, bool retiring, bool aliasGuard = false) {
        const uint genericRead = 0x80000000, delete = 0x00010000, shareRead = 1, shareDelete = 4, openExisting = 3;
        const uint backupSemantics = 0x02000000, openReparsePoint = 0x00200000;
        var handle = CreateFileW(path, genericRead | (retiring ? delete : 0), shareRead | (aliasGuard ? shareDelete : 0), IntPtr.Zero, openExisting,
            backupSemantics | openReparsePoint, IntPtr.Zero);
        if (handle.IsInvalid) {
            var error = new Win32Exception(Marshal.GetLastWin32Error());
            handle.Dispose();
            throw error;
        }
        return handle;
    }

    public static void Verify(SafeFileHandle handle, bool directory, string inode, string volume, string created, bool readOnly, uint expectedLinks, string kind, string payload) {
        FileInfo info;
        if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
        bool attached = !String.IsNullOrEmpty(kind);
        if (((info.Attributes & 0x400) != 0) != attached || ((info.Attributes & 0x10) != 0) != directory ||
            (((ulong)info.IndexHigh << 32) | info.IndexLow).ToString() != inode || info.Volume.ToString() != volume ||
            (((ulong)info.CreatedHigh << 32) | info.CreatedLow).ToString() != created ||
            (!attached && !directory && (info.Links != expectedLinks || ((info.Attributes & 1) != 0) != readOnly)))
            throw new IOException("The entry's identity, type, links, or attributes changed.");
        if (attached) VerifyReparse(handle, kind, payload);
    }

    public static string RequireOpenedName(SafeFileHandle handle, string path) {
        var buffer = new StringBuilder(32768);
        var length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 8);
        if (length == 0 || length >= buffer.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
        if (path.Length < 3 || path[1] != ':' || path[2] != (char)92 ||
            !String.Equals(buffer.ToString(), new string((char)92, 2) + "?" + (char)92 + path, StringComparison.OrdinalIgnoreCase))
            throw new IOException("Opened alias name differs from the verified path.");
        return path.Substring(2);
    }

    public static HashSet<string> AliasNames(string path, uint expectedCount) {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var name = new StringBuilder(32768);
        uint size = (uint)name.Capacity;
        var search = FindFirstFileNameW(path, 0, ref size, name);
        if (search == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            while (true) {
                if (!names.Add(name.ToString()) || names.Count > expectedCount)
                    throw new IOException("Hard-link membership changed.");
                size = (uint)name.Capacity;
                if (FindNextFileNameW(search, ref size, name)) continue;
                int error = Marshal.GetLastWin32Error();
                if (error != 38) throw new Win32Exception(error);
                break;
            }
            if (names.Count != expectedCount) throw new IOException("Hard-link membership changed.");
            return names;
        } finally {
            FindClose(search);
        }
    }

    public static void RequireAliasNames(string path, HashSet<string> expected) {
        if (!AliasNames(path, (uint)expected.Count).SetEquals(expected))
            throw new IOException("Hard-link membership changed.");
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
        $locked = [Collections.Generic.List[object]]::new()
        $heldPaths = [Collections.Generic.List[object]]::new()
        $path = $data.retiring[0].path
        $groups = @{}
        $retiringGroups = @{}
        foreach ($entry in $data.retiring) {
            if ($entry.links -gt 1) { $retiringGroups["$($entry.volume):$($entry.inode)"] = $true }
        }
        try {
            foreach ($guard in $data.guards) {
                $path = $guard.path
                $handle = [HousekeeperReclamation]::Open($path, $false)
                $heldPaths.Add($handle)
                $kind = if ($guard.link) { $guard.link.kind } elseif ($guard.junctionTarget) { 'junction' } else { $null }
                $target = if ($guard.link) { $guard.link.payload } else { $guard.junctionTarget }
                [HousekeeperReclamation]::Guard($handle, $guard.identity, $kind, $target)
                [void][HousekeeperReclamation]::Security($handle)
            }
            foreach ($entry in @($data.retiring) + @($data.survivor)) {
                $path = $entry.path
                $remove = $locked.Count -lt $data.retiring.Count
                $links = if ($null -eq $entry.links) { 1 } else { $entry.links }
                $key = "$($entry.volume):$($entry.inode)"
                $aliased = $retiringGroups.ContainsKey($key)
                $handle = [HousekeeperReclamation]::Open($path, ($remove -and !$aliased), $aliased)
                $locked.Add(@{ entry = $entry; handle = $handle; key = $key; aliased = $aliased; links = $links })
                [HousekeeperReclamation]::Verify($handle, $entry.directory, $entry.inode, $entry.volume, $entry.created, $entry.readOnly, $links, $entry.link.kind, $entry.link.payload)
                if ($aliased) {
                    $name = [HousekeeperReclamation]::RequireOpenedName($handle, $path)
                    if (!$groups.ContainsKey($key)) { $groups[$key] = [HousekeeperReclamation]::AliasNames($path, $links) }
                    if (!$groups[$key].Contains($name)) { throw 'The opened name is absent from the verified aliases.' }
                }
            }
            foreach ($item in $locked) {
                $entry = $item.entry
                $path = $entry.path
                if ($entry.directory -and !$entry.link) {
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
                if (!$item.entry.directory -and !$item.entry.link -and [HousekeeperReclamation]::Hash($item.handle) -ne $item.entry.hash) { throw 'File contents changed.' }
            }
            # Validate complete group membership before any irreversible disposal.
            foreach ($item in $locked) {
                if ($item.aliased) {
                    $path = $item.entry.path
                    [HousekeeperReclamation]::RequireAliasNames($path, $groups[$item.key])
                }
            }
            for ($i = $data.retiring.Count - 1; $i -ge 0; $i--) {
                if ($null -ne $data.failAfter -and $data.retiring.Count - 1 - $i -eq $data.failAfter) { throw 'Simulated late deletion failure.' }
                $item = $locked[$i]
                $path = $item.entry.path
                $entry = $item.entry
                if ($item.aliased) {
                    $names = $groups[$item.key]
                    $remove = [HousekeeperReclamation]::Open($path, $true)
                    try {
                        $name = [HousekeeperReclamation]::RequireOpenedName($remove, $path)
                        if (!$names.Contains($name)) { throw 'The retiring name is absent from the verified aliases.' }
                        [HousekeeperReclamation]::RequireAliasNames($path, $names)
                        [HousekeeperReclamation]::Verify($remove, $false, $entry.inode, $entry.volume, $entry.created, $entry.readOnly, $names.Count, $null, $null)
                        [HousekeeperReclamation]::Remove($remove)
                        $item.handle.Dispose()
                        $null = $names.Remove($name)
                    } finally {
                        $remove.Dispose()
                    }
                } else {
                    [HousekeeperReclamation]::Verify($item.handle, $entry.directory, $entry.inode, $entry.volume, $entry.created, $entry.readOnly, $item.links, $entry.link.kind, $entry.link.payload)
                    [HousekeeperReclamation]::Remove($item.handle)
                }
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

/** Reads the link object's security without opening its target. */
export async function readReparsePermissions(paths: readonly (ReclamationGuard & { readonly link: ReparseLink })[]): Promise<readonly string[]> {
    if (paths.length === 0) return []
    const json = await runPowerShell(
        `
        Add-Type -TypeDefinition $data.native
        $permissions = @(foreach ($entry in $data.paths) {
            $handle = [HousekeeperReclamation]::Open($entry.path, $false)
            try {
                [HousekeeperReclamation]::Guard($handle, $entry.identity, $entry.link.kind, $entry.link.payload)
                [HousekeeperReclamation]::Security($handle)
            } finally { $handle.Dispose() }
        })
        ConvertTo-Json -InputObject $permissions -Compress
        `,
        { native, paths },
        60_000
    )
    const values: unknown = JSON.parse(json)
    if (!Array.isArray(values) || values.length !== paths.length || !values.every((value) => typeof value === 'string')) {
        throw new Error('Windows returned incomplete reparse permissions.')
    }
    return values
}
