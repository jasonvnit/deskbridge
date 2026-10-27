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

/**
 * Shows a full-screen status message, optionally with one action button
 * (`action: { label, onClick }`). Pass a falsy message to hide it.
 */
export function setStatus(message, { error = false, action = null } = {}) {
  const overlay = document.getElementById('status-overlay');
  const button = document.getElementById('status-action');
  button.onclick = null;
  button.hidden = true;
  if (!message) {
    overlay.hidden = true;
    return;
  }
  document.getElementById('status-text').textContent = message;
  overlay.classList.toggle('error', error);
  if (action) {
    button.textContent = action.label;
    button.onclick = action.onClick;
    button.hidden = false;
  }
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

/**
 * Set before opening something that steals focus on purpose (file picker,
 * clipboard permission prompt) so it does not pause the session.
 */
export const focusGuard = { expected: false };
