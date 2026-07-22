/**
 * SheetJS (xlsx) 相关逻辑集中在此模块。
 * xlsx 包体积约 1MB，且仅服务于 .xls/.ods 读取与 .xls/.ods/.csv 导出，
 * 因此本模块只允许通过动态 import() 加载，严禁静态 import，
 * 以保证打开 .xlsx/.csv 时不会加载 xlsx chunk。
 */
import * as XLSX from 'xlsx';
import type { ExcelData } from './excel_reader';
import type { CellData, RowData, SheetData } from './x-spreadsheet/index';

type RowMap = NonNullable<SheetData['rows']>;

const MIN_COL_WIDTH = 70;
const MAX_COL_WIDTH = 300;
const DEFAULT_COL_WIDTH = 100;
const CHAR_WIDTH = 8;

const clampColWidth = (width: number) => Math.min(Math.max(width, MIN_COL_WIDTH), MAX_COL_WIDTH);

// ---------------------------------------------------------------------------
// 读取（.xls / .ods）
// ---------------------------------------------------------------------------

const readSheetJsMerges = (worksheet: XLSX.WorkSheet) => (worksheet['!merges'] ?? [])
    .map(merge => XLSX.utils.encode_range(merge));

const expandSizeForSheetJsMerge = (merge: XLSX.Range, size: { maxRow: number; maxCols: number }) => {
    size.maxRow = Math.max(size.maxRow, merge.e.r + 1);
    size.maxCols = Math.max(size.maxCols, merge.e.c + 1);
};

const sheetJsColWidthToPx = (col?: XLSX.ColInfo) => {
    if (!col) return null;
    if (col.wpx != null) return col.wpx;
    if (col.wch != null) return col.wch * CHAR_WIDTH;
    if (col.width != null) return col.width * CHAR_WIDTH;
    return null;
};

const buildColsFromSheetJsWorksheet = (worksheet: XLSX.WorkSheet, colCount: number) => {
    const cols: Record<number, { width: number }> = {};
    const sheetCols = worksheet['!cols'];
    for (let i = 0; i < colCount; i += 1) {
        const width = sheetJsColWidthToPx(sheetCols?.[i]) ?? DEFAULT_COL_WIDTH;
        cols[i] = { width: clampColWidth(width) };
    }
    return cols;
};

const formatSheetJsCell = (cell: XLSX.CellObject) => {
    if (cell.w) return cell.w;
    if (cell.v == null) return '';
    if (cell.v instanceof Date) return cell.v.toISOString().slice(0, 10);
    return String(cell.v);
};

const convertSheetJsWorksheet = (worksheet: XLSX.WorkSheet): Pick<SheetData, 'rows' | 'cols' | 'merges'> => {
    const rows: RowMap = {};
    let maxCols = 0;
    let maxRow = 0;
    const ref = worksheet['!ref'];
    if (!ref) {
        return { rows: { len: 0 }, cols: { len: 0 } };
    }

    const range = XLSX.utils.decode_range(ref);
    for (let ri = range.s.r; ri <= range.e.r; ri += 1) {
        const cells: Record<number, CellData> = {};
        let hasContent = false;
        for (let ci = range.s.c; ci <= range.e.c; ci += 1) {
            const addr = XLSX.utils.encode_cell({ r: ri, c: ci });
            const cell = worksheet[addr];
            if (!cell) continue;
            const text = formatSheetJsCell(cell);
            if (!text) continue;
            cells[ci] = { text };
            hasContent = true;
            if (ci + 1 > maxCols) maxCols = ci + 1;
            if (ri + 1 > maxRow) maxRow = ri + 1;
        }
        if (hasContent) {
            rows[ri] = { cells };
        }
    }

    const sheetSize = { maxRow, maxCols };
    (worksheet['!merges'] ?? []).forEach(merge => expandSizeForSheetJsMerge(merge, sheetSize));
    maxRow = sheetSize.maxRow;
    maxCols = sheetSize.maxCols;

    const colCount = Math.max(maxCols, range.e.c - range.s.c + 1);
    const merges = readSheetJsMerges(worksheet);
    return {
        rows: { len: maxRow, ...rows },
        cols: { len: colCount, ...buildColsFromSheetJsWorksheet(worksheet, colCount) },
        merges: merges.length > 0 ? merges : undefined,
    };
};

const convertSheetJsWorkbook = (workbook: XLSX.WorkBook): ExcelData => {
    const sheets: SheetData[] = [];
    let maxLength = 0;
    let maxCols = 26;

    for (const sheetName of workbook.SheetNames) {
        const converted = convertSheetJsWorksheet(workbook.Sheets[sheetName]);
        const rowCount = converted.rows?.len ?? 0;
        if (maxLength < rowCount) maxLength = rowCount;

        const colLen = converted.cols?.len ?? 0;
        if (colLen > maxCols) maxCols = colLen;

        sheets.push({
            name: sheetName,
            rows: converted.rows,
            cols: converted.cols,
            ...(converted.merges ? { merges: converted.merges } : {}),
        });
    }

    return { sheets, maxLength, maxCols };
};

/** 使用 SheetJS 读取 .xls（老式二进制）/ .ods 文件 */
export function loadWithSheetJs(buffer: ArrayBuffer): ExcelData {
    const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
    return convertSheetJsWorkbook(workbook);
}

// ---------------------------------------------------------------------------
// 导出（.xls / .ods / .csv）
// ---------------------------------------------------------------------------

function isRowData(row: RowData | number | undefined): row is RowData {
    return row != null && typeof row === 'object';
}

function getColWidth(cols: SheetData['cols'], ci: number) {
    const col = cols?.[ci];
    if (col && typeof col === 'object' && col.width != null) return col.width;
    return DEFAULT_COL_WIDTH;
}

function applyColWidths(ws: XLSX.WorkSheet, xws: SheetData) {
    const cols = xws.cols;
    if (!cols?.len) return;
    const colWidths = [];
    for (let ci = 0; ci < cols.len; ci += 1) {
        colWidths.push({ wpx: getColWidth(cols, ci) });
    }
    ws['!cols'] = colWidths;
}

function dataToSheetJs(xws: SheetData) {
    const aoa: string[][] = [];
    const rowobj = xws.rows;
    if (rowobj?.len) {
        for (let ri = 0; ri < rowobj.len; ri += 1) {
            const row = rowobj[ri];
            if (!isRowData(row)) continue;
            aoa[ri] = [];
            for (const ciKey of Object.keys(row.cells ?? {})) {
                const ci = Number(ciKey);
                if (Number.isNaN(ci)) continue;
                aoa[ri][ci] = row.cells[ci].text;
            }
        }
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    applyColWidths(ws, xws);
    return ws;
}

/** 使用 SheetJS 导出 .xls / .ods 工作簿 */
export function writeSheetJsWorkbook(sheets: SheetData[], bookType: string): Uint8Array {
    const workbook = XLSX.utils.book_new();
    for (let i = 0; i < sheets.length; i += 1) {
        const sheetData = sheets[i];
        XLSX.utils.book_append_sheet(workbook, dataToSheetJs(sheetData), sheetData.name || `Sheet${i + 1}`);
    }
    return new Uint8Array(XLSX.write(workbook, { bookType: bookType as XLSX.BookType, type: 'array' }));
}

/** 使用 SheetJS 将首个 sheet 序列化为 CSV/TSV 文本 */
export function sheetDataToCsv(sheet: SheetData, fs: string): string {
    return XLSX.utils.sheet_to_csv(dataToSheetJs(sheet), { FS: fs });
}
