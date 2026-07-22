import helper from './helper';

class Cols {
  constructor({
    len, width, indexWidth, minWidth,
  }) {
    this._ = {};
    this.len = len;
    this.baseWidth = width;
    this.baseIndexWidth = indexWidth;
    this.baseMinWidth = minWidth;
    this.zoomScale = 1;
  }

  get width() {
    return Math.max(1, Math.round(this.baseWidth * this.zoomScale));
  }

  set width(v) {
    this.baseWidth = v;
  }

  get indexWidth() {
    return Math.max(1, Math.round(this.baseIndexWidth * this.zoomScale));
  }

  set indexWidth(v) {
    this.baseIndexWidth = v;
  }

  get minWidth() {
    return Math.max(1, Math.round(this.baseMinWidth * this.zoomScale));
  }

  set minWidth(v) {
    this.baseMinWidth = v;
  }

  setZoomScale(scale) {
    this.zoomScale = scale;
  }

  setData(d) {
    if (d.len != null) {
      this.len = d.len;
      delete d.len;
    }
    this._ = d;
  }

  getData() {
    const { len } = this;
    return Object.assign({ len }, this._);
  }

  getWidth(i) {
    if (this.isHide(i)) return 0;
    const col = this._[i];
    if (col && col.width) {
      return Math.max(1, Math.round(col.width * this.zoomScale));
    }
    return this.width;
  }

  getOrNew(ci) {
    this._[ci] = this._[ci] || {};
    return this._[ci];
  }

  setWidth(ci, width) {
    const col = this.getOrNew(ci);
    col.width = Math.max(1, Math.round(width / this.zoomScale));
  }

  unhide(idx) {
    let index = idx;
    while (index > 0) {
      index -= 1;
      if (this.isHide(index)) {
        this.setHide(index, false);
      } else break;
    }
  }

  isHide(ci) {
    const col = this._[ci];
    return col && col.hide;
  }

  setHide(ci, v) {
    const col = this.getOrNew(ci);
    if (v === true) col.hide = true;
    else delete col.hide;
  }

  setStyle(ci, style) {
    const col = this.getOrNew(ci);
    col.style = style;
  }

  sumWidth(min, max) {
    return helper.rangeSum(min, max, i => this.getWidth(i));
  }

  totalWidth() {
    return this.sumWidth(0, this.len);
  }
}

export default {};
export {
  Cols,
};
