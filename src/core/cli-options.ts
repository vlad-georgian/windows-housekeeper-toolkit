import { resolve } from 'node:path'

import { object } from '@optique/core/constructs'
import { message } from '@optique/core/message'
import { map, multiple, optional } from '@optique/core/modifiers'
import { option } from '@optique/core/primitives'
import { choice, string } from '@optique/core/valueparser'
import { run } from '@optique/run'

import { projectName } from './state.ts'
import { cleanupCategoryIds, type CleanupCategoryId } from './types.ts'

export interface CliOptions {
    /** Categories for an unattended run. Empty means the interactive launch menu. */
    readonly categories: readonly CleanupCategoryId[]
    readonly dryRun: boolean
    readonly logDirectory: string
}

const cliParser = map(
    object({
        categories: multiple(
            option('--category', choice(cleanupCategoryIds, { metavar: 'CATEGORY' }), {
                description: message`Run one cleanup category unattended. Repeat to name several. Destructive caches and Windows temporary directories run only when their category is named.`
            })
        ),
        dryRun: option('--dry-run', {
            description: message`Detect and log targets without removing them.`
        }),
        logDirectory: optional(
            option('--log-dir', string({ metavar: 'PATH' }), {
                description: message`Write audit logs somewhere other than ./logs.`
            })
        )
    }),
    (options): CliOptions => ({
        categories: [...new Set(options.categories)],
        dryRun: options.dryRun,
        logDirectory: resolve(options.logDirectory ?? resolve(process.cwd(), 'logs'))
    })
)

export function parseCliOptions(arguments_: readonly string[]): CliOptions {
    return run(cliParser, {
        programName: projectName,
        args: arguments_,
        help: 'both',
        version: '0.1.0',
        completion: 'both',
        brief: message`Safely remove redundant Windows application payloads.`,
        description: message`Run without --category to choose operations and apps interactively. Categories: general-cache, destructive-cache, windows-temp, old-installations. For Windows controls, see startup --help, updates --help, signin --help, and migration --help.`,
        showUsage: true
    })
}
