import { diff_match_patch } from "diff-match-patch";

const DIFF_DELETE = -1;
const DIFF_INSERT = 1;

export const computeDiffStats = (diffs: [number, string][]): { additions: number; deletions: number } => {
    let additions = 0;
    let deletions = 0;
    for (const [op, text] of diffs) {
        const len = text.length;
        if (op === DIFF_INSERT) {
            additions += len;
        } else if (op === DIFF_DELETE) {
            deletions += len;
        }
    }
    return { additions, deletions };
};

export const computeFullDiff = (original: string, modified: string): [number, string][] => {
    const dmp = new diff_match_patch();
    dmp.Diff_Timeout = 2;
    const diffs = dmp.diff_main(original, modified, true);
    dmp.diff_cleanupSemantic(diffs);
    return diffs;
};
