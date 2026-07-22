import { useCallback, useEffect, useState } from 'react';
import { vscodeApi } from './vscode';
import { isVscodeEditorDark, observeVscodeThemeChange } from './vscodeTheme';

export type ViewerColorMode = 'light' | 'adaptive';

interface ViewerColorModeOptions {
    /** localStorage persistence key, e.g. 'office-excel-color-mode'. */
    storageKey: string;
    /** key used inside the VS Code webview state object, e.g. 'excelColorMode'. */
    stateKey: string;
    /** legacy boolean dark-mode key ('1'/'0') migrated when no new value exists. */
    legacyDarkModeKey?: string;
}

function loadViewerColorMode({ storageKey, stateKey, legacyDarkModeKey }: ViewerColorModeOptions): ViewerColorMode {
    const state = vscodeApi?.getState?.() as Record<string, unknown> | undefined;
    const stateValue = state?.[stateKey];
    if (stateValue === 'light' || stateValue === 'adaptive') {
        return stateValue;
    }
    try {
        const saved = localStorage.getItem(storageKey);
        if (saved === 'light' || saved === 'adaptive') {
            return saved;
        }
        if (legacyDarkModeKey) {
            const legacy = localStorage.getItem(legacyDarkModeKey);
            if (legacy === '1') {
                return 'adaptive';
            }
            if (legacy === '0') {
                return 'light';
            }
        }
    } catch { }
    return 'light';
}

function saveViewerColorMode({ storageKey, stateKey }: ViewerColorModeOptions, mode: ViewerColorMode) {
    try {
        localStorage.setItem(storageKey, mode);
    } catch { }
    if (vscodeApi?.setState) {
        const prev = (vscodeApi.getState?.() ?? {}) as Record<string, unknown>;
        vscodeApi.setState({ ...prev, [stateKey]: mode });
    }
}

/**
 * Shared color-mode state for viewers with a light/adaptive toggle.
 * `themedDark` is true when adaptive mode is on and the host (VS Code / desktop) theme is dark.
 */
export function useViewerColorMode(options: ViewerColorModeOptions) {
    const [colorMode, setColorMode] = useState<ViewerColorMode>(() => loadViewerColorMode(options));
    const [vscodeDark, setVscodeDark] = useState(isVscodeEditorDark);
    const adaptive = colorMode === 'adaptive';

    useEffect(() => {
        if (!adaptive) {
            return;
        }
        return observeVscodeThemeChange(() => setVscodeDark(isVscodeEditorDark()));
    }, [adaptive]);

    const toggleColorMode = useCallback(() => {
        setColorMode((prev) => {
            const next: ViewerColorMode = prev === 'adaptive' ? 'light' : 'adaptive';
            saveViewerColorMode(options, next);
            if (next === 'adaptive') {
                setVscodeDark(isVscodeEditorDark());
            }
            return next;
        });
    }, [options]);

    return {
        colorMode,
        adaptiveColorMode: adaptive,
        vscodeDark,
        themedDark: adaptive && vscodeDark,
        toggleColorMode,
    };
}
