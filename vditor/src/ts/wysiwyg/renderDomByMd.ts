import {isSpecialBlock, renderCodeBlocks, setupLazyCodeMirrorObserver, syncMathBlocksDisplayMode} from "../codeBlock/codeMirrorManager";
import {log} from "../util/log";
import {processCodeRender} from "../util/processCode";
import {renderTocNow} from "../util/toc";
import {afterRenderEvent} from "./afterRenderEvent";

export const BOUNDARY_SENTINEL_CLASS = "vditor-editor-boundary";

const BOUNDARY_SENTINEL = `<span class="${BOUNDARY_SENTINEL_CLASS}" data-block="0" contenteditable="true" aria-hidden="true">​</span>`;

export const ensureEditorBoundaryParagraphs = (editorElement: HTMLElement) => {
    editorElement.querySelectorAll(`.${BOUNDARY_SENTINEL_CLASS}`).forEach((el) => el.remove());
    editorElement.insertAdjacentHTML("afterbegin", BOUNDARY_SENTINEL);
    editorElement.insertAdjacentHTML("beforeend", BOUNDARY_SENTINEL);
};

export const renderDomByMd = (vditor: IVditor, md: string, options = {
    enableAddUndoStack: true,
    enableHint: false,
    enableInput: true,
}) => {
    const editorElement = vditor.wysiwyg.element;
    const html = vditor.lute.Md2VditorDOM(md);
    log("Md2VditorDOM", html, "result", vditor.options.debugger);
    editorElement.innerHTML = html;

    const isNearViewport = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const margin = 200;
        return rect.bottom >= -margin && rect.top <= window.innerHeight + margin;
    };

    editorElement.querySelectorAll(".vditor-wysiwyg__preview[data-render='2']").forEach((item: HTMLElement) => {
        const parent = item.parentElement as HTMLElement;
        if (!parent) {
            return;
        }
        // 普通代码块走懒加载 placeholder；数学 / mermaid / plantuml 始终渲染预览
        if (parent.getAttribute("data-type") === "code-block" && !isSpecialBlock(parent)) {
            if (!isNearViewport(parent)) {
                return;
            }
            return;
        }
        processCodeRender(item, vditor);
    });
    syncMathBlocksDisplayMode(editorElement, vditor);
    editorElement.querySelectorAll(".vditor-wysiwyg__block[data-type='math-block'] .vditor-wysiwyg__preview").forEach(
        (preview: HTMLElement) => {
            if (preview.getAttribute("data-render") !== "1") {
                processCodeRender(preview, vditor);
            }
        },
    );
    renderCodeBlocks(vditor);
    setupLazyCodeMirrorObserver(vditor);
    ensureEditorBoundaryParagraphs(editorElement);

    renderTocNow(vditor);
    afterRenderEvent(vditor, options);
};
