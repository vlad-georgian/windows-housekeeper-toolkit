import { describe, expect, test } from 'bun:test'

import type { WindowsProcess } from '../../windows/processes.ts'
import { isPathInUse, runningProcessPaths } from './running-paths.ts'

const named = /^app(?:\.exe)?$/i
const listing =
    (...processes: WindowsProcess[]) =>
    async (): Promise<WindowsProcess[]> =>
        processes

describe('running process paths', () => {
    test('collects every readable executable path', async () => {
        const paths = await runningProcessPaths(
            listing({ id: 1, name: 'app.exe', path: 'C:\\Apps\\one\\app.exe' }, { id: 2, name: 'other.exe', path: 'C:\\Apps\\two\\other.exe' }),
            named
        )
        expect(paths).toEqual(expect.arrayContaining(['C:\\Apps\\one\\app.exe', 'C:\\Apps\\two\\other.exe']))
    })

    test('ignores processes without a path unless their name matches', async () => {
        expect(await runningProcessPaths(listing({ id: 4, name: 'System', path: null }, { id: 5, name: 'Registry', path: null }), named)).toEqual([])
    })

    test('cannot verify use when a matching process has no readable path', async () => {
        expect(await runningProcessPaths(listing({ id: 4, name: 'System', path: null }, { id: 6, name: 'app.exe', path: null }), named)).toBeNull()
        expect(await runningProcessPaths(listing({ id: 6, name: 'app.exe' }), named)).toBeNull()
    })

    test('cannot verify use when a path is relative or the listing fails', async () => {
        expect(await runningProcessPaths(listing({ id: 7, name: 'other.exe', path: 'relative\\other.exe' }), named)).toBeNull()
        expect(await runningProcessPaths(() => Promise.reject(new Error('unavailable')), named)).toBeNull()
    })

    test('treats a process as using a path it is, or runs from inside', () => {
        const processes = ['C:\\Apps\\one\\app.exe']
        expect(isPathInUse('C:\\Apps\\one', processes)).toBe(true)
        expect(isPathInUse('c:\\apps\\ONE\\app.exe', processes)).toBe(true)
        expect(isPathInUse('C:\\Apps\\on', processes)).toBe(false)
        expect(isPathInUse('C:\\Apps\\two', processes)).toBe(false)
    })
})
