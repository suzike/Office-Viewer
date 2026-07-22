import type { SpreadsheetAutofilter } from './excel_meta';

const AUTO_FILTER_RE = /<autoFilter\b[^>]*ref="([^"]+)"[^>]*(?:\/>|>([\s\S]*?)<\/autoFilter>)/i;
const SORT_STATE_RE = /<sortState\b[\s\S]*?<\/sortState>/i;
const SORT_CONDITION_RE = /<sortCondition\b[^>]*ref="([A-Z]+)\d+(?::[A-Z]+\d+)?"[^>]*>/i;
const DESCENDING_RE = /\bdescending="(1|true)"/i;

function decodeXmlText(text: string): string {
    return text
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, '\'')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function escapeXmlText(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function columnNameToIndex(name: string): number {
    let colIndex = 0;
    const upper = name.toUpperCase();
    for (let i = 0; i < upper.length; i += 1) {
        colIndex = 26 * colIndex + upper.charCodeAt(i) - 64;
    }
    return colIndex - 1;
}

function indexToColumnName(index: number): string {
    let n = index;
    let label = '';
    while (n >= 0) {
        label = String.fromCharCode(65 + (n % 26)) + label;
        n = Math.floor(n / 26) - 1;
    }
    return label;
}

function buildSortRange(ref: string, ci: number): string {
    const rangeMatch = ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
    const colName = indexToColumnName(ci);
    if (!rangeMatch) return `${colName}1:${colName}1`;
    const startRow = Number(rangeMatch[2]) + 1;
    const endRow = Number(rangeMatch[4]);
    return `${colName}${startRow}:${colName}${endRow}`;
}

export function readWorksheetSortStateXml(xml: string): SpreadsheetAutofilter | undefined {
    const autoFilterMatch = xml.match(AUTO_FILTER_RE);
    if (!autoFilterMatch) return undefined;
    const ref = decodeXmlText(autoFilterMatch[1]);
    const inner = autoFilterMatch[2] || '';
    const sortStateMatch = inner.match(SORT_STATE_RE);
    if (!sortStateMatch) return undefined;
    const sortXml = sortStateMatch[0];
    const sortConditionMatch = sortXml.match(SORT_CONDITION_RE);
    if (!sortConditionMatch) {
        return { ref, filters: [] };
    }
    return {
        ref,
        filters: [],
        sort: {
            ci: columnNameToIndex(sortConditionMatch[1]),
            order: DESCENDING_RE.test(sortXml) ? 'desc' : 'asc',
        },
    };
}

export function patchWorksheetSortStateXml(xml: string, autofilter?: SpreadsheetAutofilter): string {
    const autoFilterMatch = xml.match(AUTO_FILTER_RE);
    if (!autoFilterMatch || !autofilter?.ref || !autofilter.sort) return xml;

    const fullMatch = autoFilterMatch[0];
    const ref = escapeXmlText(autofilter.ref);
    const inner = autoFilterMatch[2] || '';
    const withoutSort = inner.replace(SORT_STATE_RE, '');
    const sortRef = buildSortRange(autofilter.ref, autofilter.sort.ci);
    const descending = autofilter.sort.order === 'desc' ? ' descending="1"' : '';
    const sortStateXml = `<sortState ref="${ref}"><sortCondition ref="${sortRef}"${descending}/></sortState>`;
    const nextAutoFilterXml = `<autoFilter ref="${ref}">${withoutSort}${sortStateXml}</autoFilter>`;
    return xml.replace(fullMatch, nextAutoFilterXml);
}
