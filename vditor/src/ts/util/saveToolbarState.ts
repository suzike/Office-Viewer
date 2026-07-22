import {Constants} from "../constants";

const SAVE_TOOLBAR_NAME = "save";

const dirtyStateMap = new WeakMap<IVditor, boolean>();

const setSaveButtonDisabled = (vditor: IVditor, disabled: boolean) => {
    const toolbarItem = vditor.toolbar?.elements?.[SAVE_TOOLBAR_NAME];
    if (!toolbarItem) {
        return;
    }
    const btn = toolbarItem.children[0] as HTMLElement | undefined;
    if (!btn) {
        return;
    }
    if (disabled) {
        btn.setAttribute("disabled", "disabled");
        btn.classList.add(Constants.CLASS_MENU_DISABLED);
        return;
    }
    btn.removeAttribute("disabled");
    btn.classList.remove(Constants.CLASS_MENU_DISABLED);
};

export const initSaveToolbarState = (vditor: IVditor, _markdown: string) => {
    dirtyStateMap.set(vditor, false);
    updateSaveToolbarState(vditor);
};

export const markDocumentSaved = (vditor: IVditor, _markdown?: string) => {
    dirtyStateMap.set(vditor, false);
    updateSaveToolbarState(vditor);
};

export const isDocumentDirty = (vditor: IVditor): boolean => {
    return dirtyStateMap.get(vditor) ?? false;
};

export const updateSaveToolbarState = (vditor: IVditor) => {
    if (!vditor.toolbar?.elements?.[SAVE_TOOLBAR_NAME]) {
        return;
    }
    setSaveButtonDisabled(vditor, !isDocumentDirty(vditor));
};

export const fireContentInput = (vditor: IVditor, text: string) => {
    if (typeof vditor.options.input === "function") {
        vditor.options.input(text);
    }
    dirtyStateMap.set(vditor, true);
    updateSaveToolbarState(vditor);
};
