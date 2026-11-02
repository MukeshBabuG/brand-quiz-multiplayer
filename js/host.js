import { makeClient, configReady } from './supabase-client.js';
import {
  $, escapeHtml, friendlyError, setMessage, phaseLabel,
  scoreRows, computeServerOffset, remainingMs, formatCountdown,
  makeShareUrl, copyText, bindLogoFallback, localLogoPath
} from './common.js';

const supabase = makeClient('host');
let gameId = null;
let state = null;
let channel = null;
let refreshBusy = false;
let serverOffset = 0;
let timerHandle = null;
let fallbackHandle = null;

function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

const timerSelect = $('timerSeconds');
timerSelect.value = localStorage.getItem('hostTimerSeconds') || '10';
timerSelect.addEventListener('change', () => localStorage.setItem('hostTimerSeconds', timerSelect.value));
function selectedSeconds() { return Number(timerSelect.value) || 10; }

async function init() {
  if (!configReady()) { show('configWarning'); return; }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { show('loginView'); return; }
  await afterLogin();
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  setMessage($('loginMessage'), 'Signing in…');
  try {
    const { error } = await supabase.auth.signInWithPassword({
      email: $('hostEmail').value.trim(), password: $('hostPassword').value
    });
    if (error) throw error;
    hide('loginView');
    await afterLogin();
  } catch (err) { setMessage($('loginMessage'), friendlyError(err), 'bad'); }
});

$('signOutBtn').addEventListener('click', async () => {
  await supabase.auth.signOut();
  location.reload();
});

async function afterLogin() {
  show('signOutBtn');
  $('topStatus').textContent = 'Signed in as host';
  const { data, error } = await supabase.rpc('get_my_active_game');
  if (error) throw error;
  if (data?.id) { gameId = data.id; await openHostGame(); }
  else show('setupView');
}

$('createGameBtn').addEventListener('click', async () => {
  $('createGameBtn').disabled = true;
  setMessage($('setupMessage'), 'Creating game…');
  try {
    const { data, error } = await supabase.rpc('create_game', { p_logo_duration_seconds: 10 });
    if (error) throw error;
    gameId = data.id;
    hide('setupView');
    await openHostGame();
  } catch (err) {
    setMessage($('setupMessage'), friendlyError(err), 'bad');
    $('createGameBtn').disabled = false;
  }
});

async function openHostGame() {
  show('hostView');
  await attachRealtime();
  await refreshState();
  fallbackHandle = setInterval(refreshState, 3500);
}

async function attachRealtime() {
  if (channel) await supabase.removeChannel(channel);
  channel = supabase.channel(`host-game-${gameId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${gameId}` }, () => refreshState())
    .subscribe();
}

async function refreshState() {
  if (!gameId || refreshBusy) return;
  refreshBusy = true;
  try {
    const { data, error } = await supabase.rpc('get_host_state', { p_game_id: gameId });
    if (error) throw error;
    state = data;
    serverOffset = computeServerOffset(state.server_now);
    render();
  } catch (err) { setMessage($('hostMessage'), friendlyError(err), 'bad'); }
  finally { refreshBusy = false; }
}

function render() {
  stopTimer();
  const g = state.game;
  const r = state.round;
  const link = makeShareUrl(g.code);
  $('topStatus').textContent = `${g.code} · ${phaseLabel(g.phase)}`;
  $('phaseTitle').textContent = phaseLabel(g.phase);
  $('roundMeta').textContent = g.phase === 'lobby' ? 'Waiting for players' : `Round ${g.round_position} of ${g.total_rounds} · Source round #${r?.round_number ?? '-'}`;
  $('playerCount').textContent = `${g.player_count} player${g.player_count === 1 ? '' : 's'}`;
  $('progressBar').style.width = g.phase === 'lobby' ? '0%' : `${Math.max(0, ((g.round_position - 1) / Math.max(1, g.total_rounds)) * 100)}%`;
  $('shareCode').textContent = g.code;
  $('shareLink').textContent = link;
  renderPlayerQr(link);
  $('copyLinkBtn').onclick = () => copyText(link, $('copyLinkBtn'));
  $('leaderboard').innerHTML = scoreRows(state.leaderboard);
  setMessage($('hostMessage'), '');
  renderStage(g, r);
  renderAnswers(g);
  renderControls(g);
}

function renderPlayerQr(link) {
  const container = $('playerQr');
  if (!container) return;
  container.replaceChildren();
  if (window.QRCode) {
    new window.QRCode(container, {
      text: link,
      width: 132,
      height: 132,
      colorDark: '#08111f',
      colorLight: '#ffffff',
      correctLevel: window.QRCode.CorrectLevel.M
    });
  } else {
    container.textContent = 'QR unavailable';
  }
}

function statusGrid(players, submittedKey) {
  if (!players.length) return '';
  return `<div class="status-grid">${players.map(p => `<span class="status-chip ${p[submittedKey] ? 'answered' : 'waiting'}">${escapeHtml(p.name)} · ${p[submittedKey] ? 'Answered' : 'Waiting…'}</span>`).join('')}</div>`;
}

function revealGrid(players, submittedKey, correctKey, valueFn) {
  if (!players.length) return '';
  return `<div class="status-grid">${players.map(p => {
    const cls = !p[submittedKey] ? 'waiting' : p[correctKey] ? 'correct' : 'wrong';
    const text = p[submittedKey] ? `${escapeHtml(valueFn(p))} ${p[correctKey] ? '✓' : '✕'}` : 'No answer';
    return `<span class="status-chip ${cls}"><b>${escapeHtml(p.name)}</b> · ${text}</span>`;
  }).join('')}</div>`;
}

function renderStage(g, r) {
  const players = state.players || [];
  if (g.phase === 'lobby') {
    $('hostStage').innerHTML = `<div class="waiting"><div class="pulse"></div><h2>Lobby Open</h2><p class="muted">Scan the QR code and enter a character name plus your original name. Only character names are shown here.</p></div>${players.length ? `<div class="name-chips">${players.map(p => `<span>${escapeHtml(p.name)}</span>`).join('')}</div>` : ''}`;
    return;
  }
  if (g.phase === 'slogan') {
    const timer = g.slogan_deadline ? '<div id="hostTimer" class="timer">0.0</div>' : '';
    $('hostStage').innerHTML = `<div class="eyebrow center">Game 1 · Guess the Brand</div>${timer}<div class="slogan center">“${escapeHtml(r.slogan)}”</div><p class="center muted">${g.slogan_submitted_count} / ${g.player_count} answered</p>${statusGrid(players, 'slogan_submitted')}`;
    if (g.slogan_deadline) startTimer(g.slogan_deadline, 'revealSloganBtn');
    return;
  }
  if (g.phase === 'slogan_reveal') {
    $('hostStage').innerHTML = `<div class="eyebrow center">Brand Revealed</div><div class="slogan center">“${escapeHtml(r.slogan)}”</div><div class="brand-answer center">${escapeHtml(r.brand)}</div><h3 class="section-title" style="margin-top:16px">All answers</h3>${revealGrid(players, 'slogan_submitted', 'slogan_correct', p => p.slogan_answer || '')}`;
    return;
  }
  if (g.phase === 'logo_wait' || g.phase === 'logo_active') {
    const questionImage = localLogoPath(r.round_number, 'question') || r.question_image;
    const active = g.phase === 'logo_active';
    $('hostStage').innerHTML = `<div class="eyebrow center">Game 2 · Spot the Correct Logo</div><h2 class="center">${escapeHtml(r.brand)}</h2>${active ? `<div id="hostTimer" class="timer">${g.logo_duration_seconds}.0</div>` : '<p class="center muted">Get ready! The timer starts soon.</p>'}<div class="logo-frame"><img src="${escapeHtml(questionImage)}" alt="${escapeHtml(r.brand)} logo choices"></div>${active ? `<p class="center muted">${g.logo_submitted_count} / ${g.player_count} answered</p>${statusGrid(players, 'logo_submitted')}` : ''}`;
    bindLogoFallback($('hostStage').querySelector('img'), r.brand);
    if (active) startTimer(g.logo_deadline, 'revealLogoBtn');
    return;
  }
  if (g.phase === 'logo_reveal') {
    const answerImage = localLogoPath(r.round_number, 'answer') || r.answer_image;
    $('hostStage').innerHTML = `<div class="eyebrow center">Correct Logo Revealed</div><h2 class="center">${escapeHtml(r.brand)}</h2><div class="logo-frame"><img src="${escapeHtml(answerImage)}" alt="Correct ${escapeHtml(r.brand)} logo"></div><p class="center muted small">${escapeHtml(r.note || '')}</p><h3 class="section-title">All choices</h3>${revealGrid(players, 'logo_submitted', 'logo_correct', p => (p.logo_answer || '').toUpperCase())}`;
    bindLogoFallback($('hostStage').querySelector('img'), r.brand, true);
    return;
  }
  if (g.phase === 'finished') {
    $('progressBar').style.width = '100%';
    $('hostStage').innerHTML = `<div class="center"><div class="eyebrow">Game Complete · Who's Who?</div><h1 class="round-title">Final Leaderboard</h1></div>${scoreRows(state.leaderboard)}`;
  }
}

function resultCell(submitted, correct, value = '') {
  if (!submitted) return '<span class="pending">—</span>';
  return `${escapeHtml(value)} ${correct ? '<span class="yes">✓</span>' : '<span class="no">✕</span>'}`;
}

function statusCell(submitted) {
  return submitted ? '<span class="yes">Answered</span>' : '<span class="pending">Waiting…</span>';
}

function renderAnswers(g) {
  const players = state.players || [];
  const isLogo = ['logo_wait', 'logo_active', 'logo_reveal'].includes(g.phase);
  $('submissionCount').textContent = g.phase === 'lobby' ? `${g.player_count} joined` : isLogo ? `${g.logo_submitted_count} / ${g.player_count} logo choices` : `${g.slogan_submitted_count} / ${g.player_count} brand answers`;
  if (!players.length) { $('answersTable').innerHTML = '<div class="empty">No players yet.</div>'; return; }
  if (g.phase === 'lobby') {
    $('answersTable').innerHTML = `<table class="table"><thead><tr><th>Character</th><th>Joined</th><th></th></tr></thead><tbody>${players.map(p => `<tr><td><b>${escapeHtml(p.name)}</b></td><td>${new Date(p.joined_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td><td><button class="btn danger remove-player" data-id="${p.id}">Remove</button></td></tr>`).join('')}</tbody></table>`;
    document.querySelectorAll('.remove-player').forEach(btn => btn.addEventListener('click', () => removePlayer(btn.dataset.id)));
    return;
  }
  const finished = g.phase === 'finished';
  const sloganRevealed = g.phase !== 'slogan';
  const totals = new Map((state.leaderboard || []).map(x => [x.player_id, x.total_score]));
  const brandCell = p => sloganRevealed ? resultCell(p.slogan_submitted, p.slogan_correct, p.slogan_answer || '') : statusCell(p.slogan_submitted);
  const logoCell = p => {
    if (g.phase === 'logo_reveal' || finished) return resultCell(p.logo_submitted, p.logo_correct, (p.logo_answer || '').toUpperCase());
    if (g.phase === 'logo_active') return statusCell(p.logo_submitted);
    return '<span class="pending">—</span>';
  };
  const nameCell = p => `<b>${escapeHtml(p.name)}</b>${finished && p.real_name ? `<div class="real-name">${escapeHtml(p.real_name)}</div>` : ''}`;
  $('answersTable').innerHTML = `<table class="table"><thead><tr><th>Player</th><th>Brand</th><th>Logo</th><th>Total</th></tr></thead><tbody>${players.map(p => `<tr><td>${nameCell(p)}</td><td>${brandCell(p)}</td><td>${logoCell(p)}</td><td><b>${totals.get(p.id) ?? 0}</b></td></tr>`).join('')}</tbody></table>`;
}

function renderControls(g) {
  const c = $('controlPanel');
  const buttons = [];
  if (g.phase === 'lobby') {
    buttons.push('<label class="row small muted"><input id="shuffleRounds" type="checkbox"> Shuffle quiz rounds</label>');
    buttons.push(`<button id="startGameBtn" class="btn primary" ${g.player_count < 1 ? 'disabled' : ''}>Start Game</button>`);
  } else if (g.phase === 'slogan') {
    if (!g.slogan_deadline) buttons.push('<button id="startSloganTimerBtn" class="btn secondary">Start Answer Timer</button>');
    const running = g.slogan_deadline && remainingMs(g.slogan_deadline, serverOffset) > 0;
    buttons.push(`<button id="revealSloganBtn" class="btn primary" ${running ? 'disabled' : ''}>Reveal All Answers</button>`);
  }
  else if (g.phase === 'slogan_reveal') buttons.push('<button id="openLogoBtn" class="btn primary">Open Logo Challenge</button>');
  else if (g.phase === 'logo_wait') buttons.push('<button id="startTimerBtn" class="btn primary">Start Logo Timer</button>');
  else if (g.phase === 'logo_active') buttons.push(`<button id="revealLogoBtn" class="btn primary" ${remainingMs(g.logo_deadline, serverOffset) <= 0 ? '' : 'disabled'}>Reveal All Choices</button>`);
  else if (g.phase === 'logo_reveal') buttons.push(`<button id="nextRoundBtn" class="btn primary">${g.round_position >= g.total_rounds ? 'Finish Game & Reveal Names' : 'Next Round'}</button>`);
  if (!['lobby', 'finished'].includes(g.phase)) buttons.push('<button id="endGameBtn" class="btn danger">End Game</button>');
  if (g.phase === 'finished') buttons.push('<button id="newGameBtn" class="btn secondary">Create Another Game</button>');
  c.innerHTML = buttons.join('');
  $('startGameBtn')?.addEventListener('click', () => callHost('start_game', { p_game_id: gameId, p_shuffle: $('shuffleRounds').checked }));
  $('startSloganTimerBtn')?.addEventListener('click', () => callHost('start_slogan_timer', { p_game_id: gameId, p_seconds: selectedSeconds() }));
  $('revealSloganBtn')?.addEventListener('click', () => callHost('reveal_slogan', { p_game_id: gameId }));
  $('openLogoBtn')?.addEventListener('click', () => callHost('open_logo_challenge', { p_game_id: gameId }));
  $('startTimerBtn')?.addEventListener('click', () => callHost('start_logo_timer', { p_game_id: gameId, p_seconds: selectedSeconds() }));
  $('revealLogoBtn')?.addEventListener('click', () => callHost('reveal_logo', { p_game_id: gameId }));
  $('nextRoundBtn')?.addEventListener('click', () => callHost('next_round', { p_game_id: gameId }));
  $('endGameBtn')?.addEventListener('click', async () => { if (confirm('End this game now?')) await callHost('end_game', { p_game_id: gameId }); });
  $('newGameBtn')?.addEventListener('click', async () => { hide('hostView'); show('setupView'); gameId = null; state = null; if (channel) await supabase.removeChannel(channel); if (fallbackHandle) clearInterval(fallbackHandle); });
}

async function callHost(name, args) {
  setMessage($('hostMessage'), 'Updating game…');
  try {
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw error;
    if (data) { state = data; serverOffset = computeServerOffset(state.server_now); render(); }
    else await refreshState();
  } catch (err) { setMessage($('hostMessage'), friendlyError(err), 'bad'); }
}

async function removePlayer(playerId) {
  if (!confirm('Remove this player from the lobby?')) return;
  await callHost('remove_player', { p_game_id: gameId, p_player_id: playerId });
}

function startTimer(deadline, buttonId) {
  stopTimer();
  const tick = () => {
    const ms = remainingMs(deadline, serverOffset);
    if ($('hostTimer')) $('hostTimer').textContent = formatCountdown(ms);
    if ($(buttonId)) $(buttonId).disabled = ms > 0;
    if (ms <= 0) stopTimer();
  };
  tick();
  timerHandle = setInterval(tick, 100);
}

function stopTimer() { if (timerHandle) clearInterval(timerHandle); timerHandle = null; }
window.addEventListener('beforeunload', () => { stopTimer(); if (fallbackHandle) clearInterval(fallbackHandle); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && gameId) refreshState(); });
init().catch(err => { show('loginView'); setMessage($('loginMessage'), friendlyError(err), 'bad'); });
