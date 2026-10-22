document.addEventListener('DOMContentLoaded', () => {
  const token = localStorage.getItem('oilnwine_token');
  if (!token) { location.replace('/login'); return; }
  const $ = id => document.getElementById(id);
  const alertBox = $('settings-alert');
  let user;
  let clearLogo = false;
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
  const apiFetch = async (url, options = {}) => {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(url, { ...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  };
  function message(target, text, isError = false) { target.textContent = text; target.style.color = isError ? '#a3322c' : ''; }
  function renderTags(tags) { $('tag-list').innerHTML = tags.map(tag => `<span class="settings-tag">${escapeHtml(tag.name)}</span>`).join('') || '<span class="muted">No tags are configured.</span>'; }
  async function loadTags() { const data = await apiFetch('/api/songbook/tags'); renderTags(data.tags || []); }
  async function init() {
    try {
      const result = await apiFetch('/api/auth/me');
      user = result.user;
      if (!user.isOrgAdmin && !user.isMasterAdmin) { location.replace('/'); return; }
      const org = user.activeOrganization || (user.organizations || []).find(item => Number(item.id) === Number(user.activeOrganizationId));
      if (!org) throw new Error('No active organisation is selected.');
      document.title = `Settings | ${org.name}`;
      $('org-name').textContent = org.name;
      $('org-brand').textContent = org.name;
      $('user-name').textContent = user.username;
      $('user-avatar').textContent = user.username.slice(0, 1).toUpperCase();
      if (org.logoData) { $('org-logo').src = org.logoData; $('logo-preview').src = org.logoData; $('logo-preview').classList.remove('hidden'); }
      document.documentElement.style.setProperty('--blue', org.brandColor || '#285cf4');
      $('setting-name').value = org.name || '';
      $('setting-welcome').value = org.welcomeText || '';
      $('setting-color').value = org.brandColor || '#285cf4';
      await loadTags();
    } catch (error) { alertBox.textContent = error.message; alertBox.classList.remove('hidden'); }
  }
  $('setting-logo').addEventListener('change', () => {
    const file = $('setting-logo').files[0];
    if (!file) return;
    if (file.size > 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      message($('identity-message'), 'Choose a PNG, JPG, WEBP, or GIF logo smaller than 1 MB.', true); $('setting-logo').value = ''; return;
    }
    $('logo-preview').src = URL.createObjectURL(file);
    $('logo-preview').classList.remove('hidden');
    clearLogo = false;
  });
  $('clear-logo').addEventListener('click', () => { clearLogo = true; $('setting-logo').value = ''; $('logo-preview').removeAttribute('src'); $('logo-preview').classList.add('hidden'); });
  $('identity-form').addEventListener('submit', async event => {
    event.preventDefault();
    const org = user?.activeOrganization || (user?.organizations || []).find(item => Number(item.id) === Number(user.activeOrganizationId));
    const button = event.currentTarget.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const file = $('setting-logo').files[0];
      let logoData;
      if (file) logoData = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('Could not read the selected logo.')); reader.readAsDataURL(file); });
      const body = { name: $('setting-name').value.trim(), welcomeText: $('setting-welcome').value.trim(), brandColor: $('setting-color').value };
      if (logoData !== undefined) body.logoData = logoData; else if (clearLogo) body.logoData = null;
      const result = await apiFetch(`/api/organizations/${org.id}/settings`, { method: 'PUT', body });
      user.activeOrganization = result.organization;
      message($('identity-message'), 'Organisation identity saved.');
      clearLogo = false; $('setting-logo').value = '';
      $('org-name').textContent = result.organization.name; $('org-brand').textContent = result.organization.name;
      $('org-logo').src = result.organization.logoData || '/assets/songs-of-overcomer-mark.svg';
      if (result.organization.logoData) { $('logo-preview').src = result.organization.logoData; $('logo-preview').classList.remove('hidden'); }
      else $('logo-preview').classList.add('hidden');
    } catch (error) { message($('identity-message'), error.message, true); }
    finally { button.disabled = false; }
  });
  $('tag-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const result = await apiFetch('/api/songbook/tags', { method: 'POST', body: { name: $('tag-name').value.trim() } });
      renderTags(result.tags || []); $('tag-name').value = ''; message($('tag-message'), 'Tag added. Song numbers start separately for this songbook.');
    } catch (error) { message($('tag-message'), error.message, true); }
    finally { button.disabled = false; }
  });
  init();
});
