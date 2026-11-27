import { errorMessage } from '../core/format.ts'

/** Resolves with the error a promise rejects with, failing the test if it resolves instead. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise
    } catch (error) {
        return error
    }
    throw new Error('Expected the promise to reject.')
}

/** Resolves with the message of the error a promise rejects with. */
export async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
    return errorMessage(await rejection(promise))
}
