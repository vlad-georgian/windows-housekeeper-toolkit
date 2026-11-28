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
    /**
     * A path known only from the toolkit's receipt, such as an npm prefix that has since changed.
     * It is offered for restore while it still links to its recorded mirror, and never moved.
     */
    readonly recordedOnly?: true
    readonly kind?: 'directory' | 'file'
    /**
     * Files whose hard-link names reach outside the moved paths lose that link on another drive.
     * `refuse-external` blocks the move or restore. `report-external` lists the files in the plan.
     */
    readonly hardLinks?: 'refuse-external' | 'report-external'
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
    /** Why the app's active locations cannot be determined. The app is not offered. */
    readonly blocked?: string
    readonly paths: readonly RelocationPath[]
}
