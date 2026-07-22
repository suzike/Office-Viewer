/* global document */
import { h } from './element';
import { bind } from './event';
import { cssPrefix } from '../config';

export function hideTooltip() {
  document.querySelectorAll(`.${cssPrefix}-tooltip`).forEach(el => el.remove());
}

export function shouldShowToolbarTooltip(evt, btnEl) {
  const el = btnEl.el || btnEl;
  if (evt.target.closest(`.${cssPrefix}-dropdown-content`)) {
    return false;
  }
  const topDropdown = el.querySelector(`:scope > .${cssPrefix}-dropdown`);
  const targetDropdown = evt.target.closest(`.${cssPrefix}-dropdown`);
  if (topDropdown && targetDropdown && targetDropdown !== topDropdown) {
    return false;
  }
  for (const panel of el.querySelectorAll(`.${cssPrefix}-dropdown-content`)) {
    if (panel.style.display === 'block') {
      return false;
    }
  }
  return true;
}

export default function tooltip(html, target) {
  hideTooltip();
  const {
    left, top, width, height,
  } = target.getBoundingClientRect();
  const el = h('div', `${cssPrefix}-tooltip`).html(html).show();
  document.body.appendChild(el.el);
  const elBox = el.box();
  // console.log('elBox:', elBox);
  el.css('left', `${left + (width / 2) - (elBox.width / 2)}px`)
    .css('top', `${top + height + 2}px`);

  bind(target, 'mouseleave', () => {
    if (document.body.contains(el.el)) {
      document.body.removeChild(el.el);
    }
  });

  bind(target, 'click', () => {
    if (document.body.contains(el.el)) {
      document.body.removeChild(el.el);
    }
  });
}
