import { getToolbar, bindShortcut, createContextMenu, setAIAvailable, createWordCountChip, bindFileDrop, bindMermaidErrorPanel, revealDeadLink, showTemplatePanel, enableSaveButton } from "./util.js";
import { mapVscodeLanguageToVditorLang } from "./lang.js";

handler.on("open", async (md) => {
  const { content, rootPath, documentCacheId, pendingFragment, config } = md;
  const {
    language, isWeb, isDev, markdown,
    editMode, editorTheme, codeMirrorTheme, mermaidTheme
  } = config;
  if (isWeb) {
    document.body.classList.add('is-web')
  }
  const updateWordCount = createWordCountChip();
  const editor = new Vditor('vditor', {
    value: content,
    cdn: rootPath,
    height: '100%',
    outline: {
      position: 'left',
    },
    cache: {
      enable: false,
      id: documentCacheId,
      focusHost: 'vscode',
    },
    mode: editMode,
    editorTheme,
    codeMirrorTheme,
    mermaidTheme,
    lang: mapVscodeLanguageToVditorLang(language),
    tab: '\t',
    toolbar: await getToolbar(rootPath, () => {
      handler.emit('doSave', editor?.getValue());
      editor?.markSaved();
    }, () => editor),
    onAboutOpen: () => handler.emit('openAbout'),
    onSponsorLogoClick: () => handler.emit('openSponsor'),
    onSponsorSiteClick: () => handler.emit('openExternal', 'https://database-client.com/'),
    onLinkClick(payload, event) {
      const isCompose = event.metaKey || event.ctrlKey;
      if (payload.action !== "dblclick" && !(payload.action === "click" && isCompose)) {
        return;
      }
      if (payload.type === "footnote-ref") {
        editor.scrollToBlock(`footnote:${payload.href}`);
        return;
      }
      if (payload.href?.startsWith("#")) {
        editor.scrollToBlock(payload.href);
        return;
      }
      let uri = payload.href;
      if (payload.type === "wikilink" || payload.type === "wikilink-embed") {
        const hashIndex = uri.indexOf("#");
        const page = hashIndex < 0 ? uri : uri.slice(0, hashIndex);
        const fragment = hashIndex < 0 ? "" : uri.slice(hashIndex + 1);
        if (!page && fragment) {
          editor.scrollToBlock(fragment);
          return;
        }
        uri = `wiki:${payload.href}`;
      }
      handler.emit("openLink", uri);
    },
    debugger: isDev,
    wysiwygInputPerf: isDev && false,
    changeEditorTheme(theme) {
      handler.emit('editorTheme', theme)
    },
    changeCodeTheme(theme) {
      handler.emit('codeMirrorTheme', theme)
    },
    changeMermaidTheme(theme) {
      handler.emit('mermaidTheme', theme)
    },
    changeEditMode(mode) {
      handler.emit('editMode', mode)
    },
    onSettingsChange(settings) {
      handler.emit('syncViewerSettings', settings)
    },
    onEditSettings() {
      handler.emit('editViewerSettings', editor.exportViewerSettings())
    },
    input(content) {
      handler.emit("save", content)
      updateWordCount(content)
    },
    upload: {
      url: '/image',
      accept: 'image/*',
      handler(files) {
        const file = files[0];
        const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
        let reader = new FileReader();
        reader.readAsBinaryString(file);
        reader.onloadend = () => {
          handler.emit("img", { data: reader.result, ext })
        };
      }
    },
    onTelemetry(event, properties) {
      handler.emit('telemetry', { event, properties });
    },
    ai: {
      onPolish(markdown, apply, options) {
        handler.emit('aiPolish', { markdown, options })
      },
      onCancelPolish() {
        handler.emit('aiPolishCancel')
      }
    },
    preview: {
      math: {
        macros: markdown?.math?.macros ?? {},
      },
    },
    after() {
      const { viewerSettings } = md;
      if (viewerSettings?.enabled) {
        editor.setViewerSettingsSyncEnabled(true);
        if (viewerSettings.settings) {
          editor.applyViewerSettings(viewerSettings.settings);
        }
      }
      handler.on('viewerSettingsSync', ({ enabled }) => {
        editor.setViewerSettingsSyncEnabled(!!enabled);
      });
      handler.on('viewerSettings', (settings) => {
        editor.applyViewerSettings(settings);
      });
      handler.on('markdownConfig', (update) => {
        if (update.editorTheme !== undefined) {
          editor.setEditorTheme(update.editorTheme);
        }
        if (update.codeMirrorTheme !== undefined) {
          Vditor.setCodeTheme(update.codeMirrorTheme, editor.vditor?.element);
        }
        if (update.mermaidTheme !== undefined) {
          editor.setMermaidTheme(update.mermaidTheme);
        }
        if (update.editMode !== undefined) {
          editor.switchEditMode(update.editMode);
        }
      });
      handler.on("update", content => {
        if (document.querySelector("[data-type='yaml-front-matter'].vditor-code-block--cm .cm-editor.cm-focused")) {
          return;
        }
        if (editor.getValue() === content) {
          return;
        }
        editor.setValue(content);
        editor.markSaved();
        updateWordCount(content);
      })
      handler.on("insertImageMarkdown", (markdown) => {
        editor.insertMarkdown(markdown);
      })
      handler.on("insertGeneratedContent", (payload) => {
        const content = typeof payload === 'string' ? payload : payload?.content;
        if (!content || !content.trim()) return;
        const value = editor.getValue();
        const frontMatter = value.match(/^---[ \t]*\r?\n[\s\S]*?\n---[ \t]*\r?\n?/);
        const insertAt = frontMatter ? frontMatter[0].length : 0;
        const block = content.trim().replace(/\r\n/g, '\n');
        editor.setValue(`${value.slice(0, insertAt)}${block}\n\n${value.slice(insertAt)}`);
        handler.emit('save', editor.getValue());
        enableSaveButton();
      })
      handler.on("markdownTemplates", (templates) => {
        showTemplatePanel(Array.isArray(templates) ? templates : [], editor)
      })
      handler.on("revealDeadLink", (payload) => {
        revealDeadLink(typeof payload === 'string' ? payload : payload?.target)
      })
      handler.on("gotoBlock", (fragment) => {
        if (fragment) {
          editor.scrollToBlock(fragment);
        }
      })
      handler.emit('queryAIAvailable')
      handler.on("aiAvailable", (available) => {
        setAIAvailable(available, editor)
        if (available) {
          handler.emit('queryVSCodeModels')
        }
      })
      handler.on("vscodeModels", (models) => {
        editor.setVSCodeModels(models)
      })
      handler.on('aiPolishChunk', (chunk) => {
        editor.streamAIChunk(chunk)
      })
      handler.on('aiPolishEnd', () => {
        editor.endAIStream()
      })
      editor.restoreDocumentSession(true)
      if (pendingFragment) {
        editor.scrollToBlock(pendingFragment);
      }
      bindFileDrop(editor)
      bindMermaidErrorPanel()
      updateWordCount(editor.getValue());
    }
  })
  bindShortcut(handler, editor);
  createContextMenu(editor)
  if (window.__officeDesktopMarkdown) {
    // Desktop shell: forward text selections so the AI assistant can show its
    // floating action bar (解释 / 翻译 / 引用到助手) next to the selection.
    let selectionTimer = 0;
    document.addEventListener('selectionchange', () => {
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        const selection = window.getSelection();
        const text = selection ? String(selection).trim() : '';
        let rect = null;
        if (text && selection.rangeCount) {
          const bounds = selection.getRangeAt(0).getBoundingClientRect();
          rect = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
        }
        handler.emit('assistantSelection', { text: text.slice(0, 16000), rect });
      }, 150);
    });
  }
}).emit("init")
