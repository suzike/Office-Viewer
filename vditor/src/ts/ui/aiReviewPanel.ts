import { computeDiffStats, computeFullDiff } from "../ai/aiDiff";

const CLS = "vditor-ai-review";
const STREAM_RENDER_INTERVAL_MS = 80;

export interface AIReviewCallbacks {
    onAccept: (result: string) => void;
    onReject: () => void;
    onStop: () => void;
}

export class AIReviewPanel {
    private root: HTMLElement | null = null;
    private originalEl: HTMLPreElement | null = null;
    private resultEl: HTMLPreElement | null = null;
    private statsEl: HTMLElement | null = null;
    private statusEl: HTMLElement | null = null;
    private acceptBtn: HTMLButtonElement | null = null;
    private stopBtn: HTMLButtonElement | null = null;
    private streaming = false;
    private original = "";
    private modified = "";
    private callbacks: AIReviewCallbacks | null = null;
    private streamBuffer = "";
    private streamTimer: number | null = null;
    private keyHandler: ((e: KeyboardEvent) => void) | null = null;
    private syncScroll = false;

    public open(original: string, callbacks: AIReviewCallbacks) {
        this.close();
        this.original = original;
        this.modified = "";
        this.streamBuffer = "";
        this.callbacks = callbacks;
        this.streaming = true;

        const i = window.VditorI18n;
        const el = document.createElement("div");
        el.className = CLS;
        el.setAttribute("role", "dialog");
        el.setAttribute("aria-modal", "true");
        el.innerHTML = `
            <div class="${CLS}__header">
                <span class="codicon codicon-sparkle ${CLS}__icon"></span>
                <span class="${CLS}__title">${i.aiReviewTitle ?? "Review Changes"}</span>
                <div class="${CLS}__header-actions">
                    <span class="${CLS}__status">${i.aiGenerating ?? "Generating…"}</span>
                    <span class="${CLS}__stats"></span>
                    <button type="button" class="${CLS}__stop" data-action="stop" title="${i.aiStop ?? "Stop"}">
                        <span class="codicon codicon-debug-stop"></span>${i.aiStop ?? "Stop"}
                    </button>
                    <button type="button" class="${CLS}__close" data-action="reject" title="${i.aiCancel}">
                        <span class="codicon codicon-close"></span>
                    </button>
                </div>
            </div>
            <div class="${CLS}__body">
                <div class="${CLS}__pane ${CLS}__pane--original">
                    <div class="${CLS}__pane-label">${i.aiOriginal ?? "Original"}</div>
                    <pre class="${CLS}__text"></pre>
                </div>
                <div class="${CLS}__divider"></div>
                <div class="${CLS}__pane ${CLS}__pane--result">
                    <div class="${CLS}__pane-label">${i.aiResult ?? "AI Result"}</div>
                    <pre class="${CLS}__text ${CLS}__text--loading"></pre>
                </div>
            </div>
            <div class="${CLS}__footer">
                <button type="button" class="${CLS}__btn ${CLS}__btn--reject" data-action="reject-all" disabled>
                    <span class="codicon codicon-discard"></span>${i.aiReject ?? "Reject"}
                </button>
                <button type="button" class="${CLS}__btn ${CLS}__btn--accept" data-action="accept-all" disabled>
                    <span class="codicon codicon-check"></span>${i.aiAccept ?? "Accept"}
                </button>
            </div>`;

        this.root = el;
        this.originalEl = el.querySelector<HTMLPreElement>(`.${CLS}__pane--original .${CLS}__text`);
        this.resultEl = el.querySelector<HTMLPreElement>(`.${CLS}__pane--result .${CLS}__text`);
        this.statsEl = el.querySelector<HTMLElement>(`.${CLS}__stats`);
        this.statusEl = el.querySelector<HTMLElement>(`.${CLS}__status`);
        this.acceptBtn = el.querySelector<HTMLButtonElement>(`[data-action="accept-all"]`);
        this.stopBtn = el.querySelector<HTMLButtonElement>(`[data-action="stop"]`);

        if (this.originalEl) {
            this.originalEl.textContent = original;
        }

        document.body.appendChild(el);
        this.position();
        this.bindEvents();
        this.bindScrollSync();
    }

    public stream(chunk: string) {
        if (!this.streaming) {
            return;
        }
        this.streamBuffer += chunk;
        this.modified = this.streamBuffer;
        if (this.streamTimer !== null) {
            return;
        }
        this.streamTimer = window.setTimeout(() => {
            this.streamTimer = null;
            this.renderResult();
        }, STREAM_RENDER_INTERVAL_MS);
    }

    public endStream() {
        this.streaming = false;
        if (this.streamTimer !== null) {
            window.clearTimeout(this.streamTimer);
            this.streamTimer = null;
        }
        this.modified = this.streamBuffer;
        this.renderComplete();
    }

    public close() {
        if (this.streamTimer !== null) {
            window.clearTimeout(this.streamTimer);
            this.streamTimer = null;
        }
        if (this.keyHandler) {
            document.removeEventListener("keydown", this.keyHandler);
            this.keyHandler = null;
        }
        this.root?.remove();
        this.root = null;
        this.originalEl = null;
        this.resultEl = null;
        this.callbacks = null;
        this.streaming = false;
    }

    private bindEvents() {
        this.root?.addEventListener("click", (e) => {
            const target = e.target as HTMLElement;
            const actionEl = target.closest<HTMLElement>("[data-action]");
            if (!actionEl) {
                return;
            }
            const action = actionEl.dataset.action;
            if (action === "stop") {
                this.callbacks?.onStop();
                return;
            }
            if (action === "reject" || action === "reject-all") {
                this.callbacks?.onReject();
                this.close();
                return;
            }
            if (action === "accept-all") {
                this.accept();
            }
        });

        this.keyHandler = (e: KeyboardEvent) => {
            if (!this.root || e.key !== "Escape") {
                return;
            }
            e.preventDefault();
            if (this.streaming) {
                this.callbacks?.onStop();
            } else {
                this.callbacks?.onReject();
                this.close();
            }
        };
        document.addEventListener("keydown", this.keyHandler);
    }

    private bindScrollSync() {
        const originalPane = this.root?.querySelector<HTMLElement>(`.${CLS}__pane--original .${CLS}__text`);
        const resultPane = this.root?.querySelector<HTMLElement>(`.${CLS}__pane--result .${CLS}__text`);
        if (!originalPane || !resultPane) {
            return;
        }
        const sync = (source: HTMLElement, target: HTMLElement) => {
            if (this.syncScroll) {
                return;
            }
            this.syncScroll = true;
            target.scrollTop = source.scrollTop;
            target.scrollLeft = source.scrollLeft;
            this.syncScroll = false;
        };
        originalPane.addEventListener("scroll", () => sync(originalPane, resultPane), { passive: true });
        resultPane.addEventListener("scroll", () => sync(resultPane, originalPane), { passive: true });
    }

    private renderResult() {
        if (!this.resultEl) {
            return;
        }
        this.resultEl.textContent = this.modified;
        this.updateStats();
    }

    private renderComplete() {
        const hasChanges = this.modified !== this.original;

        if (this.statusEl) {
            this.statusEl.hidden = true;
        }
        if (this.stopBtn) {
            this.stopBtn.hidden = true;
        }
        if (this.resultEl) {
            this.resultEl.textContent = this.modified;
            this.resultEl.classList.remove(`${CLS}__text--loading`);
        }
        if (this.acceptBtn) {
            this.acceptBtn.disabled = !hasChanges;
        }
        const rejectBtn = this.root?.querySelector<HTMLButtonElement>(`[data-action="reject-all"]`);
        if (rejectBtn) {
            rejectBtn.disabled = false;
        }
        this.updateStats();
    }

    private accept() {
        this.callbacks?.onAccept(this.modified);
        this.close();
    }

    private updateStats() {
        if (!this.statsEl) {
            return;
        }
        const diffs = computeFullDiff(this.original, this.modified);
        const { additions, deletions } = computeDiffStats(diffs);
        this.statsEl.innerHTML = this.formatStatsHtml(additions, deletions);
    }

    private formatStatsHtml(additions: number, deletions: number): string {
        if (additions === 0 && deletions === 0) {
            return "";
        }
        const parts: string[] = [];
        if (additions > 0) {
            parts.push(`<span class="${CLS}__stat-add">+${additions}</span>`);
        }
        if (deletions > 0) {
            parts.push(`<span class="${CLS}__stat-del">-${deletions}</span>`);
        }
        return parts.join(" ");
    }

    private position() {
        if (!this.root) {
            return;
        }
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const panelW = Math.min(720, vw - 32);
        const panelH = 320;
        this.root.style.width = `${panelW}px`;
        this.root.style.left = `${Math.round((vw - panelW) / 2)}px`;
        this.root.style.top = `${Math.max(16, Math.round((vh - panelH) / 2))}px`;
    }
}
