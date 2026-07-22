import { getCodeMirrorView, isInsideCodeMirror } from "../codeBlock/codeMirrorManager";
import { adjustEditorScrollBy } from "../util/documentState";
import {
    TYPEWRITER_MODE_KEY,
    getGlobalLocalStorageSetting,
} from "../util/globalLocalStorageSettings";
import {
    getRangeCaretRect,
    getSelectionRangeInEditor,
} from "../util/selection";

type TypewriterBinding = {
    onInput: (event: Event) => void;
    onCompositionEnd: () => void;
    rafId: number;
};

const bindings = new WeakMap<IVditor, TypewriterBinding>();

export const isTypewriterModeEnabled = () => {
    return getGlobalLocalStorageSetting<boolean>(TYPEWRITER_MODE_KEY, false) === true;
};

export { applyTypewriterModeClass } from "../util/globalLocalStorageSettings";

const getActiveEditorElement = (vditor: IVditor): HTMLElement | null => {
    const mode = vditor.currentMode;
    if (mode === "wysiwyg" || mode === "ir") {
        return vditor[mode].element;
    }
    return null;
};

const getCaretViewportCenterDelta = (editor: HTMLElement): number | null => {
    const editorRect = editor.getBoundingClientRect();
    const targetCenter = editorRect.top + editorRect.height / 2;

    const activeElement = document.activeElement;
    if (isInsideCodeMirror(activeElement)) {
        const block = activeElement?.closest("[data-type='code-block']") as HTMLElement | null;
        if (block && editor.contains(block)) {
            const view = getCodeMirrorView(block);
            const pos = view?.state.selection.main.head;
            const coords = pos == null ? null : view?.coordsAtPos(pos, 1);
            if (coords) {
                return (coords.top + coords.bottom) / 2 - targetCenter;
            }
        }
    }

    const range = getSelectionRangeInEditor(editor);
    if (!range) {
        return null;
    }
    const rect = getRangeCaretRect(range);
    if (!rect) {
        return null;
    }
    return (rect.top + rect.bottom) / 2 - targetCenter;
};

export const syncTypewriterScroll = (vditor: IVditor) => {
    if (!isTypewriterModeEnabled()) {
        return;
    }
    const editor = getActiveEditorElement(vditor);
    if (!editor || editor.getAttribute("contenteditable") === "false") {
        return;
    }
    const delta = getCaretViewportCenterDelta(editor);
    if (delta == null || Math.abs(delta) < 1) {
        return;
    }
    adjustEditorScrollBy(vditor, delta);
};

const scheduleTypewriterScroll = (vditor: IVditor) => {
    if (!isTypewriterModeEnabled()) {
        return;
    }
    const binding = bindings.get(vditor);
    if (!binding) {
        return;
    }
    if (binding.rafId) {
        window.cancelAnimationFrame(binding.rafId);
    }
    binding.rafId = window.requestAnimationFrame(() => {
        binding.rafId = 0;
        syncTypewriterScroll(vditor);
    });
};

export const bindTypewriterMode = (vditor: IVditor) => {
    if (bindings.has(vditor)) {
        return;
    }

    const onInput = (event: Event) => {
        if ((event as InputEvent).isComposing) {
            return;
        }
        scheduleTypewriterScroll(vditor);
    };

    const onCompositionEnd = () => {
        scheduleTypewriterScroll(vditor);
    };

    const binding: TypewriterBinding = {
        onInput,
        onCompositionEnd,
        rafId: 0,
    };
    bindings.set(vditor, binding);

    for (const mode of ["wysiwyg", "ir"] as const) {
        const editor = vditor[mode].element;
        editor.addEventListener("input", onInput);
        editor.addEventListener("compositionend", onCompositionEnd);
    }
};

export const unbindTypewriterMode = (vditor: IVditor) => {
    const binding = bindings.get(vditor);
    if (!binding) {
        return;
    }
    if (binding.rafId) {
        window.cancelAnimationFrame(binding.rafId);
    }
    for (const mode of ["wysiwyg", "ir"] as const) {
        const editor = vditor[mode].element;
        editor.removeEventListener("input", binding.onInput);
        editor.removeEventListener("compositionend", binding.onCompositionEnd);
    }
    bindings.delete(vditor);
};
