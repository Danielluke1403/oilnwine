document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('login-form');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const togglePasswordBtn = document.getElementById('toggle-password');
  const alertBox = document.getElementById('alert-box');
  const submitBtn = document.getElementById('btn-login');
  const spinner = document.getElementById('login-spinner');
  const btnArrow = submitBtn.querySelector('.btn-arrow');
  const btnText = submitBtn.querySelector('.btn-text');

  // If already logged in, check auth and redirect
  const token = localStorage.getItem('oilnwine_token');
  if (token) {
    fetch('/api/auth/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(res => {
      if (res.ok) {
        window.location.href = '/controller';
      } else {
        localStorage.removeItem('oilnwine_token');
      }
    })
    .catch(() => {});
  }

  // Toggle password visibility
  togglePasswordBtn.addEventListener('click', () => {
    const isPassword = passwordInput.getAttribute('type') === 'password';
    passwordInput.setAttribute('type', isPassword ? 'text' : 'password');
    togglePasswordBtn.textContent = isPassword ? 'Hide' : 'Show';
  });

  function showAlert(msg, type = 'error') {
    alertBox.textContent = msg;
    alertBox.className = `alert-box ${type}`;
    alertBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function hideAlert() {
    alertBox.className = 'alert-box hidden';
    alertBox.textContent = '';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert();

    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (!username || !password) {
      showAlert('Please enter both username and password.');
      return;
    }

    // Set loading state
    submitBtn.disabled = true;
    spinner.classList.remove('hidden');
    btnArrow.classList.add('hidden');
    btnText.textContent = 'Signing in...';

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Login failed. Please check your credentials.');
      }

      // Store token and user
      localStorage.setItem('oilnwine_token', data.token);
      localStorage.setItem('oilnwine_user', JSON.stringify(data.user));

      showAlert('Signed in. Opening controller...', 'success');
      setTimeout(() => {
        window.location.href = '/controller';
      }, 500);

    } catch (err) {
      showAlert(err.message, 'error');
      submitBtn.disabled = false;
      spinner.classList.add('hidden');
      btnArrow.classList.remove('hidden');
      btnText.textContent = 'Sign in';
    }
  });
});
