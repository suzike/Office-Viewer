import { useEffect, useRef, useState } from 'react';
import type { GitPullDefaults, FileHistorySplitLayout } from '../util/gitHistoryState';
import type { GitRemoteDetail } from '../types';
import { getConfigs } from '../../../util/vscodeConfig';
import { handler } from '../../../util/vscode';

interface SettingsWidgetProps {
    open: boolean;
    repo: string;
    remotes: GitRemoteDetail[];
    loading: boolean;
    pullDefaults: GitPullDefaults;
    fileHistorySplitLayout: FileHistorySplitLayout;
    onClose: () => void;
    onPullDefaultsChange: (defaults: GitPullDefaults) => void;
    onFileHistorySplitLayoutChange: (layout: FileHistorySplitLayout) => void;
    onAddRemote: () => void;
    onEditRemote: (name: string) => void;
    onDeleteRemote: (name: string) => void;
    fetching: boolean;
    pulling: boolean;
    pushing: boolean;
}

async function copyText(text: string): Promise<void> {
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (!copied) {
        throw new Error('Copy failed');
    }
}

export default function SettingsWidget({
    open, repo, remotes, loading, pullDefaults, fileHistorySplitLayout, onClose,
    onPullDefaultsChange, onFileHistorySplitLayoutChange, onAddRemote, onEditRemote, onDeleteRemote,
    fetching, pulling, pushing,
}: SettingsWidgetProps) {
    const [copiedRemoteName, setCopiedRemoteName] = useState<string | null>(null);
    const [showQuickSyncButton, setShowQuickSyncButton] = useState<boolean>(() => {
        if (getConfigs()?.route === 'desktop') {
            return window.localStorage.getItem('office-desktop-git-quick-sync') === 'true';
        }
        const initial = Boolean(getConfigs()?.gitHistorySettings?.quickSyncButton);
        return initial;
    });
    const copyResetTimerRef = useRef<number | null>(null);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    useEffect(() => () => {
        if (copyResetTimerRef.current !== null) {
            window.clearTimeout(copyResetTimerRef.current);
        }
    }, []);

    if (!open) return null;

    const repoLabel = repo.split(/[/\\]/).pop() ?? repo;
    const handleCopyRemote = async (remote: GitRemoteDetail) => {
        if (!remote.url) return;
        try {
            await copyText(remote.url);
            setCopiedRemoteName(remote.name);
            if (copyResetTimerRef.current !== null) {
                window.clearTimeout(copyResetTimerRef.current);
            }
            copyResetTimerRef.current = window.setTimeout(() => {
                setCopiedRemoteName((current) => (current === remote.name ? null : current));
                copyResetTimerRef.current = null;
            }, 1600);
        } catch {
            setCopiedRemoteName(null);
        }
    };

    return (
        <aside className="git-graph-settings-panel" aria-label="Settings">
            <div className="git-graph-settings-body">
                <section className="git-graph-settings-group">
                    <div className="git-graph-settings-group-header">
                        <h2>Repository Settings</h2>
                        <button type="button" className="git-graph-icon-btn" title="Close" onClick={onClose}>
                            <span className="codicon codicon-close" aria-hidden />
                        </button>
                    </div>
                    <div className="git-graph-settings-group-content">
                        <div className="git-graph-settings-section">
                            <h3>Remote Configuration</h3>
                            {loading ? (
                                <p className="git-graph-muted">Loading remotes...</p>
                            ) : remotes.length === 0 ? (
                                <p className="git-graph-muted">No remotes configured for this repository.</p>
                            ) : (
                                <table className="git-graph-settings-table">
                                    <thead>
                                        <tr>
                                            <th>Remote</th>
                                            <th>URL</th>
                                            <th />
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {remotes.map((remote) => (
                                            <tr key={remote.name}>
                                                <td>{remote.name}</td>
                                                <td className="git-graph-settings-url" title={remote.url ?? ''}>
                                                    {remote.url ?? 'Not Set'}
                                                </td>
                                                <td className="git-graph-settings-actions">
                                                    <button
                                                        type="button"
                                                        className="git-graph-icon-btn git-graph-settings-action-copy"
                                                        title={copiedRemoteName === remote.name ? 'Copied' : 'Copy remote URL'}
                                                        onClick={() => void handleCopyRemote(remote)}
                                                        disabled={!remote.url}
                                                    >
                                                        <span
                                                            className={`codicon ${copiedRemoteName === remote.name ? 'codicon-check' : 'codicon-copy'}`}
                                                            aria-hidden
                                                        />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="git-graph-icon-btn git-graph-settings-action-edit"
                                                        title="Edit remote"
                                                        onClick={() => onEditRemote(remote.name)}
                                                    >
                                                        <span className="codicon codicon-edit" aria-hidden />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="git-graph-icon-btn git-graph-settings-action-delete"
                                                        title="Delete remote"
                                                        onClick={() => onDeleteRemote(remote.name)}
                                                    >
                                                        <span className="codicon codicon-trash" aria-hidden />
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                            <div className="git-graph-settings-section-actions">
                                <button type="button" className="git-graph-settings-btn" onClick={onAddRemote}>
                                    <span className="codicon codicon-add" aria-hidden />
                                    Add Remote
                                </button>
                            </div>
                        </div>

                        <div className="git-graph-settings-section">
                            <h3>Default Pull Behaviour</h3>
                            <p className="git-graph-settings-hint">
                                Applied when pulling from the context menu for <strong>{repoLabel}</strong>.
                            </p>
                            <label className="git-graph-settings-checkbox">
                                <input
                                    type="checkbox"
                                    checked={pullDefaults.noFastForward}
                                    onChange={(e) => {
                                        const next = { ...pullDefaults, noFastForward: e.target.checked };
                                        onPullDefaultsChange(next);
                                    }}
                                />
                                <span>No Fast Forward (--no-ff)</span>
                            </label>
                            <label className="git-graph-settings-checkbox">
                                <input
                                    type="checkbox"
                                    checked={pullDefaults.squash}
                                    onChange={(e) => {
                                        const next = { ...pullDefaults, squash: e.target.checked };
                                        onPullDefaultsChange(next);
                                    }}
                                />
                                <span>Squash (--squash)</span>
                            </label>
                        </div>
                    </div>
                </section>

                <section className="git-graph-settings-group">
                    <div className="git-graph-settings-group-header">
                        <h2>Extension Settings</h2>
                    </div>
                    <div className="git-graph-settings-group-content">
                        <div className="git-graph-settings-section">
                            <h3>File History Split</h3>
                            <p className="git-graph-settings-hint">
                                Editor layout when opening file Git history beside the current file.
                            </p>
                            <label className="git-graph-settings-radio">
                                <input
                                    type="radio"
                                    name="file-history-split"
                                    checked={fileHistorySplitLayout === 'vertical'}
                                    onChange={() => onFileHistorySplitLayoutChange('vertical')}
                                />
                                <span>Vertical (stacked)</span>
                            </label>
                            <label className="git-graph-settings-radio">
                                <input
                                    type="radio"
                                    name="file-history-split"
                                    checked={fileHistorySplitLayout === 'horizontal'}
                                    onChange={() => onFileHistorySplitLayoutChange('horizontal')}
                                />
                                <span>Horizontal (side by side)</span>
                            </label>
                        </div>

                        <div className="git-graph-settings-section">
                            <h3>Source Control</h3>
                            <p className="git-graph-settings-hint">
                                Show the Quick Sync button in the Source Control (Git) title toolbar.
                            </p>
                            <label className="git-graph-settings-checkbox">
                                <input
                                    type="checkbox"
                                    checked={showQuickSyncButton}
                                    onChange={(e) => {
                                        const next = e.target.checked;
                                        setShowQuickSyncButton(next);
                                        if (getConfigs()?.route === 'desktop') {
                                            window.localStorage.setItem('office-desktop-git-quick-sync', String(next));
                                            window.dispatchEvent(new CustomEvent('office-desktop-git-quick-sync', { detail: next }));
                                        }
                                        handler.emit('updateConfig', { key: 'gitHistory.quickSyncButton', value: next });
                                    }}
                                />
                                <span>Show Quick Sync button</span>
                            </label>
                        </div>
                    </div>
                </section>
            </div>
        </aside>
    );
}
