import {
    highlightSpecialChars,
    drawSelection,
    dropCursor,
    rectangularSelection,
    crosshairCursor,
    highlightActiveLine,
    keymap,
    type KeyBinding,
} from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { indentOnInput, bracketMatching } from "@codemirror/language";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { closeBrackets, autocompletion, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { vditorSyntaxHighlighting } from "./codeMirrorHighlight";

export const stopHandledCodeMirrorKeymap = (bindings: readonly KeyBinding[]) =>
    bindings.map((binding) => ({
        ...binding,
        stopPropagation: true,
    }));

/** basicSetup without defaultHighlightStyle — layout in _codemirror.less, colors via CSS variables / theme files */
export const vditorCodeMirrorSetup = [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    EditorState.tabSize.of(4),
    indentOnInput(),
    vditorSyntaxHighlighting,
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    keymap.of(stopHandledCodeMirrorKeymap([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...completionKeymap,
    ])),
];
