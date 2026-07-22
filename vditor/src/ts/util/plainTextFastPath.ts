/**
 * 非符号 insertText 快路径：跳过 wbr / SpinVditorDOM / outerHTML 替换。
 * 仅对首次加载足够长的文档启用，小文件保持原有全量 spin 行为。
 */

/** 达到技术长文体量（约 1.2 万字）后启用快路径 */
export const PLAIN_TEXT_FAST_PATH_MIN_LENGTH = 12_000;

/** 会触发 Markdown 结构或 spin 处理的字符（含空白） */
const MARKDOWN_TRIGGER_RE = /[`*_~#\-+>\[\]()|!$\\=\s]/;

export const containsMarkdownTriggerChar = (text: string): boolean => {
    return MARKDOWN_TRIGGER_RE.test(text);
};

export const isPlainTextFastPathEnabled = (vditor: IVditor): boolean => {
    return (vditor.documentInitialLength ?? 0) >= PLAIN_TEXT_FAST_PATH_MIN_LENGTH;
};

export const canUsePlainTextFastPath = (vditor: IVditor, event: InputEvent): boolean => {
    if (!isPlainTextFastPathEnabled(vditor)) {
        return false;
    }
    if (event.isComposing) {
        return false;
    }
    if (event.inputType !== "insertText") {
        return false;
    }
    if (!event.data) {
        return false;
    }
    return !containsMarkdownTriggerChar(event.data);
};
