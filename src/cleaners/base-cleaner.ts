import { removeFilesystemCandidate } from "../core/filesystem/index.ts";
import type {
    AppCleaner,
    CleanupCandidate,
    CleanupCategoryId,
    RemovalCallbacks,
    RemovalResult,
} from "../core/types.ts";
import { verifySquirrelVersionBeforeRemoval } from "./helpers.ts";

export abstract class BaseCleaner implements AppCleaner {
    abstract readonly id: string;
    abstract readonly appId: string;
    abstract readonly category: CleanupCategoryId;
    abstract readonly label: string;
    abstract readonly description: string;

    abstract detect(): Promise<readonly CleanupCandidate[]>;

    async remove(candidate: CleanupCandidate, callbacks: RemovalCallbacks): Promise<RemovalResult> {
        if (candidate.id.startsWith(`${this.id}:old-version:`)) {
            await verifySquirrelVersionBeforeRemoval(candidate);
        }
        return removeFilesystemCandidate(candidate, callbacks);
    }
}
