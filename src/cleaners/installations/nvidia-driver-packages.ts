import { compareVersions } from "../../core/versions.ts";

export interface DriverPackage {
    readonly publishedName: string;
    readonly providerName: string;
    readonly className: string;
    readonly driverVersion: string;
}

export function parseCsvLine(line: string): string[] {
    const fields: string[] = [];
    let field = "";
    let quoted = false;

    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"') {
            if (quoted && line[index + 1] === '"') {
                field += '"';
                index += 1;
            } else {
                quoted = !quoted;
            }
        } else if (character === "," && !quoted) {
            fields.push(field);
            field = "";
        } else {
            field += character;
        }
    }
    fields.push(field);
    return fields;
}

export function parseDriverPackages(csv: string): DriverPackage[] {
    const lines = csv
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const headerLine = lines.shift();
    if (!headerLine) return [];
    const headers = parseCsvLine(headerLine);
    const records = new Map<string, DriverPackage>();

    for (const line of lines) {
        const values = parseCsvLine(line);
        const record = Object.fromEntries(
            headers.map((header, index) => [header, values[index] ?? ""]),
        );
        const publishedName = record.DriverName;
        if (!publishedName || records.has(publishedName)) continue;
        records.set(publishedName, {
            publishedName,
            providerName: record.ProviderName ?? "",
            className: record.ClassName ?? "",
            driverVersion: extractVersion(record.DriverVersion ?? ""),
        });
    }

    return [...records.values()];
}

function extractVersion(value: string): string {
    return value.match(/(\d+(?:\.\d+){2,})\s*$/)?.[1] ?? value;
}

export function parseActiveInfNames(stdout: string): Set<string> {
    const trimmed = stdout.trim();
    if (!trimmed) return new Set();
    try {
        const value: unknown = JSON.parse(trimmed);
        const names = Array.isArray(value) ? value : [value];
        return new Set(
            names
                .filter((name): name is string => typeof name === "string")
                .map((name) => name.toLowerCase()),
        );
    } catch {
        return new Set(
            trimmed
                .split(/\r?\n/)
                .map((line) => line.trim().toLowerCase())
                .filter(Boolean),
        );
    }
}

export function selectOldInactiveNvidiaDrivers(
    packages: readonly DriverPackage[],
    activeInfNames: ReadonlySet<string>,
): DriverPackage[] {
    const nvidia = packages.filter(
        (driver) =>
            driver.providerName.toLowerCase().includes("nvidia") &&
            driver.className.toLowerCase() === "display",
    );
    const active = nvidia.filter((driver) =>
        activeInfNames.has(driver.publishedName.toLowerCase()),
    );
    if (active.length === 0) return [];
    const newestActive = active
        .map((driver) => driver.driverVersion)
        .toSorted((left, right) => compareVersions(right, left))[0];
    if (!newestActive) return [];

    return nvidia.filter(
        (driver) =>
            !activeInfNames.has(driver.publishedName.toLowerCase()) &&
            compareVersions(driver.driverVersion, newestActive) < 0,
    );
}
