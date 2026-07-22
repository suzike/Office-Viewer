import type { CellStyle, SheetData } from './x-spreadsheet/index';

const COL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function stringAt(index: number): string {
    let str = '';
    let cindex = index;
    while (cindex >= COL_LETTERS.length) {
        cindex = Math.floor(cindex / COL_LETTERS.length);
        cindex -= 1;
        str += COL_LETTERS[cindex % COL_LETTERS.length];
    }
    str += COL_LETTERS[index % COL_LETTERS.length];
    return str;
}

/** 0-based 单元格地址 */
export interface A1CellAddress {
    r: number;
    c: number;
}

/** 0-based 区域（含边界） */
export interface A1Range {
    s: A1CellAddress;
    e: A1CellAddress;
}

/** 列字母（不区分大小写，可带 $）→ 0-based 列号，非法返回 null */
export function colLettersToIndex(letters: string): number | null {
    const normalized = letters.replace(/\$/g, '').toUpperCase();
    if (!/^[A-Z]{1,4}$/.test(normalized)) return null;
    let col = 0;
    for (let i = 0; i < normalized.length; i += 1) {
        col = col * 26 + (normalized.charCodeAt(i) - 64);
    }
    return col - 1;
}

function parseA1Cell(cell: string): A1CellAddress | null {
    const match = /^(\$?[A-Za-z]{1,4})(\$?[0-9]+)$/.exec(cell.trim());
    if (!match) return null;
    const c = colLettersToIndex(match[1]);
    const r = parseInt(match[2].replace(/\$/g, ''), 10) - 1;
    if (c == null || Number.isNaN(r) || r < 0) return null;
    return { r, c };
}

/**
 * 解析 A1 风格区域（"A1:B2"、"$A$1:$B$2" 或单个 "A1"）为 0-based range，
 * 替代 XLSX.utils.decode_range；无法解析时返回 null。
 */
export function decodeA1Range(ref: string): A1Range | null {
    if (!ref || typeof ref !== 'string') return null;
    const [start, end] = ref.split(':');
    const s = parseA1Cell(start ?? '');
    if (!s) return null;
    const e = end != null ? parseA1Cell(end) : s;
    if (!e) return null;
    return {
        s: { r: Math.min(s.r, e.r), c: Math.min(s.c, e.c) },
        e: { r: Math.max(s.r, e.r), c: Math.max(s.c, e.c) },
    };
}

/** x-spreadsheet 默认行高（px），与 Excel.tsx 中 row.height 一致 */
export const DEFAULT_ROW_HEIGHT_PX = 30;

/** 视口最少列数（A–X，共 24 列） */
export const MIN_VIEW_COLS = 24;

/** 视口最少行数 */
export const MIN_VIEW_ROWS = 40;

/** Excel 行高（磅）→ 像素 */
export function excelRowHeightToPx(pt: number): number {
    return Math.round(pt * 96 / 72);
}

/** 像素 → Excel 行高（磅） */
export function pxToExcelRowHeight(px: number): number {
    return px * 72 / 96;
}

/** x-spreadsheet freeze 字符串，如 "B2" */
export function freezeToExpr(rowIndex: number, colIndex: number): string {
    return `${stringAt(colIndex)}${rowIndex + 1}`;
}

/** 从 Excel views 的 xSplit/ySplit 转为 x-spreadsheet freeze 字符串 */
export function excelFreezeToExpr(xSplit = 0, ySplit = 0): string | undefined {
    if (xSplit <= 0 && ySplit <= 0) return undefined;
    return freezeToExpr(ySplit, xSplit);
}

export interface SpreadsheetAutofilter {
    ref: string;
    filters?: { ci: number; operator: string; value: unknown }[];
    sort?: { ci: number; order: string };
}

export function readAutofilterRef(autoFilter: unknown): SpreadsheetAutofilter | undefined {
    if (!autoFilter) return undefined;
    if (typeof autoFilter === 'string') {
        return { ref: autoFilter, filters: [] };
    }
    if (typeof autoFilter === 'object' && autoFilter !== null) {
        const af = autoFilter as { from?: string | { row: number; column: number }; to?: string | { row: number; column: number } };
        const fromAddr = addressToString(af.from);
        const toAddr = addressToString(af.to);
        if (fromAddr && toAddr) {
            return { ref: `${fromAddr}:${toAddr}`, filters: [] };
        }
    }
    return undefined;
}

function addressToString(addr?: string | { row: number; column: number }): string | undefined {
    if (!addr) return undefined;
    if (typeof addr === 'string') return addr;
    return `${stringAt(addr.column - 1)}${addr.row}`;
}

interface FormattingSheetSnapshot {
    styles?: CellStyle[];
    merges?: string[];
    freeze?: string;
    autofilter?: SpreadsheetAutofilter;
    cellStyles: [number, number, number][];
    rowHeights: [number, number][];
}

function buildSheetFormattingSnapshot(sheet: SheetData): FormattingSheetSnapshot {
    const cellStyles: [number, number, number][] = [];
    const rowHeights: [number, number][] = [];
    const rows = sheet.rows;
    if (rows?.len) {
        for (let ri = 0; ri < rows.len; ri += 1) {
            const row = rows[ri];
            if (!row || typeof row !== 'object') continue;
            if ('height' in row && row.height != null && Math.abs(row.height - DEFAULT_ROW_HEIGHT_PX) >= 1) {
                rowHeights.push([ri, row.height]);
            }
            if (!('cells' in row) || !row.cells) continue;
            for (const ciKey of Object.keys(row.cells)) {
                const ci = Number(ciKey);
                const cell = row.cells[ci];
                if (cell?.style != null) {
                    cellStyles.push([ri, ci, cell.style]);
                }
            }
        }
    }
    cellStyles.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    rowHeights.sort((a, b) => a[0] - b[0]);

    const af = sheet.autofilter as SpreadsheetAutofilter | undefined;
    return {
        styles: sheet.styles,
        merges: sheet.merges?.length ? [...sheet.merges].sort() : undefined,
        freeze: sheet.freeze,
        autofilter: af?.ref ? af : undefined,
        cellStyles,
        rowHeights,
    };
}

/** 提取与工具栏相关的格式快照，用于对比是否发生过样式变更 */
export function buildFormattingSnapshot(sheets: SheetData[]): string {
    return JSON.stringify(sheets.map(buildSheetFormattingSnapshot));
}

/** 相对初始快照是否发生过格式变更 */
export function hasFormattingChanged(initialSnapshot: string, sheets: SheetData[]): boolean {
    if (!initialSnapshot) return false;
    return buildFormattingSnapshot(sheets) !== initialSnapshot;
}

/** 从 x-spreadsheet freeze 字符串解析 Excel views 参数 */
export function freezeExprToExcelView(freeze: string): { xSplit: number; ySplit: number } | undefined {
    let colPart = '';
    let rowPart = '';
    for (let i = 0; i < freeze.length; i += 1) {
        const ch = freeze.charAt(i);
        if (ch >= '0' && ch <= '9') rowPart += ch;
        else colPart += ch;
    }
    if (!colPart && !rowPart) return undefined;
    let colIndex = 0;
    for (let i = 0; i < colPart.length; i += 1) {
        colIndex = 26 * colIndex + colPart.charCodeAt(i) - 64;
    }
    colIndex -= 1;
    const rowIndex = rowPart ? parseInt(rowPart, 10) - 1 : 0;
    const xSplit = colIndex;
    const ySplit = rowIndex;
    if (xSplit <= 0 && ySplit <= 0) return undefined;
    return { xSplit, ySplit };
}
