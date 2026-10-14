(function () {
  const form = document.getElementById('requestLinkForm');
  const message = document.getElementById('message');
  const devLinkBox = document.getElementById('devLinkBox');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = document.getElementById('email').value.trim();
    message.textContent = 'Sending…';
    devLinkBox.style.display = 'none';

    try {
      const res = await fetch('/api/auth/request-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) {
        message.textContent = data.error || 'Something went wrong.';
        return;
      }
      message.textContent = data.message;
      if (data.devLink) {
        devLinkBox.style.display = 'block';
        devLinkBox.innerHTML =
          'Local dev mode (no SMTP configured): <a href="' +
          data.devLink +
          '" style="color: inherit;">' +
          data.devLink +
          '</a>';
      }
    } catch {
      message.textContent = 'Network error — try again.';
    }
  });
})();
