export function compareVersions(left: string, right: string): number {
    const leftParts = left.match(/\d+/g)?.map(Number) ?? []
    const rightParts = right.match(/\d+/g)?.map(Number) ?? []
    const length = Math.max(leftParts.length, rightParts.length)
    for (let index = 0; index < length; index += 1) {
        const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
        if (difference !== 0) return difference
    }

    return 0
}

interface Semver {
    readonly core: readonly [number, number, number]
    readonly prerelease: readonly string[]
}

function parseSemver(value: string): Semver | null {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value)
    if (!match) return null
    return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split('.') ?? [] }
}

/**
 * Semantic Versioning precedence, where a prerelease sorts before its release and build metadata
 * is ignored. Returns null when either text is not a complete version, so callers can refuse to
 * decide instead of guessing an order.
 */
export function compareSemver(left: string, right: string): number | null {
    const a = parseSemver(left)
    const b = parseSemver(right)
    if (!a || !b) return null
    for (let index = 0; index < 3; index += 1) {
        const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0)
        if (difference !== 0) return difference
    }
    if (a.prerelease.length === 0 || b.prerelease.length === 0) return b.prerelease.length - a.prerelease.length
    const length = Math.max(a.prerelease.length, b.prerelease.length)
    for (let index = 0; index < length; index += 1) {
        const x = a.prerelease[index]
        const y = b.prerelease[index]
        if (x === undefined || y === undefined) return x === undefined ? -1 : 1
        const numericX = /^\d+$/.test(x)
        const numericY = /^\d+$/.test(y)
        if (numericX && numericY) {
            const difference = Number(x) - Number(y)
            if (difference !== 0) return difference
        } else if (numericX !== numericY) {
            return numericX ? -1 : 1
        } else if (x !== y) {
            return x < y ? -1 : 1
        }
    }
    return 0
}
