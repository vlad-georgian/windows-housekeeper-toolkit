/** A per-user directory a relocatable app owns. */
export interface RelocationPath {
    readonly path: string
    /** Positive evidence for a redirected root outside the standard profile mirror. */
    readonly verifyLegacyTarget?: (target: string) => Promise<boolean>
    /** Verify an individually owned file in a shared location. */
    readonly nativeLauncherRoot?: string
    readonly linkedSelector?: { readonly owner: string; readonly entry: string; readonly selector: string }
    readonly verifyFile?: (target: string) => Promise<boolean>
    /** Require ownership evidence for an optional package-manager path. */
    readonly verifyDirectory?: (target: string) => Promise<boolean>
    readonly kind?: 'directory' | 'file'
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
    readonly processGuardId: string
    readonly label: string
    readonly preserveMirror?: boolean
    readonly paths: readonly RelocationPath[]
}
