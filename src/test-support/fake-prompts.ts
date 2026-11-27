import type { ChecklistRequest, LaunchPrompts } from '../launch/types.ts'

type Answer = readonly string[] | boolean | null

/** Scripted prompts. Each answer is consumed in order; `null` cancels the prompt. */
export class FakePrompts implements LaunchPrompts {
    readonly checklists: ChecklistRequest[] = []
    readonly confirmations: string[] = []
    readonly notes: { title: string; lines: readonly string[] }[] = []
    private readonly answers: Answer[]

    constructor(answers: readonly Answer[]) {
        this.answers = [...answers]
    }

    private next(kind: string): Answer {
        if (this.answers.length === 0) throw new Error(`Unexpected ${kind} prompt.`)
        return this.answers.shift() ?? null
    }

    checklist(request: ChecklistRequest): Promise<string[] | null> {
        this.checklists.push(request)
        const answer = this.next(`checklist "${request.message}"`)
        if (answer !== null && typeof answer === 'boolean') {
            throw new Error(`Expected a checklist answer for "${request.message}".`)
        }
        return Promise.resolve(answer === null ? null : [...answer])
    }

    confirm(message: string): Promise<boolean | null> {
        this.confirmations.push(message)
        const answer = this.next(`confirmation "${message}"`)
        if (answer !== null && typeof answer !== 'boolean') {
            throw new Error(`Expected a confirmation answer for "${message}".`)
        }
        return Promise.resolve(answer)
    }

    note(title: string, lines: readonly string[]): void {
        this.notes.push({ title, lines })
    }

    log(): void {}
}
