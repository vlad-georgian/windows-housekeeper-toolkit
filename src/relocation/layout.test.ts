import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { symlink } from 'node:fs/promises'
import { join } from 'node:path'

import { createSandbox, type Sandbox } from '../test-support/fixtures.ts'
import { mirroredPath, relocationBaseOf, validateRelocationBase } from './layout.ts'

describe('relocation layout', () => {
    test('mirrors a path under the base, profile name, and its profile-relative path', () => {
        expect(mirroredPath('E:\\Software', 'C:\\Users\\test', 'C:\\Users\\test\\AppData\\Local\\Claude-Data')).toBe('E:\\Software\\test\\AppData\\Local\\Claude-Data')
    })

    test('refuses paths outside the profile', () => {
        expect(() => mirroredPath('E:\\Software', 'C:\\Users\\test', 'C:\\ProgramData\\App')).toThrow('outside the Windows profile')
        expect(() => mirroredPath('E:\\Software', 'C:\\Users\\test', 'C:\\Users\\test')).toThrow('outside the Windows profile')
    })

    test('recovers the base from a mirrored destination, ignoring case', () => {
        expect(relocationBaseOf('e:\\software\\TEST\\appdata\\local\\claude-data', 'C:\\Users\\test', 'C:\\Users\\test\\AppData\\Local\\Claude-Data')).toBe('e:\\software')
    })

    test('finds no base for a destination outside the mirrored layout', () => {
        expect(relocationBaseOf('E:\\Elsewhere\\Claude-Data', 'C:\\Users\\test', 'C:\\Users\\test\\AppData\\Local\\Claude-Data')).toBeNull()
        expect(relocationBaseOf('E:\\test\\AppData\\Local\\Claude-Data', 'C:\\Users\\test', 'C:\\Users\\test\\AppData\\Local\\Claude-Data')).toBe('E:\\')
    })
})

const otherVolume = async (): Promise<boolean> => true

describe('relocation base validation', () => {
    let sandbox: Sandbox
    beforeEach(async () => {
        sandbox = await createSandbox()
    })
    afterEach(() => sandbox.dispose())

    const original = (): string => join(sandbox.paths.localAppData, 'GitHubDesktop')

    test('accepts an absolute directory outside the profile on another volume', async () => {
        const base = join(sandbox.root, 'E', 'Software')
        expect(await validateRelocationBase(base, { home: sandbox.paths.home, originals: [original()], volumesDiffer: otherVolume })).toBeNull()
    })

    test('rejects relative, profile, and same-volume bases', async () => {
        const options = { home: sandbox.paths.home, originals: [original()], volumesDiffer: otherVolume }
        expect(await validateRelocationBase('Software', options)).toContain('absolute')
        expect(await validateRelocationBase(join(sandbox.paths.home, 'Moved'), options)).toContain('outside the Windows profile')
        expect(await validateRelocationBase(join(sandbox.root, 'E'), { ...options, volumesDiffer: async () => false })).toContain('another drive')
    })

    test('rejects a base that is a file or reached through a link', async () => {
        const options = { home: sandbox.paths.home, originals: [original()], volumesDiffer: otherVolume }
        expect(await validateRelocationBase(await sandbox.file('E/file'), options)).toContain('not a directory')
        const real = await sandbox.directory('E/real')
        await symlink(real, join(sandbox.root, 'E', 'linked'), 'junction')
        expect(await validateRelocationBase(join(sandbox.root, 'E', 'linked', 'Software'), options)).toContain('link')
    })
})
