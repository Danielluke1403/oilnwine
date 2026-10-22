document.addEventListener('DOMContentLoaded', () => {
  const token = localStorage.getItem('oilnwine_token');
  if (!token) { window.location.replace('/login'); return; }
  const apiFetch = async (url, options = {}) => {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(url, { ...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  };

  const groupList = document.getElementById('group-list');
  const membersContent = document.getElementById('members-content');
  const emptyMembers = document.getElementById('empty-members');
  const memberList = document.getElementById('member-list');
  const addForm = document.getElementById('form-add-member');
  const alertBox = document.getElementById('groups-alert');
  let user = null;
  let groups = [];
  let selectedGroupId = null;
  let isOrgAdmin = false;

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const error = message => {
    alertBox.textContent = message;
    alertBox.classList.remove('hidden');
    setTimeout(() => alertBox.classList.add('hidden'), 5000);
  };

  async function loadMembers(groupId) {
    selectedGroupId = Number(groupId);
    const group = groups.find(item => Number(item.id) === selectedGroupId);
    if (!group) return;
    document.querySelectorAll('.group-option').forEach(button => button.classList.toggle('active', Number(button.dataset.id) === selectedGroupId));
    emptyMembers.classList.add('hidden');
    membersContent.classList.remove('hidden');
    document.getElementById('form-rename-group').classList.add('hidden');
    document.getElementById('confirm-delete-group').classList.add('hidden');
    document.getElementById('selected-group-title').textContent = group.name;
    document.getElementById('selected-group-note').textContent = `${group.memberCount ?? 0} member${group.memberCount === 1 ? '' : 's'} · Manage access for this group.`;
    addForm.classList.add('hidden');
    memberList.innerHTML = '<p class="muted">Loading members…</p>';
    try {
      const data = await apiFetch(`/api/groups/${selectedGroupId}/members`);
      renderMembers(data.members || []);
      document.getElementById('selected-group-note').textContent = `${data.members.length} member${data.members.length === 1 ? '' : 's'} · Manage access for this group.`;
    } catch (err) { memberList.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`; }
  }

  function renderGroups() {
    document.getElementById('groups-total').textContent = `${groups.length} group${groups.length === 1 ? '' : 's'}`;
    if (!groups.length) {
      groupList.innerHTML = '<p class="muted">No groups yet. Add your first group to get started.</p>';
      return;
    }
    groupList.innerHTML = groups.map(group => `
      <div class="group-option ${Number(group.id) === selectedGroupId ? 'active' : ''}" data-id="${group.id}">
        <button type="button" class="group-select" data-id="${group.id}">
          <strong>${escapeHtml(group.name)}</strong><small>${group.memberCount ?? '…'} member${group.memberCount === 1 ? '' : 's'}</small>
        </button>
      </div>
    `).join('');
    groupList.querySelectorAll('.group-select').forEach(button => button.addEventListener('click', () => loadMembers(button.dataset.id)));
  }

  function renderMembers(members) {
    if (!members.length) {
      memberList.innerHTML = '<div class="empty-members"><span class="empty-icon">＋</span><h2>No members yet</h2><p>Add the first member to this group.</p></div>';
      return;
    }
    memberList.innerHTML = members.map(member => `
      <article class="member-row" data-user-id="${member.id}">
        <div class="member-row-top">
          <div class="member-identity"><strong>${escapeHtml(member.username)}</strong><small>${escapeHtml(member.email)}</small></div>
          <div class="member-actions">
            ${isOrgAdmin ? `<select class="member-role" aria-label="${escapeHtml(member.username)} role"><option value="member" ${member.role === 'group_admin' ? '' : 'selected'}>Member</option><option value="group_admin" ${member.role === 'group_admin' ? 'selected' : ''}>Group admin</option></select>` : `<span class="total-badge">${member.role === 'group_admin' ? 'Group admin' : 'Member'}</span>`}
            <button type="button" class="remove-member" data-user-id="${member.id}" data-name="${escapeHtml(member.username)}">Remove</button>
          </div>
        </div>
        <div class="member-permissions">
          <label><input class="perm-display" type="checkbox" ${member.canDisplay || member.role === 'group_admin' ? 'checked' : ''}> Can present</label>
          <label><input class="perm-add" type="checkbox" ${member.canAddSongs || member.role === 'group_admin' ? 'checked' : ''}> Add songs</label>
          <label><input class="perm-edit" type="checkbox" ${member.canEditSongs || member.role === 'group_admin' ? 'checked' : ''}> Edit songs</label>
        </div>
        <button type="button" class="save-permissions" data-user-id="${member.id}">Save access</button>
      </article>
    `).join('');

    memberList.querySelectorAll('.remove-member').forEach(button => button.addEventListener('click', async () => {
      if (!confirm(`Remove ${button.dataset.name} from ${groups.find(group => Number(group.id) === selectedGroupId)?.name}?`)) return;
      try {
        await apiFetch(`/api/groups/${selectedGroupId}/members/${button.dataset.userId}`, { method: 'DELETE' });
        await refreshGroups(selectedGroupId);
      } catch (err) { error(err.message); }
    }));

    memberList.querySelectorAll('.save-permissions').forEach(button => button.addEventListener('click', async () => {
      const row = button.closest('.member-row');
      const role = row.querySelector('.member-role')?.value || 'member';
      try {
        await apiFetch(`/api/groups/${selectedGroupId}/members/${button.dataset.userId}`, {
          method: 'PUT',
          body: {
            role,
            canDisplay: row.querySelector('.perm-display').checked,
            canAddSongs: row.querySelector('.perm-add').checked,
            canEditSongs: row.querySelector('.perm-edit').checked
          }
        });
        button.textContent = 'Saved';
        setTimeout(() => { if (button.isConnected) button.textContent = 'Save access'; }, 1600);
      } catch (err) { error(err.message); }
    }));
  }

  async function refreshGroups(openId = selectedGroupId) {
    const data = await apiFetch('/api/groups');
    groups = data.groups || [];
    groups = await Promise.all(groups.map(async group => {
      try {
        const roster = await apiFetch(`/api/groups/${group.id}/members`);
        return { ...group, memberCount: roster.members.length };
      } catch { return { ...group, memberCount: 0 }; }
    }));
    renderGroups();
    if (openId && groups.some(group => Number(group.id) === Number(openId))) await loadMembers(openId);
    else if (groups.length) await loadMembers(groups[0].id);
    else { membersContent.classList.add('hidden'); emptyMembers.classList.remove('hidden'); }
  }

  async function init() {
    try {
      const data = await apiFetch('/api/auth/me');
      user = data.user;
      isOrgAdmin = Boolean(user.isMasterAdmin || user.isOrgAdmin);
      const isGroupAdmin = (user.groups || []).some(group => group.role === 'group_admin');
      if (!isOrgAdmin && !isGroupAdmin) { window.location.replace('/'); return; }
      const org = user.activeOrganization;
      document.title = `Groups | ${org?.name || 'Organisation'}`;
      document.getElementById('groups-org-name').textContent = org?.name || 'Organisation';
      document.getElementById('groups-user-label').textContent = `${user.username} · ${isOrgAdmin ? 'Organisation admin' : 'Group admin'}`;
      if (org?.logoData) document.getElementById('groups-logo').src = org.logoData;
      document.getElementById('btn-add-group').classList.toggle('hidden', !isOrgAdmin);
      document.getElementById('form-new-group').classList.add('hidden');
      document.getElementById('group-management-toolbar').classList.toggle('hidden', !isOrgAdmin);
      document.getElementById('member-admin-role').classList.toggle('hidden', !isOrgAdmin);
      await refreshGroups(Number(new URLSearchParams(location.search).get('group')) || Number(user.activeGroupId) || null);
    } catch {
      localStorage.removeItem('oilnwine_token');
      localStorage.removeItem('oilnwine_user');
      window.location.replace('/login');
    }
  }

  document.getElementById('btn-add-group').addEventListener('click', () => {
    const form = document.getElementById('form-new-group');
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) document.getElementById('new-group-name').focus();
  });
  document.getElementById('form-new-group').addEventListener('submit', async event => {
    event.preventDefault();
    const input = document.getElementById('new-group-name');
    try {
      const data = await apiFetch('/api/groups', { method: 'POST', body: { name: input.value.trim() } });
      const url = new URL(window.location.href);
      url.searchParams.set('group', data.group.id);
      window.location.assign(url.href);
    } catch (err) { error(err.message); }
  });
  document.getElementById('btn-rename-group').addEventListener('click', () => {
    const group = groups.find(item => Number(item.id) === selectedGroupId);
    if (!group) return;
    document.getElementById('rename-group-name').value = group.name;
    document.getElementById('confirm-delete-group').classList.add('hidden');
    document.getElementById('form-rename-group').classList.remove('hidden');
    document.getElementById('rename-group-name').focus();
    document.getElementById('rename-group-name').select();
  });
  document.getElementById('btn-cancel-rename-group').addEventListener('click', () => document.getElementById('form-rename-group').classList.add('hidden'));
  document.getElementById('form-rename-group').addEventListener('submit', async event => {
    event.preventDefault();
    const input = document.getElementById('rename-group-name');
    const group = groups.find(item => Number(item.id) === selectedGroupId);
    if (!group || !input.value.trim()) return;
    try {
      await apiFetch(`/api/groups/${selectedGroupId}`, { method: 'PUT', body: { name: input.value.trim() } });
      await refreshGroups(selectedGroupId);
    } catch (err) { error(err.message); }
  });
  document.getElementById('btn-delete-group').addEventListener('click', () => {
    const group = groups.find(item => Number(item.id) === selectedGroupId);
    if (!group) return;
    document.getElementById('form-rename-group').classList.add('hidden');
    document.getElementById('delete-group-message').textContent = `“${group.name}” and its group-specific member assignments and presentation settings will be removed.`;
    document.getElementById('confirm-delete-group').classList.remove('hidden');
  });
  document.getElementById('btn-cancel-delete-group').addEventListener('click', () => document.getElementById('confirm-delete-group').classList.add('hidden'));
  document.getElementById('btn-confirm-delete-group').addEventListener('click', async () => {
    const group = groups.find(item => Number(item.id) === selectedGroupId);
    if (!group) return;
    const deleteButton = document.getElementById('btn-confirm-delete-group');
    deleteButton.disabled = true;
    try {
      await apiFetch(`/api/groups/${selectedGroupId}`, { method: 'DELETE' });
      const nextId = groups.find(item => Number(item.id) !== selectedGroupId)?.id || null;
      await refreshGroups(nextId);
    } catch (err) { error(err.message); }
    finally { deleteButton.disabled = false; }
  });
  document.getElementById('btn-show-add-member').addEventListener('click', () => {
    addForm.classList.toggle('hidden');
    if (!addForm.classList.contains('hidden')) document.getElementById('member-email').focus();
  });
  document.getElementById('btn-cancel-member').addEventListener('click', () => { addForm.reset(); addForm.classList.add('hidden'); });
  addForm.addEventListener('submit', async event => {
    event.preventDefault();
    const message = document.getElementById('member-form-message');
    message.textContent = '';
    const username = document.getElementById('member-username').value.trim();
    const email = document.getElementById('member-email').value.trim();
    const password = document.getElementById('member-password').value;
    const role = isOrgAdmin && document.getElementById('member-is-admin').checked ? 'group_admin' : 'member';
    try {
      await apiFetch(`/api/groups/${selectedGroupId}/members`, {
        method: 'POST',
        body: {
          username: username || undefined,
          email,
          password: password || undefined,
          role,
          canDisplay: document.getElementById('member-can-display').checked,
          canAddSongs: document.getElementById('member-can-add').checked,
          canEditSongs: document.getElementById('member-can-edit').checked
        }
      });
      addForm.reset();
      document.getElementById('member-can-display').checked = true;
      addForm.classList.add('hidden');
      await refreshGroups(selectedGroupId);
    } catch (err) { message.textContent = err.message; }
  });

  init();
});
