import { theme, ThemeConfig } from "antd";

const baseThemeConfig: ThemeConfig = {
    token: {
        controlHeight: 28,
    },
    components: {
        Button: {
            paddingInline: 8,
        },
    }
}

export function getAntThemeConfig(dark: boolean): ThemeConfig {
    return {
        ...baseThemeConfig,
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    };
}
