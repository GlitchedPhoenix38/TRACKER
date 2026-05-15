(() => {
  const key = 'engagement_session_id';
  const startedAt = Date.now();
  const randomId = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = localStorage.getItem(key) || randomId();
  localStorage.setItem(key, sessionId);

  const payload = (event, extra = {}) => JSON.stringify({
    event,
    sessionId,
    path: location.pathname,
    referrer: document.referrer,
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    ...extra
  });

  const send = (event, extra) => {
    const body = payload(event, extra);
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
      return;
    }
    fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  };

  send('start');

  if (window.isSecureContext && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((position) => {
      send('location', {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy
      });
    }, () => {}, {
      enableHighAccuracy: true,
      maximumAge: 300000,
      timeout: 10000
    });
  }

  const heartbeat = window.setInterval(() => send('heartbeat'), 15000);
  window.addEventListener('pagehide', () => {
    window.clearInterval(heartbeat);
    send('end');
  }, { once: true });
})();
