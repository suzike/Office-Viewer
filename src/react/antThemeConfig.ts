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

/** VS Code extension theme — intentionally minimal to blend into VS Code. */
export function getAntThemeConfig(dark: boolean): ThemeConfig {
    return {
        ...baseThemeConfig,
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    };
}

const macFontFamily = `-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", sans-serif`;

/** Desktop app theme — macOS design language, aligned with src/desktop/styles.css. */
export function getDesktopAntThemeConfig(dark: boolean): ThemeConfig {
    return {
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
            colorPrimary: dark ? "#0a84ff" : "#007aff",
            colorInfo: dark ? "#0a84ff" : "#007aff",
            colorError: dark ? "#ff453a" : "#ff3b30",
            colorSuccess: dark ? "#30d158" : "#34c759",
            colorWarning: dark ? "#ffd60a" : "#ff9500",
            colorBgLayout: dark ? "#1e1e20" : "#f5f5f7",
            colorBgContainer: dark ? "#2a2a2d" : "#ffffff",
            colorBgElevated: dark ? "#2a2a2d" : "#ffffff",
            colorText: dark ? "#f5f5f7" : "#1d1d1f",
            colorTextSecondary: dark ? "#98989d" : "#86868b",
            colorBorder: dark ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.14)",
            colorBorderSecondary: dark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)",
            borderRadius: 6,
            borderRadiusLG: 12,
            controlHeight: 28,
            fontFamily: macFontFamily,
            boxShadowSecondary: dark
                ? "0 1px 3px rgba(0,0,0,0.36), 0 16px 48px rgba(0,0,0,0.44)"
                : "0 0.5px 2px rgba(0,0,0,0.08), 0 12px 32px rgba(0,0,0,0.12)",
        },
        components: {
            Button: {
                paddingInline: 12,
                fontWeight: 500,
            },
            Modal: {
                titleFontSize: 15,
            },
            Input: {
                activeShadow: dark
                    ? "0 0 0 3.5px rgba(10,132,255,0.3)"
                    : "0 0 0 3.5px rgba(0,122,255,0.25)",
            },
        },
    };
}
