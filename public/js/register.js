document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('register-org-form');
  const orgNameInput = document.getElementById('reg-org-name');
  const usernameInput = document.getElementById('reg-username');
  const emailInput = document.getElementById('reg-email');
  const passwordInput = document.getElementById('reg-password');
  const togglePasswordBtn = document.getElementById('toggle-reg-password');
  const button = document.getElementById('btn-register-org');
  const spinner = document.getElementById('reg-spinner');
  const arrow = button.querySelector('.btn-arrow');
  const buttonText = button.querySelector('.btn-text');
  const alertBox = document.getElementById('alert-box');
  const logoInput = document.getElementById('reg-logo');

  function readLogo() {
    const file = logoInput.files[0];
    if (!file) return Promise.resolve(null);
    if (file.size > 1024 * 1024) return Promise.reject(new Error('Logo must be smaller than 1 MB.'));
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      return Promise.reject(new Error('Choose a PNG, JPG, WEBP, or GIF logo.'));
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read the selected logo.'));
      reader.readAsDataURL(file);
    });
  }

  function showAlert(message, type = 'error') {
    alertBox.textContent = message;
    alertBox.className = `alert-box ${type}`;
    alertBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  togglePasswordBtn.addEventListener('click', () => {
    const isPassword = passwordInput.type === 'password';
    passwordInput.type = isPassword ? 'text' : 'password';
    togglePasswordBtn.textContent = isPassword ? 'Hide' : 'Show';
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alertBox.className = 'alert-box hidden';

    const organizationName = orgNameInput.value.trim();
    const username = usernameInput.value.trim();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    let logoData;
    try {
      logoData = await readLogo();
    } catch (error) {
      showAlert(error.message);
      return;
    }
    if (!organizationName || !username || !email || !password) {
      showAlert('Please fill in all fields.');
      return;
    }
    if (password.length < 6) {
      showAlert('Password must be at least 6 characters.');
      return;
    }

    button.disabled = true;
    spinner.classList.remove('hidden');
    arrow.classList.add('hidden');
    buttonText.textContent = 'Registering...';

    try {
      const response = await fetch('/api/auth/register-organization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organizationName,
          username,
          email,
          password,
          logoData,
          brandColor: document.getElementById('reg-brand-color').value,
          welcomeText: document.getElementById('reg-welcome-text').value.trim()
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Registration failed.');

      localStorage.setItem('oilnwine_token', data.token);
      localStorage.setItem('oilnwine_user', JSON.stringify(data.user));
      showAlert('Organisation registered! Opening your home page...', 'success');
      setTimeout(() => { window.location.href = '/'; }, 500);
    } catch (error) {
      showAlert(error.message);
      button.disabled = false;
      spinner.classList.add('hidden');
      arrow.classList.remove('hidden');
      buttonText.textContent = 'Register Organisation';
    }
  });
});
