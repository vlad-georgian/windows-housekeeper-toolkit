import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { SystemPaths } from '../core/system-paths.ts'

/** A disposable Windows-shaped profile. Tests never touch the real user profile. */
export interface Sandbox {
    readonly root: string
    readonly paths: SystemPaths
    file(path: string, content?: string): Promise<string>
    directory(path: string): Promise<string>
    dispose(): Promise<void>
}

export async function createSandbox(): Promise<Sandbox> {
    const root = await mkdtemp(join(tmpdir(), 'housekeeper-test-'))
    const home = join(root, 'Users', 'test')
    const paths: SystemPaths = {
        home,
        localAppData: join(home, 'AppData', 'Local'),
        roamingAppData: join(home, 'AppData', 'Roaming'),
        temp: join(home, 'AppData', 'Local', 'Temp'),
        programData: join(root, 'ProgramData'),
        systemRoot: join(root, 'Windows'),
        systemDrive: root
    }
    for (const directory of [paths.localAppData, paths.roamingAppData, paths.temp]) {
        await mkdir(directory, { recursive: true })
    }
    return {
        root,
        paths,
        async file(path, content = 'x') {
            const target = join(root, path)
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, content)
            return target
        },
        async directory(path) {
            const target = join(root, path)
            await mkdir(target, { recursive: true })
            return target
        },
        dispose: () => rm(root, { recursive: true, force: true })
    }
}
