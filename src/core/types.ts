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

export interface RemovalCallbacks {
    readonly onRemoved: (entry: RemovedEntry) => Promise<void>
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

export interface AppCleaner {
    readonly id: string
    readonly label: string
    readonly description: string
    detect(): Promise<readonly CleanupCandidate[]>
    remove(candidate: CleanupCandidate, callbacks: RemovalCallbacks): Promise<RemovalResult>
}

export interface CommandResult {
    readonly exitCode: number
    readonly stdout: string
    readonly stderr: string
}

export type CommandRunner = (command: readonly string[], timeoutMs?: number) => Promise<CommandResult>
