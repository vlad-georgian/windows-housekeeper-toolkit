import { dirname, join, parse, resolve } from "node:path";

export interface SystemPaths {
    readonly home: string;
    readonly localAppData: string;
    readonly roamingAppData: string;
    /** The current user's temporary directory. */
    readonly temp: string;
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
    const localAppData = requireEnvironmentPath("LOCALAPPDATA", join(home, "AppData", "Local"));

    return {
        home,
        localAppData,
        roamingAppData: requireEnvironmentPath("APPDATA", join(home, "AppData", "Roaming")),
        temp: requireEnvironmentPath("TEMP", join(localAppData, "Temp")),
        programData: requireEnvironmentPath("ProgramData", "C:\\ProgramData"),
        systemRoot,
        systemDrive: dirname(systemDrive) === systemDrive ? systemDrive : "C:\\",
    };
}
