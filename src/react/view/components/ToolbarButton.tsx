import { type ReactNode } from 'react';

/**
 * Shared toolbar button. Visual styles stay in the consumer's stylesheet
 * (e.g. compress/Zip.less defines `.zip-btn` / `.zip-btn-primary`).
 */
export default function ToolbarButton({ title, onClick, primary, disabled, children }: {
    title: string;
    onClick: () => void;
    primary?: boolean;
    disabled?: boolean;
    children: ReactNode;
}) {
    return (
        <button
            type="button"
            className={`zip-btn${primary ? ' zip-btn-primary' : ''}`}
            title={title}
            onClick={onClick}
            disabled={disabled}
        >
            {children}
        </button>
    );
}
