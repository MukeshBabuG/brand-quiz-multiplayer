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
  $('copyLinkBtn').onclick = () => copyText(link, $('copyLinkBtn'));
  $('leaderboard').innerHTML = scoreRows(state.leaderboard);
  setMessage($('hostMessage'), '');
  renderStage(g, r);
  renderAnswers(g);
  renderControls(g);
}

function renderStage(g, r) {
  if (g.phase === 'lobby') {
    $('hostStage').innerHTML = '<div class="waiting"><div class="pulse"></div><h2>Lobby Open</h2><p class="muted">Share the player link. Names will appear below as people join.</p></div>';
    return;
  }
  if (g.phase === 'slogan') {
    $('hostStage').innerHTML = `<div class="eyebrow center">Game 1 · Guess the Brand</div><div class="slogan center">“${escapeHtml(r.slogan)}”</div><div class="panel center"><span class="muted">Host answer key:</span> <b>${escapeHtml(r.brand)}</b></div>`;
    return;
  }
  if (g.phase === 'slogan_reveal') {
    $('hostStage').innerHTML = `<div class="eyebrow center">Brand Revealed to Players</div><div class="slogan center">“${escapeHtml(r.slogan)}”</div><div class="brand-answer center">${escapeHtml(r.brand)}</div>`;
    return;
  }
  if (g.phase === 'logo_wait' || g.phase === 'logo_active') {
    const questionImage = localLogoPath(r.round_number, 'question') || r.question_image;
    $('hostStage').innerHTML = `<div class="eyebrow center">Game 2 · Spot the Correct Logo</div><h2 class="center">${escapeHtml(r.brand)}</h2>${g.phase === 'logo_active' ? '<div id="hostTimer" class="timer">10.0</div>' : '<p class="center muted">Logo challenge is visible. Start the timer when everyone is ready.</p>'}<div class="logo-frame"><img src="${escapeHtml(questionImage)}" alt="${escapeHtml(r.brand)} logo choices"></div><p class="center muted small">Host key: correct side is <b>${escapeHtml(r.correct_side.toUpperCase())}</b>.</p>`;
    bindLogoFallback($('hostStage').querySelector('img'), r.brand);
    if (g.phase === 'logo_active') startTimer();
    return;
  }
  if (g.phase === 'logo_reveal') {
    const answerImage = localLogoPath(r.round_number, 'answer') || r.answer_image;
    $('hostStage').innerHTML = `<div class="eyebrow center">Correct Logo Revealed</div><h2 class="center">${escapeHtml(r.brand)}</h2><div class="logo-frame"><img src="${escapeHtml(answerImage)}" alt="Correct ${escapeHtml(r.brand)} logo"></div><p class="center muted small">${escapeHtml(r.note || '')}</p>`;
    bindLogoFallback($('hostStage').querySelector('img'), r.brand, true);
    return;
  }
  if (g.phase === 'finished') {
    $('progressBar').style.width = '100%';
    $('hostStage').innerHTML = `<div class="center"><div class="eyebrow">Game Complete</div><h1 class="round-title">Final Leaderboard</h1></div>${scoreRows(state.leaderboard)}`;
  }
}

function resultCell(submitted, correct, value = '') {
  if (!submitted) return '<span class="pending">—</span>';
  return `${escapeHtml(value)} ${correct ? '<span class="yes">✓</span>' : '<span class="no">✕</span>'}`;
}

function renderAnswers(g) {
  const players = state.players || [];
  const isLogo = ['logo_wait', 'logo_active', 'logo_reveal'].includes(g.phase);
  $('submissionCount').textContent = g.phase === 'lobby' ? `${g.player_count} joined` : isLogo ? `${g.logo_submitted_count} / ${g.player_count} logo choices` : `${g.slogan_submitted_count} / ${g.player_count} brand answers`;
  if (!players.length) { $('answersTable').innerHTML = '<div class="empty">No players yet.</div>'; return; }
  if (g.phase === 'lobby') {
    $('answersTable').innerHTML = `<table class="table"><thead><tr><th>Name</th><th>Joined</th><th></th></tr></thead><tbody>${players.map(p => `<tr><td><b>${escapeHtml(p.name)}</b></td><td>${new Date(p.joined_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td><td><button class="btn danger remove-player" data-id="${p.id}">Remove</button></td></tr>`).join('')}</tbody></table>`;
    document.querySelectorAll('.remove-player').forEach(btn => btn.addEventListener('click', () => removePlayer(btn.dataset.id)));
    return;
  }
  $('answersTable').innerHTML = `<table class="table"><thead><tr><th>Player</th><th>Brand answer</th><th>Logo choice</th><th>Slogan</th><th>Logo</th><th>Total</th></tr></thead><tbody>${players.map(p => `<tr><td><b>${escapeHtml(p.name)}</b></td><td>${resultCell(p.slogan_submitted, p.slogan_correct, p.slogan_answer || '')}</td><td>${resultCell(p.logo_submitted, p.logo_correct, (p.logo_answer || '').toUpperCase())}</td><td>${p.slogan_score}</td><td>${p.logo_score}</td><td><b>${p.total_score}</b></td></tr>`).join('')}</tbody></table>`;
}

function renderControls(g) {
  const c = $('controlPanel');
  const buttons = [];
  if (g.phase === 'lobby') {
    buttons.push('<label class="row small muted"><input id="shuffleRounds" type="checkbox"> Shuffle quiz rounds</label>');
    buttons.push(`<button id="startGameBtn" class="btn primary" ${g.player_count < 1 ? 'disabled' : ''}>Start Game</button>`);
  } else if (g.phase === 'slogan') buttons.push('<button id="revealSloganBtn" class="btn primary">Reveal Brand Answer</button>');
  else if (g.phase === 'slogan_reveal') buttons.push('<button id="openLogoBtn" class="btn primary">Open Logo Challenge</button>');
  else if (g.phase === 'logo_wait') buttons.push(`<button id="startTimerBtn" class="btn primary">Start ${g.logo_duration_seconds}-Second Timer</button>`);
  else if (g.phase === 'logo_active') buttons.push(`<button id="revealLogoBtn" class="btn primary" ${remainingMs(g.logo_deadline, serverOffset) <= 0 ? '' : 'disabled'}>Reveal Correct Logo</button>`);
  else if (g.phase === 'logo_reveal') buttons.push(`<button id="nextRoundBtn" class="btn primary">${g.round_position >= g.total_rounds ? 'Finish Game' : 'Next Round'}</button>`);
  if (!['lobby', 'finished'].includes(g.phase)) buttons.push('<button id="endGameBtn" class="btn danger">End Game</button>');
  if (g.phase === 'finished') buttons.push('<button id="newGameBtn" class="btn secondary">Create Another Game</button>');
  c.innerHTML = buttons.join('');
  $('startGameBtn')?.addEventListener('click', () => callHost('start_game', { p_game_id: gameId, p_shuffle: $('shuffleRounds').checked }));
  $('revealSloganBtn')?.addEventListener('click', () => callHost('reveal_slogan', { p_game_id: gameId }));
  $('openLogoBtn')?.addEventListener('click', () => callHost('open_logo_challenge', { p_game_id: gameId }));
  $('startTimerBtn')?.addEventListener('click', () => callHost('start_logo_timer', { p_game_id: gameId }));
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

function startTimer() {
  stopTimer();
  const tick = () => {
    const ms = remainingMs(state.game.logo_deadline, serverOffset);
    if ($('hostTimer')) $('hostTimer').textContent = formatCountdown(ms);
    if ($('revealLogoBtn')) $('revealLogoBtn').disabled = ms > 0;
    if (ms <= 0) stopTimer();
  };
  tick();
  timerHandle = setInterval(tick, 100);
}

function stopTimer() { if (timerHandle) clearInterval(timerHandle); timerHandle = null; }
window.addEventListener('beforeunload', () => { stopTimer(); if (fallbackHandle) clearInterval(fallbackHandle); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && gameId) refreshState(); });
init().catch(err => { show('loginView'); setMessage($('loginMessage'), friendlyError(err), 'bad'); });
