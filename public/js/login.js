document.addEventListener('DOMContentLoaded', () => {
  const loginForm = document.getElementById('login-form');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const togglePasswordBtn = document.getElementById('toggle-password');
  const btnLogin = document.getElementById('btn-login');
  const loginSpinner = document.getElementById('login-spinner');
  const loginArrow = btnLogin.querySelector('.btn-arrow');
  const loginText = btnLogin.querySelector('.btn-text');
  const alertBox = document.getElementById('alert-box');
  const pathSlug = window.location.pathname.match(/^\/login\/([^/]+)\/?$/)?.[1];
  const organizationSlug = new URLSearchParams(window.location.search).get('org') || (pathSlug ? decodeURIComponent(pathSlug) : null);

  if (organizationSlug) {
    fetch(`/api/organization-brand?slug=${encodeURIComponent(organizationSlug)}`)
      .then(response => response.ok ? response.json() : Promise.reject())
      .then(({ organization }) => {
        document.title = `Sign in | ${organization.name}`;
        document.getElementById('brand-title').textContent = organization.name;
        document.getElementById('card-title').textContent = `Sign in to ${organization.name}`;
        document.documentElement.style.setProperty('--login-blue', organization.brandColor || '#2563eb');
        const welcome = document.getElementById('brand-welcome');
        if (organization.welcomeText) {
          welcome.textContent = organization.welcomeText;
          welcome.classList.remove('hidden');
        }
        if (organization.logoData) {
          document.getElementById('brand-logo').src = organization.logoData;
          document.getElementById('brand-icon').classList.remove('hidden');
          let favicon = document.querySelector('link[rel="icon"]');
          if (!favicon) {
            favicon = document.createElement('link');
            favicon.rel = 'icon';
            document.head.appendChild(favicon);
          }
          favicon.href = organization.logoData;
        }
      })
      .catch(() => showAlert('Organisation sign-in page not found. You can still sign in from the main page.'));
  }

  const token = localStorage.getItem('oilnwine_token');
  if (token) {
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(res => {
        if (res.ok) window.location.href = '/';
        else localStorage.removeItem('oilnwine_token');
      })
      .catch(() => {});
  }

  function showAlert(msg, type = 'error') {
    alertBox.textContent = msg;
    alertBox.className = `alert-box ${type}`;
    alertBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  togglePasswordBtn.addEventListener('click', () => {
    const isPassword = passwordInput.type === 'password';
    passwordInput.type = isPassword ? 'text' : 'password';
    togglePasswordBtn.textContent = isPassword ? 'Hide' : 'Show';
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    alertBox.className = 'alert-box hidden';

    const username = usernameInput.value.trim();
    const password = passwordInput.value;
    if (!username || !password) return showAlert('Please enter both username and password.');

    btnLogin.disabled = true;
    loginSpinner.classList.remove('hidden');
    loginArrow.classList.add('hidden');
    loginText.textContent = 'Signing in...';

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, organizationSlug })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Login failed.');

      localStorage.setItem('oilnwine_token', data.token);
      localStorage.setItem('oilnwine_user', JSON.stringify(data.user));
      showAlert('Signed in. Opening your home page...', 'success');
      setTimeout(() => { window.location.href = '/'; }, 400);
    } catch (err) {
      showAlert(err.message);
      btnLogin.disabled = false;
      loginSpinner.classList.add('hidden');
      loginArrow.classList.remove('hidden');
      loginText.textContent = 'Sign in';
    }
  });
});
