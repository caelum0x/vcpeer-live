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

  const DEST_STATE_LABEL = {
    pushing: 'Receiving',
    retrying: 'Reconnecting',
    failed: 'Not receiving',
    stopped: 'Idle',
  };

  function destStatusDot(entry) {
    const state = (entry && entry.state) || 'stopped';
    const label = DEST_STATE_LABEL[state] || 'Idle';
    return `<span class="dest-status dest-status--${state}" title="${label}"><span class="dot"></span>${label}</span>`;
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
            <div class="dest-status" data-dest-status="${d.id}" style="display: none;"></div>
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

    const byId = {};
    (data.destinations || []).forEach((entry) => {
      byId[entry.id] = entry;
    });
    document.querySelectorAll('[data-dest-status]').forEach((el) => {
      const entry = byId[el.dataset.destStatus];
      if (!data.live || !entry) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
      }
      el.style.display = '';
      el.innerHTML = destStatusDot(entry);
    });
  }

  // Static, well-known ingest URLs - Kick and YouTube's public APIs don't
  // expose a raw stream key to third-party apps the way Twitch's Helix
  // `GET /streams/key` does, so for those two platforms this is as far
  // as "auto-fill" goes: the server URL fills in, the user still pastes
  // their own key from the platform's dashboard. Twitch gets the same
  // URL autofill here PLUS the full OAuth key fetch via "Connect Twitch".
  const PLATFORM_DEFAULT_URLS = {
    twitch: 'rtmp://live.twitch.tv/app',
    kick: 'rtmp://fa723fc1b171.global-contribute.live-video.net/app',
    youtube: 'rtmp://a.rtmp.youtube.com/live2',
  };

  document.getElementById('platform').addEventListener('change', (event) => {
    const urlField = document.getElementById('rtmpUrl2');
    const defaultUrl = PLATFORM_DEFAULT_URLS[event.target.value];
    // Only overwrite if the field is empty or still holds a previous
    // platform's default - never clobber a URL the user typed by hand.
    const isEmptyOrDefault = !urlField.value || Object.values(PLATFORM_DEFAULT_URLS).includes(urlField.value);
    if (defaultUrl && isEmptyOrDefault) {
      urlField.value = defaultUrl;
    }
  });

  async function initTwitchConnect() {
    const row = document.getElementById('connectTwitchRow');
    const btn = document.getElementById('connectTwitchBtn');
    try {
      const res = await api('/api/oauth/twitch/status');
      const data = await res.json();
      row.style.display = data.configured ? 'block' : 'none';
    } catch {
      row.style.display = 'none';
    }

    btn.addEventListener('click', () => {
      window.location.href = '/api/oauth/twitch/start';
    });

    // Returning from the Twitch OAuth redirect: pick up the one-time
    // pending credentials and fill the add-destination form, but do NOT
    // auto-submit - the user still reviews/labels it before it's saved
    // (and saving is what actually encrypts+persists the key).
    const params = new URLSearchParams(window.location.search);
    if (params.get('twitchConnected') === '1') {
      try {
        const pendingRes = await api('/api/oauth/twitch/pending');
        const pendingData = await pendingRes.json();
        if (pendingData.ok) {
          document.getElementById('platform').value = pendingData.platform;
          document.getElementById('rtmpUrl2').value = pendingData.rtmpUrl;
          document.getElementById('streamKey').value = pendingData.streamKey;
          document.getElementById('label').focus();
          showToast('Twitch connected — review the label below, then Add destination.');
        }
      } catch {
        showToast('Could not retrieve Twitch credentials — try Connect Twitch again.');
      }
      history.replaceState(null, '', '/live');
    } else if (params.get('twitchError')) {
      showToast('Twitch connect failed (' + params.get('twitchError') + '). Use the manual form below instead.');
      history.replaceState(null, '', '/live');
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
    await loadHistory();
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
      await loadHistory();
    } catch (err) {
      showToast('Could not start browser broadcast: ' + err.message);
    }
  });

  function formatDuration(ms) {
    if (ms == null) return 'in progress';
    const totalMinutes = Math.round(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) return `${minutes}m`;
    return `${hours}h ${minutes}m`;
  }

  function formatClock(iso) {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  async function loadHistory() {
    const summary = document.getElementById('historySummary');
    const list = document.getElementById('historyList');
    const res = await api('/api/broadcasts');
    const data = await res.json();
    const broadcasts = data.broadcasts || [];

    if (!broadcasts.length) {
      summary.textContent = '';
      list.innerHTML = '<div class="empty-state">No broadcasts yet - go live once and it will show up here.</div>';
      return;
    }

    summary.textContent = `${broadcasts.length} broadcast(s) · ${data.totalHours.toFixed(1)} hour(s) streamed total`;

    list.innerHTML = broadcasts
      .map((b) => {
        const destRows = (b.destinationsSnapshot || [])
          .map((d) => destStatusDot(d) + ` <span style="color: var(--ds-neutral-300); font-size: 0.78rem;">${d.label}</span>`)
          .join(' &nbsp; ');
        return `
      <div class="destination-row" style="align-items: flex-start;">
        <div class="destination-info" style="flex-direction: column; align-items: flex-start; gap: 4px;">
          <div class="destination-meta">
            <div class="label">${formatClock(b.startedAt)} ${b.endedAt ? '' : '<span style="color: var(--ds-success);">(live now)</span>'}</div>
            <div class="url">${formatDuration(b.durationMs)} · ${b.destinationsArmed} destination(s) armed</div>
            ${destRows ? `<div style="margin-top: 6px;">${destRows}</div>` : ''}
          </div>
        </div>
      </div>`;
      })
      .join('');
  }

  document.getElementById('stopBroadcastBtn').addEventListener('click', async () => {
    const res = await api('/api/live/stop', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Could not stop the broadcast.');
      return;
    }
    if (!data.broadcast) {
      showToast('No open broadcast to stop.');
    } else {
      showToast('Broadcast marked finished in your history.');
    }
    await loadHistory();
  });

  function formatSessionDate(iso) {
    if (!iso) return 'unknown date';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  async function loadSessions() {
    const list = document.getElementById('sessionList');
    const res = await api('/api/auth/sessions');
    const data = await res.json();
    if (!data.sessions || !data.sessions.length) {
      list.innerHTML = '<div class="empty-state">No active sessions.</div>';
      return;
    }
    list.innerHTML = data.sessions
      .map(
        (s) => `
      <div class="destination-row" data-session-id="${s.id}">
        <div class="destination-info">
          <div class="destination-meta">
            <div class="label">${s.current ? 'This device' : 'Other device'}</div>
            <div class="url">Signed in ${formatSessionDate(s.createdAt)} • expires ${formatSessionDate(s.expiresAt)}</div>
          </div>
        </div>
        <div class="destination-actions">
          ${s.current ? '<span class="hint" style="margin: 0;">current</span>' : `<button class="btn btn-danger" data-action="revoke-session" data-id="${s.id}">Revoke</button>`}
        </div>
      </div>`
      )
      .join('');
  }

  document.getElementById('sessionList').addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-action="revoke-session"]');
    if (!btn) return;
    const res = await api(`/api/auth/sessions/${btn.dataset.id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
      showToast('Could not revoke that session.');
      return;
    }
    showToast('Session revoked.');
    await loadSessions();
  });

  document.getElementById('regenerateKeyBtn').addEventListener('click', async () => {
    const confirmed = window.confirm(
      'Regenerate your stream key? The current server/key stops working immediately - ' +
        'you will need to update OBS (or the browser go-live page) with the new one.'
    );
    if (!confirmed) return;
    const res = await api('/api/live/credentials/regenerate', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Could not regenerate the stream key.');
      return;
    }
    document.getElementById('rtmpUrl').textContent = data.rtmpUrl;
    document.getElementById('watchUrl').textContent = data.watchUrl;
    showToast('Stream key regenerated. The old one no longer works - update OBS with the new server URL above.');
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
    await loadSessions();
    await loadHistory();
    await initTwitchConnect();
    setInterval(loadStatus, 5000);
  })();
})();
