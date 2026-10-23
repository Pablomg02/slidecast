// Admin sign-in (scope "admin").
import { t, el, api, setTitle } from './shell.js';

setTitle(t('admin'));
const app = document.getElementById('app');
const input = el('input', { type: 'password', id: 'password', autocomplete: 'current-password', required: true, autofocus: true });
const error = el('p.form-error', { role: 'alert', hidden: true });
const button = el('button.primary', { type: 'submit' }, t('signIn'));
const form = el('form.card.login-form', {},
  el('h1', {}, t('signInAdmin')),
  el('label', { htmlFor: 'password' }, t('password')), input, error, button);
app.append(form);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  button.disabled = true;
  const res = await api('/api/login', { method: 'POST', body: { scope: 'admin', password: input.value } });
  button.disabled = false;
  const fail = {
    401: t('wrongPassword'),
    409: t('noPasswordAdmin'),
    429: t('tooMany'),
  };
  if (res.status === 204) {
    location.reload();
    return;
  }
  error.textContent = fail[res.status] ?? t('error', { code: res.status });
  error.hidden = false;
  input.select();
});
