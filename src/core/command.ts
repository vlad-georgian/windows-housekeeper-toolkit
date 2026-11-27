import type { CommandRunner } from "./types.ts";

export const runCommand: CommandRunner = async (command, timeoutMs) => {
    const processHandle = Bun.spawn([...command], {
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    });

    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
        processHandle.exited,
    ]);

    return { exitCode, stdout, stderr };
};
