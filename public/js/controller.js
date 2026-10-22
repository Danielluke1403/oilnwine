// Worship Presentation Controller for Oil & Wine Church

class WorshipController {
  constructor() {
    this.token = localStorage.getItem('oilnwine_token');
    this.historyStorageKey = this.token ? `oilnwine_session_history_${this.token}` : 'oilnwine_session_history';
    // History is per page session: clear it on refresh, then record new song changes.
    localStorage.removeItem(this.historyStorageKey);
    this.currentUser = null;
    this.currentGroupId = null;
    this.groups = [];
    this.manageGroups = [];
    this.managedGroupRoster = [];
    this.ws = null;
    this.pendingWsActions = [];
    this.liveState = null;
    this.cuedSong = null; // Song in private preview deck
    this.currentSongbookTag = '';
    this.songs = [];
    this.songbookTags = [];
    this.sessionHistory = [];
    this.ignoreInitialLiveState = true;
    this.searchDebounce = null;
    this.mobileSearchDebounce = null;
    this.fontReflowDebounce = null;

    // Check Auth
    if (!this.token) {
      window.location.href = '/login';
      return;
    }

    this.init();
  }

  async init() {
    const authenticated = await this.verifyAuth();
    if (!authenticated) return;
    await this.loadSongbookTags();
    this.initWebSocket();
    this.bindDOM();
    // Songs are shared across the whole app. A group is needed to display or
    // change them, but not to browse or preview the songbook.
    if (!this.currentGroupId) this.showNoGroupMessage();
    this.loadSongs();
    this.renderHistory();
    this.bindKeyboardShortcuts();
    this.setupMobileTabs();
    const requestedAction = new URLSearchParams(window.location.search).get('open');
    if (requestedAction === 'add') document.getElementById('btn-new-song')?.click();
    if (requestedAction === 'master') document.getElementById('btn-open-master-catalog')?.click();
    if (new URLSearchParams(window.location.search).get('settings') === '1') document.getElementById('btn-open-settings')?.click();
  }

  async apiFetch(url, { method = 'GET', body, headers = {} } = {}) {
    const requestHeaders = new Headers(headers);
    if (this.token) requestHeaders.set('Authorization', `Bearer ${this.token}`);
    if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');

    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const responseText = await response.text();
    let data = {};
    try { data = responseText ? JSON.parse(responseText) : {}; }
    catch { data = { error: responseText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240) }; }
    if (!response.ok) {
      const detail = data.error || data.message || responseText.trim();
      throw new Error(detail || `${method} ${url} failed with HTTP ${response.status}. Check the server terminal for details.`);
    }
    return data;
  }

  bindLiveAction(buttonId, action) {
    document.getElementById(buttonId).addEventListener('click', () => this.sendWsAction(action));
  }

  async verifyAuth() {
    try {
      const data = await this.apiFetch('/api/auth/me');
      this.currentUser = data.user;
      this.applyOrganizationBranding();
      this.currentGroupId = Number(data.user.activeGroupId || (data.user.groups[0] && data.user.groups[0].id)) || null;
      this.groups = data.user.groups || [];
      this.manageGroups = this.groups.filter(group => group.role === 'group_admin');
      this.renderGroupSelectors();

      // Update User Name and Organisation badge in header
      const nameEl = document.getElementById('current-user-name');
      if (nameEl) {
        nameEl.textContent = `${this.currentUser.username}${this.currentUser.isMasterAdmin ? ' (Master)' : ''}`;
      }
      const orgBadge = document.getElementById('org-name-badge');
      if (orgBadge) orgBadge.classList.add('hidden');

      // Check Admin access
      const isOrgAdmin = Boolean(this.currentUser.isMasterAdmin || this.currentUser.isOrgAdmin);
      const tabGroups = document.getElementById('tab-groups');
      if (tabGroups) {
        tabGroups.classList.toggle('hidden', !isOrgAdmin);
        if (isOrgAdmin) this.loadGroupsOverview();
      }

      this.updateGroupPermissions();
      const groupAdmin = isOrgAdmin || this.currentUser.activeGroup?.role === 'group_admin';
      if (groupAdmin) {
        const btnUsers = document.getElementById('btn-open-users');
        if (btnUsers) btnUsers.style.display = 'inline-flex';
      }
      const organizationSettings = document.getElementById('org-brand-settings');
      if (organizationSettings) organizationSettings.classList.toggle('hidden', !isOrgAdmin);
      if (this.currentUser.isMasterAdmin) document.getElementById('btn-delete-cued-song').style.display = 'inline-flex';
      return true;
    } catch (e) {
      localStorage.removeItem('oilnwine_token');
      localStorage.removeItem('oilnwine_user');
      window.location.href = '/login';
      return false;
    }
  }

  applyOrganizationBranding() {
    const organization = this.currentUser?.activeOrganization;
    if (!organization) return;
    const logo = document.getElementById('org-brand-logo');
    const name = document.getElementById('org-brand-name');
    if (name) name.textContent = organization.name;
    if (logo) logo.src = organization.logoData || '/assets/songs-of-overcomer-mark.svg';
    document.title = `Controller | ${organization.name}`;
    document.documentElement.style.setProperty('--accent-primary', organization.brandColor || '#2563eb');
    document.documentElement.style.setProperty('--accent-hover', organization.brandColor || '#1d4ed8');
    const favicon = document.querySelector('link[rel="icon"]');
    if (favicon) favicon.href = organization.logoData || '/assets/songs-of-overcomer-mark.svg';
    const section = document.getElementById('org-brand-settings');
    if (!section) return;
    document.getElementById('org-setting-name').value = organization.name;
    document.getElementById('org-setting-welcome').value = organization.welcomeText || '';
    document.getElementById('org-setting-color').value = organization.brandColor || '#2563eb';
    const signInLink = document.getElementById('org-signin-link');
    signInLink.href = `/login/${encodeURIComponent(organization.slug)}`;
    signInLink.textContent = `${window.location.origin}${signInLink.href}`;
    const preview = document.getElementById('org-setting-logo-preview');
    preview.src = organization.logoData || '';
    preview.classList.toggle('hidden', !organization.logoData);
    this.clearOrganizationLogo = false;
  }

  async loadSongbookTags() {
    try {
      const data = await this.apiFetch('/api/songbook/tags');
      this.songbookTags = data.tags || [];
      this.populateSongbookTagSelects();
      this.renderSongbookTagFilters();
      const list = document.getElementById('songbook-tag-list');
      if (list) list.innerHTML = this.songbookTags.map(tag => `<span class="songbook-tag-chip">${this.escapeHtml(tag.name)}</span>`).join('');
    } catch (error) {
      console.error('Failed to load songbook tags:', error);
    }
  }

  populateSongbookTagSelects() {
    ['edit-song-tag', 'import-song-tag'].forEach(id => {
      const select = document.getElementById(id);
      if (!select) return;
      const selected = select.value;
      select.innerHTML = '<option value="" disabled>Choose a tag</option>' + this.songbookTags
        .map(tag => `<option value="${this.escapeHtml(tag.name)}">${this.escapeHtml(tag.name)}</option>`).join('');
      if (this.songbookTags.some(tag => tag.name.toLowerCase() === selected.toLowerCase())) select.value = selected;
      else select.value = this.songbookTags[0]?.name || '';
    });
  }

  renderSongbookTagFilters() {
    const container = document.getElementById('filter-pills');
    if (!container) return;
    container.innerHTML = `<button type="button" class="pill ${this.currentSongbookTag ? '' : 'active'}" data-tag="">All tags</button>` +
      this.songbookTags.map(tag => `<button type="button" class="pill ${tag.name.toLowerCase() === this.currentSongbookTag.toLowerCase() ? 'active' : ''}" data-tag="${this.escapeHtml(tag.name)}">${this.escapeHtml(tag.name)}</button>`).join('');
  }

  initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    if (!this.currentGroupId) return;
    const orgId = this.currentUser?.activeOrganizationId || 1;
    const wsUrl = `${protocol}//${window.location.host}?client=controller&orgId=${encodeURIComponent(orgId)}&groupId=${encodeURIComponent(this.currentGroupId)}`;

    this.ws = new WebSocket(wsUrl);
    const connection = this.ws;

    this.ws.onopen = () => {
      console.log('Controller connected to WebSocket server');
      const queuedActions = this.pendingWsActions.splice(0);
      queuedActions.forEach(message => {
        if (this.ws === connection && connection.readyState === WebSocket.OPEN) connection.send(message);
      });
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'STATE_UPDATE' && msg.state) {
          this.handleLiveStateUpdate(msg.state);
        }
      } catch (err) {
        console.error('Error handling WebSocket message:', err);
      }
    };

    this.ws.onclose = () => {
      if (this.ws === connection) setTimeout(() => this.initWebSocket(), 2000);
    };
  }

  renderGroupSelectors() {
    const activeSelector = document.getElementById('group-select');
    if (!activeSelector) return;
    const activeGroup = this.groups.find(group => Number(group.id) === Number(this.currentGroupId));
    const activeLabel = document.getElementById('controller-active-group');
    if (activeLabel) activeLabel.textContent = activeGroup?.name || 'Songbook';
    activeSelector.innerHTML = '';
    this.groups.forEach(group => {
      const option = document.createElement('option');
      option.value = group.id;
      option.textContent = group.name;
      option.selected = Number(group.id) === Number(this.currentGroupId);
      activeSelector.appendChild(option);
    });
    activeSelector.hidden = this.groups.length === 0 || (this.groups.length <= 1 && !this.currentUser?.isMasterAdmin);
  }

  updateGroupPermissions() {
    const active = this.groups.find(group => Number(group.id) === Number(this.currentGroupId));
    const master = Boolean(this.currentUser?.isMasterAdmin);
    const orgAdmin = Boolean(this.currentUser?.isOrgAdmin);
    this.currentUser.activeGroup = active || this.currentUser.activeGroup;

    const groupAdmin = active?.role === 'group_admin';
    this.canDisplay = Boolean(active && (master || orgAdmin || groupAdmin || active.canDisplay));
    this.canAddSongs = Boolean(active && (master || orgAdmin || groupAdmin || active.canAddSongs));
    this.canEditSongs = Boolean(active && (master || orgAdmin || groupAdmin || active.canEditSongs));

    const newSong = document.getElementById('btn-new-song');
    if (newSong) newSong.classList.toggle('hidden', !this.canAddSongs);
    const masterCatalogBtn = document.getElementById('btn-open-master-catalog');
    if (masterCatalogBtn) masterCatalogBtn.classList.toggle('hidden', !this.canAddSongs);

    const editSongBtn = document.getElementById('btn-edit-cued-song');
    if (editSongBtn) editSongBtn.classList.toggle('hidden', !this.canEditSongs);

    const managerButton = document.getElementById('btn-open-users');
    if (managerButton) managerButton.style.display = (master || orgAdmin || (active && active.role === 'group_admin')) ? 'inline-flex' : 'none';

    ['btn-prev-slide', 'btn-next-slide', 'btn-toggle-blank', 'btn-toggle-clear', 'btn-toggle-translit', 'btn-reset-display', 'btn-open-settings'].forEach(id => {
      const button = document.getElementById(id);
      if (button) button.classList.toggle('hidden', !this.canDisplay);
    });

    const displayLink = document.getElementById('btn-open-display');
    const mobileDisplayLink = document.getElementById('mobile-open-display');
    if (displayLink) {
      const orgId = this.currentUser?.activeOrganizationId || 1;
      displayLink.href = this.currentGroupId ? `/display?orgId=${encodeURIComponent(orgId)}&groupId=${encodeURIComponent(this.currentGroupId)}` : '/display';
      displayLink.classList.toggle('hidden', !this.canDisplay);
    }
    if (mobileDisplayLink) {
      mobileDisplayLink.href = displayLink?.href || '/display';
      mobileDisplayLink.classList.toggle('hidden', !this.canDisplay);
    }
  }

  showNoGroupMessage() {
    const count = document.getElementById('results-count');
    if (count) count.textContent = 'No active group';
    document.getElementById('deck-song-title').textContent = 'No group selected';
    document.getElementById('deck-song-meta').textContent = 'The shared songbook is available. Group permissions are needed to display songs.';
  }

  async loadManagedGroups(openGroupIds = []) {
    const { groups } = await this.apiFetch('/api/groups');
    const canManageOrganization = this.currentUser.isMasterAdmin || this.currentUser.isOrgAdmin;
    this.manageGroups = canManageOrganization
      ? groups.map(group => ({ ...group, role: 'group_admin' }))
      : groups.filter(group => group.role === 'group_admin');
    this.renderGroupSelectors();

    const managed = await Promise.all(this.manageGroups.map(async group => {
      const { members } = await this.apiFetch(`/api/groups/${group.id}/members`);
      return { ...group, members };
    }));
    this.managedGroupRoster = managed;
    this.renderManagedGroups(openGroupIds);
  }

  renderManagedGroups(openGroupIds = []) {
    const list = document.getElementById('managed-groups-list');
    if (!list) return;
    const userForm = document.getElementById('form-create-user');
    const formPlaceholder = document.getElementById('member-form-placeholder');
    const canManageOrganization = this.currentUser.isMasterAdmin || this.currentUser.isOrgAdmin;
    // Keep the reusable form alive when the group list is rebuilt after a save.
    if (userForm && formPlaceholder && !formPlaceholder.contains(userForm)) formPlaceholder.before(userForm);
    if (!this.managedGroupRoster?.length) {
      const emptyMessage = canManageOrganization
        ? 'No groups yet. Create the first group above.'
        : 'You are not an admin of any groups.';
      list.innerHTML = `<h4 class="managed-groups-title">${canManageOrganization ? 'All groups' : 'Groups you administer'}</h4><div class="empty-state">${emptyMessage}</div>`;
      return;
    }

    const dragHint = canManageOrganization ? '<p class="group-drag-hint">Drag a member onto another group to add or move them.</p>' : '';
    list.innerHTML = `<h4 class="managed-groups-title">${canManageOrganization ? 'All groups' : 'Groups you administer'}</h4>${dragHint}` + this.managedGroupRoster.map(group => {
      const members = group.members.map(member => {
        const locked = member.role === 'group_admin' && !canManageOrganization;
        const access = [
          member.role === 'group_admin' ? 'Group admin' : 'Member',
          member.canDisplay ? 'Display' : '',
          member.canAddSongs ? 'Add songs' : '',
          member.canEditSongs ? 'Edit songs' : ''
        ].filter(Boolean);
        const roleEditor = canManageOrganization ? `
          <label>Group role<select class="form-select-sm member-role">
            <option value="member" ${member.role === 'member' ? 'selected' : ''}>Member</option>
            <option value="group_admin" ${member.role === 'group_admin' ? 'selected' : ''}>Group admin</option>
          </select></label>` : '';
        const targetGroups = canManageOrganization
          ? this.manageGroups.filter(target => Number(target.id) !== Number(group.id))
          : [];
        const assignmentEditor = canManageOrganization ? `
          <div class="group-assignment-editor hidden">
            <label>Destination group<select class="form-select-sm assignment-target-group" ${targetGroups.length ? '' : 'disabled'}>
              <option value="">Choose a group…</option>
              ${targetGroups.map(target => `<option value="${target.id}">${this.escapeHtml(target.name)}</option>`).join('')}
            </select></label>
            <label>Access in destination<select class="form-select-sm assignment-role"><option value="member">Member</option><option value="group_admin">Group admin</option></select></label>
            <div class="member-permission-options">
              <label><input type="checkbox" class="assignment-can-display" checked> Display</label>
              <label><input type="checkbox" class="assignment-can-add"> Add songs</label>
              <label><input type="checkbox" class="assignment-can-edit"> Edit songs</label>
            </div>
            <div class="group-member-actions">
              <button type="button" class="btn-secondary-sm btn-assign-group-member" data-mode="add" ${targetGroups.length ? '' : 'disabled'}>Add to group</button>
              <button type="button" class="btn-primary-sm btn-assign-group-member" data-mode="move" ${targetGroups.length ? '' : 'disabled'}>Move to group</button>
              <button type="button" class="btn-text-sm btn-cancel-group-assignment">Cancel</button>
            </div>
          </div>` : '';
        return `
          <li class="group-member-entry ${canManageOrganization ? 'is-draggable' : ''}" data-group-id="${group.id}" data-user-id="${member.id}" ${canManageOrganization ? 'draggable="true"' : ''}>
            <div class="group-member-line">
              <div class="group-member-identity">${canManageOrganization ? '<span class="member-drag-handle" aria-hidden="true" title="Drag to another group">⋮⋮</span>' : ''}<strong>${this.escapeHtml(member.username)}</strong><small>${this.escapeHtml(member.email)}</small></div>
              <div class="member-access-tags">${access.map(item => `<span>${item}</span>`).join('')}</div>
              ${canManageOrganization ? '<button type="button" class="btn-text-sm btn-open-group-assignment">Change groups</button>' : ''}
              <button type="button" class="btn-text-sm btn-edit-group-member" ${locked ? 'disabled' : ''}>Edit access</button>
            </div>
            <div class="group-member-editor hidden">
              ${roleEditor}
              <div class="member-permission-options">
                <label><input type="checkbox" class="member-can-display" ${member.canDisplay ? 'checked' : ''}> Display</label>
                <label><input type="checkbox" class="member-can-add" ${member.canAddSongs ? 'checked' : ''}> Add songs</label>
                <label><input type="checkbox" class="member-can-edit" ${member.canEditSongs ? 'checked' : ''}> Edit songs</label>
              </div>
              <div class="group-member-actions">
                <button type="button" class="btn-secondary-sm btn-save-group-member">Save access</button>
                <button type="button" class="btn-danger-sm btn-remove-group-member">Remove from group</button>
                <button type="button" class="btn-text-sm btn-cancel-group-member">Cancel</button>
              </div>
            </div>
            ${assignmentEditor}
          </li>`;
      }).join('');
      const expanded = openGroupIds.map(Number).includes(Number(group.id));
      return `
        <details class="managed-group-card" data-managed-group-id="${group.id}" ${expanded ? 'open' : ''}>
          <summary><span class="managed-group-heading"><strong>${this.escapeHtml(group.name)}</strong></span><span class="managed-group-chevron" aria-hidden="true">⌄</span></summary>
          <div class="managed-group-content">
            <ul class="group-member-list">${members || '<li class="empty-state">No members yet.</li>'}</ul>
            <button type="button" class="btn-add-group-member-link btn-add-group-member" data-group-id="${group.id}">+ Add member</button>
            <div class="member-add-form-slot" data-member-form-slot="${group.id}"></div>
          </div>
        </details>`;
    }).join('');
  }

  async saveGroupMember(row) {
    if (!row) return;
    const groupId = Number(row.dataset.groupId), userId = Number(row.dataset.userId);
    try {
      const group = this.managedGroupRoster.find(item => Number(item.id) === groupId);
      const member = group?.members.find(item => Number(item.id) === userId);
      const roleSelect = row.querySelector('.member-role');
      await this.apiFetch(`/api/groups/${groupId}/members/${userId}`, {
        method: 'PUT', body: {
          role: roleSelect ? roleSelect.value : member?.role,
          canDisplay: row.querySelector('.member-can-display').checked,
          canAddSongs: row.querySelector('.member-can-add').checked,
          canEditSongs: row.querySelector('.member-can-edit').checked
        }
      });
      await this.loadManagedGroups([groupId]);
    } catch (err) { alert(err.message); }
  }

  async assignGroupMember(row, mode) {
    if (!row) return;
    const sourceGroupId = Number(row.dataset.groupId);
    const targetGroupId = Number(row.querySelector('.assignment-target-group').value);
    const userId = Number(row.dataset.userId);
    if (!targetGroupId) {
      alert('Choose a destination group first.');
      return;
    }
    const group = this.managedGroupRoster.find(item => Number(item.id) === sourceGroupId);
    const member = group?.members.find(item => Number(item.id) === userId);
    const actionText = mode === 'move' ? 'move' : 'add';
    if (mode === 'move' && !confirm(`Move ${member?.username || 'this member'} out of ${group?.name || 'this group'} and into the selected group?`)) return;

    try {
      await this.apiFetch(`/api/groups/${sourceGroupId}/members/${userId}/assign`, {
        method: 'POST',
        body: {
          targetGroupId,
          mode,
          role: row.querySelector('.assignment-role').value,
          canDisplay: row.querySelector('.assignment-can-display').checked,
          canAddSongs: row.querySelector('.assignment-can-add').checked,
          canEditSongs: row.querySelector('.assignment-can-edit').checked
        }
      });
      if (mode === 'move' && Number(this.currentUser.id) === userId && Number(this.currentGroupId) === sourceGroupId) {
        window.location.reload();
        return;
      }
      await this.loadManagedGroups([sourceGroupId, targetGroupId]);
      alert(`Member ${actionText === 'move' ? 'moved' : 'added'} successfully.`);
    } catch (err) { alert(err.message); }
  }

  async removeGroupMember(row) {
    if (!row) return;
    const groupId = Number(row.dataset.groupId), userId = Number(row.dataset.userId);
    const group = this.managedGroupRoster.find(item => Number(item.id) === groupId);
    const member = group?.members.find(item => Number(item.id) === userId);
    if (!confirm(`Remove ${member?.username || 'this member'} from this group? Their account and other group memberships will remain.`)) return;
    try {
      await this.apiFetch(`/api/groups/${groupId}/members/${userId}`, { method: 'DELETE' });
      if (Number(this.currentUser.id) === userId && Number(this.currentGroupId) === groupId) {
        window.location.reload();
        return;
      }
      await this.loadManagedGroups([groupId]);
    } catch (err) { alert(err.message); }
  }

  async switchGroup(groupId) {
    if (!groupId || Number(groupId) === Number(this.currentGroupId)) return;
    try {
      await this.apiFetch('/api/auth/select-group', { method: 'POST', body: { groupId: Number(groupId) } });
      this.currentGroupId = Number(groupId);
      this.currentUser.activeGroupId = this.currentGroupId;
      this.cuedSong = null;
      this.sessionHistory = [];
      this.ignoreInitialLiveState = true;
      this.pendingWsActions = [];
      this.renderGroupSelectors();
      this.updateGroupPermissions();
      if (this.ws) this.ws.close();
      this.initWebSocket();
      this.renderDeck();
      this.renderHistory();
      await this.loadSongs();
    } catch (err) {
      alert(err.message);
      this.renderGroupSelectors();
    }
  }

  sendWsAction(action, payload = {}) {
    if (!this.canDisplay) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action, ...payload }));
    } else {
      this.pendingWsActions.push(JSON.stringify({ action, ...payload }));
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) this.initWebSocket();
    }
  }

  bindDOM() {
    document.getElementById('group-select').addEventListener('change', event => this.switchGroup(event.target.value));
    // Logout
    document.getElementById('btn-logout').addEventListener('click', async () => {
      try {
        await this.apiFetch('/api/auth/logout', { method: 'POST' });
      } catch (e) {}
      localStorage.removeItem('oilnwine_token');
      localStorage.removeItem('oilnwine_user');
      window.location.href = '/login';
    });

    // Navigation Tabs (Groups vs Songs vs History)
    const tabGroups = document.getElementById('tab-groups');
    const tabSongs = document.getElementById('tab-songs');
    const tabHistory = document.getElementById('tab-history');
    const viewGroups = document.getElementById('view-groups');
    const viewSongs = document.getElementById('view-songs');
    const viewHistory = document.getElementById('view-history');

    if (tabGroups) {
      tabGroups.addEventListener('click', () => {
        tabGroups.classList.add('active');
        tabSongs.classList.remove('active');
        tabHistory.classList.remove('active');
        viewGroups.classList.remove('hidden');
        viewSongs.classList.add('hidden');
        viewHistory.classList.add('hidden');
        this.loadGroupsOverview();
      });
    }

    tabSongs.addEventListener('click', () => {
      tabSongs.classList.add('active');
      if (tabGroups) tabGroups.classList.remove('active');
      tabHistory.classList.remove('active');
      viewSongs.classList.remove('hidden');
      if (viewGroups) viewGroups.classList.add('hidden');
      viewHistory.classList.add('hidden');
    });

    tabHistory.addEventListener('click', () => {
      tabHistory.classList.add('active');
      if (tabGroups) tabGroups.classList.remove('active');
      tabSongs.classList.remove('active');
      viewHistory.classList.remove('hidden');
      if (viewGroups) viewGroups.classList.add('hidden');
      viewSongs.classList.add('hidden');
    });

    const btnQuickAddGroup = document.getElementById('btn-quick-add-group');
    if (btnQuickAddGroup) {
      btnQuickAddGroup.addEventListener('click', () => {
        const modalUsers = document.getElementById('modal-users');
        modalUsers.classList.remove('hidden');
        document.getElementById('master-group-create').classList.remove('hidden');
        document.getElementById('new-group-name').focus();
      });
    }

    const mobileHistoryButton = document.getElementById('btn-open-mobile-history');
    const mobileHistoryPopover = document.getElementById('mobile-history-popover');
    mobileHistoryButton.addEventListener('click', () => {
      this.renderMobileHistoryPopover();
      mobileHistoryPopover.classList.toggle('hidden');
    });
    document.addEventListener('click', event => {
      if (!mobileHistoryPopover.contains(event.target) && !mobileHistoryButton.contains(event.target)) {
        mobileHistoryPopover.classList.add('hidden');
      }
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') mobileHistoryPopover.classList.add('hidden');
    });

    // Search input
    const searchInput = document.getElementById('song-search-input');
    const btnClearSearch = document.getElementById('btn-clear-search');

    searchInput.addEventListener('input', () => {
      btnClearSearch.classList.toggle('hidden', !searchInput.value);
      clearTimeout(this.searchDebounce);
      this.searchDebounce = setTimeout(() => {
        this.loadSongs(searchInput.value.trim());
      }, 200);
    });

    btnClearSearch.addEventListener('click', () => {
      searchInput.value = '';
      btnClearSearch.classList.add('hidden');
      this.loadSongs('');
    });

    // Songbook tag filters
    document.getElementById('filter-pills').addEventListener('click', event => {
      const pill = event.target.closest('button[data-tag]');
      if (!pill) return;
      this.currentSongbookTag = pill.dataset.tag;
      this.renderSongbookTagFilters();
      this.loadSongs(searchInput.value.trim());
    });

    const mobileSearch = document.getElementById('mobile-song-search');
    const mobileSearchResults = document.getElementById('mobile-song-search-results');
    mobileSearch.addEventListener('input', () => {
      clearTimeout(this.mobileSearchDebounce);
      const query = mobileSearch.value.trim();
      if (!query) {
        mobileSearchResults.classList.add('hidden');
        mobileSearchResults.replaceChildren();
        return;
      }
      this.mobileSearchDebounce = setTimeout(() => this.searchMobileSongs(query), 180);
    });
    mobileSearch.addEventListener('keydown', event => {
      if (event.key === 'Escape') mobileSearchResults.classList.add('hidden');
    });

    const livePill = document.getElementById('live-pill');
    livePill.addEventListener('click', () => this.openCurrentlyLiveSong());
    livePill.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.openCurrentlyLiveSong();
      }
    });

    // Live Action Buttons
    this.bindLiveAction('btn-prev-slide', 'PREV_SLIDE');
    this.bindLiveAction('btn-next-slide', 'NEXT_SLIDE');
    this.bindLiveAction('btn-toggle-blank', 'TOGGLE_BLANK');
    this.bindLiveAction('btn-toggle-clear', 'TOGGLE_CLEAR');
    this.bindLiveAction('btn-toggle-translit', 'TOGGLE_TRANSLIT');

    document.getElementById('btn-reset-display').addEventListener('click', () => {
      if (confirm('Clear the display screen and reset to Standby?')) {
        this.sendWsAction('RESET_DISPLAY');
      }
    });

    // Cue Go Live
    document.getElementById('btn-cue-go-live').addEventListener('click', () => {
      if (this.cuedSong) {
        this.sendWsAction('SET_SONG', { songId: this.cuedSong.id, slideIndex: 0 });
      }
    });

    // History actions
    const btnClearHist = document.getElementById('btn-clear-history');
    if (btnClearHist) {
      btnClearHist.addEventListener('click', () => {
        if (confirm('Clear the current session history?')) {
          this.sessionHistory = [];
          localStorage.removeItem(this.historyStorageKey);
          this.renderHistory();
        }
      });
    }

    // Settings Modal
    const modalSettings = document.getElementById('modal-settings');
    document.getElementById('btn-open-settings').addEventListener('click', () => {
      document.getElementById('org-brand-settings').classList.toggle('hidden', !this.currentUser?.isOrgAdmin && !this.currentUser?.isMasterAdmin);
      modalSettings.classList.remove('hidden');
      this.loadSongbookTags();
    });

    document.getElementById('form-songbook-tags').addEventListener('submit', async event => {
      event.preventDefault();
      const input = document.getElementById('songbook-tag-name');
      const message = document.getElementById('songbook-tag-message');
      try {
        const result = await this.apiFetch('/api/songbook/tags', { method: 'POST', body: { name: input.value.trim() } });
        this.songbookTags = result.tags || [];
        this.populateSongbookTagSelects();
        this.renderSongbookTagFilters();
        const list = document.getElementById('songbook-tag-list');
        list.innerHTML = this.songbookTags.map(tag => `<span class="songbook-tag-chip">${this.escapeHtml(tag.name)}</span>`).join('');
        input.value = '';
        message.textContent = 'Tag added. Song numbers will start separately for this tag.';
      } catch (error) {
        message.textContent = error.message;
      }
    });

    const logoFile = document.getElementById('org-setting-logo');
    const logoPreview = document.getElementById('org-setting-logo-preview');
    logoFile.addEventListener('change', () => {
      const file = logoFile.files[0];
      if (!file) return;
      if (file.size > 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
        document.getElementById('org-brand-settings-message').textContent = 'Choose a PNG, JPG, WEBP, or GIF logo smaller than 1 MB.';
        logoFile.value = '';
        return;
      }
      logoPreview.src = URL.createObjectURL(file);
      logoPreview.classList.remove('hidden');
      this.clearOrganizationLogo = false;
    });

    document.getElementById('btn-clear-org-logo').addEventListener('click', () => {
      this.clearOrganizationLogo = true;
      logoFile.value = '';
      logoPreview.removeAttribute('src');
      logoPreview.classList.add('hidden');
    });

    document.getElementById('form-org-brand-settings').addEventListener('submit', async (event) => {
      event.preventDefault();
      const org = this.currentUser?.activeOrganization;
      if (!org) return;
      const message = document.getElementById('org-brand-settings-message');
      const file = logoFile.files[0];
      let logoData;
      try {
        if (file) {
          logoData = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Could not read the selected logo.'));
            reader.readAsDataURL(file);
          });
        }
        const body = {
          name: document.getElementById('org-setting-name').value.trim(),
          welcomeText: document.getElementById('org-setting-welcome').value.trim(),
          brandColor: document.getElementById('org-setting-color').value
        };
        if (logoData !== undefined) body.logoData = logoData;
        else if (this.clearOrganizationLogo) body.logoData = null;
        message.textContent = 'Saving…';
        const result = await this.apiFetch(`/api/organizations/${org.id}/settings`, { method: 'PUT', body });
        this.currentUser.activeOrganization = result.organization;
        message.textContent = 'Organisation identity saved.';
        logoFile.value = '';
        this.applyOrganizationBranding();
        this.loadGroupsOverview();
      } catch (error) {
        message.textContent = error.message;
      }
    });

    // Font size slider
    const fontSlider = document.getElementById('slider-font-size');
    const fontSizeVal = document.getElementById('font-size-val');
    const mobileFontSlider = document.getElementById('mobile-font-size');
    const mobileFontSizeVal = document.getElementById('mobile-font-size-value');
    const applyFontSize = value => {
      fontSizeVal.textContent = `${value}px`;
      mobileFontSlider.value = value;
      mobileFontSizeVal.value = `${value}px`;
      mobileFontSizeVal.textContent = `${value}px`;
      this.sendWsAction('UPDATE_STYLE', { fontSize: value });
      clearTimeout(this.fontReflowDebounce);
      this.fontReflowDebounce = setTimeout(() => this.refreshCuedSongSlides(), 250);
    };
    fontSlider.addEventListener('input', () => applyFontSize(fontSlider.value));
    mobileFontSlider.addEventListener('input', () => applyFontSize(mobileFontSlider.value));

    // Font family dropdown
    const fontSelect = document.getElementById('select-font-family');
    fontSelect.addEventListener('change', () => {
      this.sendWsAction('UPDATE_STYLE', { fontFamily: fontSelect.value });
    });

    // Text Align
    const alignBtns = document.querySelectorAll('.btn-choice');
    alignBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        alignBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.sendWsAction('UPDATE_STYLE', { textAlign: btn.getAttribute('data-align') });
      });
    });

    // User Management Modal
    const modalUsers = document.getElementById('modal-users');
    const btnUsers = document.getElementById('btn-open-users');
    if (btnUsers) {
      btnUsers.addEventListener('click', async () => {
        modalUsers.classList.remove('hidden');
        const canManageOrganization = this.currentUser.isMasterAdmin || this.currentUser.isOrgAdmin;
        document.getElementById('master-group-create').classList.toggle('hidden', !canManageOrganization);
        document.getElementById('new-group-admin-option').classList.toggle('hidden', !canManageOrganization);
        try {
          await this.loadManagedGroups();
        } catch (err) { alert(err.message); }
      });
    }

    document.getElementById('form-create-group').addEventListener('submit', async event => {
      event.preventDefault();
      try {
        const result = await this.apiFetch('/api/groups', { method: 'POST', body: { name: document.getElementById('new-group-name').value.trim() } });
        document.getElementById('new-group-name').value = '';
        await this.loadManagedGroups([result.group.id]);
        alert(`Group “${result.group.name}” created. Open it and choose Add member to assign its first group admin.`);
      } catch (err) { alert(err.message); }
    });

    // Create User Form
    const userForm = document.getElementById('form-create-user');
    document.getElementById('btn-cancel-add-member').addEventListener('click', () => {
      userForm.classList.add('hidden');
      userForm.reset();
      delete userForm.dataset.groupId;
      document.getElementById('member-form-placeholder').before(userForm);
    });
    document.getElementById('managed-groups-list').addEventListener('click', event => {
      const addButton = event.target.closest('.btn-add-group-member');
      if (addButton) {
        const group = this.managedGroupRoster.find(item => Number(item.id) === Number(addButton.dataset.groupId));
        if (!group) return;
        userForm.dataset.groupId = addButton.dataset.groupId;
        document.getElementById('member-form-title').textContent = `Add a member to ${group.name}`;
        document.getElementById('new-group-admin-option').classList.toggle('hidden', !(this.currentUser.isMasterAdmin || this.currentUser.isOrgAdmin));
        document.getElementById('new-is-group-admin').checked = false;
        const formSlot = managedGroupsList.querySelector(`[data-member-form-slot="${group.id}"]`);
        if (formSlot) formSlot.appendChild(userForm);
        userForm.classList.remove('hidden');
        document.getElementById('new-email').focus({ preventScroll: true });
        return;
      }

      const saveButton = event.target.closest('.btn-save-group-member');
      if (saveButton) this.saveGroupMember(saveButton.closest('.group-member-entry'));
      const removeButton = event.target.closest('.btn-remove-group-member');
      if (removeButton) this.removeGroupMember(removeButton.closest('.group-member-entry'));
      const editButton = event.target.closest('.btn-edit-group-member');
      if (editButton) editButton.closest('.group-member-entry').querySelector('.group-member-editor').classList.remove('hidden');
      const cancelButton = event.target.closest('.btn-cancel-group-member');
      if (cancelButton) cancelButton.closest('.group-member-editor').classList.add('hidden');
      const assignmentButton = event.target.closest('.btn-open-group-assignment');
      if (assignmentButton) assignmentButton.closest('.group-member-entry').querySelector('.group-assignment-editor').classList.remove('hidden');
      const cancelAssignmentButton = event.target.closest('.btn-cancel-group-assignment');
      if (cancelAssignmentButton) cancelAssignmentButton.closest('.group-assignment-editor').classList.add('hidden');
      const assignButton = event.target.closest('.btn-assign-group-member');
      if (assignButton) this.assignGroupMember(assignButton.closest('.group-member-entry'), assignButton.dataset.mode);
    });
    const managedGroupsList = document.getElementById('managed-groups-list');
    managedGroupsList.addEventListener('dragstart', event => {
      if (!this.currentUser.isMasterAdmin && !this.currentUser.isOrgAdmin) return;
      const member = event.target.closest('.group-member-entry[draggable="true"]');
      if (!member) return;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', JSON.stringify({
        sourceGroupId: member.dataset.groupId,
        userId: member.dataset.userId
      }));
      this.draggedGroupMember = { sourceGroupId: Number(member.dataset.groupId), userId: Number(member.dataset.userId) };
      member.classList.add('is-dragging');
    });
    managedGroupsList.addEventListener('dragend', event => {
      this.draggedGroupMember = null;
      event.target.closest('.group-member-entry')?.classList.remove('is-dragging');
      managedGroupsList.querySelectorAll('.managed-group-card.drop-target').forEach(group => group.classList.remove('drop-target'));
    });
    managedGroupsList.addEventListener('dragover', event => {
      const target = event.target.closest('.managed-group-card');
      if ((!this.currentUser.isMasterAdmin && !this.currentUser.isOrgAdmin) || !target || !this.draggedGroupMember) return;
      if (this.draggedGroupMember.sourceGroupId === Number(target.dataset.managedGroupId)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      target.classList.add('drop-target');
    });
    managedGroupsList.addEventListener('dragleave', event => {
      const target = event.target.closest('.managed-group-card');
      if (target && !target.contains(event.relatedTarget)) target.classList.remove('drop-target');
    });
    managedGroupsList.addEventListener('drop', event => {
      const target = event.target.closest('.managed-group-card');
      if ((!this.currentUser.isMasterAdmin && !this.currentUser.isOrgAdmin) || !target) return;
      event.preventDefault();
      target.classList.remove('drop-target');
      try {
        const { sourceGroupId, userId } = JSON.parse(event.dataTransfer.getData('text/plain'));
        const source = this.managedGroupRoster.find(group => Number(group.id) === Number(sourceGroupId));
        const member = source?.members.find(item => Number(item.id) === Number(userId));
        const destinationId = Number(target.dataset.managedGroupId);
        const destination = this.managedGroupRoster.find(group => Number(group.id) === destinationId);
        if (!source || !member || !destination || Number(source.id) === destinationId) return;
        if (destination.members.some(item => Number(item.id) === Number(member.id))) {
          alert(`${member.username} is already in ${destination.name}.`);
          return;
        }
        const row = managedGroupsList.querySelector(`.group-member-entry[data-group-id="${source.id}"][data-user-id="${member.id}"]`);
        const editor = row?.querySelector('.group-assignment-editor');
        const select = editor?.querySelector('.assignment-target-group');
        if (!editor || !select) return;
        select.value = String(destination.id);
        editor.classList.remove('hidden');
      } catch (err) {
        console.error('Could not process group drop:', err);
      }
    });
    userForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const groupId = userForm.dataset.groupId;
      if (!groupId) return;
      const username = document.getElementById('new-username').value.trim();
      const email = document.getElementById('new-email').value.trim();
      const password = document.getElementById('new-password').value.trim();
      const role = document.getElementById('new-is-group-admin').checked ? 'group_admin' : 'member';

      try {
        await this.apiFetch(`/api/groups/${groupId}/members`, {
          method: 'POST', body: {
            username, email, password, role,
            canDisplay: document.getElementById('new-can-display').checked,
            canAddSongs: document.getElementById('new-can-add-songs').checked,
            canEditSongs: document.getElementById('new-can-edit-songs').checked
          }
        });
        alert('Member added successfully.');
        userForm.reset();
        userForm.classList.add('hidden');
        delete userForm.dataset.groupId;
        document.getElementById('member-form-placeholder').before(userForm);
        await this.loadManagedGroups([Number(groupId)]);
      } catch (err) { alert(err.message); }
    });

    document.getElementById('btn-song-history').addEventListener('click', () => this.openSongVersionHistory());
    document.querySelectorAll('[data-close="modal-song-versions"]').forEach(button => {
      button.addEventListener('click', () => document.getElementById('modal-song-versions').classList.add('hidden'));
    });

    // Song Creator / Editor
    const modalSongEditor = document.getElementById('modal-song-editor');
    document.getElementById('btn-new-song').addEventListener('click', () => {
      document.getElementById('song-editor-title').textContent = 'Add New Song';
      document.getElementById('form-song-editor').reset();
      document.getElementById('edit-song-id').value = '';
      document.getElementById('edit-song-tag').value = this.songbookTags[0]?.name || '';
      modalSongEditor.classList.remove('hidden');
    });

    document.getElementById('btn-edit-cued-song').addEventListener('click', () => {
      if (!this.cuedSong) return;
      document.getElementById('song-editor-title').textContent = 'Edit Song';
      document.getElementById('edit-song-id').value = this.cuedSong.id;
      document.getElementById('edit-song-title').value = this.cuedSong.title || '';
      document.getElementById('edit-song-alternate').value = this.cuedSong.alternate_title || '';
      document.getElementById('edit-song-lyrics').value = this.cuedSong.lyrics || '';
      document.getElementById('edit-song-translit').value = this.cuedSong.transliteration || '';
      document.getElementById('edit-song-chord').value = this.cuedSong.chord || '';
      document.getElementById('edit-song-language').value = this.cuedSong.language || this.inferSongLanguage(this.cuedSong) || '';
      document.getElementById('edit-song-tag').value = this.cuedSong.songbook_tag || this.cuedSong.language || this.songbookTags[0]?.name || '';
      modalSongEditor.classList.remove('hidden');
    });

    document.getElementById('btn-delete-cued-song').addEventListener('click', async () => {
      if (!this.cuedSong || !this.currentUser?.isMasterAdmin) return;
      const song = this.cuedSong;
      const message = `Delete "${song.title}"? This cannot be undone.${
        this.liveState && this.liveState.currentSong && this.liveState.currentSong.id === song.id
          ? ' It is currently live and will be removed from the projector.'
          : ''
      }`;
      if (!confirm(message)) return;

      try {
        await this.apiFetch(`/api/songs/${song.id}`, { method: 'DELETE' });
        this.cuedSong = null;
        this.renderDeck();
        this.loadSongs(document.getElementById('song-search-input').value.trim());
      } catch (err) {
        alert(err.message);
      }
    });

    document.getElementById('btn-insert-slide-break').addEventListener('click', () => {
      const lyricsInput = document.getElementById('edit-song-lyrics');
      const start = lyricsInput.selectionStart;
      const end = lyricsInput.selectionEnd;
      const separator = '\n\n';
      lyricsInput.value = `${lyricsInput.value.slice(0, start)}${separator}${lyricsInput.value.slice(end)}`;
      lyricsInput.focus();
      lyricsInput.setSelectionRange(start + separator.length, start + separator.length);
    });

    document.getElementById('form-song-editor').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('edit-song-id').value;
      const title = document.getElementById('edit-song-title').value.trim();
      const alternate_title = document.getElementById('edit-song-alternate').value.trim();
      const language = document.getElementById('edit-song-language').value;
      const songbook_tag = document.getElementById('edit-song-tag').value;
      const lyrics = document.getElementById('edit-song-lyrics').value.trim();
      const transliteration = document.getElementById('edit-song-translit').value.trim();
      const chord = document.getElementById('edit-song-chord').value.trim();
      const method = id ? 'PUT' : 'POST';
      const endpoint = id ? `/api/songs/${id}` : '/api/songs';

      try {
        const result = await this.apiFetch(endpoint, {
          method, body: { title, alternate_title, language, songbook_tag, lyrics, transliteration, chord }
        });
        alert(id ? 'Song updated successfully!' : `Song created successfully. Its songbook number is ${result.song.song_number}.`);
        modalSongEditor.classList.add('hidden');
        this.loadSongs();
        if (id) {
          this.previewSong(id);
        }
      } catch (err) {
        alert(err.message);
      }
    });

    // Master Songs Explorer Actions
    const btnMasterCatalog = document.getElementById('btn-open-master-catalog');
    if (btnMasterCatalog) {
      btnMasterCatalog.addEventListener('click', () => this.openMasterSongsExplorer());
    }

    const masterSearchInput = document.getElementById('master-song-search-input');
    const btnClearMasterSearch = document.getElementById('btn-clear-master-search');
    if (masterSearchInput) {
      masterSearchInput.addEventListener('input', () => {
        if (btnClearMasterSearch) btnClearMasterSearch.classList.toggle('hidden', !masterSearchInput.value);
        clearTimeout(this.masterSearchDebounce);
        this.masterSearchDebounce = setTimeout(() => {
          this.searchMasterSongs(masterSearchInput.value.trim());
        }, 250);
      });
    }

    if (btnClearMasterSearch) {
      btnClearMasterSearch.addEventListener('click', () => {
        masterSearchInput.value = '';
        btnClearMasterSearch.classList.add('hidden');
        this.searchMasterSongs('');
      });
    }

    const formImportSong = document.getElementById('form-import-song');
    if (formImportSong) {
      const importLanguage = document.getElementById('import-song-language');
      const importTag = document.getElementById('import-song-tag');
      importLanguage.addEventListener('change', () => {
        if (this.songbookTags.some(tag => tag.name.toLowerCase() === importLanguage.value.toLowerCase())) importTag.value = importLanguage.value;
      });
      importTag.addEventListener('change', () => this.updateImportNumberSuggestion(importTag.value));
      formImportSong.addEventListener('submit', async (e) => {
        e.preventDefault();
        const masterSongId = document.getElementById('import-master-song-id').value;
        const language = importLanguage.value;
        const songbookTag = importTag.value;

        try {
          const result = await this.apiFetch('/api/songbook/import', {
            method: 'POST',
            body: { masterSongId, language, songbookTag }
          });
          alert(`Song added to your organisation songbook as ${songbookTag} song #${result.song.song_number}.`);
          document.getElementById('modal-import-song').classList.add('hidden');
          document.getElementById('modal-master-songs').classList.add('hidden');
          await this.loadSongs();
        } catch (err) {
          alert(err.message);
        }
      });
    }

    // Close buttons on all modals
    document.querySelectorAll('.modal-close-btn, [data-close]').forEach(btn => {
      btn.addEventListener('click', () => {
        const modalId = btn.getAttribute('data-close');
        if (modalId) {
          document.getElementById(modalId).classList.add('hidden');
        } else {
          btn.closest('.modal-overlay').classList.add('hidden');
        }
      });
    });
  }

  // Fetch and display songs list
  async loadSongs(query = '') {
    try {
      const params = new URLSearchParams();
      if (query) params.append('q', query);
      if (this.currentSongbookTag) params.append('tag', this.currentSongbookTag);

      const data = await this.apiFetch(`/api/songs?${params.toString()}`);
      this.songs = data.songs || [];

      // Update badge counts
      document.getElementById('badge-total-songs').textContent = this.songs.length;
      document.getElementById('results-count').textContent = `Showing ${this.songs.length} song${this.songs.length === 1 ? '' : 's'}`;

      this.renderSongsList();
      if (!this.cuedSong && this.songs.length > 0 && !query) {
        this.previewSong(this.songs[0].id);
      }
    } catch (err) {
      console.error('Failed to load songs:', err);
    }
  }

  async searchMobileSongs(query) {
    const resultsEl = document.getElementById('mobile-song-search-results');
    if (!query) {
      resultsEl.classList.add('hidden');
      return;
    }

    try {
      const params = new URLSearchParams({ q: query });
      const data = await this.apiFetch(`/api/songs?${params.toString()}`);
      if (document.getElementById('mobile-song-search').value.trim() !== query) return;
      resultsEl.replaceChildren();

      if (!data.songs || data.songs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'mobile-song-search-empty';
        empty.textContent = 'No songs found';
        resultsEl.appendChild(empty);
      } else {
        data.songs.forEach(song => {
          const option = document.createElement('button');
          option.type = 'button';
          option.className = 'mobile-song-search-option';
          option.setAttribute('role', 'option');
          const title = document.createElement('span');
          title.textContent = song.title;
          const number = document.createElement('small');
          const language = song.language || this.inferSongLanguage(song);
          number.textContent = [language, song.song_number ? `#${song.song_number}` : ''].filter(Boolean).join(' · ');
          option.append(title, number);
          option.addEventListener('click', async () => {
            const loaded = await this.previewSong(song.id);
            if (loaded && this.canDisplay) this.sendWsAction('SET_SONG', { songId: song.id, slideIndex: 0 });
            document.getElementById('mobile-song-search').value = song.title;
            resultsEl.classList.add('hidden');
            if (window.innerWidth <= 768) this.switchMobileTab(this.canDisplay ? 'panel-live' : 'panel-deck');
          });
          resultsEl.appendChild(option);
        });
      }
      resultsEl.classList.remove('hidden');
    } catch (err) {
      console.error('Failed to search songs:', err);
    }
  }

  async openCurrentlyLiveSong() {
    if (window.innerWidth > 768 || !this.liveState || !this.liveState.currentSong) return;
    const song = this.liveState.currentSong;
    const loaded = await this.previewSong(song.id);
    if (!loaded) {
      this.cuedSong = song;
      this.renderDeck();
      this.renderMobileLiveSlides();
    }
    this.switchMobileTab('panel-live');
    document.getElementById('mobile-song-search').value = song.title;
    document.getElementById('mobile-song-search-results').classList.add('hidden');
  }

  renderSongsList() {
    const listEl = document.getElementById('song-list');
    listEl.innerHTML = '';

    if (this.songs.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <p>No songs found matching your search.</p>
        </div>
      `;
      return;
    }

    this.songs.forEach(song => {
      const isLive = this.liveState && this.liveState.currentSong && this.liveState.currentSong.id === song.id;
      const isCued = this.cuedSong && this.cuedSong.id === song.id;

      const item = document.createElement('div');
      item.className = `song-item ${isLive ? 'live' : ''} ${isCued ? 'cued' : ''}`;
      const language = song.language || this.inferSongLanguage(song);
      const numberDisplay = song.song_number;
      const numberingTag = song.songbook_tag || language;
      item.innerHTML = `
        <div class="song-item-left">
          <span class="song-item-title">${this.escapeHtml(song.title)}</span>
          <div class="song-item-meta">
            ${numberDisplay ? `<span class="song-item-number">#${this.escapeHtml(numberDisplay)}</span>` : ''}
            ${numberingTag ? `<span class="song-item-language">${this.escapeHtml(numberingTag)}</span>` : ''}
            ${language && language.toLowerCase() !== numberingTag.toLowerCase() ? `<span class="song-item-language">${this.escapeHtml(language)}</span>` : ''}
            ${song.chord ? `<span>• ${this.escapeHtml(song.chord)}</span>` : ''}
          </div>
        </div>
      `;

      // Selecting a song sends it live and also loads its slides in the deck.
      item.addEventListener('click', () => {
        this.previewSong(song.id).then(loaded => {
          if (loaded && this.canDisplay) this.sendWsAction('SET_SONG', { songId: song.id, slideIndex: 0 });
        });
        // On mobile, automatically switch to deck tab
        if (window.innerWidth <= 768) {
          this.switchMobileTab('panel-deck');
        }
      });

      listEl.appendChild(item);
    });
  }

  async loadGroupsOverview() {
    const orgId = this.currentUser?.activeOrganizationId;
    if (!orgId) return;

    try {
      const data = await this.apiFetch(`/api/organizations/${orgId}/overview`);
      const container = document.getElementById('groups-cards-container');
      const countEl = document.getElementById('groups-overview-count');
      const badgeGroups = document.getElementById('badge-total-groups');
      const orgHeading = document.getElementById('groups-org-name');

      if (orgHeading) orgHeading.textContent = `${data.organization.name} Groups`;
      if (countEl) countEl.textContent = `${data.groups.length} group${data.groups.length === 1 ? '' : 's'}`;
      if (badgeGroups) badgeGroups.textContent = data.groups.length;

      if (!data.groups || data.groups.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <p>No groups created yet in this organisation.</p>
            <button type="button" class="btn-primary-sm" id="btn-empty-add-group">+ Create Group</button>
          </div>
        `;
        document.getElementById('btn-empty-add-group')?.addEventListener('click', () => {
          document.getElementById('modal-users').classList.remove('hidden');
          document.getElementById('master-group-create').classList.remove('hidden');
        });
        return;
      }

      container.innerHTML = data.groups.map(g => `
        <div class="group-overview-card" data-group-id="${g.id}">
          <div class="group-overview-card-header">
            <span class="group-overview-card-title">${this.escapeHtml(g.name)}</span>
            <span class="badge-member-count">👥 ${g.memberCount} ${g.memberCount === 1 ? 'Member' : 'Members'}</span>
          </div>
          <div class="group-overview-card-actions">
            <button type="button" class="btn-secondary-sm btn-manage-group-members" data-group-id="${g.id}">
              Manage Members
            </button>
          </div>
        </div>
      `).join('');

      container.querySelectorAll('.btn-manage-group-members').forEach(btn => {
        btn.addEventListener('click', async () => {
          const groupId = Number(btn.dataset.groupId);
          const modalUsers = document.getElementById('modal-users');
          modalUsers.classList.remove('hidden');
          await this.loadManagedGroups([groupId]);
        });
      });
    } catch (err) {
      console.error('Failed to load groups overview:', err);
    }
  }

  async openMasterSongsExplorer() {
    const modal = document.getElementById('modal-master-songs');
    modal.classList.remove('hidden');
    await this.searchMasterSongs('');
  }

  async searchMasterSongs(query = '') {
    const listEl = document.getElementById('master-songs-list');
    const countEl = document.getElementById('master-results-count');
    listEl.innerHTML = '<div class="empty-state">Searching master songs…</div>';

    try {
      const params = new URLSearchParams();
      if (query) params.append('q', query);
      const data = await this.apiFetch(`/api/master-songs?${params.toString()}`);
      const songs = data.songs || [];

      if (countEl) countEl.textContent = `Found ${songs.length} song${songs.length === 1 ? '' : 's'}`;

      if (songs.length === 0) {
        listEl.innerHTML = '<div class="empty-state">No master songs found matching your search.</div>';
        return;
      }

      listEl.innerHTML = songs.map(s => `
        <div class="master-song-card" data-song-id="${s.id}">
          <div class="master-song-info">
            <div class="master-song-title-row">
              <span class="master-song-title">${this.escapeHtml(s.title)}</span>
              ${s.language ? `<span class="song-item-language">${this.escapeHtml(s.language)}</span>` : ''}
              ${s.chord ? `<small>• ${this.escapeHtml(s.chord)}</small>` : ''}
            </div>
            ${s.alternate_title && !/^\d+$/.test(String(s.alternate_title).trim()) ? `<small class="text-muted">Alt: ${this.escapeHtml(s.alternate_title)}</small>` : ''}
          </div>
          <button type="button" class="btn-primary-sm btn-import-master-song" data-song-id="${s.id}" data-song-title="${this.escapeHtml(s.title)}" data-language="${this.escapeHtml(s.language || '')}" data-alternate-title="${this.escapeHtml(s.alternate_title || '')}">
            + Add to Songbook
          </button>
        </div>
      `).join('');

      listEl.querySelectorAll('.btn-import-master-song').forEach(btn => {
        btn.addEventListener('click', async () => {
          const masterSongId = btn.dataset.songId;
          const masterTitle = btn.dataset.songTitle;
          const language = btn.dataset.language || this.inferSongLanguage({ title: masterTitle, alternate_title: btn.dataset.alternateTitle });

          document.getElementById('import-master-song-id').value = masterSongId;
          document.getElementById('import-song-title').textContent = `Add "${masterTitle}" to Songbook`;
          document.getElementById('import-song-language').value = language;
          const matchingTag = this.songbookTags.find(tag => tag.name.toLowerCase() === language.toLowerCase());
          document.getElementById('import-song-tag').value = matchingTag?.name || this.songbookTags[0]?.name || '';

          document.getElementById('modal-import-song').classList.remove('hidden');
          document.getElementById('import-song-language').focus();
          await this.updateImportNumberSuggestion(document.getElementById('import-song-tag').value);
        });
      });
    } catch (err) {
      listEl.innerHTML = `<div class="empty-state error">Error loading master songs: ${err.message}</div>`;
    }
  }

  inferSongLanguage(song) {
    const text = `${song.alternate_title || ''} ${song.title || ''}`.toLowerCase();
    const namedLanguage = ['Malayalam', 'Tamil', 'Hindi', 'Telugu', 'Nagamese', 'English']
      .find(language => text.includes(language.toLowerCase()));
    if (namedLanguage) return namedLanguage;
    if (/[\u0D00-\u0D7F]/.test(text)) return 'Malayalam';
    if (/[\u0B80-\u0BFF]/.test(text)) return 'Tamil';
    if (/[\u0900-\u097F]/.test(text)) return 'Hindi';
    if (/[\u0C00-\u0C7F]/.test(text)) return 'Telugu';
    return /[a-z]/i.test(text) && /^[\x00-\x7F]*$/.test(text) ? 'English' : '';
  }

  async updateImportNumberSuggestion(tag) {
    const message = document.getElementById('import-suggested-number');
    if (!tag) {
      message.textContent = 'Choose a songbook tag to see its next number.';
      return;
    }
    try {
      const data = await this.apiFetch(`/api/songbook/next-song-number?tag=${encodeURIComponent(tag)}`);
      message.textContent = `Next ${tag} songbook number: ${data.nextSongNumber} (assigned automatically).`;
    } catch (error) {
      message.textContent = error.message;
    }
  }

  // Load song into Deck (Private Preview mode)
  async previewSong(songId) {
    try {
      const data = await this.apiFetch(`/api/songs/${songId}`);
      this.cuedSong = data.song;

      this.renderDeck();
      this.renderSongsList(); // Update cued highlight
      return true;
    } catch (err) {
      console.error('Failed to preview song:', err);
      return false;
    }
  }

  async refreshCuedSongSlides() {
    if (!this.cuedSong) return;
    try {
      const data = await this.apiFetch(`/api/songs/${this.cuedSong.id}`);
      this.cuedSong = data.song;
      this.renderDeck();
      this.renderMobileLiveSlides();
    } catch (err) {
      console.error('Failed to update slide layout:', err);
    }
  }

  // Render Slide Deck (Center Column)
  renderDeck() {
    const titleEl = document.getElementById('deck-song-title');
    const metaEl = document.getElementById('deck-song-meta');
    const statusTag = document.getElementById('deck-status-tag');
    const actionsEl = document.getElementById('deck-actions');
    const scrollEl = document.getElementById('deck-slides-scroll');

    if (!this.cuedSong) {
      this.renderMobileLiveSlides();
      titleEl.textContent = 'Select a Song to Preview';
      metaEl.textContent = 'Browse the song library';
      statusTag.textContent = 'Private Preview';
      statusTag.className = 'deck-status-tag';
      actionsEl.classList.add('hidden');
      scrollEl.innerHTML = `
        <div class="deck-empty-state">
          <div class="deck-empty-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
              <line x1="8" y1="21" x2="16" y2="21"></line>
              <line x1="12" y1="17" x2="12" y2="21"></line>
            </svg>
          </div>
          <h3>Private Slide Deck</h3>
          <p>${this.canDisplay ? 'Choose a song to preview its verses. Click a slide to send it to the screen.' : 'Browse and preview any shared song. Display access must be granted by a group admin.'}</p>
        </div>
      `;
      return;
    }

    const isLive = this.liveState && this.liveState.currentSong && this.liveState.currentSong.id === this.cuedSong.id;
    const hasSlides = Array.isArray(this.cuedSong.slides) && this.cuedSong.slides.length > 0;

    titleEl.textContent = this.cuedSong.title;
    metaEl.textContent = `${this.cuedSong.song_number ? `#${this.cuedSong.song_number} • ` : ''}${hasSlides ? `${this.cuedSong.slides.length} Slides` : 'No lyrics added'}`;
    statusTag.textContent = isLive ? '● Live on Projector' : 'Private Preview (Not Live)';
    statusTag.className = `deck-status-tag ${isLive ? 'live' : ''}`;
    actionsEl.classList.remove('hidden');
    document.getElementById('btn-cue-go-live').disabled = !hasSlides;
    document.getElementById('btn-cue-go-live').classList.toggle('hidden', !this.canDisplay);
    document.getElementById('btn-edit-cued-song').classList.toggle('hidden', !this.canEditSongs);
    document.getElementById('btn-song-history').classList.remove('hidden');

    scrollEl.innerHTML = '';

    if (!hasSlides) {
      scrollEl.innerHTML = `
        <div class="deck-empty-state">
          <h3>No lyrics yet</h3>
          <p>Use Edit to add lyrics whenever you're ready.</p>
        </div>
      `;
      this.renderMobileLiveSlides();
      return;
    }

    this.cuedSong.slides.forEach((slide, idx) => {
      const isSlideActive = isLive && this.liveState.activeSlideIndex === idx;

      const card = document.createElement('div');
      card.className = `slide-card ${isSlideActive ? 'active-live' : ''}`;
      
      let linesHtml = '';
      if (slide.pairedLines && slide.pairedLines.length > 0) {
        slide.pairedLines.forEach(item => {
          linesHtml += `<div class="slide-card-line">${this.escapeHtml(item.text)}</div>`;
          if (item.translit) {
            linesHtml += `<div class="slide-card-translit">${this.escapeHtml(item.translit)}</div>`;
          }
        });
      } else if (slide.lines) {
        slide.lines.forEach(line => {
          linesHtml += `<div class="slide-card-line">${this.escapeHtml(line)}</div>`;
        });
      }

      card.innerHTML = `
        <div class="slide-card-header">
          <span class="slide-label-badge">${slide.label}</span>
          ${isSlideActive ? '<span class="live-now-tag">● PROJECTING</span>' : `<span class="label-hint">Slide ${idx + 1}</span>`}
        </div>
        <div class="slide-card-body">
          ${linesHtml}
        </div>
      `;

      // Clicking any card pushes this slide LIVE!
      if (this.canDisplay) card.addEventListener('click', () => {
        this.sendWsAction('SET_SONG', { songId: this.cuedSong.id, slideIndex: idx });
        if (window.innerWidth <= 768) this.switchMobileTab('panel-live');
      });

      scrollEl.appendChild(card);
    });

    this.renderMobileLiveSlides();
  }

  renderMobileLiveSlides() {
    const listEl = document.getElementById('mobile-live-slides');
    if (!listEl) return;

    const song = this.cuedSong || (this.liveState && this.liveState.currentSong);
    if (!song || !Array.isArray(song.slides) || song.slides.length === 0) {
      const message = song ? 'No lyrics yet. Edit this song to add them.' : 'Choose a song to see its slides here.';
      listEl.innerHTML = `<div class="mobile-live-slides-empty">${this.escapeHtml(message)}</div>`;
      return;
    }

    const isLive = this.liveState && this.liveState.currentSong && this.liveState.currentSong.id === song.id;
    listEl.innerHTML = `<div class="mobile-live-slides-heading">${this.escapeHtml(song.title)} <span>${song.slides.length} slides</span></div>`;

    song.slides.forEach((slide, idx) => {
      const isActive = isLive && this.liveState.activeSlideIndex === idx;
      const lines = slide.pairedLines && slide.pairedLines.length
        ? slide.pairedLines.map(item => `<div class="mobile-live-slide-line">${this.escapeHtml(item.text)}${item.translit ? `<span>${this.escapeHtml(item.translit)}</span>` : ''}</div>`).join('')
        : (slide.lines || []).map(line => `<div class="mobile-live-slide-line">${this.escapeHtml(line)}</div>`).join('');
      const card = document.createElement('button');
      card.type = 'button';
      card.disabled = !this.canDisplay;
      card.className = `mobile-live-slide ${isActive ? 'active' : ''}`;
      card.innerHTML = `<span class="mobile-live-slide-label">${this.escapeHtml(slide.label || `Slide ${idx + 1}`)}${isActive ? ' · LIVE' : ''}</span><span class="mobile-live-slide-body">${lines}</span>`;
      if (this.canDisplay) card.addEventListener('click', () => this.sendWsAction('SET_SONG', { songId: song.id, slideIndex: idx }));
      listEl.appendChild(card);
    });
  }

  // Handle incoming live state from WebSocket
  handleLiveStateUpdate(state) {
    this.liveState = state;

    const fontSize = Number(state.fontSize) || 54;
    document.querySelectorAll('.theme-option').forEach(option => {
      option.classList.toggle('active', option.dataset.theme === (state.theme || 'clean-white'));
    });
    const fontSlider = document.getElementById('slider-font-size');
    const fontSizeVal = document.getElementById('font-size-val');
    const mobileFontSlider = document.getElementById('mobile-font-size');
    const mobileFontSizeVal = document.getElementById('mobile-font-size-value');
    fontSlider.value = fontSize;
    fontSizeVal.textContent = `${fontSize}px`;
    mobileFontSlider.value = fontSize;
    mobileFontSizeVal.value = `${fontSize}px`;
    mobileFontSizeVal.textContent = `${fontSize}px`;

    // 1. Header Pill
    const livePill = document.getElementById('live-pill');
    const statusText = document.getElementById('live-status-text');

    if (state.isBlank) {
      livePill.className = 'live-pill blank';
      statusText.textContent = 'Blackout Active';
    } else if (state.currentSong) {
      livePill.className = 'live-pill active';
      const curSlide = state.currentSong.slides[state.activeSlideIndex];
      const label = curSlide ? curSlide.label : `Slide ${state.activeSlideIndex + 1}`;
      statusText.textContent = `Projecting: ${state.currentSong.title} (${label})`;
    } else {
      livePill.className = 'live-pill';
      statusText.textContent = 'Standby';
    }
    livePill.setAttribute('aria-label', state.currentSong
      ? `Open currently live song: ${state.currentSong.title}`
      : 'No song is currently live');
    livePill.title = state.currentSong
      ? `Tap to open ${state.currentSong.title}, currently live on the projector`
      : 'No song is currently live';

    // 2. Monitor Screen (Mini Mirror)
    const monitorScreen = document.getElementById('monitor-screen');
    const monitorText = document.getElementById('monitor-text');
    const monitorBadge = document.getElementById('monitor-badge');
    const monitorSongBadge = document.getElementById('monitor-song-badge');

    monitorScreen.className = `monitor-screen theme-${state.theme || 'sanctuary'} ${state.isBlank ? 'blackout' : ''} ${state.isClear ? 'clear' : ''}`;

    if (state.currentSong && state.currentSong.slides.length > 0) {
      const slide = state.currentSong.slides[state.activeSlideIndex] || state.currentSong.slides[0];
      const previewText = slide.lines.slice(0, 3).join('\n');
      monitorText.textContent = previewText;
      monitorBadge.style.display = 'block';
      monitorSongBadge.textContent = `${state.currentSong.title} (${slide.label})`;
    } else {
      monitorText.innerHTML = '<em>Display is on standby</em>';
      monitorBadge.style.display = 'none';
    }

    // 3. Toggles State
    document.getElementById('btn-toggle-blank').classList.toggle('active', !!state.isBlank);
    document.getElementById('btn-toggle-clear').classList.toggle('active', !!state.isClear);
    document.getElementById('btn-toggle-translit').classList.toggle('active', !!state.showTranslit);

    // 4. Update Deck Cards if cued song is currently projecting
    if (this.cuedSong && state.currentSong && this.cuedSong.id === state.currentSong.id) {
      this.cuedSong.slides = state.currentSong.slides;
    }
    if (this.cuedSong && state.currentSong && this.cuedSong.id === state.currentSong.id) {
      this.renderDeck();
    }
    this.renderMobileLiveSlides();

    // Start a fresh history for each page load; don't immediately add the song
    // that was already live when this controller connected.
    if (this.ignoreInitialLiveState) {
      this.ignoreInitialLiveState = false;
    } else if (state.currentSong) {
      this.addToSessionHistory(state.currentSong);
    }

    // 6. Update song items live highlight
    this.renderSongsList();
    this.renderHistory();
  }

  addToSessionHistory(song) {
    if (!song || !song.id) return;
    // Don't add duplicate if it's already the most recent song in history
    if (this.sessionHistory.length > 0 && this.sessionHistory[0].id === song.id) {
      return;
    }

    const now = new Date();
    const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    this.sessionHistory.unshift({
      id: song.id,
      title: song.title,
      alternate_title: song.alternate_title,
      song_number: song.song_number,
      time: timeStr
    });

    localStorage.setItem(this.historyStorageKey, JSON.stringify(this.sessionHistory));

    this.renderHistory();
  }

  renderHistory() {
    const listEl = document.getElementById('history-items-list');
    const badgeEl = document.getElementById('badge-history-count');
    if (badgeEl) badgeEl.textContent = this.sessionHistory.length;
    if (!listEl) return;

    listEl.innerHTML = '';
    this.renderMobileHistoryPopover();

    if (this.sessionHistory.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <p>No songs projected yet in this session.</p>
          <span>When you project a song, it will automatically appear here so you can jump back to it anytime.</span>
        </div>
      `;
      return;
    }

    this.sessionHistory.forEach((item, idx) => {
      const isLive = this.liveState && this.liveState.currentSong && this.liveState.currentSong.id === item.id;

      const div = document.createElement('div');
      div.className = `history-item ${isLive ? 'live' : ''}`;
      div.innerHTML = `
        <div class="history-item-left">
          <span class="history-item-title">${idx + 1}. ${this.escapeHtml(item.title)}</span>
          <div class="history-item-meta">
            ${item.song_number ? `<span>#${this.escapeHtml(item.song_number)}</span>` : ''}
            <span class="history-item-time">• Projected at ${item.time}</span>
          </div>
        </div>
        <div class="history-item-actions">
          <button type="button" class="btn-cue-item">View</button>
        </div>
      `;

      div.addEventListener('click', () => {
        this.previewSong(item.id);
        if (window.innerWidth <= 768) {
          this.switchMobileTab('panel-deck');
        }
      });

      listEl.appendChild(div);
    });
  }

  renderMobileHistoryPopover() {
    const listEl = document.getElementById('mobile-history-popover-list');
    if (!listEl) return;
    listEl.replaceChildren();

    if (this.sessionHistory.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'mobile-history-empty';
      empty.textContent = 'No previous songs yet.';
      listEl.appendChild(empty);
      return;
    }

    this.sessionHistory.forEach(item => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'mobile-history-option';
      const title = document.createElement('span');
      title.className = 'mobile-history-option-title';
      title.textContent = item.title;
      const meta = document.createElement('span');
      meta.className = 'mobile-history-option-meta';
      meta.textContent = item.song_number ? `#${item.song_number}` : item.time;
      option.append(title, meta);
      option.addEventListener('click', async () => {
        await this.previewSong(item.id);
        document.getElementById('mobile-history-popover').classList.add('hidden');
      });
      listEl.appendChild(option);
    });
  }

  async openSongVersionHistory() {
    if (!this.cuedSong) return;
    const modal = document.getElementById('modal-song-versions');
    const list = document.getElementById('song-version-list');
    list.textContent = 'Loading version history…';
    modal.classList.remove('hidden');
    try {
      const { versions } = await this.apiFetch(`/api/songs/${this.cuedSong.id}/versions`);
      list.replaceChildren();
      if (!versions.length) {
        list.textContent = 'No saved revisions yet. New edits will appear here.';
        return;
      }
      versions.forEach(version => {
        const card = document.createElement('article');
        card.className = 'song-version-card';
        const when = new Date(version.changedAt).toLocaleString();
        const label = version.changeType === 'rollback' ? 'Rollback' : version.changeType === 'baseline' ? 'Starting copy' : version.changeType === 'create' ? 'Created' : 'Edit';
        const preview = String(version.snapshot.lyrics || '').split(/\r?\n/).filter(Boolean).slice(0, 3).join(' · ');
        card.innerHTML = `<div><strong>${this.escapeHtml(label)} · ${this.escapeHtml(version.snapshot.title || this.cuedSong.title)}</strong><p>${this.escapeHtml(version.actorUsername)} · ${this.escapeHtml(when)}</p><small>${this.escapeHtml(preview || 'No lyrics saved in this version')}</small></div>`;
        if (this.canEditSongs) {
          const rollback = document.createElement('button');
          rollback.type = 'button';
          rollback.className = 'btn-secondary-sm';
          rollback.textContent = 'Restore this version';
          rollback.addEventListener('click', async () => {
            if (!confirm(`Restore the version saved ${when}? This will create a new history entry.`)) return;
            try {
              await this.apiFetch(`/api/songs/${this.cuedSong.id}/versions/${version.id}/rollback`, { method: 'POST' });
              modal.classList.add('hidden');
              await this.previewSong(this.cuedSong.id);
              await this.loadSongs(document.getElementById('song-search-input').value.trim());
              alert('Song restored. The rollback is recorded in its version history.');
            } catch (err) { alert(err.message); }
          });
          card.appendChild(rollback);
        }
        list.appendChild(card);
      });
    } catch (err) { list.textContent = err.message; }
  }

  // Keyboard Shortcuts (Space, Arrows, B, C, Numbers 1-9)
  bindKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
      // Don't intercept when user is typing in form inputs
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
        if (e.key === 'Escape') {
          e.target.blur();
        }
        return;
      }

      // Space / Right Arrow / Down Arrow: Next Slide
      if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') {
        e.preventDefault();
        this.sendWsAction('NEXT_SLIDE');
      }
      // Left Arrow / Up Arrow / PageUp: Previous Slide
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault();
        this.sendWsAction('PREV_SLIDE');
      }
      // B: Blackout Screen
      else if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        this.sendWsAction('TOGGLE_BLANK');
      }
      // C: Clear Lyrics
      else if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        this.sendWsAction('TOGGLE_CLEAR');
      }
      // Numbers 1-9: Direct Jump to Slide Number
      else if (/^[1-9]$/.test(e.key)) {
        const targetIndex = parseInt(e.key, 10) - 1;
        if (this.liveState && this.liveState.currentSong) {
          this.sendWsAction('SET_SLIDE', { slideIndex: targetIndex });
        }
      }
      // /: Focus search
      else if (e.key === '/') {
        e.preventDefault();
        const searchInput = document.getElementById('song-search-input');
        if (searchInput) searchInput.focus();
      }
      // Escape: Close all modals
      else if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay').forEach(m => m.classList.add('hidden'));
      }
    });
  }

  // Mobile Bottom Tab Bar Switcher
  setupMobileTabs() {
    const mobileBtns = document.querySelectorAll('.mobile-tab-btn');
    mobileBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-target');
        this.switchMobileTab(targetId);
      });
    });

    // Default active panel for mobile
    if (window.innerWidth <= 768) {
      this.isRestoringMobileNavigation = true;
      this.switchMobileTab('panel-library');
      this.isRestoringMobileNavigation = false;

      history.replaceState({ ...(history.state || {}), oilnwineControllerHome: true }, '', location.href);
      history.pushState({ oilnwineMobilePanel: 'panel-library' }, '', location.href);
      window.addEventListener('popstate', event => {
        const historyPopover = document.getElementById('mobile-history-popover');
        const activePanel = document.querySelector('.panel.mobile-active');

        if (historyPopover && !historyPopover.classList.contains('hidden')) {
          historyPopover.classList.add('hidden');
          history.pushState({ oilnwineMobilePanel: activePanel ? activePanel.id : 'panel-library' }, '', location.href);
          return;
        }

        if (event.state && event.state.oilnwineMobilePanel) {
          this.isRestoringMobileNavigation = true;
          this.switchMobileTab(event.state.oilnwineMobilePanel);
          this.isRestoringMobileNavigation = false;
          return;
        }

        if (activePanel && activePanel.id !== 'panel-library') {
          this.switchMobileTab('panel-library');
          return;
        }

        const historyTab = document.getElementById('tab-history');
        if (historyTab && historyTab.classList.contains('active')) {
          document.getElementById('tab-songs').click();
        }
        history.replaceState({ oilnwineControllerHome: true }, '', '/');
      });
    }
  }

  switchMobileTab(panelId) {
    const previousPanel = document.querySelector('.panel.mobile-active');
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('mobile-active'));
    document.querySelectorAll('.mobile-tab-btn').forEach(b => b.classList.remove('active'));

    const panel = document.getElementById(panelId);
    if (panel) panel.classList.add('mobile-active');

    const btn = document.querySelector(`.mobile-tab-btn[data-target="${panelId}"]`);
    if (btn) btn.classList.add('active');

    if (window.innerWidth <= 768 && previousPanel && previousPanel.id !== panelId && !this.isRestoringMobileNavigation) {
      history.pushState({ oilnwineMobilePanel: panelId }, '', location.href);
    }
  }

  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

// Instantiate on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.controllerApp = new WorshipController();
});
