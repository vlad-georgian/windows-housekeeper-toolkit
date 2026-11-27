import { dirname, join, parse, resolve } from "node:path";

export interface SystemPaths {
    readonly home: string;
    readonly localAppData: string;
    readonly roamingAppData: string;
    readonly programData: string;
    readonly systemRoot: string;
    readonly systemDrive: string;
}

function requireEnvironmentPath(name: string, fallback?: string): string {
    const value = process.env[name] ?? fallback;
    if (!value) {
        throw new Error(`Required environment variable ${name} is not set.`);
    }
    return resolve(value);
}

export function getSystemPaths(): SystemPaths {
    const home = requireEnvironmentPath("USERPROFILE", process.env.HOME);
    const systemRoot = requireEnvironmentPath("SystemRoot", "C:\\Windows");
    const systemDrive = parse(systemRoot).root;

    return {
        home,
        localAppData: requireEnvironmentPath("LOCALAPPDATA", join(home, "AppData", "Local")),
        roamingAppData: requireEnvironmentPath("APPDATA", join(home, "AppData", "Roaming")),
        programData: requireEnvironmentPath("ProgramData", "C:\\ProgramData"),
        systemRoot,
        systemDrive: dirname(systemDrive) === systemDrive ? systemDrive : "C:\\",
    };
}
