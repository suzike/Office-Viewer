type HostMessage = {
    type: string;
    content?: unknown;
};

export interface OfficeHostBridge {
    postMessage(message: HostMessage): void;
    subscribe?(listener: (message: HostMessage) => void): () => void;
}

const vscode = window['acquireVsCodeApi']?.();
export { vscode as vscodeApi };

interface HostBridgeFrame {
    bridge?: OfficeHostBridge;
    unsubscribe?: () => void;
    events: Record<string, (content: unknown) => void>;
}

// Frames are activation-ordered: the last frame owns outgoing messages and the
// live event table, so a hidden document's viewer can never hijack (or be
// orphaned by) the visible one when several viewers stay mounted via Activity.
const hostBridgeStack: HostBridgeFrame[] = [];
let activeHostFrame: HostBridgeFrame | undefined;
const fallbackEvents: Record<string, (content: unknown) => void> = {};

const postMessage = (message: HostMessage) => {
    if (vscode) {
        vscode.postMessage(message);
        return;
    }
    activeHostFrame?.bridge?.postMessage(message);
}

const DARK_MODE_KEY = 'office-dark-mode';

export function loadDarkMode(): boolean {
    const state = vscode?.getState?.() as { darkMode?: boolean } | undefined;
    if (state?.darkMode !== undefined) {
        return state.darkMode;
    }
    try {
        return localStorage.getItem(DARK_MODE_KEY) === '1';
    } catch {
        return false;
    }
}

export function saveDarkMode(dark: boolean) {
    try {
        localStorage.setItem(DARK_MODE_KEY, dark ? '1' : '0');
    } catch { }
    if (vscode?.setState) {
        const prev = (vscode.getState?.() ?? {}) as Record<string, unknown>;
        vscode.setState({ ...prev, darkMode: dark });
    }
}

export function applyDarkMode(dark: boolean) {
    document.body.classList.toggle('office-dark', dark);
    saveDarkMode(dark);
}

function hostEventTable() {
    return activeHostFrame?.events ?? fallbackEvents;
}
function receive({ data }: MessageEvent<HostMessage>) {
    if (!data)
        return;
    const table = hostEventTable();
    if (table[data.type]) {
        table[data.type](data.content);
    }
}
window.addEventListener('message', receive)

export function dispatchHostMessage(message: HostMessage) {
    receive(new MessageEvent('message', { data: message }));
}

export interface OfficeHostBridgeHandle {
    (): void;
    /** Moves this frame to the top of the activation stack (call when its document becomes visible). */
    activate(): void;
}

export function installOfficeHostBridge(bridge?: OfficeHostBridge): OfficeHostBridgeHandle {
    const frame: HostBridgeFrame = { bridge, events: {} };
    if (bridge?.subscribe) {
        frame.unsubscribe = bridge.subscribe(dispatchHostMessage);
    }
    const activate = () => {
        const index = hostBridgeStack.indexOf(frame);
        if (index !== -1) hostBridgeStack.splice(index, 1);
        hostBridgeStack.push(frame);
        activeHostFrame = frame;
    };
    activate();
    const dispose = (() => {
        const index = hostBridgeStack.indexOf(frame);
        if (index !== -1) hostBridgeStack.splice(index, 1);
        frame.unsubscribe?.();
        frame.unsubscribe = undefined;
        if (activeHostFrame === frame) {
            activeHostFrame = hostBridgeStack.at(-1);
        }
    }) as OfficeHostBridgeHandle;
    dispose.activate = activate;
    return dispose;
}
const isMac = navigator.userAgent.includes('Mac OS');
window.addEventListener('keydown', e => {
    if (isMac && isCompose(e) && (e.altKey || e.code == 'KeyW')) {
        e.preventDefault()
    }
}, isMac ? true : undefined)

const getVscodeEvent = () => {
    return {
        on(event: string, data) {
            hostEventTable()[event] = data
            return this;
        },
        emit(event: string, data?: any) {
            postMessage({ type: event, content: data })
        }
    }
}
export const handler = getVscodeEvent();

export function isCompose(e) {
    return e.metaKey || e.ctrlKey;
}

window.addEventListener('keydown', e => {
    if (e.code == 'F12') handler.emit('developerTool')
    else if (vscode && (isCompose(e) && e.code == 'KeyV')) e.preventDefault()  // VS Code webview can paste twice with some IMEs.
})
