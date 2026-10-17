(function () {
  const PLATFORM_COLORS = {
    twitch: '#9146FF',
    kick: '#53FC18',
    youtube: '#FF0000',
    custom: '#376DF9',
  };

  function platformIcon(platform) {
    const color = PLATFORM_COLORS[platform] || PLATFORM_COLORS.custom;
    const initial = (platform || 'c').charAt(0).toUpperCase();
    return (
      '<div class="platform-icon"><svg width="20" height="20" viewBox="0 0 20 20">' +
      '<circle cx="10" cy="10" r="9" fill="none" stroke="' +
      color +
      '" stroke-width="2"/>' +
      '<text x="10" y="14" text-anchor="middle" font-size="9" font-family="sans-serif" fill="' +
      color +
      '">' +
      initial +
      '</text></svg></div>'
    );
  }

  function showToast(text) {
    const toast = document.getElementById('toast');
    toast.textContent = text;
    toast.classList.add('visible');
    setTimeout(() => toast.classList.remove('visible'), 2800);
  }

  async function api(path, options) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (res.status === 401) {
      window.location.href = '/';
      throw new Error('not authenticated');
    }
    return res;
  }

  async function loadCredentials() {
    const res = await api('/api/live/credentials');
    const data = await res.json();
    document.getElementById('rtmpUrl').textContent = data.rtmpUrl;
    document.getElementById('watchUrl').textContent = data.watchUrl;
    return data;
  }

  async function loadDestinations() {
    const res = await api('/api/destinations');
    const data = await res.json();
    const list = document.getElementById('destinationList');
    if (!data.destinations.length) {
      list.innerHTML = '<div class="empty-state">No destinations yet — add your first one below.</div>';
      return;
    }
    list.innerHTML = data.destinations
      .map(
        (d) => `
      <div class="destination-row" data-id="${d.id}">
        <div class="destination-info">
          ${platformIcon(d.platform)}
          <div class="destination-meta">
            <div class="label">${d.label}</div>
            <div class="url">${d.rtmpUrl} • key ${d.streamKeyMasked}</div>
          </div>
        </div>
        <div class="destination-actions">
          <button class="toggle" data-on="${d.enabled}" data-action="toggle" data-id="${d.id}">
            <span class="knob"></span>
          </button>
          <button class="btn btn-danger" data-action="delete" data-id="${d.id}">Remove</button>
        </div>
      </div>`
      )
      .join('');
  }

  async function loadStatus() {
    const res = await api('/api/live/status');
    const data = await res.json();
    const pill = document.getElementById('statusPill');
    if (data.live) {
      pill.classList.add('live');
      pill.innerHTML = '<span class="dot"></span> Live';
    } else {
      pill.classList.remove('live');
      pill.innerHTML = '<span class="dot"></span> Offline';
    }
  }

  document.getElementById('addDestinationForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const platform = document.getElementById('platform').value;
    const label = document.getElementById('label').value.trim();
    const rtmpUrl = document.getElementById('rtmpUrl2').value.trim();
    const streamKey = document.getElementById('streamKey').value.trim();

    const res = await api('/api/destinations', {
      method: 'POST',
      body: JSON.stringify({ platform, label, rtmpUrl, streamKey }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast((data.errors && data.errors[0]) || 'Could not add destination.');
      return;
    }
    showToast(`${label} added.`);
    event.target.reset();
    await loadDestinations();
  });

  document.getElementById('destinationList').addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;

    if (btn.dataset.action === 'delete') {
      await api(`/api/destinations/${id}`, { method: 'DELETE' });
      showToast('Destination removed.');
      await loadDestinations();
      return;
    }

    if (btn.dataset.action === 'toggle') {
      const nextEnabled = btn.dataset.on !== 'true';
      await api(`/api/destinations/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      await loadDestinations();
    }
  });

  document.getElementById('goLiveBtn').addEventListener('click', async () => {
    const res = await api('/api/live/go', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Could not arm destinations.');
      return;
    }
    showToast(`Armed ${data.destinationsArmed} destination(s). Start pushing from OBS or the browser now.`);
  });

  let whip = null;
  let localStream = null;
  document.getElementById('browserGoLiveBtn').addEventListener('click', async () => {
    const btn = document.getElementById('browserGoLiveBtn');
    const preview = document.getElementById('browserPreview');

    if (whip) {
      await whip.stop();
      whip = null;
      if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
        localStream = null;
      }
      preview.style.display = 'none';
      btn.textContent = 'Go live from browser';
      showToast('Stopped browser broadcast.');
      return;
    }

    try {
      // "Go live from browser" is a separate ingest path from OBS/RTMP
      // (WHIP straight into MediaMTX), but it still needs the SAME arming
      // step the "Arm destinations" button performs: MediaMTX's
      // runOnReady hook (fanout.sh) only pushes to Owncast/Twitch/Kick/etc
      // if the destinations file it reads has already been written by
      // POST /api/live/go. Without this call, WHIP publish still succeeds
      // and /api/live/status still flips to "live" (MediaMTX really is
      // receiving the stream) while fanout.sh silently exits with nothing
      // armed yet - the broadcaster would see "Live" and no viewer would
      // ever see anything, with no error anywhere. Previously this
      // button skipped straight to getUserMedia()/WHIP publish and never
      // called /api/live/go at all.
      const goRes = await api('/api/live/go', { method: 'POST' });
      const goData = await goRes.json();
      if (!goRes.ok) {
        showToast(goData.error || 'Could not arm destinations.');
        return;
      }

      const creds = await (await api('/api/live/credentials')).json();
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      preview.srcObject = localStream;
      preview.style.display = 'block';

      whip = new WhipPublisher(creds.whipUrl);
      await whip.publish(localStream);
      btn.textContent = 'Stop browser broadcast';
      showToast(`Broadcasting from browser via WHIP. Armed ${goData.destinationsArmed} destination(s).`);
    } catch (err) {
      showToast('Could not start browser broadcast: ' + err.message);
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  });

  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.copy);
      navigator.clipboard.writeText(target.textContent);
      showToast('Copied.');
    });
  });

  (async function init() {
    await loadCredentials();
    await loadDestinations();
    await loadStatus();
    setInterval(loadStatus, 5000);
  })();
})();
