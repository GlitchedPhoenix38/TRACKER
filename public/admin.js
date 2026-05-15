const formatDuration = (seconds = 0) => {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
};

const formatDate = (value) => value ? new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short'
}).format(new Date(value)) : 'No data';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
})[char]);

const formatCoordinate = (value, axis) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  const suffix = axis === 'lat'
    ? number >= 0 ? 'N' : 'S'
    : number >= 0 ? 'E' : 'W';
  return `${Math.abs(number).toFixed(5)} ${suffix}`;
};

const formatAccuracy = (value) => {
  const meters = Number(value);
  if (!Number.isFinite(meters)) return '';
  if (meters >= 1000) return `Accuracy ~${(meters / 1000).toFixed(1)} km`;
  return `Accuracy ~${Math.round(meters)} m`;
};

const colors = ['#1e40af', '#0f766e', '#b45309', '#7c3aed', '#be123c', '#475569', '#15803d', '#0369a1'];

function drawBarChart(canvas, rows, options = {}) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const pad = 36;
  const max = Math.max(1, ...rows.map((row) => row.value));
  ctx.clearRect(0, 0, width, height);
  ctx.font = '13px Fira Sans, system-ui, sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.fillText(options.empty && rows.length === 0 ? options.empty : '', pad, height / 2);
  if (!rows.length) return;

  const barWidth = Math.max(18, (width - pad * 2) / rows.length - 10);
  rows.forEach((row, index) => {
    const x = pad + index * ((width - pad * 2) / rows.length) + 5;
    const barHeight = Math.max(4, (row.value / max) * (height - 90));
    const y = height - pad - barHeight;
    ctx.fillStyle = colors[index % colors.length];
    ctx.fillRect(x, y, barWidth, barHeight);
    ctx.fillStyle = '#0f172a';
    ctx.fillText(row.value, x, y - 8);
    ctx.save();
    ctx.translate(x + 2, height - 14);
    ctx.rotate(-0.35);
    ctx.fillStyle = '#475569';
    ctx.fillText(String(row.label).slice(0, 16), 0, 0);
    ctx.restore();
  });
}

function drawLineChart(canvas, rows) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const pad = 38;
  const max = Math.max(1, ...rows.map((row) => row.value));
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, height - pad);
  ctx.lineTo(width - pad, height - pad);
  ctx.stroke();

  if (!rows.length) {
    ctx.font = '13px Fira Sans, system-ui, sans-serif';
    ctx.fillStyle = '#64748b';
    ctx.fillText('No visits recorded yet', pad, height / 2);
    return;
  }

  const points = rows.map((row, index) => {
    const x = rows.length === 1 ? width / 2 : pad + (index / (rows.length - 1)) * (width - pad * 2);
    const y = height - pad - (row.value / max) * (height - 82);
    return [x, y, row];
  });

  ctx.strokeStyle = '#1e40af';
  ctx.lineWidth = 3;
  ctx.beginPath();
  points.forEach(([x, y], index) => index ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.stroke();
  points.forEach(([x, y, row]) => {
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0f172a';
    ctx.font = '12px Fira Sans, system-ui, sans-serif';
    ctx.fillText(row.value, x + 8, y - 8);
  });
}

function project(lat, lon) {
  return {
    x: ((lon + 180) / 360) * 960,
    y: ((90 - lat) / 180) * 480
  };
}

function renderMap(points) {
  const group = document.querySelector('#mapPoints');
  group.innerHTML = '';
  document.querySelector('#mapCount').textContent = `${points.length} plotted`;
  points.forEach((point) => {
    const { x, y } = project(point.latitude, point.longitude);
    const coords = `${formatCoordinate(point.latitude, 'lat')}, ${formatCoordinate(point.longitude, 'lon')}`;
    const accuracy = formatAccuracy(point.location_accuracy);
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', x);
    circle.setAttribute('cy', y);
    circle.setAttribute('r', Math.min(18, 5 + point.value * 2));
    circle.setAttribute('tabindex', '0');
    circle.innerHTML = `<title>${escapeHtml(point.label)}: ${escapeHtml(coords)}${accuracy ? `, ${escapeHtml(accuracy)}` : ''} - ${point.value} visit${point.value === 1 ? '' : 's'}</title>`;
    group.appendChild(circle);
  });
}

function renderRows(visits) {
  const tbody = document.querySelector('#visitRows');
  document.querySelector('#logCount').textContent = `${visits.length} rows`;
  tbody.innerHTML = visits.map((visit) => {
    const place = [visit.city, visit.region, visit.country].filter(Boolean).join(', ') || 'Unknown';
    const hasCoordinates = Number.isFinite(Number(visit.latitude)) && Number.isFinite(Number(visit.longitude));
    const coords = hasCoordinates
      ? `${formatCoordinate(visit.latitude, 'lat')}, ${formatCoordinate(visit.longitude, 'lon')}`
      : '';
    const accuracy = formatAccuracy(visit.location_accuracy);
    const source = visit.location_source === 'browser' ? 'Browser GPS' : 'IP/host estimate';
    const mapUrl = hasCoordinates
      ? `https://www.google.com/maps?q=${encodeURIComponent(`${visit.latitude},${visit.longitude}`)}`
      : '';
    const locationTitle = visit.location_source === 'browser' && hasCoordinates ? coords : place;
    const locationMeta = hasCoordinates
      ? `${visit.location_source === 'browser' ? source : `${coords} - ${source}`}${accuracy ? `, ${accuracy}` : ''}`
      : '';
    const location = `
      <strong>${escapeHtml(locationTitle)}</strong>
      ${locationMeta ? `<span>${escapeHtml(locationMeta)}</span>` : ''}
      ${hasCoordinates ? `<a href="${mapUrl}" target="_blank" rel="noopener">Open in map</a>` : ''}
    `;
    return `
      <tr>
        <td>${formatDate(visit.started_at)}</td>
        <td>${escapeHtml(visit.ip)}</td>
        <td class="location-cell">${location}</td>
        <td>${escapeHtml(visit.device)} / ${escapeHtml(visit.os)}</td>
        <td>${escapeHtml(visit.browser)}</td>
        <td>${formatDuration(visit.duration_seconds)}</td>
      </tr>
    `;
  }).join('');
}

let refreshInFlight = false;

function setLiveStatus(text, state = 'ok') {
  const status = document.querySelector('#liveStatus');
  if (!status) return;
  status.textContent = text;
  status.dataset.state = state;
}

async function refresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  setLiveStatus('Updating...', 'loading');

  try {
    const response = await fetch(`/api/admin/analytics?ts=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) {
      location.href = '/admin';
      return;
    }
    const data = await response.json();
    document.querySelector('#totalVisits').textContent = data.totals.total_visits || 0;
    document.querySelector('#uniqueVisitors').textContent = data.totals.unique_visitors || 0;
    document.querySelector('#avgDuration').textContent = formatDuration(data.totals.avg_duration || 0);
    document.querySelector('#lastVisit').textContent = formatDate(data.totals.last_visit);
    renderMap(data.mapPoints);
    renderRows(data.recentVisits);
    drawLineChart(document.querySelector('#timelineChart'), data.timeline);
    drawBarChart(document.querySelector('#countryChart'), data.countries, { empty: 'No geographic data yet' });
    drawBarChart(document.querySelector('#deviceChart'), data.devices, { empty: 'No device data yet' });
    drawBarChart(document.querySelector('#browserChart'), data.browsers, { empty: 'No browser data yet' });
    setLiveStatus(`Live - updated ${new Date().toLocaleTimeString()}`, 'ok');
  } catch {
    setLiveStatus('Live paused - reconnecting', 'error');
  } finally {
    refreshInFlight = false;
  }
}

refresh();
setInterval(refresh, 3000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
