import { LoadingOutlined, WarningOutlined, FileOutlined } from '@ant-design/icons';
import { Spin } from 'antd';
import { $t } from '../../i18n/i18nConfig';
import './ViewerState.css';

interface ViewerStateProps {
    kind: 'loading' | 'error' | 'empty';
    /** Defaults to the i18n loading text for kind="loading". */
    message?: string;
    description?: string;
}

/** Shared full-area loading / error / empty placeholder for viewers. */
export default function ViewerState({ kind, message, description }: ViewerStateProps) {
    const text = message ?? (kind === 'loading' ? $t('common.loading') : undefined);
    return (
        <div className={`viewer-state viewer-state--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
            {kind === 'loading' && <Spin indicator={<LoadingOutlined style={{ fontSize: 28 }} spin />} />}
            {kind === 'error' && <WarningOutlined className="viewer-state__icon viewer-state__icon--error" />}
            {kind === 'empty' && <FileOutlined className="viewer-state__icon" />}
            {text && <div className="viewer-state__message">{text}</div>}
            {description && <div className="viewer-state__description">{description}</div>}
        </div>
    );
}
