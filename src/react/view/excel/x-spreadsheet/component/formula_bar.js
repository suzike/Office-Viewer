import { h } from './element';
import { cssPrefix } from '../config';
import { expr2xy, xy2expr } from '../core/alphabet';

export default class FormulaBar {
  constructor(data, onCommit, onInput, onNavigate) {
    this.data = data;
    this.onCommit = onCommit;
    this.onInput = onInput;
    this.onNavigate = onNavigate;
    this.editing = false;
    this.changed = false;
    this.originalValue = '';

    this.nameEl = h('input', `${cssPrefix}-formula-bar-name`).attr({
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      title: 'Go to cell',
      'aria-label': 'Cell address',
    });
    this.inputEl = h('input', `${cssPrefix}-formula-bar-input`).attr({
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': 'Cell content',
    });
    this.el = h('div', `${cssPrefix}-formula-bar`)
      .children(this.nameEl, this.inputEl);

    this.nameEl.on('focus', () => this.nameEl.el.select());
    this.nameEl.on('keydown', (evt) => {
      evt.stopPropagation();
      if (evt.key === 'Enter') {
        evt.preventDefault();
        this.nameEl.el.blur();
      } else if (evt.key === 'Escape') {
        evt.preventDefault();
        this.updateAddress();
        this.nameEl.el.blur();
      }
    });
    this.nameEl.on('blur', () => this.navigateToAddress());

    this.inputEl.on('focus', () => {
      this.editing = true;
      this.changed = false;
      this.originalValue = this.inputEl.val();
    });
    this.inputEl.on('input', () => {
      this.changed = true;
      this.onInput(this.inputEl.val());
    });
    this.inputEl.on('keydown', (evt) => {
      evt.stopPropagation();
      if (evt.key === 'Enter') {
        evt.preventDefault();
        this.inputEl.el.blur();
      } else if (evt.key === 'Escape') {
        evt.preventDefault();
        this.inputEl.val(this.originalValue);
        if (this.changed) this.onInput(this.originalValue);
        this.changed = false;
        this.editing = false;
        this.inputEl.el.blur();
      }
    });
    this.inputEl.on('blur', () => {
      const nextValue = this.inputEl.val();
      const shouldCommit = this.editing && this.changed && nextValue !== this.originalValue;
      this.editing = false;
      this.changed = false;
      if (shouldCommit) this.onCommit(nextValue);
    });

    this.resetData(data);
  }

  resetData(data) {
    this.data = data;
    const readOnly = data.settings.mode === 'read';
    this.inputEl.attr('readonly', readOnly ? 'readonly' : null);
    if (!readOnly) this.inputEl.removeAttr('readonly');
    this.update();
  }

  updateAddress() {
    const { ri, ci } = this.data.selector;
    this.nameEl.val(ri >= 0 && ci >= 0 ? xy2expr(ci, ri) : '');
  }

  navigateToAddress() {
    const address = this.nameEl.val().trim().toUpperCase();
    if (!/^[A-Z]+[1-9]\d*$/.test(address)) {
      this.updateAddress();
      return;
    }
    const [ci, ri] = expr2xy(address);
    if (ri < 0 || ci < 0 || ri >= this.data.rows.len || ci >= this.data.cols.len) {
      this.updateAddress();
      return;
    }
    this.onNavigate(ri, ci);
  }

  update(text) {
    const { ri, ci } = this.data.selector;
    this.nameEl.val(ri >= 0 && ci >= 0 ? xy2expr(ci, ri) : '');
    if (!this.editing) {
      const cell = this.data.getSelectedCell();
      this.inputEl.val(text !== undefined ? text : ((cell && cell.text) || ''));
    }
    const editable = ri >= 0 && ci >= 0 && this.data.canEditCell(ri, ci);
    this.inputEl.disabled(!editable || this.data.settings.mode === 'read');
  }
}
