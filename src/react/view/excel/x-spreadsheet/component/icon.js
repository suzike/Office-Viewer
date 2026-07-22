import { Element, h } from './element';
import { cssPrefix } from '../config';

const CODICON_MAP = {
  undo: 'redo',
  redo: 'redo',
  bold: 'bold',
  italic: 'italic',
  'font-bold': 'bold',
  'font-italic': 'italic',
  strike: 'strikethrough',
  clearformat: 'eraser',
  textwrap: 'word-wrap',
  ellipsis: 'more',
  vscode: 'vscode',
  save: 'save',
  'save-as': 'save-as',
  find: 'search',
  autofilter: 'filter',
  freeze: 'pin',
};

function codiconClass(name, codicon) {
  const flipClass = name === 'undo' ? ` ${cssPrefix}-icon-flip-horizontal` : '';
  return `codicon codicon-${codicon}${flipClass}`;
}

export default class Icon extends Element {
  constructor(name) {
    super('div', `${cssPrefix}-icon`);
    const codicon = CODICON_MAP[name];
    if (codicon) {
      this.iconNameEl = h('i', codiconClass(name, codicon));
    } else {
      this.iconNameEl = h('div', `${cssPrefix}-icon-img ${name}`);
    }
    this.child(this.iconNameEl);
  }

  setName(name) {
    const codicon = CODICON_MAP[name];
    if (codicon) {
      this.iconNameEl.className(codiconClass(name, codicon));
    } else {
      this.iconNameEl.className(`${cssPrefix}-icon-img ${name}`);
    }
  }
}
