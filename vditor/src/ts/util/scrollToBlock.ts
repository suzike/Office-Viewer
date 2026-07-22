import { pinOutlineActive } from "../outline/updateOutlineActive";
import { scrollOutlineTarget, OUTLINE_SCROLL_OFFSET } from "../markdown/outlineRender";
import {
    isMathBlockElement,
    isMathBlockEmpty,
    syncMathBlockDisplayMode,
} from "../codeBlock/codeMirrorManager";

const slugifyHeading = (text: string) =>
    text
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .replace(/\s+/g, "-");

const normalizeFragment = (fragment: string) => {
    const trimmed = fragment.trim();
    if (!trimmed) {
        return "";
    }
    const withoutHash = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
    try {
        return decodeURIComponent(withoutHash.replace(/\+/g, " "));
    } catch {
        return withoutHash;
    }
};

const findFootnoteElement = (editorElement: HTMLElement, label: string): HTMLElement | null => {
    const normalizedLabel = label.trim();
    if (!normalizedLabel) {
        return null;
    }
    const escapedLabel = CSS.escape(normalizedLabel);
    const selectors = [
        `[data-type="footnotes-def"][data-marker="${escapedLabel}"]`,
        `[data-type="footnotes-block"] li[data-marker="${escapedLabel}"]`,
    ];
    for (const selector of selectors) {
        const footnote = editorElement.querySelector(selector);
        if (footnote instanceof HTMLElement) {
            return footnote;
        }
    }
    for (const footnote of editorElement.querySelectorAll("[data-type='footnotes-def'], [data-type='footnotes-block'] li")) {
        if (footnote instanceof HTMLElement && footnote.textContent?.trim().startsWith(`[^${normalizedLabel}]:`)) {
            return footnote;
        }
    }
    return null;
};

const scrollBlockIntoView = (vditor: IVditor, blockElement: HTMLElement) => {
    const editorElement = vditor[vditor.currentMode].element;
    if (vditor.options.height === "auto") {
        let windowScrollY = blockElement.offsetTop + vditor.element.offsetTop;
        if (!vditor.options.toolbarConfig.pin) {
            windowScrollY += vditor.toolbar.element.offsetHeight;
        }
        window.scrollTo(window.scrollX, windowScrollY - OUTLINE_SCROLL_OFFSET);
        return;
    }
    if (vditor.element.offsetTop < window.scrollY) {
        window.scrollTo(window.scrollX, vditor.element.offsetTop);
    }
    scrollOutlineTarget(editorElement, blockElement);
};

const findBlockElement = (editorElement: HTMLElement, fragment: string): HTMLElement | null => {
    const normalized = normalizeFragment(fragment);
    if (!normalized) {
        return null;
    }

    if (normalized.startsWith("footnote:")) {
        return findFootnoteElement(editorElement, normalized.slice("footnote:".length));
    }

    const blockId = normalized.startsWith("^") ? normalized.slice(1) : normalized;
    if (blockId) {
        const byAttr = editorElement.querySelector(`[data-block-id="${CSS.escape(blockId)}"]`);
        if (byAttr instanceof HTMLElement) {
            return byAttr;
        }
    }

    if (normalized.startsWith("^")) {
        for (const el of editorElement.querySelectorAll("[data-block=\"0\"]")) {
            if (el instanceof HTMLElement && el.textContent?.includes(normalized)) {
                return el;
            }
        }
    }

    const headingText = decodeURIComponent(normalized.replace(/\+/g, " "));
    const headingSelectors = [
        `#${CSS.escape("wysiwyg-" + normalized)}`,
        `#${CSS.escape("ir-" + normalized)}`,
        `#${CSS.escape(normalized)}`,
        `[name="${CSS.escape(normalized)}"]`,
    ];
    for (const selector of headingSelectors) {
        const heading = editorElement.querySelector(selector);
        if (heading instanceof HTMLElement) {
            return heading;
        }
    }

    for (const heading of editorElement.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
        if (!(heading instanceof HTMLElement)) {
            continue;
        }
        const text = heading.textContent?.trim() || "";
        if (text === headingText || slugifyHeading(text) === headingText || slugifyHeading(text) === normalized) {
            return heading;
        }
    }

    return null;
};

export const scrollToBlock = (vditor: IVditor, fragment: string): boolean => {
    const blockElement = findBlockElement(vditor[vditor.currentMode].element, fragment);
    if (!blockElement) {
        return false;
    }

    const tagName = blockElement.tagName;
    if (/^H[1-6]$/i.test(tagName)) {
        const rawId = blockElement.id.replace(/^(wysiwyg-|ir-)/, "");
        if (rawId) {
            pinOutlineActive(vditor, rawId);
        }
    }

    scrollBlockIntoView(vditor, blockElement);

    const mathBlock = isMathBlockElement(blockElement)
        ? blockElement
        : (blockElement.closest("[data-type='math-block']") as HTMLElement | null);
    if (mathBlock && isMathBlockEmpty(mathBlock)) {
        syncMathBlockDisplayMode(vditor, mathBlock, true);
    }

    return true;
};
