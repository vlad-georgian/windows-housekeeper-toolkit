import { basename, join } from 'node:path'

import { createFilesystemCandidate, readSmallTextFile } from '../../core/filesystem/index.ts'
import type { SystemPaths } from '../../core/system-paths.ts'
import type { CleanupCandidate, RemovalCallbacks, RemovalResult } from '../../core/types.ts'
import { BaseCleaner } from '../base-cleaner.ts'

function parseJson(content: string | null): unknown {
    if (content === null) return null
    try {
        return JSON.parse(content)
    } catch {
        return null
    }
}

function isFolderName(value: string): boolean {
    return value !== '' && value !== '.' && value !== '..' && !/[\\/:]/.test(value)
}

/** Folders that VS Code's `.obsolete` file marks as removed or replaced extensions. */
function obsoleteFolders(content: string | null): Set<string> | null {
    const parsed = parseJson(content)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    return new Set(Object.entries(parsed).flatMap(([name, marked]) => (marked === true && isFolderName(name) ? [name] : [])))
}

/** Lower-cased folders that `extensions.json` records as installed extensions. */
function installedFolders(content: string | null): Set<string> | null {
    const parsed = parseJson(content)
    if (!Array.isArray(parsed)) return null
    const folders = new Set<string>()
    for (const entry of parsed) {
        if (typeof entry !== 'object' || entry === null) return null
        const relative = 'relativeLocation' in entry && typeof entry.relativeLocation === 'string' ? entry.relativeLocation : null
        const location = 'location' in entry && typeof entry.location === 'object' && entry.location !== null ? entry.location : null
        const path = location && 'path' in location && typeof location.path === 'string' ? location.path : null
        const folder = relative ?? path?.split(/[\\/]/).at(-1)
        // An entry that names no folder cannot be matched, so treat the registry as unverified.
        if (!folder) return null
        folders.add(folder.toLowerCase())
    }
    return folders
}

export class VSCodeExtensionsCleaner extends BaseCleaner {
    readonly id = 'vscode-extensions'
    readonly appId = 'vscode'
    readonly category = 'old-installations'
    readonly label = 'Visual Studio Code'
    readonly description = 'Extension versions that VS Code has marked obsolete'

    constructor(private readonly paths: SystemPaths) {
        super()
    }

    private root(): string {
        return join(this.paths.home, '.vscode', 'extensions')
    }

    /** Obsolete folders that the installed-extension registry does not reference, or null when either file is unverified. */
    private async removableFolders(): Promise<Set<string> | null> {
        const root = this.root()
        const obsolete = obsoleteFolders(await readSmallTextFile(join(root, '.obsolete'), root))
        const installed = installedFolders(await readSmallTextFile(join(root, 'extensions.json'), root))
        if (!obsolete || !installed) return null
        return new Set([...obsolete].filter((folder) => !installed.has(folder.toLowerCase())))
    }

    async detect(): Promise<readonly CleanupCandidate[]> {
        const root = this.root()
        const candidates: CleanupCandidate[] = []
        for (const folder of (await this.removableFolders()) ?? []) {
            const candidate = await createFilesystemCandidate({
                id: `vscode:extension:${folder}`,
                path: join(root, folder),
                allowedRoot: root,
                displayName: `VS Code extension ${folder}`,
                reason: 'Marked obsolete by VS Code and not recorded as an installed extension',
                type: 'directory'
            })
            if (candidate) candidates.push(candidate)
        }
        return candidates
    }

    override async remove(candidate: CleanupCandidate, callbacks: RemovalCallbacks): Promise<RemovalResult> {
        const folder = candidate.path ? basename(candidate.path) : null
        if (!folder || candidate.id !== `vscode:extension:${folder}` || !(await this.removableFolders())?.has(folder)) {
            throw new Error(`Could not verify that ${candidate.displayName} is still obsolete.`)
        }
        return super.remove(candidate, callbacks)
    }
}
