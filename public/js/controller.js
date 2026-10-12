// Worship Presentation Controller for Oil & Wine Church

class WorshipController {
  constructor() {
    this.token = localStorage.getItem('oilnwine_token');
    this.historyStorageKey = this.token ? `oilnwine_session_history_${this.token}` : 'oilnwine_session_history';
    // History is per page session: clear it on refresh, then record new song changes.
    localStorage.removeItem(this.historyStorageKey);
    this.currentUser = null;
    this.ws = null;
    this.liveState = null;
    this.cuedSong = null; // Song in private preview deck
    this.currentLanguage = '';
    this.songs = [];
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
    this.initWebSocket();
    this.bindDOM();
    this.loadSongs();
    this.renderHistory();
    this.bindKeyboardShortcuts();
    this.setupMobileTabs();
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
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  }

  bindLiveAction(buttonId, action) {
    document.getElementById(buttonId).addEventListener('click', () => this.sendWsAction(action));
  }

  async verifyAuth() {
    try {
      const data = await this.apiFetch('/api/auth/me');
      this.currentUser = data.user;

      // Update User Name in header
      const nameEl = document.getElementById('current-user-name');
      if (nameEl) {
        nameEl.textContent = `${this.currentUser.username}${this.currentUser.permission >= 2 ? ' (Admin)' : ''}`;
      }

      // Show user management button if admin
      if (this.currentUser.permission >= 2) {
        const btnUsers = document.getElementById('btn-open-users');
        if (btnUsers) btnUsers.style.display = 'inline-flex';
        const btnDeleteSong = document.getElementById('btn-delete-cued-song');
        if (btnDeleteSong) btnDeleteSong.style.display = 'inline-flex';
      }
      return true;
    } catch (e) {
      localStorage.removeItem('oilnwine_token');
      localStorage.removeItem('oilnwine_user');
      window.location.href = '/login';
      return false;
    }
  }

  initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('Controller connected to WebSocket server');
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
      setTimeout(() => this.initWebSocket(), 2000);
    };
  }

  sendWsAction(action, payload = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action, ...payload }));
    }
  }

  bindDOM() {
    // Logout
    document.getElementById('btn-logout').addEventListener('click', async () => {
      try {
        await this.apiFetch('/api/auth/logout', { method: 'POST' });
      } catch (e) {}
      localStorage.removeItem('oilnwine_token');
      localStorage.removeItem('oilnwine_user');
      window.location.href = '/login';
    });

    // Navigation Tabs (Songs vs History)
    const tabSongs = document.getElementById('tab-songs');
    const tabHistory = document.getElementById('tab-history');
    const viewSongs = document.getElementById('view-songs');
    const viewHistory = document.getElementById('view-history');

    tabSongs.addEventListener('click', () => {
      tabSongs.classList.add('active');
      tabHistory.classList.remove('active');
      viewSongs.classList.remove('hidden');
      viewHistory.classList.add('hidden');
    });

    tabHistory.addEventListener('click', () => {
      tabHistory.classList.add('active');
      tabSongs.classList.remove('active');
      viewHistory.classList.remove('hidden');
      viewSongs.classList.add('hidden');
    });

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

    // Language pills
    const pills = document.querySelectorAll('#filter-pills .pill');
    pills.forEach(pill => {
      pill.addEventListener('click', () => {
        pills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        this.currentLanguage = pill.getAttribute('data-lang');
        this.loadSongs(searchInput.value.trim());
      });
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
      modalSettings.classList.remove('hidden');
    });

    // Theme pickers inside Settings Modal
    const themeOptions = document.querySelectorAll('.theme-option');
    themeOptions.forEach(opt => {
      opt.addEventListener('click', () => {
        themeOptions.forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        const theme = opt.getAttribute('data-theme');
        this.sendWsAction('UPDATE_STYLE', { theme });
      });
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
      btnUsers.addEventListener('click', () => {
        modalUsers.classList.remove('hidden');
        this.loadUsersTable();
      });
    }

    // Create User Form
    const userForm = document.getElementById('form-create-user');
    userForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('new-username').value.trim();
      const email = document.getElementById('new-email').value.trim();
      const password = document.getElementById('new-password').value.trim();
      const permission = document.getElementById('new-permission').value;

      try {
        await this.apiFetch('/api/users', {
          method: 'POST', body: { username, email, password, permission }
        });
        alert('User created successfully!');
        userForm.reset();
        this.loadUsersTable();
      } catch (err) {
        alert(err.message);
      }
    });

    // Song Creator / Editor
    const modalSongEditor = document.getElementById('modal-song-editor');
    document.getElementById('btn-new-song').addEventListener('click', () => {
      document.getElementById('song-editor-title').textContent = 'Add New Song';
      document.getElementById('form-song-editor').reset();
      document.getElementById('edit-song-id').value = '';
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
      modalSongEditor.classList.remove('hidden');
    });

    document.getElementById('btn-delete-cued-song').addEventListener('click', async () => {
      if (!this.cuedSong || !this.currentUser || this.currentUser.permission < 2) return;
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
      const lyrics = document.getElementById('edit-song-lyrics').value.trim();
      const transliteration = document.getElementById('edit-song-translit').value.trim();
      const chord = document.getElementById('edit-song-chord').value.trim();
      const method = id ? 'PUT' : 'POST';
      const endpoint = id ? `/api/songs/${id}` : '/api/songs';

      try {
        await this.apiFetch(endpoint, {
          method, body: { title, alternate_title, language, lyrics, transliteration, chord }
        });
        alert(id ? 'Song updated successfully!' : 'Song created successfully!');
        modalSongEditor.classList.add('hidden');
        this.loadSongs();
        if (id) {
          this.previewSong(id);
        }
      } catch (err) {
        alert(err.message);
      }
    });

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
      if (this.currentLanguage) params.append('language', this.currentLanguage);

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
          number.textContent = [language, song.alternate_title ? `#${song.alternate_title}` : ''].filter(Boolean).join(' · ');
          option.append(title, number);
          option.addEventListener('click', async () => {
            const loaded = await this.previewSong(song.id);
            if (loaded) this.sendWsAction('SET_SONG', { songId: song.id, slideIndex: 0 });
            document.getElementById('mobile-song-search').value = song.title;
            resultsEl.classList.add('hidden');
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
      item.innerHTML = `
        <div class="song-item-left">
          <span class="song-item-title">${this.escapeHtml(song.title)}</span>
          <div class="song-item-meta">
            ${language ? `<span class="song-item-language">${this.escapeHtml(language)}</span>` : ''}
            ${song.alternate_title ? `<span class="song-item-number">#${this.escapeHtml(song.alternate_title)}</span>` : ''}
            ${song.chord ? `<span>• ${this.escapeHtml(song.chord)}</span>` : ''}
          </div>
        </div>
      `;

      // Clicking song item opens preview in Column 2
      item.addEventListener('click', () => {
        this.previewSong(song.id);
        // On mobile, automatically switch to deck tab
        if (window.innerWidth <= 768) {
          this.switchMobileTab('panel-deck');
        }
      });

      listEl.appendChild(item);
    });
  }

  inferSongLanguage(song) {
    const text = `${song.alternate_title || ''} ${song.title || ''}`.toLowerCase();
    return ['Malayalam', 'Tamil', 'Hindi', 'Telugu', 'Nagamese', 'English']
      .find(language => text.includes(language.toLowerCase())) || '';
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
      metaEl.textContent = 'Browse the library or setlist';
      statusTag.textContent = 'Private Preview';
      statusTag.className = 'deck-status-tag';
      actionsEl.style.display = 'none';
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
          <p>Choose any song from the left column to view its verses without projecting. Click any slide to send it straight to the screen!</p>
        </div>
      `;
      return;
    }

    const isLive = this.liveState && this.liveState.currentSong && this.liveState.currentSong.id === this.cuedSong.id;
    const hasSlides = Array.isArray(this.cuedSong.slides) && this.cuedSong.slides.length > 0;

    titleEl.textContent = this.cuedSong.title;
    metaEl.textContent = `${this.cuedSong.alternate_title ? `#${this.cuedSong.alternate_title} • ` : ''}${hasSlides ? `${this.cuedSong.slides.length} Slides` : 'No lyrics added'}`;
    statusTag.textContent = isLive ? '● Live on Projector' : 'Private Preview (Not Live)';
    statusTag.className = `deck-status-tag ${isLive ? 'live' : ''}`;
    actionsEl.style.display = 'flex';
    document.getElementById('btn-cue-go-live').disabled = !hasSlides;

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
      card.addEventListener('click', () => {
        this.sendWsAction('SET_SONG', { songId: this.cuedSong.id, slideIndex: idx });
        // On mobile, switch to live tab for immediate big controls
        if (window.innerWidth <= 768) {
          this.switchMobileTab('panel-live');
        }
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
      card.className = `mobile-live-slide ${isActive ? 'active' : ''}`;
      card.innerHTML = `<span class="mobile-live-slide-label">${this.escapeHtml(slide.label || `Slide ${idx + 1}`)}${isActive ? ' · LIVE' : ''}</span><span class="mobile-live-slide-body">${lines}</span>`;
      card.addEventListener('click', () => this.sendWsAction('SET_SONG', { songId: song.id, slideIndex: idx }));
      listEl.appendChild(card);
    });
  }

  // Handle incoming live state from WebSocket
  handleLiveStateUpdate(state) {
    this.liveState = state;

    const fontSize = Number(state.fontSize) || 54;
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
            ${item.alternate_title ? `<span>#${this.escapeHtml(item.alternate_title)}</span>` : ''}
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
      meta.textContent = item.alternate_title ? `#${item.alternate_title}` : item.time;
      option.append(title, meta);
      option.addEventListener('click', async () => {
        await this.previewSong(item.id);
        document.getElementById('mobile-history-popover').classList.add('hidden');
      });
      listEl.appendChild(option);
    });
  }

  // Load Users for User Management Modal
  async loadUsersTable() {
    try {
      const data = await this.apiFetch('/api/users');
      const tbody = document.getElementById('users-table-body');
      tbody.innerHTML = '';

      (data.users || []).forEach(u => {
        const tr = document.createElement('tr');
        const roleText = u.permission >= 2 ? 'Admin' : 'Operator';
        const isSelf = this.currentUser && this.currentUser.id === u.id;

        tr.innerHTML = `
          <td><strong>${this.escapeHtml(u.username)}</strong></td>
          <td>${this.escapeHtml(u.email)}</td>
          <td><span class="badge ${u.permission >= 2 ? 'badge-accent' : ''}">${roleText}</span></td>
          <td>
            <button type="button" class="btn-secondary-sm btn-reset-user-pass">Reset Pass</button>
            ${!isSelf ? '<button type="button" class="btn-danger-sm btn-del-user">Delete</button>' : ''}
          </td>
        `;

        tr.querySelector('.btn-reset-user-pass').addEventListener('click', async () => {
          const newPass = prompt(`Enter new password for ${u.username}:`);
          if (newPass && newPass.trim()) {
            await this.apiFetch(`/api/users/${u.id}`, {
              method: 'PUT', body: { password: newPass.trim() }
            });
            alert('Password reset successfully!');
          }
        });

        const delBtn = tr.querySelector('.btn-del-user');
        if (delBtn) {
          delBtn.addEventListener('click', async () => {
            if (confirm(`Are you sure you want to delete user "${u.username}"?`)) {
              await this.apiFetch(`/api/users/${u.id}`, { method: 'DELETE' });
              this.loadUsersTable();
            }
          });
        }

        tbody.appendChild(tr);
      });
    } catch (err) {
      console.error('Failed to load users:', err);
    }
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
