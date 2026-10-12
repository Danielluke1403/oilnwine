// Projector Display Client for Oil & Wine Presentation System

class DisplayClient {
  constructor() {
    this.ws = null;
    this.state = null;
    this.idleTimer = null;
    this.reconnectTimer = null;
    this.displaySizeTimer = null;
    this.overflowReports = new Map();
    this.overflowSignatures = new Set();
    
    // DOM Elements
    this.slideContent = document.getElementById('slide-content');
    this.metaSongTitle = document.getElementById('meta-song-title');
    this.metaStanza = document.getElementById('meta-stanza');
    this.metaBadge = document.getElementById('meta-badge');
    this.connectionStatus = document.getElementById('connection-status');
    this.btnFullscreen = document.getElementById('btn-fullscreen');
    this.iconExpand = this.btnFullscreen.querySelector('.icon-expand');
    this.iconCompress = this.btnFullscreen.querySelector('.icon-compress');

    this.init();
  }

  init() {
    this.connectWebSocket();
    this.setupEventListeners();
    this.setupIdleCursor();
  }

  connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.updateConnectionStatus(true);
        this.sendDisplaySize();
        document.fonts.ready.then(() => this.sendDisplaySize());
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'STATE_UPDATE' && msg.state) {
            this.handleStateUpdate(msg.state);
          }
        } catch (e) {
          console.error('Display WebSocket parse error:', e);
        }
      };

      this.ws.onclose = () => {
        this.updateConnectionStatus(false);
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.updateConnectionStatus(false);
        this.ws.close();
      };

    } catch (err) {
      this.updateConnectionStatus(false);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (!this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connectWebSocket();
      }, 2500);
    }
  }

  sendDisplaySize() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const lyricArea = document.getElementById('lyrics-wrapper');
      const contentWidth = lyricArea ? lyricArea.clientWidth : Math.floor(window.innerWidth * 0.82);
      const contentHeight = lyricArea ? lyricArea.clientHeight : Math.floor(window.innerHeight * 0.72);
      const fontSize = Number(this.state && this.state.fontSize) || 54;
      const fontFamily = (this.state && this.state.fontFamily) || 'Outfit';
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      context.font = `${fontSize}px "${fontFamily}"`;
      const sample = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      const charWidthRatio = context.measureText(sample).width / (sample.length * fontSize);
      this.ws.send(JSON.stringify({
        action: 'DISPLAY_SIZE',
        width: window.innerWidth,
        height: window.innerHeight,
        contentWidth,
        contentHeight,
        charWidthRatio
      }));
    }
  }

  updateConnectionStatus(isConnected) {
    if (isConnected) {
      this.connectionStatus.classList.remove('disconnected');
      this.connectionStatus.querySelector('.status-label').textContent = 'Live';
    } else {
      this.connectionStatus.classList.add('disconnected');
      this.connectionStatus.querySelector('.status-label').textContent = 'Reconnecting...';
    }
  }

  handleStateUpdate(newState) {
    const prevState = this.state;
    this.state = newState;
    if (prevState && (
      prevState.displayWidth !== newState.displayWidth ||
      prevState.displayHeight !== newState.displayHeight ||
      prevState.fontSize !== newState.fontSize ||
      String(prevState.currentSong?.id || '') !== String(newState.currentSong?.id || '')
    )) {
      this.overflowReports.clear();
      this.overflowSignatures.clear();
    }

    // 1. Update Visual Styles & Theme
    this.applyStyles(newState);
    if (prevState && (prevState.fontSize !== newState.fontSize || prevState.fontFamily !== newState.fontFamily)) {
      document.fonts.load(`${newState.fontSize || 54}px "${newState.fontFamily || 'Outfit'}"`)
        .then(() => this.sendDisplaySize())
        .catch(() => this.sendDisplaySize());
    }

    // 2. Blackout & Clear States
    if (newState.isBlank) {
      document.body.classList.add('state-blank');
    } else {
      document.body.classList.remove('state-blank');
    }

    if (newState.isClear) {
      document.body.classList.add('state-clear');
    } else {
      document.body.classList.remove('state-clear');
    }

    // 4. Render Lyrics / Slide Content
    this.renderSlide(newState, prevState);
  }

  applyStyles(state) {
    // Theme
    const themes = ['theme-clean-white', 'theme-sanctuary', 'theme-pure-black', 'theme-cathedral', 'theme-warm-ember'];
    themes.forEach(t => document.body.classList.remove(t));
    document.body.classList.add(`theme-${state.theme || 'clean-white'}`);

    // Font size
    const root = document.documentElement;
    if (state.fontSize) {
      root.style.setProperty('--display-font-size', `${state.fontSize}px`);
    }

    // Font family
    if (state.fontFamily) {
      root.style.setProperty('--display-font', `'${state.fontFamily}', 'Plus Jakarta Sans', sans-serif`);
    }

    // Text alignment
    if (state.textAlign) {
      root.style.setProperty('--display-text-align', state.textAlign);
    }
  }

  renderSlide(state, prevState) {
    const { currentSong, activeSlideIndex, showTranslit } = state;

    // Check if there is an active song
    if (!currentSong || !currentSong.slides || currentSong.slides.length === 0) {
      this.renderStandby();
      return;
    }

    const slide = currentSong.slides[activeSlideIndex] || currentSong.slides[0];
    if (!slide) {
      this.renderStandby();
      return;
    }

    // Slide transition animation
    this.slideContent.classList.add('transition-out');

    setTimeout(() => {
      // Build HTML for slide lines
      let html = '';
      const pairedLines = slide.pairedLines || [];

      if (pairedLines.length > 0) {
        pairedLines.forEach(item => {
          html += `<div class="lyric-line-group">`;
          html += `  <div class="lyric-main">${this.escapeHtml(item.text)}</div>`;
          if (showTranslit && item.translit) {
            html += `  <div class="lyric-translit">${this.escapeHtml(item.translit)}</div>`;
          }
          html += `</div>`;
        });
      } else if (slide.lines && slide.lines.length > 0) {
        slide.lines.forEach(line => {
          html += `<div class="lyric-line-group">`;
          html += `  <div class="lyric-main">${this.escapeHtml(line)}</div>`;
          html += `</div>`;
        });
      }

      this.slideContent.innerHTML = html;
      this.slideContent.classList.remove('transition-out');
      this.slideContent.classList.add('transition-in');

      // Update meta badge
      const numPrefix = currentSong.alternate_title ? `#${currentSong.alternate_title} • ` : '';
      this.metaSongTitle.textContent = `${numPrefix}${currentSong.title}`;
      this.metaStanza.textContent = `${slide.label} (${activeSlideIndex + 1}/${currentSong.slides.length})`;
      this.metaBadge.classList.remove('hidden');
      requestAnimationFrame(() => this.checkSlideFit(currentSong));
      document.fonts.ready.then(() => this.checkSlideFit(currentSong));

    }, 150);
  }

  checkSlideFit(song) {
    const lyricArea = document.getElementById('lyrics-wrapper');
    if (!song || !lyricArea || !this.slideContent) return;
    const availableHeight = lyricArea.clientHeight;
    const renderedHeight = this.slideContent.scrollHeight;
    if (!availableHeight || renderedHeight <= availableHeight * 0.94) return;

    const fontSize = Number(this.state && this.state.fontSize) || 54;
    const key = `${song.id}:${fontSize}`;
    const attempts = this.overflowReports.get(key) || 0;
    if (attempts >= 6 || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const signature = `${key}:${this.state.activeSlideIndex}:${song.slides.length}:${Math.round(renderedHeight)}`;
    if (this.overflowSignatures.has(signature)) return;
    this.overflowSignatures.add(signature);
    this.overflowReports.set(key, attempts + 1);
    this.ws.send(JSON.stringify({
      action: 'DISPLAY_OVERFLOW',
      songId: song.id,
      fontSize,
      renderedHeight,
      availableHeight
    }));
  }

  renderStandby() {
    this.slideContent.innerHTML = `
      <div class="standby-screen">
        <img class="standby-logo" src="/assets/oil-n-wine-logo.webp" alt="Oil N Wine">
        <h1 class="standby-title">Oil N Wine</h1>
        <p class="standby-subtitle">Waiting for operator to project a song...</p>
      </div>
    `;
    this.metaBadge.classList.add('hidden');
  }

  escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  setupEventListeners() {
    window.addEventListener('resize', () => {
      clearTimeout(this.displaySizeTimer);
      this.displaySizeTimer = setTimeout(() => this.sendDisplaySize(), 200);
    });

    // Fullscreen toggle button
    this.btnFullscreen.addEventListener('click', () => {
      this.toggleFullscreen();
    });

    // Keyboard shortcuts: F for Fullscreen, Escape
    window.addEventListener('keydown', (e) => {
      if (e.key === 'f' || e.key === 'F') {
        this.toggleFullscreen();
      }
    });

    // Double click to toggle fullscreen
    document.addEventListener('dblclick', (e) => {
      if (e.target.closest('#display-controls')) return;
      this.toggleFullscreen();
    });

    // Fullscreen change listener to update icons
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement) {
        this.iconExpand.classList.add('hidden');
        this.iconCompress.classList.remove('hidden');
      } else {
        this.iconExpand.classList.remove('hidden');
        this.iconCompress.classList.add('hidden');
      }
    });
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        console.warn('Fullscreen request blocked:', err.message);
      });
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  }

  setupIdleCursor() {
    const resetIdle = () => {
      document.body.classList.remove('cursor-hidden');
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        document.body.classList.add('cursor-hidden');
      }, 2500);
    };

    window.addEventListener('mousemove', resetIdle);
    window.addEventListener('mousedown', resetIdle);
    window.addEventListener('touchstart', resetIdle);
    resetIdle();
  }
}

// Instantiate on load
document.addEventListener('DOMContentLoaded', () => {
  window.displayApp = new DisplayClient();
});
