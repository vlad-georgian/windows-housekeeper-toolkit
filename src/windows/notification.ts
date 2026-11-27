import { lstat, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCommand } from "../core/command.ts";
import { projectName, stateDirectory } from "../core/state.ts";
import type { SystemPaths } from "../core/system-paths.ts";
import { runPowerShell } from "./powershell.ts";

const appId = "George.WindowsCleanup";
const logName = /^windows-housekeeper-toolkit-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+\.log$/;
const entrypoint = fileURLToPath(new URL("../index.ts", import.meta.url));

const shortcutProperties = `
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class NotificationShortcut {
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct PropertyKey {
        public Guid Format;
        public uint Id;
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct PropVariant {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(8)] public IntPtr Value;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }

    public static void SetAppId(string shortcut, string appId) {
        Guid shellLink = new Guid("00021401-0000-0000-C000-000000000046");
        object link = Activator.CreateInstance(Type.GetTypeFromCLSID(shellLink));
        IntPtr appIdValue = Marshal.StringToCoTaskMemUni(appId);
        IntPtr clsidValue = Marshal.AllocCoTaskMem(16);
        try {
            IPersistFile file = (IPersistFile)link;
            file.Load(shortcut, 2);
            IPropertyStore store = (IPropertyStore)link;
            PropertyKey key = new PropertyKey {
                Format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), Id = 5
            };
            PropVariant value = new PropVariant { Type = 31, Value = appIdValue };
            store.SetValue(ref key, ref value);
            // Protocol activation is handled by the registered URI. A stub CLSID
            // lets Windows retain these notifications in Notification Center.
            Marshal.StructureToPtr(new Guid("D0BE0749-89DB-4728-B229-1FC54F7AA2B6"), clsidValue, false);
            key.Id = 26;
            value = new PropVariant { Type = 72, Value = clsidValue };
            store.SetValue(ref key, ref value);
            store.Commit();
            file.Save(shortcut, true);
        } finally {
            Marshal.FreeCoTaskMem(clsidValue);
            Marshal.FreeCoTaskMem(appIdValue);
            Marshal.FinalReleaseComObject(link);
        }
    }
}
`;

export async function registerNotificationIdentity(paths: SystemPaths): Promise<void> {
    const logs = join(stateDirectory(paths), "logs");
    const command = `"${process.execPath}" run "${entrypoint}" notification-log "%1"`;
    await runPowerShell(
        `
      Add-Type -TypeDefinition $data.source
      $programs = [Environment]::GetFolderPath('Programs')
      if (-not $programs) { throw 'The current user Start menu folder could not be located.' }
      $null = [IO.Directory]::CreateDirectory($data.logs)
      $shortcutPath = Join-Path $programs ($data.name + '.lnk')
      $wsh = New-Object -ComObject WScript.Shell
      $shortcut = $wsh.CreateShortcut($shortcutPath)
      $shortcut.TargetPath = $data.explorer
      $shortcut.Arguments = '"' + $data.logs + '"'
      $shortcut.Description = $data.name + ' audit logs'
      $shortcut.Save()
      [NotificationShortcut]::SetAppId($shortcutPath, $data.appId)

      $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\\Classes\\' + $data.name)
      try {
        $key.SetValue('', 'URL:' + $data.name)
        $key.SetValue('URL Protocol', '')
        $open = $key.CreateSubKey('shell\\open\\command')
        try { $open.SetValue('', $data.command) } finally { $open.Dispose() }
      } finally { $key.Dispose() }
    `,
        {
            appId,
            source: shortcutProperties,
            logs,
            name: projectName,
            command,
            explorer: join(paths.systemRoot, "explorer.exe"),
        },
    );
}

export async function sendCleanupNotification(summary: string, logPath: string): Promise<void> {
    const name = basename(logPath);
    if (!logName.test(name)) throw new Error("Invalid cleanup notification log name.");
    await runPowerShell(
        `
      $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
      $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]
      $xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
      $xml.LoadXml('<toast activationType="protocol"><visual><binding template="ToastGeneric"><text/><text hint-maxLines="5"/></binding></visual><actions><action content="Open audit log" activationType="protocol"/></actions></toast>')
      $xml.DocumentElement.SetAttribute('launch', $data.uri)
      $xml.GetElementsByTagName('action').Item(0).SetAttribute('arguments', $data.uri)
      $texts = $xml.GetElementsByTagName('text')
      $texts.Item(0).InnerText = $data.title
      $texts.Item(1).InnerText = $data.summary
      $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($data.appId)
      if ($notifier.Setting.ToString() -ne 'Enabled') { throw "Windows notifications are $($notifier.Setting)." }
      $notifier.Show([Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime]::new($xml))
    `,
        { appId, uri: `${projectName}://audit/${name}`, title: projectName, summary },
    );
}

export async function openNotificationLog(
    paths: SystemPaths,
    args: readonly string[],
): Promise<void> {
    const uri = args[0];
    const prefix = `${projectName}://audit/`;
    const filename = uri?.startsWith(prefix) ? uri.slice(prefix.length) : "";
    if (args.length !== 1 || !logName.test(filename)) throw new Error("Invalid audit log link.");
    const path = join(stateDirectory(paths), "logs", filename);
    if (
        !(await lstat(path)).isFile() ||
        (await realpath(path)).toLowerCase() !== path.toLowerCase()
    ) {
        throw new Error("The audit log no longer resolves to its original location.");
    }
    await runCommand([join(paths.systemRoot, "System32", "notepad.exe"), path]);
}
