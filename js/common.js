export const $ = (id) => document.getElementById(id);

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'
  }[c]));
}

export function friendlyError(error) {
  const raw = error?.message || String(error || 'Something went wrong');
  return raw
    .replace(/^.*?: /, '')
    .replace(/PGRST\d+\s*/g, '')
    .trim();
}

export function setMessage(el, text = '', kind = '') {
  el.textContent = text;
  el.className = `notice ${kind}`.trim();
  el.hidden = !text;
}

export function phaseLabel(phase) {
  return ({
    lobby: 'Lobby', slogan: 'Guess the Brand', slogan_reveal: 'Brand Reveal',
    logo_wait: 'Logo Challenge Ready', logo_active: 'Logo Timer',
    logo_reveal: 'Logo Reveal', finished: 'Finished'
  })[phase] || phase;
}

export function scoreRows(leaderboard = [], limit = null) {
  const rows = limit ? leaderboard.slice(0, limit) : leaderboard;
  if (!rows.length) return '<div class="empty">No scores yet.</div>';
  return `<div class="score-list">${rows.map((p, i) => `
    <div class="score-row">
      <div class="rank">${i + 1}</div>
      <div class="score-name">${escapeHtml(p.name)}</div>
      <div class="score-split"><span>S ${p.slogan_score}</span><span>L ${p.logo_score}</span></div>
      <div class="score-total">${p.total_score}</div>
    </div>`).join('')}</div>`;
}

export function namesHtml(names = [], emptyText = 'No correct answers this round.') {
  if (!names.length) return `<div class="empty">${escapeHtml(emptyText)}</div>`;
  return `<div class="name-chips">${names.map(n => `<span>${escapeHtml(n)}</span>`).join('')}</div>`;
}

export function computeServerOffset(serverNow) {
  return serverNow ? new Date(serverNow).getTime() - Date.now() : 0;
}

export function remainingMs(deadline, serverOffset = 0) {
  if (!deadline) return 0;
  return Math.max(0, new Date(deadline).getTime() - (Date.now() + serverOffset));
}

export function formatCountdown(ms) {
  if (ms <= 0) return '0.0';
  return (ms / 1000).toFixed(1);
}

export function makeShareUrl(code) {
  const u = new URL('./', window.location.href);
  u.searchParams.set('game', code);
  return u.toString();
}

export async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const old = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = old; }, 1200);
    }
  } catch {
    window.prompt('Copy this link:', text);
  }
}

export function logoFallbackSvg(brand, answer = false) {
  const label = answer ? `Correct logo: ${brand}` : `${brand} logo choices`;
  const safeLabel = escapeHtml(label);
  const safeBrand = escapeHtml(brand).toUpperCase();
  const content = answer
    ? `<text x="600" y="320" fill="#ffd54f" font-size="76" font-family="Arial" font-weight="700" text-anchor="middle">${safeBrand}</text>`
    : `<rect x="30" y="30" width="540" height="540" rx="28" fill="#111d31"/><rect x="630" y="30" width="540" height="540" rx="28" fill="#111d31"/><text x="300" y="320" fill="#f7f9ff" font-size="56" font-family="Arial" text-anchor="middle">${safeBrand}</text><text x="900" y="320" fill="#ffd54f" font-size="48" font-family="Arial" text-anchor="middle">${safeBrand}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" role="img" aria-label="${safeLabel}"><rect width="1200" height="600" fill="#f7f9ff"/><rect width="1200" height="600" fill="#0c172a" opacity="${answer ? '1' : '.08'}"/>${content}</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

export function bindLogoFallback(image, brand, answer = false) {
  if (!image) return;
  image.addEventListener('error', () => {
    if (image.dataset.fallbackApplied) return;
    image.dataset.fallbackApplied = 'true';
    image.src = logoFallbackSvg(brand, answer);
  }, { once: true });
}
