function loadRes(url) {
    return fetch(url).then(r => r.text())
}

const isMac = navigator.userAgent.includes('Mac OS');
const shortcutTip = isMac ? '⌘ ^ E' : 'Ctrl Alt E';

export async function getToolbar(resPath, onSave = null, getEditor = null) {
    const codicon = (name) => `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
    return [
        'outline',
        "headings",
        "bold",
        "italic",
        "strike",
        "link",
        "|",
        {
            name: 'edit-in-vscode',
            tip: `Edit In VSCode (${shortcutTip})`,
            className: 'right',
            icon: codicon('edit'),
            click() {
                handler.emit("editInVSCode", true)
            }
        },
        {
            name: 'save',
            tip: 'Save',
            className: 'right',
            icon: codicon('save'),
            click() {
                onSave?.()
            }
        },
        'upload',
        "|",
        "editor-theme",
        "editor-theme-toggle",
        "|",
        // "|",
        "list",
        "ordered-list",
        "check",
        "table",
        "|",
        "quote",
        "code",
        "inline-code",
        "|",
        "undo",
        "redo",
        "|",
        "find",
        "ai-settings",
        {
            name: 'desktop-markdown-toc',
            tip: '插入/更新目录',
            icon: codicon('list-tree'),
            click() {
                insertOrUpdateToc(getEditor?.())
            }
        },
        {
            name: 'desktop-markdown-focus',
            tip: '专注模式（打字机滚动）',
            icon: codicon('eye'),
            click() {
                toggleFocusMode(getEditor?.())
            }
        },
        {
            name: 'desktop-markdown-zen',
            tip: '禅模式（ESC 退出）',
            icon: codicon('screen-full'),
            click() {
                toggleZenMode()
            }
        },
        {
            name: 'desktop-markdown-template',
            tip: '从模板插入',
            icon: codicon('file-add'),
            click() {
                requestTemplatePanel()
            }
        },
        {
            name: 'desktop-markdown-settings',
            tip: 'Markdown Settings',
            icon: codicon('settings-gear'),
            click() {
                handler.emit('editDesktopMarkdownSettings')
            }
        },
        "settings"
    ]
}

const hideContextMenu = (menu) => {
    menu.hidden = true
}

const showContextMenu = (menu, clientX, clientY) => {
    menu.hidden = false
    menu.style.left = `${clientX}px`
    menu.style.top = `${clientY}px`
    const rect = menu.getBoundingClientRect()
    const padding = 4
    let left = clientX
    let top = clientY
    if (left + rect.width > window.innerWidth - padding) {
        left = window.innerWidth - rect.width - padding
    }
    if (top + rect.height > window.innerHeight - padding) {
        top = window.innerHeight - rect.height - padding
    }
    if (left < padding) left = padding
    if (top < padding) top = padding
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
}

const getSelectedHtml = () => {
    const selection = document.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return ''
    const editorRoot = document.getElementById('vditor')
    if (!editorRoot?.contains(selection.anchorNode) || !editorRoot.contains(selection.focusNode)) return ''
    const container = document.createElement('div')
    for (let i = 0; i < selection.rangeCount; i++) {
        container.appendChild(selection.getRangeAt(i).cloneContents())
    }
    return container.innerHTML
}

const normalizePlainText = text => {
    return (text || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

const htmlToPlainText = html => {
    if (!html) return ''
    const container = document.createElement('div')
    container.innerHTML = html
    container.querySelectorAll(
        '.vditor-ir__marker, .vditor-ir__preview, .vditor-toolbar, .vditor-hint, script, style',
    ).forEach(item => item.remove())
    container.querySelectorAll('br').forEach(item => item.replaceWith('\n'))
    container.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, li, tr, pre, blockquote').forEach(item => {
        item.appendChild(document.createTextNode('\n'))
    })
    return normalizePlainText(container.textContent || '')
}

const getSelectedPlainText = () => {
    const selection = document.getSelection()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return ''
    const editorRoot = document.getElementById('vditor')
    if (!editorRoot?.contains(selection.anchorNode) || !editorRoot.contains(selection.focusNode)) return ''
    const container = document.createElement('div')
    for (let i = 0; i < selection.rangeCount; i++) {
        container.appendChild(selection.getRangeAt(i).cloneContents())
    }
    return htmlToPlainText(container.innerHTML) || normalizePlainText(selection.toString())
}

const copyHtml = async (html) => {
    if (!html) return
    if (navigator.clipboard?.write && window.ClipboardItem) {
        await navigator.clipboard.write([
            new ClipboardItem({
                'text/html': new Blob([html], { type: 'text/html' }),
                'text/plain': new Blob([html], { type: 'text/plain' }),
            }),
        ])
        return
    }
    await navigator.clipboard.writeText(html)
}

const copyPlainText = async (text) => {
    if (!text) return
    if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
        return
    }
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.left = '-9999px'
    textarea.style.top = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
}

export const setAIAvailable = (available, editor) => {
    editor?.setCopilotAvailable?.(available);
}

export const createContextMenu = (editor) => {
    const menu = document.getElementById('context-menu')

    const closeMenu = () => hideContextMenu(menu)

    document.addEventListener('mousedown', e => {
        if (!menu.contains(e.target)) {
            closeMenu()
        }
    })
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            closeMenu()
        }
    })
    document.oncontextmenu = e => {
        e.preventDefault()
        e.stopPropagation()
        showContextMenu(menu, e.clientX, e.clientY)
    }
    menu.addEventListener('click', e => {
        const item = e.target.closest('[data-action]')
        if (!item || (item.classList.contains('vditor-context-menu__item--desktop-only') && document.body.classList.contains('is-web'))) return
        closeMenu()
        const action = item.dataset.action
        switch (action) {
            case 'copy':
                document.execCommand('copy')
                break
            case 'copyAsHtml':
                copyHtml(getSelectedHtml() || editor.getHTML())
                break
            case 'copyAsPlainText':
                copyPlainText(getSelectedPlainText() || htmlToPlainText(editor.getHTML()))
                break
            case 'paste':
                if (document.getSelection()?.toString()) { document.execCommand('delete') }
                vscodeEvent.emit('command', 'office.markdown.paste')
                break
            case 'exportPdf':
                vscodeEvent.emit('export', { type: 'pdf' })
                break
            case 'exportPdfWithoutOutline':
                vscodeEvent.emit('export', { type: 'pdf', withoutOutline: true })
                break
            case 'exportDocx':
                vscodeEvent.emit('export', { type: 'docx' })
                break
            case 'exportHtml':
                vscodeEvent.emit('export', { type: 'html' })
                break
            case 'showInFolder':
                vscodeEvent.emit('showInFolder')
                break
            case 'insertImage':
                vscodeEvent.emit('insertImage')
                break
            case 'aiPolish':
                editor.openAIPolishDialog()
                break
            case 'print':
                vscodeEvent.emit('print')
                break
            case 'longImageExport':
                vscodeEvent.emit('exportImage')
                break
            case 'plainTextExport':
                vscodeEvent.emit('exportText')
                break
            case 'deadLinkScan':
                vscodeEvent.emit('scanDeadLinks', editor.getValue())
                break
            case 'aiGenerateToc':
                emitAIGenerate(editor, 'toc')
                break
            case 'aiGenerateSummary':
                emitAIGenerate(editor, 'summary')
                break
        }
    })
}

function matchShortcut(hotkey, event) {

    const matchAlt = hotkey.match(/!/) != null == event.altKey
    const matchMeta = hotkey.match(/⌘/) != null == event.metaKey
    const matchCtrl = hotkey.match(/\^/) != null == event.ctrlKey
    const matchShifter = hotkey.match(/\+/) != null == event.shiftKey

    if (matchAlt && matchCtrl && matchShifter && matchMeta) {
        return hotkey.match(new RegExp(`\\b${event.key}\\b`, "i"))
    }

}


const isInsideCodeMirrorTarget = (target) => {
    const node = target?.nodeType === 1 ? target : target?.parentElement;
    return !!node?.closest?.(".vditor-code-block--cm .cm-editor");
};

export const bindShortcut = (handler, editor) => {
    let _exec = document.execCommand.bind(document)
    document.execCommand = (cmd, ...args) => {
        if (cmd === 'delete') {
            setTimeout(() => {
                return _exec(cmd, ...args)
            })
        } else {
            return _exec(cmd, ...args)
        }
    }
    window.addEventListener('keydown', async e => {
        if (matchShortcut('^⌘e', e) || matchShortcut('^!e', e)) {
            e.stopPropagation();
            e.preventDefault();
            return handler.emit("editInVSCode", true);
        }

        if (e.code == 'F12') return handler.emit('developerTool')
        if (isCompose(e)) {
            switch (e.code) {
                case 'KeyS':
                    vscodeEvent.emit("doSave", editor.getValue());
                    editor.markSaved();
                    e.stopPropagation();
                    e.preventDefault();
                    break;
                case 'KeyP':
                    vscodeEvent.emit('print');
                    e.stopPropagation();
                    e.preventDefault();
                    break;
                case 'KeyV':
                    if (isInsideCodeMirrorTarget(e.target) || isInsideCodeMirrorTarget(document.activeElement)) {
                        return;
                    }
                    if (e.shiftKey) {
                        const text = await navigator.clipboard.readText();
                        if (text) document.execCommand('insertText', false, text.trim());
                        e.stopPropagation();
                    }
                    else if (document.getSelection()?.toString()) {
                        // vscode webview only: 修复剪切后选中文本没有被清除
                        document.execCommand("delete")
                    }
                    e.preventDefault();
                    break;
            }
        }
    }, isMac ? true : undefined)

    window.onresize = () => {
        document.getElementById('vditor').style.height = '100%'
    }
}

const TOC_MARKER_PATTERN = /^[ \t]*\[\[?toc\]?\][ \t]*$/im
const TOC_HEADING_PATTERN = /^#{1,6}[ \t]+\S/

export const insertOrUpdateToc = (vditor) => {
    if (!vditor) return
    const value = vditor.getValue()
    let inFence = false
    let hasHeading = false
    for (const line of value.split('\n')) {
        if (/^[ \t]*(```|~~~)/.test(line)) {
            inFence = !inFence
        } else if (!inFence && TOC_HEADING_PATTERN.test(line)) {
            hasHeading = true
            break
        }
    }
    if (!hasHeading) return
    let next = value
    const existing = value.match(TOC_MARKER_PATTERN)
    if (existing) {
        next = `${value.slice(0, existing.index)}[toc]${value.slice(existing.index + existing[0].length)}`
    } else {
        const frontMatter = value.match(/^---[ \t]*\r?\n[\s\S]*?\n---[ \t]*\r?\n?/)
        const insertAt = frontMatter ? frontMatter[0].length : 0
        next = `${value.slice(0, insertAt)}[toc]\n\n${value.slice(insertAt)}`
    }
    if (next !== value) {
        vditor.setValue(next)
        handler.emit('save', vditor.getValue())
    }
}

const WORD_COUNT_CJK_PATTERN = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/g

export const createWordCountChip = () => {
    let chip = document.querySelector('.office-markdown-word-count')
    if (!chip) {
        chip = document.createElement('div')
        chip.className = 'office-markdown-word-count'
        chip.setAttribute('aria-live', 'polite')
        document.body.appendChild(chip)
    }
    let timer = 0
    const render = (text) => {
        const source = typeof text === 'string' ? text : ''
        const cjkCount = (source.match(WORD_COUNT_CJK_PATTERN) || []).length
        const latinWords = (source.replace(WORD_COUNT_CJK_PATTERN, ' ').match(/[A-Za-z0-9_'’-]+/g) || []).length
        const characters = source.replace(/\s/g, '').length
        const minutes = Math.max(1, Math.ceil(cjkCount / 400 + latinWords / 200))
        chip.textContent = `字数 ${characters} · 词数 ${cjkCount + latinWords} · 约 ${minutes} 分钟`
    }
    return (text) => {
        clearTimeout(timer)
        timer = setTimeout(() => render(text), 300)
    }
}

// 批次 2：专注模式（打字机滚动 + 当前段落高亮）、禅模式、拖放文件插入链接、AI 生成目录/摘要

const setToolbarActive = (name, active) => {
    const button = document.querySelector(`[data-type="${name}"]`)
    button?.closest('.vditor-toolbar__item')?.classList.toggle('office-toolbar-active', active)
}

let focusCleanup = null

const findCaretBlock = () => {
    const selection = document.getSelection()
    if (!selection || selection.rangeCount === 0) return null
    const node = selection.anchorNode
    const element = node?.nodeType === 1 ? node : node?.parentElement
    const editorRoot = document.getElementById('vditor')
    if (!element || !editorRoot?.contains(element)) return null
    const block = element.closest?.('.vditor-wysiwyg__block, .vditor-ir__node')
    if (block && editorRoot.contains(block)) return block
    let current = element
    while (current && current.parentElement && !current.parentElement.matches('.vditor-wysiwyg, .vditor-ir')) {
        current = current.parentElement
    }
    return current && current.parentElement ? current : null
}

const scrollCaretToCenter = () => {
    const container = document.querySelector('.vditor-wysiwyg, .vditor-ir')
    const selection = document.getSelection()
    if (!container || !selection || selection.rangeCount === 0) return
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    if (!rect || (rect.top === 0 && rect.bottom === 0)) return
    const containerRect = container.getBoundingClientRect()
    const offset = rect.top - containerRect.top - containerRect.height * 0.4
    if (Math.abs(offset) > 4) container.scrollTop += offset
}

const enableFocusMode = () => {
    let currentBlock = null
    let scheduled = false
    const onSelectionChange = () => {
        if (scheduled) return
        scheduled = true
        requestAnimationFrame(() => {
            scheduled = false
            const block = findCaretBlock()
            if (block !== currentBlock) {
                currentBlock?.classList.remove('office-focus-current')
                block?.classList.add('office-focus-current')
                currentBlock = block
            }
            if (block) scrollCaretToCenter()
        })
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => {
        document.removeEventListener('selectionchange', onSelectionChange)
        currentBlock?.classList.remove('office-focus-current')
    }
}

export const toggleFocusMode = (editor) => {
    if (!editor) return false
    if (focusCleanup) {
        focusCleanup()
        focusCleanup = null
        document.body.classList.remove('office-focus-mode')
        setToolbarActive('desktop-markdown-focus', false)
        return false
    }
    focusCleanup = enableFocusMode()
    document.body.classList.add('office-focus-mode')
    setToolbarActive('desktop-markdown-focus', true)
    return true
}

let zenActive = false

export const toggleZenMode = () => {
    zenActive = !zenActive
    document.body.classList.toggle('office-zen-mode', zenActive)
    setToolbarActive('desktop-markdown-zen', zenActive)
    return zenActive
}

window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && zenActive) {
        event.preventDefault()
        toggleZenMode()
    }
})

const DROP_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'apng'])

const isImageDropFile = (file) => {
    if (file.type?.toLowerCase().startsWith('image/')) return true
    return DROP_IMAGE_EXTENSIONS.has(file.name?.split('.').pop()?.toLowerCase() ?? '')
}

export const bindFileDrop = (editor) => {
    const dropZone = document.getElementById('vditor')
    if (!dropZone) return
    dropZone.addEventListener('drop', (event) => {
        // 桌面端：非图片文件拖入编辑器 → 插入相对链接；图片走现有图片服务
        if (!window.__officeDesktopMarkdown) return
        const files = [...(event.dataTransfer?.files ?? [])]
        const others = files.filter((file) => !isImageDropFile(file))
        if (!others.length) return
        event.preventDefault()
        event.stopPropagation()
        const caret = document.caretRangeFromPoint?.(event.clientX, event.clientY)
        if (caret) {
            const selection = document.getSelection()
            selection.removeAllRanges()
            selection.addRange(caret)
        }
        for (const file of files.filter(isImageDropFile)) {
            const ext = file.name.split('.').pop()?.toLowerCase() || 'png'
            const reader = new FileReader()
            reader.readAsBinaryString(file)
            reader.onloadend = () => handler.emit('img', { data: reader.result, ext })
        }
        handler.emit('dropFiles', others)
    }, true)
}

const readAIGenerateOptions = () => {
    try {
        const settings = JSON.parse(localStorage.getItem('vditor-global-settings') || '{}')
        const models = JSON.parse(settings.aiModels || '[]')
        const model = models.find((item) => item.id === settings.aiSelectedModel) || models[0]
        if (!model) return undefined
        return {
            engine: 'custom',
            customUrl: model.url,
            customKey: model.key,
            customModel: (model.model || '').split(',')[0].trim(),
            customApiFormat: model.format || 'auto',
        }
    } catch {
        return undefined
    }
}

const emitAIGenerate = (editor, kind) => {
    vscodeEvent.emit('aiGenerate', {
        kind,
        markdown: editor.getValue(),
        options: readAIGenerateOptions(),
    })
}

// 批次 3：Mermaid 渲染错误面板、死链检查定位、模板插入

export const bindMermaidErrorPanel = () => {
    const root = document.getElementById('vditor')
    if (!root) return
    const decorate = () => {
        root.querySelectorAll('.language-mermaid.vditor-reset--error').forEach((item) => {
            if (item.querySelector(':scope > .office-mermaid-error')) return
            const message = (item.textContent || '').replace(/^mermaid render error:\s*/i, '').trim()
            const lineMatch = message.match(/line\s+(\d+)/i)
            const lineNo = lineMatch ? Number(lineMatch[1]) : 0
            const source = item.getAttribute('data-mermaid') || ''
            const sourceLine = lineNo > 0 ? (source.split('\n')[lineNo - 1] ?? '').trim() : ''
            item.innerHTML = ''
            const panel = document.createElement('div')
            panel.className = 'office-mermaid-error'
            const title = document.createElement('div')
            title.className = 'office-mermaid-error__title'
            title.textContent = lineNo > 0 ? `Mermaid 渲染失败（第 ${lineNo} 行）` : 'Mermaid 渲染失败'
            panel.appendChild(title)
            const detail = document.createElement('div')
            detail.className = 'office-mermaid-error__detail'
            detail.textContent = message
            panel.appendChild(detail)
            if (sourceLine) {
                const code = document.createElement('code')
                code.className = 'office-mermaid-error__line'
                code.textContent = sourceLine
                panel.appendChild(code)
            }
            item.appendChild(panel)
        })
    }
    decorate()
    const observer = new MutationObserver(() => decorate())
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
}

const decodeLinkValue = (value) => {
    try {
        return decodeURIComponent(value)
    } catch {
        return value
    }
}

export const revealDeadLink = (target) => {
    if (!target) return
    const root = document.querySelector('.vditor-wysiwyg, .vditor-ir')
    if (!root) return
    const decoded = decodeLinkValue(target)
    const node = [...root.querySelectorAll('a[href], img[src]')].find((element) => {
        const value = element.getAttribute('href') ?? element.getAttribute('src') ?? ''
        return value === target || decodeLinkValue(value) === decoded
    })
    if (!node) return
    node.scrollIntoView({ block: 'center', behavior: 'smooth' })
    node.classList.add('office-dead-link-flash')
    setTimeout(() => node.classList.remove('office-dead-link-flash'), 1600)
}

let templatePanel = null

const closeTemplatePanel = () => {
    templatePanel?.remove()
    templatePanel = null
}

export const requestTemplatePanel = () => {
    if (templatePanel) {
        closeTemplatePanel()
        return
    }
    vscodeEvent.emit('requestTemplates')
}

// setValue 不触发 input 回调，工具栏保存按钮保持禁用态；手动置为可用，
// 让「从模板插入」/AI 生成内容后的未保存修改可以被保存按钮写出。
export const enableSaveButton = () => {
    const button = document.querySelector('[data-type="save"]')
    button?.removeAttribute('disabled')
    button?.classList.remove('vditor-menu--disabled')
}

export const showTemplatePanel = (templates, editor) => {
    closeTemplatePanel()
    if (!templates.length) return
    const panel = document.createElement('div')
    panel.className = 'office-template-panel'
    panel.setAttribute('role', 'menu')
    const hint = document.createElement('div')
    hint.className = 'office-template-panel__hint'
    hint.textContent = '选择模板替换当前文档内容'
    panel.appendChild(hint)
    for (const template of templates) {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'office-template-panel__item'
        item.setAttribute('role', 'menuitem')
        item.textContent = template.name
        item.addEventListener('click', () => {
            closeTemplatePanel()
            editor.setValue(template.content)
            handler.emit('save', editor.getValue())
            enableSaveButton()
        })
        panel.appendChild(item)
    }
    document.body.appendChild(panel)
    const anchor = document.querySelector('[data-type="desktop-markdown-template"]')
    const rect = anchor?.getBoundingClientRect()
    const left = Math.max(4, Math.min(rect?.left ?? 40, window.innerWidth - panel.offsetWidth - 4))
    panel.style.left = `${left}px`
    panel.style.top = `${(rect?.bottom ?? 30) + 6}px`
    templatePanel = panel
}

document.addEventListener('mousedown', (event) => {
    if (templatePanel && !templatePanel.contains(event.target)) closeTemplatePanel()
})
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeTemplatePanel()
})
