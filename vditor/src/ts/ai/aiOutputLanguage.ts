export type AIVditorLang = "en_US" | "zh_CN" | "zh_TW" | "ja_JP" | "ko_KR" | "ru_RU";
export type AIOutputLanguage = "auto" | AIVditorLang;

export const AI_VDITOR_LANGS: AIVditorLang[] = [
    "en_US", "zh_CN", "zh_TW", "ja_JP", "ko_KR", "ru_RU",
];

/** 传给 LLM 的语言名（英文描述，模型理解稳定） */
export const AI_LANG_PROMPT_NAMES: Record<AIVditorLang, string> = {
    en_US: "English",
    zh_CN: "Simplified Chinese",
    zh_TW: "Traditional Chinese",
    ja_JP: "Japanese",
    ko_KR: "Korean",
    ru_RU: "Russian",
};

export const AI_OUTPUT_LANGUAGE_OPTIONS: { value: AIOutputLanguage; i18nKey: keyof typeof window.VditorI18n }[] = [
    { value: "auto", i18nKey: "aiOutputLangAuto" },
    { value: "en_US", i18nKey: "aiOutputLangEn" },
    { value: "zh_CN", i18nKey: "aiOutputLangZhCN" },
    { value: "zh_TW", i18nKey: "aiOutputLangZhTW" },
    { value: "ja_JP", i18nKey: "aiOutputLangJa" },
    { value: "ko_KR", i18nKey: "aiOutputLangKo" },
    { value: "ru_RU", i18nKey: "aiOutputLangRu" },
];

export const normalizeVditorLang = (lang: string | undefined): AIVditorLang => {
    if (lang && (AI_VDITOR_LANGS as string[]).includes(lang)) {
        return lang as AIVditorLang;
    }
    return "en_US";
};

export const resolveAIOutputVditorLang = (
    outputLanguage: AIOutputLanguage | string | undefined,
    uiLanguage: string | undefined,
): AIVditorLang => {
    if (outputLanguage && outputLanguage !== "auto") {
        return normalizeVditorLang(outputLanguage);
    }
    return normalizeVditorLang(uiLanguage);
};

export const resolveAIOutputLanguageName = (
    outputLanguage: AIOutputLanguage | string | undefined,
    uiLanguage: string | undefined,
): string => {
    const lang = resolveAIOutputVditorLang(outputLanguage, uiLanguage);
    return AI_LANG_PROMPT_NAMES[lang];
};

export const buildAIOutputLanguageInstruction = (
    outputLanguage: AIOutputLanguage | string | undefined,
    uiLanguage: string | undefined,
): string => {
    const name = resolveAIOutputLanguageName(outputLanguage, uiLanguage);
    return `Write the output in ${name}. Preserve the original Markdown structure and formatting.`;
};

export const getAIOutputLanguageOptionLabel = (
    value: AIOutputLanguage,
    uiLanguage: AIVditorLang,
): string => {
    const i = window.VditorI18n;
    if (value === "auto") {
        const uiOpt = AI_OUTPUT_LANGUAGE_OPTIONS.find((o) => o.value === uiLanguage);
        const uiLabel = uiOpt
            ? (i[uiOpt.i18nKey] ?? AI_LANG_PROMPT_NAMES[uiLanguage])
            : AI_LANG_PROMPT_NAMES[uiLanguage];
        return `${i.aiOutputLangAuto ?? "Follow UI language"} (${uiLabel})`;
    }
    const opt = AI_OUTPUT_LANGUAGE_OPTIONS.find((o) => o.value === value);
    return opt ? (i[opt.i18nKey] ?? value) : value;
};
