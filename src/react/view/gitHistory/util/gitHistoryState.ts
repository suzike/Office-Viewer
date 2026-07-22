import { vscodeApi } from '../../../util/vscode';

export interface GitPullDefaults {
    noFastForward: boolean;
    squash: boolean;
}

export const DEFAULT_PULL_DEFAULTS: GitPullDefaults = {
    noFastForward: false,
    squash: false,
};

export type FileHistorySplitLayout = 'vertical' | 'horizontal';

export type GitHistoryColorMode = 'adaptive' | 'light';

export const DEFAULT_COLOR_MODE: GitHistoryColorMode = 'adaptive';
const COLOR_MODE_KEY = 'office.gitHistory.colorMode';
const DESKTOP_STATE_KEY = 'office.gitHistory.desktopState';

export const DEFAULT_FILE_HISTORY_SPLIT_LAYOUT: FileHistorySplitLayout = 'vertical';

export interface GitHistorySavedState {
    repo?: string;
    selectedBranch?: string | null;
    selectedAuthor?: string;
    searchValue?: string;
    selectedCommitHash?: string | null;
    filePath?: string | null;
    pullDefaultsByRepo?: Record<string, GitPullDefaults>;
    fileHistorySplitLayout?: FileHistorySplitLayout;
    colorMode?: GitHistoryColorMode;
}

export function loadGitHistoryState(): GitHistorySavedState {
    const vscodeState = vscodeApi?.getState?.() as GitHistorySavedState | undefined;
    if (vscodeState) return vscodeState;
    try {
        const value = localStorage.getItem(DESKTOP_STATE_KEY);
        if (!value) return {};
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as GitHistorySavedState
            : {};
    } catch {
        return {};
    }
}

export function saveGitHistoryState(partial: GitHistorySavedState): void {
    const prev = loadGitHistoryState();
    const next = { ...prev, ...partial };
    if (vscodeApi?.setState) {
        vscodeApi.setState(next);
        return;
    }
    try {
        localStorage.setItem(DESKTOP_STATE_KEY, JSON.stringify(next));
    } catch { }
}

export function getPullDefaults(repo: string): GitPullDefaults {
    const state = loadGitHistoryState();
    return state.pullDefaultsByRepo?.[repo] ?? DEFAULT_PULL_DEFAULTS;
}

export function savePullDefaults(repo: string, defaults: GitPullDefaults): void {
    const state = loadGitHistoryState();
    const pullDefaultsByRepo = { ...(state.pullDefaultsByRepo ?? {}), [repo]: defaults };
    saveGitHistoryState({ pullDefaultsByRepo });
}

export function getFileHistorySplitLayout(): FileHistorySplitLayout {
    const state = loadGitHistoryState();
    return state.fileHistorySplitLayout === 'horizontal' ? 'horizontal' : DEFAULT_FILE_HISTORY_SPLIT_LAYOUT;
}

export function saveFileHistorySplitLayout(layout: FileHistorySplitLayout): void {
    saveGitHistoryState({ fileHistorySplitLayout: layout });
}

export function getColorMode(): GitHistoryColorMode {
    try {
        const value = localStorage.getItem(COLOR_MODE_KEY);
        return value === 'light' ? 'light' : DEFAULT_COLOR_MODE;
    } catch {
        return DEFAULT_COLOR_MODE;
    }
}

export function saveColorMode(mode: GitHistoryColorMode): void {
    try {
        localStorage.setItem(COLOR_MODE_KEY, mode);
    } catch { }
}
