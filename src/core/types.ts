export type CandidateKind = 'filesystem' | 'driver-package'

export interface FilesystemIdentity {
    readonly target: string
    readonly allowedRoot: string
}

export interface CleanupCandidate {
    readonly id: string
    readonly kind: CandidateKind
    readonly displayName: string
    readonly reason: string
    readonly sizeBytes: number | null
    readonly fileCount: number | null
    readonly modifiedAt: Date | null
    readonly path?: string
    readonly allowedRoot?: string
    readonly canonicalPath?: string
    readonly filesystemIdentity?: FilesystemIdentity
    readonly filesystemAliases?: readonly string[]
    readonly publishedName?: string
    readonly driverVersion?: string
}

export interface RemovedEntry {
    readonly kind: 'file' | 'directory' | 'link' | 'driver-package'
    readonly path: string
    readonly sizeBytes: number | null
    readonly modifiedAt: Date | null
}

export interface SkippedEntry {
    readonly path: string
    readonly reason: string
}

export interface RemovalCallbacks {
    readonly onRemoved: (entry: RemovedEntry) => Promise<void>
    /** Reports an entry left in place, such as a locked file, while removal continues. */
    readonly onSkipped?: (entry: SkippedEntry) => Promise<void>
    /** Files that must stay, such as the active audit log. Cleaners that empty directories honor them. */
    readonly protectedPaths?: readonly string[]
}

export interface RemovalResult {
    readonly removedEntries: number
    readonly reclaimedBytes: number
    readonly message?: string
}

export interface DetectionResult {
    readonly cleaner: AppCleaner
    readonly candidates: readonly CleanupCandidate[]
    readonly totalBytes: number
}

/**
 * Cleanup categories, in checklist order. Each cleaner belongs to exactly one category.
 * Classify a cleaner by what its underlying data is, not by the app it belongs to.
 */
export const cleanupCategoryIds = ['general-cache', 'destructive-cache', 'windows-temp', 'old-installations'] as const

export type CleanupCategoryId = (typeof cleanupCategoryIds)[number]

export interface AppCleaner {
    /** Unique cleaner ID recorded in audit logs and sign-in selections. */
    readonly id: string
    /** Application identity for running-app checks. Several cleaners can share one app. */
    readonly appId: string
    readonly category: CleanupCategoryId
    readonly label: string
    readonly description: string
    /** Consequences of removal, such as redownloads or lost offline use. */
    readonly implications?: string
    /**
     * False when the cleaner verifies in-use state itself during removal, or when the app's
     * processes are routinely running, so manual runs skip the app-level running check.
     * Sign-in runs always apply the app-level check.
     */
    readonly manualRunningAppCheck?: boolean
    detect(): Promise<readonly CleanupCandidate[]>
    remove(candidate: CleanupCandidate, callbacks: RemovalCallbacks): Promise<RemovalResult>
}

export interface CommandResult {
    readonly exitCode: number
    readonly stdout: string
    readonly stderr: string
}

export type CommandRunner = (command: readonly string[], timeoutMs?: number) => Promise<CommandResult>
