(function () {
  'use strict';
  var MESSAGES = {
    invalid: 'Incorrect password.',
    rate: 'Too many attempts. Try again in a minute.',
    expired: 'Your session expired. Please sign in again.',
  };
  var code = new URLSearchParams(location.search).get('error');
  if (!code) return;
  var box = document.getElementById('login-error');
  var input = document.getElementById('password');
  if (!box) return;
  box.textContent = MESSAGES[code] || 'Sign in failed. Please try again.';
  box.classList.remove('hidden');
  if (input) {
    input.setAttribute('aria-invalid', code === 'expired' ? 'false' : 'true');
    input.setAttribute('aria-describedby', 'login-error');
  }
})();
