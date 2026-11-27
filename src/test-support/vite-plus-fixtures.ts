import { link, symlink } from 'node:fs/promises'
import { join } from 'node:path'

import type { Sandbox } from './fixtures.ts'

/** The monolithic layout of Vite+ 0.2 and earlier, and the split data directory of 0.3 and later. */
export const vitePlusLegacyHome = join('Users', 'test', '.vite-plus')
export const vitePlusSplitData = join('Users', 'test', 'AppData', 'Local', 'vite-plus', 'data')
export const pnpmStore = join('Users', 'test', 'pnpm-store')

/**
 * A release as Vite+ installs it: the wrapper project the installer writes, installed by pnpm, so
 * `node_modules` holds a junction into the virtual store and a file hardlinked from the shared
 * content store. Returns the path of the release's `vp.exe`.
 */
export async function addVitePlusRelease(sandbox: Sandbox, version: string, root = vitePlusLegacyHome, manifestVersion = version.split('+')[0]): Promise<string> {
    const release = join(root, version)
    await sandbox.file(
        join(release, 'package.json'),
        JSON.stringify({ name: 'vp-global', version: manifestVersion, private: true, dependencies: { 'vite-plus': manifestVersion } })
    )
    const binary = await sandbox.file(join(release, 'bin', 'vp.exe'))
    const virtual = join(release, 'node_modules', '.pnpm', `vite-plus@${manifestVersion}`, 'node_modules', 'vite-plus')
    const content = await sandbox.file(join(pnpmStore, `${version.replaceAll('+', '_')}-index.js`), 'shared content')
    await sandbox.directory(virtual)
    await link(content, join(sandbox.root, virtual, 'index.js'))
    await symlink(join(sandbox.root, virtual), join(sandbox.root, release, 'node_modules', 'vite-plus'), 'junction')
    return binary
}

/** Points the data directory's `current` junction at a release, as Vite+ does. */
export async function selectVitePlusRelease(sandbox: Sandbox, version: string, root = vitePlusLegacyHome): Promise<void> {
    await symlink(join(sandbox.root, root, version), join(sandbox.root, root, 'current'), 'junction')
}
