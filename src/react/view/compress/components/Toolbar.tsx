import { $t } from '../../../i18n/i18nConfig';
import { handler } from '../../../util/vscode';
import ToolbarButton from '../../components/ToolbarButton';
import { IconExtract, IconFileAdd, IconFolderOpen, IconMoon, IconReload, IconSidebar, IconSun } from '../icons';

interface ToolbarProps {
    size: string;
    currentDir: string;
    extension: string;
    dark: boolean;
    onToggleDark: () => void;
    onExtract: () => void;
    showSidebar: boolean;
    sidebarToggleDisabled: boolean;
    onToggleSidebar: () => void;
}

export default function Toolbar({
    size,
    currentDir,
    extension,
    dark,
    onToggleDark,
    onExtract,
    showSidebar,
    sidebarToggleDisabled,
    onToggleSidebar,
}: ToolbarProps) {
    const editable = !extension || extension === 'zip';
    const sidebarTitle = sidebarToggleDisabled
        ? 'Sidebar hidden on narrow view'
        : (showSidebar ? 'Hide folder tree' : 'Show folder tree');

    return (
        <header className="zip-toolbar">
            <div className="zip-toolbar-left">
                <ToolbarButton
                    title={sidebarTitle}
                    onClick={onToggleSidebar}
                    disabled={sidebarToggleDisabled}
                >
                    <span className={`zip-sidebar-toggle${showSidebar ? ' is-active' : ''}${sidebarToggleDisabled ? ' is-disabled' : ''}`}>
                        <IconSidebar size={15} />
                    </span>
                </ToolbarButton>
                <ToolbarButton title="Show In Explorer" onClick={() => handler.emit('showInExplorer')}>
                    <IconFolderOpen size={15} />
                </ToolbarButton>
                <ToolbarButton title="Reload" onClick={() => handler.emit('init')}>
                    <IconReload size={15} />
                </ToolbarButton>
                {editable && (
                    <ToolbarButton title={$t('compress.add')} onClick={() => handler.emit('addFile', currentDir)}>
                        <IconFileAdd size={15} />
                        <span>{$t('compress.add')}</span>
                    </ToolbarButton>
                )}
                <ToolbarButton title={$t('compress.extract')} primary onClick={onExtract}>
                    <IconExtract size={15} />
                    <span>{$t('compress.extract')}</span>
                </ToolbarButton>
            </div>

            <div className="zip-toolbar-center">
                {currentDir ? (
                    <span className="zip-path" title={currentDir}>/{currentDir}</span>
                ) : null}
            </div>

            <div className="zip-toolbar-right">
                <span className="zip-size">
                    <span className="zip-size-label">{$t('compress.size')}</span>
                    <span className="zip-size-value">{size}</span>
                </span>
                <ToolbarButton
                    title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
                    onClick={onToggleDark}
                >
                    {dark ? <IconSun size={15} /> : <IconMoon size={15} />}
                </ToolbarButton>
            </div>
        </header>
    );
}
