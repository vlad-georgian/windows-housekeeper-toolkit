/** A per-user directory a relocatable app owns. */
export interface RelocationPath {
    readonly path: string
    /** What the directory holds, such as "installation" or "data". */
    readonly description: string
}

/**
 * A supported app in the relocation catalog. Its applicable paths are the configured paths
 * that exist. Every path must sit inside the Windows profile so it can be mirrored under a base.
 */
export interface RelocatableApp {
    readonly id: string
    /** The process guard ID from `src/windows/processes.ts` used to detect the app in use. */
    readonly appId: string
    readonly label: string
    readonly paths: readonly RelocationPath[]
}
