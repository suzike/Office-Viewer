import { useState } from 'react';
import { $t } from '../../../i18n/i18nConfig';
import { IconChevronDown, IconChevronRight } from '../icons';
import type { JarInfo } from '../zipTypes';

interface JarInfoPanelProps {
    info: JarInfo;
}

interface InfoRowProps {
    label: string;
    value?: string;
    mono?: boolean;
    inline?: boolean;
}

function InfoRow({ label, value, mono, inline }: InfoRowProps) {
    if (!value) return null;
    return (
        <div className={`zip-jar-row${inline ? ' zip-jar-row-inline' : ''}`}>
            <span className="zip-jar-label">{label}</span>
            <span className={`zip-jar-value${mono ? ' zip-jar-value-mono' : ''}`} title={value}>{value}</span>
        </div>
    );
}

export default function JarInfoPanel({ info }: JarInfoPanelProps) {
    const [expanded, setExpanded] = useState(true);

    if (!info.mainClass && !info.javaMinVersion) {
        return null;
    }

    return (
        <section className="zip-jar-panel" aria-label={$t('compress.jarInfo')}>
            <button
                type="button"
                className="zip-jar-header"
                onClick={() => setExpanded(prev => !prev)}
                aria-expanded={expanded}
            >
                {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                <span>{$t('compress.jarInfo')}</span>
            </button>
            {expanded ? (
                <div className="zip-jar-body">
                    <InfoRow label={$t('compress.targetJavaVersion')} value={info.javaMinVersion} inline />
                    <InfoRow label={$t('compress.mainClass')} value={info.mainClass} mono />
                </div>
            ) : null}
        </section>
    );
}
