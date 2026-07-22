import { EditorSelection, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

import { getMarkdown } from "../markdown/getMarkdown";
import { focusCodeMirror, getCodeMirrorView } from "../codeBlock/codeMirrorManager";
import { recordHistoryChange } from "../util/instantHistory";
import { fireContentInput } from "../util/saveToolbarState";
import { getNodeByPath, getNodePath } from "../util/selection";

const HIGHLIGHT_CLASS = "vditor-find-highlight";
const CURRENT_CLASS = "vditor-find-highlight--current";
const CSS_FIND_MATCH = "vditor-find-match";
const CSS_FIND_CURRENT = "vditor-find-current";
const FIND_SKIP_SELECTOR = [
    "code",
    ".cm-editor",
    ".vditor-cm-chrome",
    ".vditor-find-bar",
    "[hidden]",
    "[aria-hidden='true']",
].join(", ");

const c = (name: string) => `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;

type FindMatch = FindDomMatch | FindCodeMirrorMatch;

interface FindDomMatch {
    kind: "dom";
    startPath: number[];
    startOffset: number;
    endPath: number[];
    endOffset: number;
}

interface FindCodeMirrorMatch {
    kind: "cm";
    block: HTMLElement;
    view?: EditorView;
    from: number;
    to: number;
}

interface FindOptionsState {
    matchCase: boolean;
    wholeWord: boolean;
    regex: boolean;
}

interface CompiledPattern {
    global: RegExp;
    single: RegExp;
}

const cmDecorationsEffect = StateEffect.define<DecorationSet>();

const cmDecorationsField = StateField.define<DecorationSet>({
    create() {
        return Decoration.none;
    },
    update(decorations, tr) {
        decorations = decorations.map(tr.changes);
        for (const effect of tr.effects) {
            if (effect.is(cmDecorationsEffect)) {
                decorations = effect.value;
            }
        }
        return decorations;
    },
    provide: (field) => EditorView.decorations.from(field),
});

const supportsCssCustomHighlight = () => typeof CSS !== "undefined" && "highlights" in CSS;

const clampNodeOffset = (node: Node, offset: number) => {
    if (node.nodeType === 3) {
        return Math.min(Math.max(0, offset), node.textContent?.length || 0);
    }
    return Math.min(Math.max(0, offset), node.childNodes.length);
};

const ensureFindDecorationsField = (view: EditorView) => {
    if (view.state.field(cmDecorationsField, false)) {
        return;
    }
    view.dispatch({
        effects: StateEffect.appendConfig.of([cmDecorationsField]),
    });
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildSearchSource = (query: string, options: FindOptionsState) => {
    const base = options.regex ? query : escapeRegExp(query);
    return options.wholeWord ? `\\b(?:${base})\\b` : base;
};

const buildRegexFlags = (matchCase: boolean, global: boolean) => {
    return `${global ? "g" : ""}${matchCase ? "" : "i"}`;
};

const compilePattern = (query: string, options: FindOptionsState): CompiledPattern => {
    const source = buildSearchSource(query, options);
    return {
        global: new RegExp(source, buildRegexFlags(options.matchCase, true)),
        single: new RegExp(source, buildRegexFlags(options.matchCase, false)),
    };
};

export class FindBar {
    public element: HTMLElement;
    private input: HTMLInputElement;
    private replaceInput: HTMLInputElement;
    private replaceRow: HTMLElement;
    private replaceToggleBtn: HTMLButtonElement;
    private countEl: HTMLElement;
    private matches: FindMatch[] = [];
    private currentIndex = -1;
    private vditor: IVditor;
    private options: FindOptionsState = {
        matchCase: false,
        wholeWord: false,
        regex: false,
    };
    private compiledPattern: CompiledPattern | null = null;
    private queryError: string | null = null;
    private replaceExpanded = false;
    private editorObserver: MutationObserver | null = null;
    private refreshScheduled = false;
    private focusRestoreTimer = 0;
    private activeFindField: HTMLInputElement | null = null;
    private findComposing = false;

    constructor(vditor: IVditor) {
        this.vditor = vditor;

        const i18n = window.VditorI18n;
        this.element = document.createElement("div");
        this.element.className = "vditor-find-bar";
        this.element.style.display = "none";
        this.element.innerHTML = `
            <div class="vditor-find-bar__row">
                <input
                    type="text"
                    class="vditor-find-bar__input"
                    placeholder="${i18n?.["find-placeholder"] || "Find…"}"
                />
                <span class="vditor-find-bar__count"></span>
                <button type="button" class="vditor-find-bar__option" data-option="matchCase" title="${i18n?.["find-match-case"] || "Match Case"}">Aa</button>
                <button type="button" class="vditor-find-bar__option" data-option="wholeWord" title="${i18n?.["find-whole-word"] || "Whole Word"}">W</button>
                <button type="button" class="vditor-find-bar__option" data-option="regex" title="${i18n?.["find-regex"] || "Use Regular Expression"}">.*</button>
                <button type="button" class="vditor-find-bar__option" data-action="toggle-replace" title="${i18n?.["find-toggle-replace"] || "Toggle Replace"}">R</button>
                <button type="button" class="vditor-find-bar__nav" data-dir="-1" title="${i18n?.["find-previous"] || "Previous (Shift+Enter)"}">${c("arrow-up")}</button>
                <button type="button" class="vditor-find-bar__nav" data-dir="1" title="${i18n?.["find-next"] || "Next (Enter)"}">${c("arrow-down")}</button>
                <button type="button" class="vditor-find-bar__close" title="${i18n?.close || "Close"}">${c("close")}</button>
            </div>
            <div class="vditor-find-bar__row vditor-find-bar__row--replace" style="display: none;">
                <input
                    type="text"
                    class="vditor-find-bar__input vditor-find-bar__input--replace"
                    placeholder="${i18n?.["replace-placeholder"] || "Replace…"}"
                />
                <button type="button" class="vditor-find-bar__action" data-action="replace">${i18n?.["find-replace"] || "Replace"}</button>
                <button type="button" class="vditor-find-bar__action" data-action="replace-all">${i18n?.["find-replace-all"] || "Replace All"}</button>
            </div>
        `;

        this.input = this.element.querySelector(".vditor-find-bar__input") as HTMLInputElement;
        this.replaceInput = this.element.querySelector(".vditor-find-bar__input--replace") as HTMLInputElement;
        this.replaceRow = this.element.querySelector(".vditor-find-bar__row--replace") as HTMLElement;
        this.replaceToggleBtn = this.element.querySelector("[data-action='toggle-replace']") as HTMLButtonElement;
        this.countEl = this.element.querySelector(".vditor-find-bar__count") as HTMLElement;

        this.input.addEventListener("focus", () => {
            this.activeFindField = this.input;
        });
        this.replaceInput.addEventListener("focus", () => {
            this.activeFindField = this.replaceInput;
        });

        this.input.addEventListener("compositionstart", () => {
            this.findComposing = true;
        });
        this.input.addEventListener("compositionend", () => {
            this.findComposing = false;
            this.search();
        });
        this.input.addEventListener("input", (event: Event) => {
            const inputEvent = event as InputEvent;
            if (this.findComposing || inputEvent.isComposing) {
                return;
            }
            this.search();
        });

        this.input.addEventListener("keydown", (e) => {
            if (e.isComposing) {
                return;
            }
            if (e.key === "Enter") {
                e.preventDefault();
                this.navigate(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") {
                this.hide();
            }
        });

        this.replaceInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) {
                    this.replaceAll();
                } else {
                    this.replaceCurrent();
                }
            } else if (e.key === "Escape") {
                this.hide();
            }
        });

        document.addEventListener("keydown", (e) => {
            if (e.key !== "Escape" || !this.isVisible()) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            this.hide();
        }, true);

        (this.element.querySelector("[data-dir='-1']") as HTMLElement).addEventListener("click", () => this.navigate(-1));
        (this.element.querySelector("[data-dir='1']") as HTMLElement).addEventListener("click", () => this.navigate(1));
        (this.element.querySelector(".vditor-find-bar__close") as HTMLElement).addEventListener("click", () => this.hide());
        this.replaceToggleBtn.addEventListener("click", () => this.toggleReplace());
        (this.element.querySelector("[data-action='replace']") as HTMLElement).addEventListener("click", () => this.replaceCurrent());
        (this.element.querySelector("[data-action='replace-all']") as HTMLElement).addEventListener("click", () => this.replaceAll());
        this.element.querySelectorAll<HTMLElement>("[data-option]").forEach((button) => {
            button.addEventListener("click", () => {
                const key = button.dataset.option as keyof FindOptionsState;
                this.options[key] = !this.options[key];
                button.classList.toggle("vditor-find-bar__option--active", this.options[key]);
                button.setAttribute("aria-pressed", String(this.options[key]));
                this.search();
            });
        });
    }

    private getContentEl(): HTMLElement | null {
        const mode = this.vditor.currentMode;
        if (mode === "ir") return this.vditor.element.querySelector(".vditor-ir");
        if (mode === "wysiwyg") return this.vditor.element.querySelector(".vditor-wysiwyg");
        return null;
    }

    private getScrollElement(): HTMLElement | null {
        const contentEl = this.getContentEl();
        if (!contentEl) return null;
        if (contentEl.classList.contains("vditor-reset")) {
            return contentEl;
        }
        return contentEl.querySelector(".vditor-reset") as HTMLElement | null;
    }

    private getEditorRoot(): HTMLElement | null {
        return this.getScrollElement() || this.getContentEl();
    }

    private getDomMatchRange(match: FindDomMatch): Range | null {
        const editor = this.getEditorRoot();
        if (!editor) {
            return null;
        }
        const startNode = getNodeByPath(editor, match.startPath);
        const endNode = getNodeByPath(editor, match.endPath);
        if (!startNode || !endNode) {
            return null;
        }
        try {
            const range = editor.ownerDocument.createRange();
            range.setStart(startNode, clampNodeOffset(startNode, match.startOffset));
            range.setEnd(endNode, clampNodeOffset(endNode, match.endOffset));
            return range;
        } catch {
            return null;
        }
    }

    private bindEditorRefresh() {
        this.unbindEditorRefresh();
        const editor = this.getEditorRoot();
        if (!editor) {
            return;
        }
        this.editorObserver = new MutationObserver(() => this.scheduleRefresh());
        this.editorObserver.observe(editor, {
            subtree: true,
            childList: true,
            characterData: true,
        });
    }

    private unbindEditorRefresh() {
        this.editorObserver?.disconnect();
        this.editorObserver = null;
        this.refreshScheduled = false;
    }

    private cancelRestoreFindFocus() {
        if (this.focusRestoreTimer) {
            window.clearTimeout(this.focusRestoreTimer);
            this.focusRestoreTimer = 0;
        }
    }

    /** CM 懒加载/滚动会抢焦点，延迟把焦点还给查找框 */
    private scheduleRestoreFindFocus() {
        if (!this.isVisible()) {
            return;
        }
        this.cancelRestoreFindFocus();
        const target = this.activeFindField ?? this.input;
        const selectionStart = target.selectionStart ?? target.value.length;
        const selectionEnd = target.selectionEnd ?? selectionStart;
        this.focusRestoreTimer = window.setTimeout(() => {
            this.focusRestoreTimer = 0;
            if (!this.isVisible() || document.activeElement === target) {
                return;
            }
            target.focus({ preventScroll: true });
            target.setSelectionRange(selectionStart, selectionEnd);
        }, 0);
    }

    private scheduleRefresh() {
        if (this.refreshScheduled || !this.isVisible()) {
            return;
        }
        this.refreshScheduled = true;
        window.requestAnimationFrame(() => {
            this.refreshScheduled = false;
            if (!this.isVisible() || !this.input.value.trim()) {
                return;
            }
            const preferredIndex = this.currentIndex >= 0 ? this.currentIndex : 0;
            this.search(preferredIndex);
        });
    }

    private getReplacementText(matchedText: string) {
        if (!this.compiledPattern) {
            return this.replaceInput.value;
        }
        return matchedText.replace(this.compiledPattern.single, this.replaceInput.value);
    }

    private buildPattern() {
        const query = this.input.value.trim();
        if (!query) {
            this.compiledPattern = null;
            this.queryError = null;
            return null;
        }

        try {
            this.compiledPattern = compilePattern(query, this.options);
            this.queryError = null;
            return this.compiledPattern;
        } catch {
            this.compiledPattern = null;
            this.queryError = window.VditorI18n?.["find-invalid-regex"] || "Invalid regular expression";
            return null;
        }
    }

    private scrollDomMatchIntoView(match: FindDomMatch) {
        const range = this.getDomMatchRange(match);
        if (!range) {
            return;
        }
        const scrollEl = this.getScrollElement();
        const markRect = range.getBoundingClientRect();
        if (!scrollEl || (markRect.width === 0 && markRect.height === 0)) {
            range.startContainer.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
            return;
        }
        const scrollRect = scrollEl.getBoundingClientRect();
        const padding = 40;
        if (markRect.top < scrollRect.top + padding) {
            scrollEl.scrollTop += markRect.top - scrollRect.top - padding;
        } else if (markRect.bottom > scrollRect.bottom - padding) {
            scrollEl.scrollTop += markRect.bottom - scrollRect.bottom + padding;
        }
    }

    private scrollCodeMirrorMatchIntoView(match: FindCodeMirrorMatch) {
        const view = this.ensureCodeMirrorMatchView(match);
        if (!view) {
            match.block.scrollIntoView({ block: "nearest", inline: "nearest" });
            return;
        }
        view.dispatch({
            effects: EditorView.scrollIntoView(match.from, { y: "center" }),
            selection: EditorSelection.cursor(match.from),
        });
    }

    private ensureCodeMirrorMatchView(match: FindCodeMirrorMatch) {
        const currentView = getCodeMirrorView(match.block);
        if (currentView) {
            match.view = currentView;
            return currentView;
        }
        focusCodeMirror(match.block, true, this.vditor);
        const mountedView = getCodeMirrorView(match.block);
        if (mountedView) {
            match.view = mountedView;
        }
        return mountedView;
    }

    private setReplaceExpanded(expanded: boolean) {
        this.replaceExpanded = expanded;
        this.replaceRow.style.display = expanded ? "flex" : "none";
        this.replaceToggleBtn.classList.toggle("vditor-find-bar__option--active", expanded);
        this.replaceToggleBtn.setAttribute("aria-pressed", String(expanded));
    }

    private toggleReplace() {
        this.setReplaceExpanded(!this.replaceExpanded);
        if (this.replaceExpanded) {
            this.replaceInput.focus();
            this.replaceInput.select();
        } else {
            this.focusInput();
        }
    }

    private search(preferredIndex = 0) {
        this.clearHighlights();
        const compiled = this.buildPattern();
        if (!compiled) {
            this.updateCount();
            return;
        }

        const contentEl = this.getContentEl();
        if (!contentEl) return;

        this.collectDomMatches(contentEl, compiled);
        this.applyCodeMirrorHighlights(contentEl, compiled);
        this.sortMatchesInDocumentOrder();
        this.currentIndex = this.matches.length > 0
            ? Math.min(Math.max(preferredIndex, 0), this.matches.length - 1)
            : -1;
        this.updateCurrent();
        this.updateCount();
    }

    private collectDomMatches(root: HTMLElement, compiled: CompiledPattern) {
        const editorRoot = this.getEditorRoot();
        if (!editorRoot) {
            return;
        }

        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                const parent = node.parentElement;
                if (!parent) return NodeFilter.FILTER_REJECT;
                if (parent.closest(FIND_SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            },
        });

        const textNodes: Text[] = [];
        let node: Node | null;
        while ((node = walker.nextNode())) {
            textNodes.push(node as Text);
        }

        for (const textNode of textNodes) {
            const text = textNode.textContent || "";
            const regex = new RegExp(compiled.global.source, compiled.global.flags);
            let match: RegExpExecArray | null;
            while ((match = regex.exec(text)) !== null) {
                const matchedText = match[0];
                if (!matchedText) {
                    regex.lastIndex += 1;
                    continue;
                }
                const range = document.createRange();
                range.setStart(textNode, match.index);
                range.setEnd(textNode, match.index + matchedText.length);
                const startPath = getNodePath(editorRoot, range.startContainer);
                const endPath = getNodePath(editorRoot, range.endContainer);
                if (!startPath || !endPath) {
                    continue;
                }
                this.matches.push({
                    kind: "dom",
                    startPath,
                    startOffset: range.startOffset,
                    endPath,
                    endOffset: range.endOffset,
                });
            }
        }
    }

    private renderDomHighlights() {
        if (!supportsCssCustomHighlight()) {
            return;
        }
        const matchRanges: Range[] = [];
        const currentRanges: Range[] = [];
        for (let i = 0; i < this.matches.length; i++) {
            const match = this.matches[i];
            if (match.kind !== "dom") {
                continue;
            }
            const range = this.getDomMatchRange(match);
            if (!range) {
                continue;
            }
            if (i === this.currentIndex) {
                currentRanges.push(range);
            } else {
                matchRanges.push(range);
            }
        }
        CSS.highlights.set(CSS_FIND_MATCH, new Highlight(...matchRanges));
        CSS.highlights.set(CSS_FIND_CURRENT, new Highlight(...currentRanges));
    }

    private clearDomHighlights() {
        if (!supportsCssCustomHighlight()) {
            return;
        }
        CSS.highlights.delete(CSS_FIND_MATCH);
        CSS.highlights.delete(CSS_FIND_CURRENT);
    }

    private applyCodeMirrorHighlights(root: HTMLElement, compiled: CompiledPattern) {
        const blockElements = root.querySelectorAll<HTMLElement>("[data-type='code-block'], [data-type='math-block']");
        for (const blockElement of blockElements) {
            const view = getCodeMirrorView(blockElement);
            if (view) {
                ensureFindDecorationsField(view);
            }
            const text = view?.state.doc.toString()
                ?? blockElement.querySelector("pre code, code")?.textContent
                ?? "";
            const regex = new RegExp(compiled.global.source, compiled.global.flags);
            let match: RegExpExecArray | null;
            while ((match = regex.exec(text)) !== null) {
                const matchedText = match[0];
                if (!matchedText) {
                    regex.lastIndex += 1;
                    continue;
                }
                this.matches.push({
                    kind: "cm",
                    block: blockElement,
                    view,
                    from: match.index,
                    to: match.index + matchedText.length,
                });
            }
        }
        this.updateCodeMirrorDecorations();
    }

    private sortMatchesInDocumentOrder() {
        this.matches.sort((a, b) => {
            if (a.kind === "cm" && b.kind === "cm" && a.block === b.block) {
                return a.from - b.from;
            }
            const editor = this.getEditorRoot();
            const aNode = a.kind === "dom"
                ? (editor ? getNodeByPath(editor, a.startPath) : null)
                : a.block;
            const bNode = b.kind === "dom"
                ? (editor ? getNodeByPath(editor, b.startPath) : null)
                : b.block;
            if (!aNode || !bNode) {
                return 0;
            }
            if (aNode === bNode) {
                if (a.kind === "cm" && b.kind === "cm") {
                    return a.from - b.from;
                }
                return 0;
            }
            const position = aNode.compareDocumentPosition(bNode);
            if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
                return -1;
            }
            if (position & Node.DOCUMENT_POSITION_PRECEDING) {
                return 1;
            }
            return 0;
        });
    }

    private updateCodeMirrorDecorations() {
        const cmMatchesByView = new Map<EditorView, Array<{ match: FindCodeMirrorMatch; index: number }>>();
        this.matches.forEach((match, index) => {
            if (match.kind !== "cm") {
                return;
            }
            if (!match.view) {
                return;
            }
            const matches = cmMatchesByView.get(match.view) || [];
            matches.push({ match, index });
            cmMatchesByView.set(match.view, matches);
        });

        const views = new Set<EditorView>();
        this.getContentEl()?.querySelectorAll<HTMLElement>("[data-type='code-block'], [data-type='math-block']").forEach((blockElement) => {
            const view = getCodeMirrorView(blockElement);
            if (view) {
                views.add(view);
            }
        });

        views.forEach((view) => {
            ensureFindDecorationsField(view);
            const builder = new RangeSetBuilder<Decoration>();
            const matches = cmMatchesByView.get(view) || [];
            for (const { match, index } of matches) {
                const className = index === this.currentIndex
                    ? `${HIGHLIGHT_CLASS} ${CURRENT_CLASS}`
                    : HIGHLIGHT_CLASS;
                builder.add(match.from, match.to, Decoration.mark({ class: className }));
            }
            view.dispatch({
                effects: cmDecorationsEffect.of(builder.finish()),
            });
        });
    }

    private clearHighlights() {
        this.clearDomHighlights();
        const contentEl = this.getContentEl();
        contentEl?.querySelectorAll<HTMLElement>("[data-type='code-block'], [data-type='math-block']").forEach((blockElement) => {
            const view = getCodeMirrorView(blockElement);
            if (!view) {
                return;
            }
            ensureFindDecorationsField(view);
            view.dispatch({
                effects: cmDecorationsEffect.of(Decoration.none),
            });
        });
        this.matches = [];
        this.currentIndex = -1;
    }

    private navigate(dir: 1 | -1) {
        if (this.matches.length === 0) return;
        this.currentIndex = (this.currentIndex + dir + this.matches.length) % this.matches.length;
        this.updateCurrent();
        this.updateCount();
    }

    private updateCurrent() {
        const currentMatch = this.currentIndex >= 0 ? this.matches[this.currentIndex] : undefined;
        if (currentMatch?.kind === "cm") {
            this.ensureCodeMirrorMatchView(currentMatch);
        }
        this.renderDomHighlights();
        this.updateCodeMirrorDecorations();
        if (currentMatch) {
            if (currentMatch.kind === "dom") {
                this.scrollDomMatchIntoView(currentMatch);
            } else {
                this.scrollCodeMirrorMatchIntoView(currentMatch);
                this.scheduleRestoreFindFocus();
            }
        }
    }

    private updateCount() {
        if (this.queryError) {
            this.countEl.textContent = this.queryError;
            this.countEl.classList.add("vditor-find-bar__count--none");
            return;
        }
        if (this.matches.length > 0) {
            this.countEl.textContent = `${this.currentIndex + 1} / ${this.matches.length}`;
            this.countEl.classList.remove("vditor-find-bar__count--none");
        } else {
            this.countEl.textContent = window.VditorI18n?.["find-no-result"] || "No results";
            this.countEl.classList.toggle("vditor-find-bar__count--none", !!this.input.value.trim());
        }
    }

    private replaceDomMatch(match: FindDomMatch) {
        const range = this.getDomMatchRange(match);
        if (!range) {
            return false;
        }
        const replacement = this.getReplacementText(range.toString());
        range.deleteContents();
        range.insertNode(document.createTextNode(replacement));
        range.startContainer.parentNode?.normalize();
        return true;
    }

    private replaceCodeMirrorMatch(match: FindCodeMirrorMatch) {
        const view = this.ensureCodeMirrorMatchView(match);
        if (!view) {
            return false;
        }
        const matchedText = view.state.sliceDoc(match.from, match.to);
        const replacement = this.getReplacementText(matchedText);
        view.dispatch({
            changes: { from: match.from, to: match.to, insert: replacement },
            selection: EditorSelection.cursor(match.from + replacement.length),
            effects: EditorView.scrollIntoView(match.from + replacement.length, { y: "center" }),
        });
        return true;
    }

    private onReplaceApplied(touchedDom: boolean) {
        if (touchedDom) {
            recordHistoryChange(this.vditor);
            return;
        }
        fireContentInput(this.vditor, getMarkdown(this.vditor));
        this.vditor.undo.resetIcon(this.vditor);
    }

    private replaceCurrent() {
        if (this.matches.length === 0 || !this.compiledPattern) {
            return;
        }
        const index = this.currentIndex >= 0 ? this.currentIndex : 0;
        const match = this.matches[index];
        const replaced = match.kind === "dom"
            ? this.replaceDomMatch(match)
            : this.replaceCodeMirrorMatch(match);
        if (!replaced) {
            return;
        }
        this.onReplaceApplied(match.kind === "dom");
        this.search(index);
    }

    private replaceAll() {
        if (this.matches.length === 0 || !this.compiledPattern) {
            return;
        }

        let touchedDom = false;
        const domMatches = this.matches.filter((match): match is FindDomMatch => match.kind === "dom");
        for (let i = domMatches.length - 1; i >= 0; i--) {
            touchedDom = this.replaceDomMatch(domMatches[i]) || touchedDom;
        }

        const cmChangesByView = new Map<EditorView, Array<{ from: number; to: number; insert: string }>>();
        this.matches.forEach((match) => {
            if (match.kind !== "cm") {
                return;
            }
            const view = this.ensureCodeMirrorMatchView(match);
            if (!view) {
                return;
            }
            const matchedText = view.state.sliceDoc(match.from, match.to);
            const changes = cmChangesByView.get(view) || [];
            changes.push({
                from: match.from,
                to: match.to,
                insert: this.getReplacementText(matchedText),
            });
            cmChangesByView.set(view, changes);
        });

        cmChangesByView.forEach((changes, view) => {
            if (changes.length === 0) {
                return;
            }
            changes.sort((a, b) => a.from - b.from);
            view.dispatch({ changes });
        });

        this.onReplaceApplied(touchedDom);
        this.search();
    }

    public focusInput() {
        this.activeFindField = this.input;
        this.input.focus();
        this.input.select();
    }

    public focusReplaceInput() {
        this.activeFindField = this.replaceInput;
        this.setReplaceExpanded(true);
        this.replaceInput.focus();
        this.replaceInput.select();
    }

    public show(shouldFocusInput = false) {
        this.element.style.display = "flex";
        this.setReplaceExpanded(false);
        this.activeFindField = this.input;
        this.bindEditorRefresh();
        if (this.input.value.trim()) {
            this.search();
        } else {
            this.updateCount();
        }
        if (shouldFocusInput) {
            this.focusInput();
        }
    }

    public showReplace() {
        this.element.style.display = "flex";
        this.bindEditorRefresh();
        if (this.input.value.trim()) {
            this.search();
        } else {
            this.updateCount();
        }
        this.setReplaceExpanded(true);
        this.focusInput();
    }

    public hide() {
        this.element.style.display = "none";
        this.setReplaceExpanded(false);
        this.findComposing = false;
        this.cancelRestoreFindFocus();
        this.unbindEditorRefresh();
        this.clearHighlights();
    }

    public toggle(shouldFocusInput = false) {
        if (this.isVisible()) {
            this.hide();
        } else {
            this.show(shouldFocusInput);
        }
    }

    public isVisible() {
        return this.element.style.display === "flex";
    }
}
