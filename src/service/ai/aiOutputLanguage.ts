export type AIVditorLang = "en_US" | "zh_CN" | "zh_TW" | "ja_JP" | "ko_KR" | "ru_RU";

const LANG_PROMPT_NAMES: Record<AIVditorLang, string> = {
    en_US: "English",
    zh_CN: "Simplified Chinese",
    zh_TW: "Traditional Chinese",
    ja_JP: "Japanese",
    ko_KR: "Korean",
    ru_RU: "Russian",
};

const normalizeVditorLang = (lang: string | undefined): AIVditorLang => {
    if (lang && lang in LANG_PROMPT_NAMES) {
        return lang as AIVditorLang;
    }
    return "en_US";
};

export const resolveAIOutputLanguageName = (
    outputLanguage: string | undefined,
    uiLanguage: string | undefined,
): string => {
    const lang = outputLanguage && outputLanguage !== "auto"
        ? normalizeVditorLang(outputLanguage)
        : normalizeVditorLang(uiLanguage);
    return LANG_PROMPT_NAMES[lang];
};

export const buildAIOutputLanguageInstruction = (
    outputLanguage: string | undefined,
    uiLanguage: string | undefined,
): string => {
    const name = resolveAIOutputLanguageName(outputLanguage, uiLanguage);
    return `Write the output in ${name}. Preserve the original Markdown structure and formatting.`;
};
