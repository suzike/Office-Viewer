import { h } from './element';
import { cssPrefix } from '../config';
import { sheetImageDataUrl } from '../../excel_images';
import { mouseMoveUp } from './event';

const RESIZE_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const MIN_IMAGE_SIZE = 8;

function anchorUsesExtSize(anchor) {
  return anchor.width != null || anchor.height != null
    || (anchor.brCol == null && anchor.brRow == null);
}

function applyAnchorRect(data, anchor, l, t, widthPx, heightPx) {
  const zoom = data.getZoomScale();
  const tl = data.getFractionalCellFromSheetXY(l, t);
  anchor.col = tl.col;
  anchor.row = tl.row;
  if (anchorUsesExtSize(anchor)) {
    anchor.width = widthPx / zoom;
    anchor.height = heightPx / zoom;
    delete anchor.brCol;
    delete anchor.brRow;
  } else {
    const br = data.getFractionalCellFromSheetXY(l + widthPx, t + heightPx);
    anchor.brCol = br.col;
    anchor.brRow = br.row;
    delete anchor.width;
    delete anchor.height;
  }
}

function resizeRect(l, t, w, h, dx, dy, dir) {
  let nl = l;
  let nt = t;
  let nw = w;
  let nh = h;
  if (dir.includes('e')) nw = w + dx;
  if (dir.includes('w')) {
    nw = w - dx;
    nl = l + dx;
  }
  if (dir.includes('s')) nh = h + dy;
  if (dir.includes('n')) {
    nh = h - dy;
    nt = t + dy;
  }
  if (nw < MIN_IMAGE_SIZE) {
    if (dir.includes('w')) nl -= MIN_IMAGE_SIZE - nw;
    nw = MIN_IMAGE_SIZE;
  }
  if (nh < MIN_IMAGE_SIZE) {
    if (dir.includes('n')) nt -= MIN_IMAGE_SIZE - nh;
    nh = MIN_IMAGE_SIZE;
  }
  return { l: nl, t: nt, w: nw, h: nh };
}

function getResizeDirection(target) {
  if (!target || !target.classList) return null;
  const prefix = `${cssPrefix}-sheet-image-handle-`;
  for (let i = 0; i < target.classList.length; i += 1) {
    const cls = target.classList[i];
    if (cls.startsWith(prefix)) {
      return cls.slice(prefix.length);
    }
  }
  return null;
}

export default class SheetImages {
  constructor() {
    this.el = h('div', `${cssPrefix}-sheet-images`);
    this.items = [];
    this.data = null;
    this.editable = false;
    this.onChange = null;
    this.selectedIndex = -1;
  }

  setEditable(editable) {
    this.editable = editable;
    this.el.active(editable, 'editable');
  }

  setOnChange(fn) {
    this.onChange = fn;
  }

  clearSelection() {
    if (this.selectedIndex < 0) return;
    const prev = this.items[this.selectedIndex];
    if (prev) {
      prev.wrapEl.removeClass('selected');
      prev.wrapEl.removeClass('dragging');
      prev.wrapEl.removeClass('resizing');
    }
    this.selectedIndex = -1;
    this.updatePositions();
  }

  select(index) {
    if (index === this.selectedIndex) return;
    this.clearSelection();
    if (index < 0 || index >= this.items.length) return;
    this.selectedIndex = index;
    this.items[index].wrapEl.addClass('selected');
    this.updatePositions();
  }

  reset(data) {
    this.data = data;
    this.el.html('');
    this.items = [];
    this.selectedIndex = -1;
    const images = data.images || [];
    for (let i = 0; i < images.length; i += 1) {
      const image = images[i];
      const wrapEl = h('div', `${cssPrefix}-sheet-image-item`);
      const imgEl = h('img')
        .attr('src', sheetImageDataUrl(image))
        .attr('draggable', 'false')
        .attr('alt', '');
      wrapEl.child(imgEl);
      if (this.editable) {
        for (let hi = 0; hi < RESIZE_HANDLES.length; hi += 1) {
          const dir = RESIZE_HANDLES[hi];
          wrapEl.child(h('div', `${cssPrefix}-sheet-image-handle ${cssPrefix}-sheet-image-handle-${dir}`));
        }
        wrapEl.on('mousedown', (evt) => {
          const dir = getResizeDirection(evt.target);
          if (dir) {
            this.onResizeMouseDown(evt, i, dir);
          } else {
            this.onMoveMouseDown(evt, i);
          }
        });
      }
      this.el.child(wrapEl);
      this.items.push({ wrapEl, imgEl, anchor: image.anchor });
    }
    this.updatePositions();
  }

  onMoveMouseDown(evt, index) {
    if (!this.editable || evt.button !== 0) return;
    evt.stopPropagation();
    evt.preventDefault();

    const item = this.items[index];
    const { data } = this;
    const startRect = data.getImageDisplayRect(item.anchor);
    const startX = evt.clientX;
    const startY = evt.clientY;
    let moved = false;

    this.select(index);
    item.wrapEl.addClass('dragging');

    mouseMoveUp(window, (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      moved = true;
      applyAnchorRect(
        data,
        item.anchor,
        startRect.l + dx,
        startRect.t + dy,
        startRect.width,
        startRect.height,
      );
      this.updatePositions();
    }, () => {
      item.wrapEl.removeClass('dragging');
      if (moved && this.onChange) {
        this.onChange();
      }
    });
  }

  onResizeMouseDown(evt, index, dir) {
    if (!this.editable || evt.button !== 0) return;
    evt.stopPropagation();
    evt.preventDefault();

    const item = this.items[index];
    const { data } = this;
    const startRect = data.getImageDisplayRect(item.anchor);
    const startX = evt.clientX;
    const startY = evt.clientY;
    let resized = false;

    this.select(index);
    item.wrapEl.addClass('resizing');

    mouseMoveUp(window, (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!resized && Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      resized = true;
      const next = resizeRect(
        startRect.l,
        startRect.t,
        startRect.width,
        startRect.height,
        dx,
        dy,
        dir,
      );
      applyAnchorRect(data, item.anchor, next.l, next.t, next.w, next.h);
      this.updatePositions();
    }, () => {
      item.wrapEl.removeClass('resizing');
      if (resized && this.onChange) {
        this.onChange();
      }
    });
  }

  updatePositions(data = this.data) {
    if (!data) return;
    this.data = data;
    for (let i = 0; i < this.items.length; i += 1) {
      const { wrapEl, anchor } = this.items[i];
      const rect = data.getImageDisplayRect(anchor);
      if (rect.width <= 0 || rect.height <= 0) {
        wrapEl.hide();
        continue;
      }
      const zIndex = (i === this.selectedIndex) ? 2 : 1;
      wrapEl.show().css({
        position: 'absolute',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        zIndex: `${zIndex}`,
      });
    }
  }
}
