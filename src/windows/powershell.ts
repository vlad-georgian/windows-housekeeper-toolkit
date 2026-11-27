import { join } from "node:path";

export function powershellPath(): string {
    return join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    );
}

export async function runPowerShell(
    script: string,
    input?: unknown,
    timeoutMs?: number,
): Promise<string> {
    const body = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    try {
      $json = [Console]::In.ReadToEnd()
      $data = if ($json) { ConvertFrom-Json -InputObject $json }
      & {
        ${script}
      }
    } catch {
      [Console]::Error.WriteLine($_.Exception.Message)
      exit 1
    }
  `;
    const subprocess = Bun.spawn(
        [
            powershellPath(),
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(body, "utf16le").toString("base64"),
        ],
        {
            stdin: new Blob([input === undefined ? "" : JSON.stringify(input)]),
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
            ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
        },
    );
    const [stdout, stderr, code] = await Promise.all([
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
        subprocess.exited,
    ]);
    if (subprocess.signalCode === "SIGTERM" && timeoutMs !== undefined) {
        throw new Error(`PowerShell query timed out after ${timeoutMs / 1000} seconds.`);
    }
    if (code !== 0) throw new Error(stderr.trim() || `PowerShell exited with code ${code}.`);
    return stdout.trim();
}
