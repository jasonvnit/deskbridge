let toastTimer = 0;

export function toast(message, { error = false, duration = 2200 } = {}) {
  const element = document.getElementById('toast');
  element.textContent = message;
  element.classList.toggle('error', error);
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.hidden = true;
  }, duration);
}

export function setStatus(message, { error = false } = {}) {
  const overlay = document.getElementById('status-overlay');
  if (!message) {
    overlay.hidden = true;
    return;
  }
  document.getElementById('status-text').textContent = message;
  overlay.classList.toggle('error', error);
  overlay.hidden = false;
}

export function setConnectionState(state) {
  const dot = document.getElementById('conn-dot');
  dot.classList.toggle('ok', state === 'ok');
  dot.classList.toggle('bad', state === 'bad');
}

const panels = ['panel-clipboard', 'panel-settings'];

export function togglePanel(id, force) {
  const panel = document.getElementById(id);
  const show = force ?? panel.hidden;
  for (const other of panels) {
    if (other !== id) document.getElementById(other).hidden = true;
  }
  panel.hidden = !show;
  return show;
}

export function closePanels() {
  for (const id of panels) document.getElementById(id).hidden = true;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
