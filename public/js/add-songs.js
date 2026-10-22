document.addEventListener('DOMContentLoaded', () => {
  const token = localStorage.getItem('oilnwine_token');
  if (!token) { window.location.replace('/login'); return; }
  const $ = id => document.getElementById(id);
  const alertBox = $('songs-alert');
  let tags = [];
  let selectedTag = '';
  let canAdd = false;
  let songSearchTimer;
  let masterSearchTimer;
  let songs = [];
  let masterPage = 1;
  let masterHasMore = false;
  let masterRequestId = 0;
  let masterLoading = false;
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
  function showMessage(message, success = false) {
    alertBox.textContent = message;
    alertBox.classList.toggle('success', success);
    alertBox.classList.remove('hidden');
    window.setTimeout(() => alertBox.classList.add('hidden'), 5000);
  }
  function languageFor(tag) {
    const known = ['English', 'Malayalam', 'Tamil', 'Hindi', 'Telugu', 'Nagamese'];
    return known.find(language => language.toLowerCase() === tag.toLowerCase()) || 'Other';
  }
  function updateTagSelectors() {
    for (const select of [$('manual-tag'), $('master-tag')]) {
      select.replaceChildren(...tags.map(tag => {
        const option = document.createElement('option');
        option.value = tag.name;
        option.textContent = tag.name;
        option.selected = tag.name === selectedTag;
        return option;
      }));
    }
    $('dialog-tag-name').textContent = selectedTag;
    $('manual-form').elements.language.value = languageFor(selectedTag);
  }
  function syncDialogTagHeading() {
    const manualActive = document.querySelector('.add-tab.active')?.dataset.panel === 'manual-panel';
    $('dialog-tag-name').textContent = manualActive ? $('manual-tag').value : $('master-tag').value;
  }
  function renderTags() {
    const counts = new Map();
    for (const song of songs) counts.set(String(song.songbook_tag || ''), (counts.get(String(song.songbook_tag || '')) || 0) + 1);
    $('tag-list').replaceChildren(...tags.map(tag => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `tag-button${tag.name === selectedTag ? ' active' : ''}`;
      button.innerHTML = `<span>${escapeHtml(tag.name)}</span><span class="tag-count">${counts.get(tag.name) || 0}</span>`;
      button.addEventListener('click', () => selectTag(tag.name));
      return button;
    }));
  }
  function renderSongs() {
    const query = $('song-search').value.trim().toLowerCase();
    const visible = songs.filter(song => String(song.songbook_tag || '').toLowerCase() === selectedTag.toLowerCase())
      .filter(song => !query || `${song.title} ${song.alternate_title || ''} ${song.language || ''}`.toLowerCase().includes(query));
    $('selected-tag').textContent = selectedTag;
    $('song-count').textContent = `${visible.length} song${visible.length === 1 ? '' : 's'}`;
    if (!visible.length) {
      $('song-list').innerHTML = `<p class="muted">${query ? 'No songs match your search.' : 'This songbook is empty. Add a song manually or import one from the master catalog.'}</p>`;
      return;
    }
    $('song-list').innerHTML = visible.map(song => `<article class="song-row"><div class="song-main"><span class="song-title">${escapeHtml(song.title)}</span><span class="song-meta">${escapeHtml(song.language || selectedTag)}${song.alternate_title ? ` · ${escapeHtml(song.alternate_title)}` : ''}</span></div><span class="song-number">${escapeHtml(song.song_number)}</span></article>`).join('');
  }
  async function loadSongbook() {
    $('song-list').innerHTML = '<p class="muted">Loading songs…</p>';
    try {
      const data = await apiFetch('/api/songs');
      songs = data.songs || [];
      renderTags();
      renderSongs();
    } catch (error) { $('song-list').innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`; }
  }
  function selectTag(name) {
    selectedTag = name;
    updateTagSelectors();
    renderTags();
    loadSongbook();
  }
  async function loadMasterCatalog(reset = true) {
    if (masterLoading && !reset) return;
    if (reset) {
      masterPage = 1;
      masterHasMore = false;
      $('master-list').innerHTML = '';
    }
    masterLoading = true;
    const requestId = ++masterRequestId;
    const query = $('master-search').value.trim();
    if (reset) $('master-list').innerHTML = '<p class="muted">Loading master catalog…</p>';
    else $('master-list').querySelector('#master-load-more')?.replaceWith(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Loading more songs…' }));
    try {
      const data = await apiFetch(`/api/master-songs?q=${encodeURIComponent(query)}&page=${masterPage}&limit=100`);
      if (requestId !== masterRequestId) return;
      const found = data.songs || [];
      if (!found.length && reset) { $('master-list').innerHTML = `<p class="muted">${query ? 'No master songs match your search.' : 'The master catalog is empty.'}</p>`; return; }
      if (reset) $('master-list').replaceChildren();
      const rows = found.map(song => {
        const row = document.createElement('article');
        row.className = 'master-row';
        row.innerHTML = `<div class="song-main"><span class="song-title">${escapeHtml(song.title)}</span><span class="song-meta">${escapeHtml(song.language || 'Other')}${song.alternate_title ? ` · ${escapeHtml(song.alternate_title)}` : ''}</span></div><button type="button" data-master-id="${Number(song.id)}">Add to ${escapeHtml($('master-tag').value)}</button>`;
        row.querySelector('[data-master-id]').addEventListener('click', event => importMasterSong(event.currentTarget));
        return row;
      });
      $('master-list').append(...rows);
      masterHasMore = found.length === 100;
      masterPage += 1;
      if (masterHasMore) {
        const more = document.createElement('button');
        more.type = 'button';
        more.id = 'master-load-more';
        more.className = 'master-load-more';
        more.textContent = 'Load more songs';
        more.addEventListener('click', () => loadMasterCatalog(false));
        $('master-list').append(more);
      }
      if (!found.length && !reset) $('master-list').querySelector('.muted')?.remove();
    } catch (error) {
      if (requestId === masterRequestId) $('master-list').innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
    } finally {
      if (requestId === masterRequestId) masterLoading = false;
    }
  }
  async function importMasterSong(button) {
    button.disabled = true;
    button.textContent = 'Adding…';
    try {
      const data = await apiFetch('/api/songbook/import', { method: 'POST', body: { masterSongId: Number(button.dataset.masterId), language: languageFor($('master-tag').value), songbookTag: $('master-tag').value } });
      $('add-dialog').close();
      selectTag($('master-tag').value);
      showMessage(`${data.song.title} added to ${data.song.songbook_tag} as song ${data.song.song_number}.`, true);
    } catch (error) { button.disabled = false; button.textContent = `Add to ${$('master-tag').value}`; showMessage(error.message); }
  }

  async function init() {
    try {
      const { user } = await apiFetch('/api/auth/me');
      const org = user.activeOrganization || (user.organizations || []).find(item => Number(item.id) === Number(user.activeOrganizationId));
      if (!org) throw new Error('Select an organisation before opening its songbooks.');
      document.title = `Songbooks | ${org.name}`;
      $('org-name').textContent = org.name;
      $('org-brand').textContent = org.name;
      if (org.logoData) $('org-logo').src = org.logoData;
      document.documentElement.style.setProperty('--blue', org.brandColor || '#285cf4');
      $('user-name').textContent = user.username;
      $('user-avatar').textContent = user.username.slice(0, 1).toUpperCase();
      const group = (user.groups || []).find(item => Number(item.id) === Number(user.activeGroupId));
      canAdd = Boolean(user.isMasterAdmin || user.isOrgAdmin || group?.role === 'group_admin' || group?.canAddSongs);
      $('open-add').classList.toggle('hidden', !canAdd);
      const tagData = await apiFetch('/api/songbook/tags');
      tags = tagData.tags || [];
      if (!tags.length) throw new Error('This organisation does not have any songbook tags yet. Ask an admin to create one in Settings & tags.');
      selectedTag = tags[0].name;
      updateTagSelectors();
      renderTags();
      await loadSongbook();
      if (new URLSearchParams(location.search).get('view') !== 'songbooks' && canAdd) $('add-dialog').showModal();
    } catch (error) { showMessage(error.message); }
  }
  $('open-add').addEventListener('click', () => { updateTagSelectors(); $('add-dialog').showModal(); });
  $('close-dialog').addEventListener('click', () => $('add-dialog').close());
  $('add-dialog').addEventListener('click', event => { if (event.target === $('add-dialog')) $('add-dialog').close(); });
  document.querySelectorAll('.add-tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.add-tab').forEach(item => item.classList.toggle('active', item === tab));
    document.querySelectorAll('.add-panel').forEach(panel => panel.classList.toggle('hidden', panel.id !== tab.dataset.panel));
    syncDialogTagHeading();
    if (tab.dataset.panel === 'master-panel') loadMasterCatalog();
  }));
  $('manual-tag').addEventListener('change', () => { syncDialogTagHeading(); $('manual-form').elements.language.value = languageFor($('manual-tag').value); });
  $('master-tag').addEventListener('change', () => { syncDialogTagHeading(); loadMasterCatalog(); });
  $('song-search').addEventListener('input', () => { clearTimeout(songSearchTimer); songSearchTimer = setTimeout(renderSongs, 120); });
  $('master-search').addEventListener('input', () => { clearTimeout(masterSearchTimer); masterSearchTimer = setTimeout(() => loadMasterCatalog(true), 300); });
  $('manual-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    body.songbook_tag = $('manual-tag').value;
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.textContent = 'Adding…';
    try {
      const data = await apiFetch('/api/songs', { method: 'POST', body });
      const tag = data.song.songbook_tag;
      event.currentTarget.reset();
      $('add-dialog').close();
      selectTag(tag);
      showMessage(`${data.song.title} added to ${tag} as song ${data.song.song_number}.`, true);
    } catch (error) { showMessage(error.message); }
    finally { submit.disabled = false; submit.textContent = 'Add to songbook'; }
  });
  init();
});
