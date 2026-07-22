/** 中等篇幅文档的 debounce 放行倍数（相对 undoDelay），与原默认行为一致 */
export const DEFAULT_HISTORY_MAX_WAIT_FACTOR = 3;

/**
 * 超大文档阈值：超过后不设放行倍数，连续输入只重置 undoDelay 计时器，
 * 仅在停笔后触发 recordHistory / 保存，不因累计输入时长被强制 flush。
 */
export const HISTORY_UNLIMITED_DEFER_LENGTH = 50_000;

/** getHistoryMaxWaitFactor 返回值：仅 debounce，不强制 flush */
export const HISTORY_UNLIMITED_DEFER_FACTOR = -1;

/** Markdown 常见篇幅分级（字符数，与 String.length 一致） */
const LENGTH_SNIPPET = 800;       // 便签、单行备忘
const LENGTH_SHORT = 2_500;       // 短文、日报
const LENGTH_README = 6_000;      // README、博客短文
const LENGTH_ARTICLE = 12_000;    // 技术文章
const LENGTH_CHAPTER = 20_000;    // 长文、文档章节
const LENGTH_LARGE_PAGE = 30_000; // 大型单页、多节合一

const HISTORY_MAX_WAIT_FACTOR_MIN = 1;
const HISTORY_MAX_WAIT_FACTOR_MAX = 5;

export const isUnlimitedHistoryDefer = (maxWaitFactor: number): boolean => {
    return maxWaitFactor === HISTORY_UNLIMITED_DEFER_FACTOR;
};

/**
 * 根据首次加载的 Markdown 体量计算 debounce 放行倍数。
 * 文档越大，放行倍数越高；≥5 万字仅 debounce，不设放行上限。
 */
export const computeHistoryMaxWaitFactor = (markdownLength: number): number => {
    if (markdownLength >= HISTORY_UNLIMITED_DEFER_LENGTH) {
        return HISTORY_UNLIMITED_DEFER_FACTOR;
    }
    if (markdownLength >= LENGTH_LARGE_PAGE) {
        return HISTORY_MAX_WAIT_FACTOR_MAX;
    }
    if (markdownLength >= LENGTH_CHAPTER) {
        return 4;
    }
    if (markdownLength >= LENGTH_ARTICLE) {
        return DEFAULT_HISTORY_MAX_WAIT_FACTOR;
    }
    if (markdownLength >= LENGTH_README) {
        return 3;
    }
    if (markdownLength >= LENGTH_SHORT) {
        return 2;
    }
    if (markdownLength >= LENGTH_SNIPPET) {
        return 2;
    }
    return HISTORY_MAX_WAIT_FACTOR_MIN;
};

export const configureHistoryDeferByDocumentLength = (vditor: IVditor, markdownLength: number) => {
    vditor.documentInitialLength = markdownLength;
    vditor.historyMaxWaitFactor = computeHistoryMaxWaitFactor(markdownLength);
};

export const getHistoryMaxWaitFactor = (vditor: IVditor): number => {
    if (vditor.historyMaxWaitFactor === undefined) {
        return DEFAULT_HISTORY_MAX_WAIT_FACTOR;
    }
    return vditor.historyMaxWaitFactor;
};

/**
 * 连续输入时 debounce 会被不断重置。
 * 未超限时返回 undoDelay；超过 maxWait 后返回 0 强制入栈。
 * 超大文档（unlimited）始终返回 undoDelay，只靠停笔触发保存。
 */
export const getHistoryRecordWait = (
    lastRecordAt: number,
    undoDelay: number,
    maxWaitFactor: number = DEFAULT_HISTORY_MAX_WAIT_FACTOR,
): number => {
    if (isUnlimitedHistoryDefer(maxWaitFactor)) {
        return undoDelay;
    }
    if (maxWaitFactor <= 0) {
        return 0;
    }
    if (!lastRecordAt) {
        return undoDelay;
    }
    const maxWait = undoDelay * maxWaitFactor;
    return Date.now() - lastRecordAt >= maxWait ? 0 : undoDelay;
};
