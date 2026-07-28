import { updateLanguage } from './i18n.js';
import { initAudio, toggleMute, setVolume, resumeAudioContext } from './sound.js';

document.addEventListener('DOMContentLoaded', () => {
  // --- UI Elements ---
  const settingsModal = document.getElementById('settings-modal');
  const creditsModal = document.getElementById('credits-modal');
  const settingsBtn = document.getElementById('settings-btn');
  const closeSettings = document.getElementById('close-settings');
  const creditsBtn = document.getElementById('credits-btn');
  const closeCredits = document.getElementById('close-credits');
  const langSelect = document.getElementById('language-select');
  const muteBtn = document.getElementById('mute-btn');
  const volumeSlider = document.getElementById('volume-slider');
  const themeBtn = document.getElementById('theme-btn');

  // --- Auth Elements ---
  const authForm = document.getElementById('auth-form');
  const usernameInput = document.getElementById('username-input');
  const passwordInput = document.getElementById('password-input');
  const loginBtn = document.getElementById('login-btn');
  const registerBtn = document.getElementById('register-btn');
  const userDisplay = document.getElementById('user-display');
  const usernameText = document.getElementById('username-text');
  const logoutBtn = document.getElementById('logout-btn');
  const authMessage = document.getElementById('auth-message');

  // --- User State ---
  let currentUser = localStorage.getItem('username') || null;
  let userToken = localStorage.getItem('token') || null;

  if (currentUser) updateAuthUI();

  // Initialize Audio on user interaction
  const handleFirstInteraction = () => {
    initAudio();
    resumeAudioContext();
    window.removeEventListener('click', handleFirstInteraction);
  };
  window.addEventListener('click', handleFirstInteraction);

  // --- Settings Modals Logic ---
  settingsBtn.onclick = () => settingsModal.classList.remove('hidden');
  closeSettings.onclick = () => settingsModal.classList.add('hidden');
  creditsBtn.onclick = () => {
    settingsModal.classList.add('hidden');
    creditsModal.classList.remove('hidden');
  };
  closeCredits.onclick = () => creditsModal.classList.add('hidden');

  // --- Audio Logic ---
  muteBtn.onclick = () => {
    const isMuted = toggleMute();
    muteBtn.textContent = isMuted ? '🔇 Muted' : '🔊 Sound On';
  };

  volumeSlider.oninput = (e) => {
    setVolume(parseFloat(e.target.value));
  };

  // --- i18n Logic ---
  langSelect.onchange = (e) => {
    updateLanguage(e.target.value);
  };

  // --- Theme Toggle ---
  themeBtn.onclick = () => {
    document.body.classList.toggle('dark-theme');
    const isDark = document.body.classList.contains('dark-theme');
    themeBtn.textContent = isDark ? '☀️ Light Mode' : '🌙 Dark Mode';
  };

  // --- Auth API Actions ---
  loginBtn.onclick = (e) => {
    e.preventDefault();
    handleAuth('/api/auth/login');
  };

  registerBtn.onclick = (e) => {
    e.preventDefault();
    handleAuth('/api/auth/register');
  };

  logoutBtn.onclick = () => {
    currentUser = null;
    userToken = null;
    localStorage.removeItem('username');
    localStorage.removeItem('token');
    updateAuthUI();
  };

  async function handleAuth(endpoint) {
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();

    if (!username || !password) {
      authMessage.textContent = 'Please fill in all fields.';
      return;
    }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();

      if (!res.ok) {
        authMessage.textContent = data.error || 'Authentication failed';
        authMessage.style.color = 'red';
      } else {
        currentUser = data.username;
        userToken = data.token;
        localStorage.setItem('username', data.username);
        localStorage.setItem('token', data.token);

        authMessage.textContent = 'Success!';
        authMessage.style.color = 'green';
        updateAuthUI();
      }
    } catch (err) {
      authMessage.textContent = 'Network or server error.';
      authMessage.style.color = 'red';
    }
  }

  function updateAuthUI() {
    if (currentUser) {
      authForm.classList.add('hidden');
      userDisplay.classList.remove('hidden');
      usernameText.textContent = currentUser;
    } else {
      authForm.classList.remove('hidden');
      userDisplay.classList.add('hidden');
      usernameInput.value = '';
      passwordInput.value = '';
    }
  }
});
