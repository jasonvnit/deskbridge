const form = document.getElementById('login-form');
const input = document.getElementById('password');
const submit = document.getElementById('login-submit');
const errorBox = document.getElementById('login-error');

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  submit.disabled = true;
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: input.value }),
    });
    if (response.ok) {
      location.replace('/');
      return;
    }
    const body = await response.json().catch(() => ({}));
    if (response.status === 429) {
      const minutes = Math.ceil((body.retryAfterSec ?? 60) / 60);
      showError(`Too many attempts. Try again in about ${minutes} minute(s).`);
    } else if (response.status === 401) {
      showError('Wrong password.');
      input.select();
    } else {
      showError('Sign in failed. Please try again.');
    }
  } catch {
    showError('Cannot reach the server.');
  } finally {
    submit.disabled = false;
  }
});
