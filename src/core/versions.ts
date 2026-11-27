export function compareVersions(left: string, right: string): number {
    const leftParts = left.match(/\d+/g)?.map(Number) ?? [];
    const rightParts = right.match(/\d+/g)?.map(Number) ?? [];
    const length = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < length; index += 1) {
        const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
        if (difference !== 0) return difference;
    }

    return 0;
}
