// Password form for presenter or viewer access to one deck.
import { t, el, api, slugFromPath, setTitle, brand } from './shell.js';

const slug = slugFromPath();
const as = new URLSearchParams(location.search).get('as') === 'presenter' ? 'presenter' : 'viewer';
const target = as === 'presenter' ? `/${slug}/present` : `/${slug}/view`;
const app = document.getElementById('app');
const roleName = t(as);
setTitle(roleName);

const input = el('input', { type: 'password', name: 'password', id: 'password', autocomplete: 'current-password', required: true, autofocus: true });
const error = el('p.form-error', { role: 'alert', hidden: true });
const button = el('button.primary', { type: 'submit' }, t('signIn'));
const form = el('form.card.login-form', {},
  el('h1', {}, t(as === 'presenter' ? 'signInPresenter' : 'signInViewer')),
  el('label', { htmlFor: 'password' }, t('password')),
  input, error, button);
app.append(brand(), form);

function showError(text) {
  error.textContent = text;
  error.hidden = false;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  button.disabled = true;
  error.hidden = true;
  const res = await api('/api/login', { method: 'POST', body: { scope: as, deck: slug, password: input.value } });
  button.disabled = false;
  if (res.status === 204) {
    location.replace(target);
  } else if (res.status === 401) {
    showError(t('wrongPassword'));
    input.select();
  } else if (res.status === 409) {
    if (as === 'viewer') location.replace(target);
    else showError(t('noPasswordPresenter'));
  } else if (res.status === 429) {
    showError(t('tooMany'));
  } else {
    showError(t('error', { code: res.status }));
  }
});
