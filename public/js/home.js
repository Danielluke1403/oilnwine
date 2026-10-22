document.addEventListener('DOMContentLoaded', () => {
  const token = localStorage.getItem('oilnwine_token');
  if (!token) {
    window.location.replace('/login');
    return;
  }

  const apiFetch = async (url, options = {}) => {
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(url, {
      ...options,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  };

  const alertEl = document.getElementById('home-alert');
  const showError = message => {
    alertEl.textContent = message;
    alertEl.classList.remove('hidden');
    setTimeout(() => alertEl.classList.add('hidden'), 5000);
  };

  function setLinkGroup(groupId, orgId) {
    const params = new URLSearchParams();
    if (orgId) params.set('orgId', orgId);
    if (groupId) params.set('groupId', groupId);
    const suffix = params.toString() ? `?${params}` : '';
    document.getElementById('home-display-card').href = `/display${suffix}`;
    document.getElementById('home-display-card').dataset.groupId = groupId || '';
  }

  async function loadHome() {
    try {
      const { user } = await apiFetch('/api/auth/me');
      const orgs = user.organizations || [];
      const org = user.activeOrganization || orgs.find(item => Number(item.id) === Number(user.activeOrganizationId));
      if (!org) {
        showError('This account is not connected to an organisation yet. Please ask an organisation admin to add you.');
        return;
      }

      const groups = user.groups || [];
      const isOrgAdmin = Boolean(user.isMasterAdmin || user.isOrgAdmin);
      const isGroupAdmin = groups.some(group => group.role === 'group_admin');
      const canDisplay = isOrgAdmin || groups.some(group => group.canDisplay || group.role === 'group_admin');
      const canAddSongs = isOrgAdmin || groups.some(group => group.canAddSongs || group.role === 'group_admin');
      let activeGroupId = Number(user.activeGroupId || groups[0]?.id) || null;
      const activeGroup = groups.find(group => Number(group.id) === activeGroupId) || groups[0];
      if (!activeGroupId && activeGroup) activeGroupId = Number(activeGroup.id);

      document.title = `Home | ${org.name}`;
      document.getElementById('home-org-name').textContent = org.name;
      document.getElementById('home-brand-name').textContent = org.name;
      document.documentElement.style.setProperty('--blue', org.brandColor || '#285cf4');
      if (org.logoData) document.getElementById('home-org-logo').src = org.logoData;
      document.getElementById('home-user-name').textContent = user.username;
      document.getElementById('home-avatar').textContent = user.username.slice(0, 1).toUpperCase();
      document.getElementById('home-user-role').textContent = user.isMasterAdmin ? 'Master admin' : isOrgAdmin ? 'Organisation admin' : isGroupAdmin ? 'Group admin' : 'Member';
      document.getElementById('home-greeting').textContent = `Welcome back, ${user.username}`;

      const orgSelect = document.getElementById('home-org-select');
      if (orgSelect) {
        orgSelect.replaceChildren(...orgs.map(item => {
          const option = document.createElement('option');
          option.value = item.id;
          option.textContent = item.name;
          option.selected = Number(item.id) === Number(org.id);
          return option;
        }));
        orgSelect.classList.toggle('hidden', orgs.length < 2);
        orgSelect.addEventListener('change', async () => {
          try {
            await apiFetch('/api/auth/select-organization', { method: 'POST', body: { organizationId: Number(orgSelect.value) } });
            window.location.reload();
          } catch (error) { showError(error.message); }
        });
      }

      const groupSelect = document.getElementById('home-group-select');
      groupSelect.replaceChildren(...groups.map(group => {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = group.name;
        option.selected = Number(group.id) === Number(activeGroupId);
        return option;
      }));
      if (!groups.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No groups assigned';
        groupSelect.append(option);
      }
      groupSelect.classList.toggle('hidden', groups.length < 2);
      groupSelect.addEventListener('change', async () => {
        try {
          await apiFetch('/api/auth/select-group', { method: 'POST', body: { groupId: Number(groupSelect.value) } });
          window.location.reload();
        } catch (error) { showError(error.message); }
      });

      const groupCard = document.getElementById('home-groups-card');
      groupCard.classList.toggle('hidden', !(isOrgAdmin || isGroupAdmin));
      document.getElementById('home-settings-card').classList.toggle('hidden', !isOrgAdmin);
      document.getElementById('home-settings').classList.toggle('hidden', !isOrgAdmin);
      document.getElementById('home-controller-card').classList.toggle('hidden', !canDisplay);
      document.getElementById('home-display-card').classList.toggle('hidden', !canDisplay || !activeGroupId);
      document.getElementById('home-add-songs-card').classList.toggle('hidden', !canAddSongs);
      const groupText = activeGroup?.name || 'Select a group';
      document.getElementById('home-controller-group').textContent = groupText;
      document.getElementById('home-display-group').textContent = `Open ${groupText} display`;
      document.getElementById('home-controller-card').href = `/controller${activeGroupId ? `?groupId=${activeGroupId}` : ''}`;
      document.getElementById('home-songbook-card').href = '/add-songs?view=songbooks';
      document.getElementById('home-add-songs-card').href = '/add-songs';
      setLinkGroup(activeGroupId, org.id);
      document.getElementById('home-subtitle').textContent = groups.length
        ? `Your workspace for ${org.name}${activeGroup ? ` · ${activeGroup.name}` : ''}.`
        : `Your workspace for ${org.name}. Ask an admin to assign you to a group to present songs.`;

      if (isOrgAdmin) {
        try {
          const overview = await apiFetch(`/api/organizations/${org.id}/overview`);
          document.getElementById('home-group-count').textContent = `${overview.stats.groupCount} groups · ${overview.stats.memberCount} members`;
          document.getElementById('home-groups-description').textContent = 'Manage every group, member, and permission in your organisation.';
          document.getElementById('home-song-count').textContent = `${overview.stats.songCount} songs in the shared songbook`;
        } catch (error) { console.warn('Could not load organisation overview:', error); }
      } else {
        document.getElementById('home-group-count').textContent = `${groups.length} assigned group${groups.length === 1 ? '' : 's'}`;
        document.getElementById('home-groups-description').textContent = 'Manage members and access in the groups you lead.';
      }

      document.getElementById('home-logout').addEventListener('click', async () => {
        try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch {}
        localStorage.removeItem('oilnwine_token');
        localStorage.removeItem('oilnwine_user');
        window.location.href = '/login';
      });
    } catch (error) {
      localStorage.removeItem('oilnwine_token');
      localStorage.removeItem('oilnwine_user');
      window.location.replace('/login');
    }
  }

  loadHome();
});
