export function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B'
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
    const value = bytes / 1024 ** exponent
    return `${value >= 10 || exponent === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[exponent]}`
}

export function sumKnownBytes(values: readonly { readonly sizeBytes: number | null }[]): number {
    return values.reduce((total, value) => total + (value.sizeBytes ?? 0), 0)
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
