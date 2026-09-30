import { makeClient, configReady } from './supabase-client.js';
import {
  $, escapeHtml, friendlyError, setMessage, phaseLabel,
  scoreRows, namesHtml, computeServerOffset, remainingMs, formatCountdown,
  bindLogoFallback, localLogoPath
} from './common.js';

const supabase = makeClient('player');
let gameCode = '';
let gameId = null;
let state = null;
let channel = null;
let refreshBusy = false;
let serverOffset = 0;
let timerHandle = null;
let fallbackHandle = null;
let selectedLogoSide = null;

function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

async function ensurePlayerSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) return session;
  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  return data.session;
}

async function init() {
  if (!configReady()) { show('configWarning'); return; }
  await ensurePlayerSession();
  const urlCode = new URL(window.location.href).searchParams.get('game');
  if (urlCode) $('gameCode').value = urlCode.toUpperCase().slice(0, 6);
  show('joinView');
}

$('joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  setMessage($('joinMessage'), 'Joining…');
  const code = $('gameCode').value.trim().toUpperCase();
  const name = $('displayName').value.trim();
  try {
    await ensurePlayerSession();
    const { data, error } = await supabase.rpc('join_game', { p_game_code: code, p_display_name: name });
    if (error) throw error;
    gameCode = data.code;
    gameId = data.game_id;
    hide('joinView'); show('gameView');
    await attachRealtime();
    await refreshState();
    fallbackHandle = setInterval(refreshState, 4000);
  } catch (err) { setMessage($('joinMessage'), friendlyError(err), 'bad'); }
});

async function attachRealtime() {
  if (channel) await supabase.removeChannel(channel);
  channel = supabase.channel(`player-game-${gameId}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'games', filter: `id=eq.${gameId}` }, () => refreshState())
    .subscribe();
}

async function refreshState() {
  if (!gameCode || refreshBusy) return;
  refreshBusy = true;
  try {
    const { data, error } = await supabase.rpc('get_player_state', { p_game_code: gameCode });
    if (error) throw error;
    state = data;
    serverOffset = computeServerOffset(state.server_now);
    selectedLogoSide = state.my_answer?.logo_answer || null;
    render();
  } catch (err) { setMessage($('playerMessage'), friendlyError(err), 'bad'); }
  finally { refreshBusy = false; }
}

function render() {
  const g = state.game;
  const r = state.round;
  $('topStatus').textContent = `${gameCode} · ${phaseLabel(g.phase)}`;
  $('playerIdentity').textContent = state.player.name;
  $('phaseTitle').textContent = phaseLabel(g.phase);
  $('roundMeta').textContent = g.phase === 'lobby' ? `${g.player_count} player${g.player_count === 1 ? '' : 's'} joined` : `Round ${g.round_position} of ${g.total_rounds}`;
  $('progressBar').style.width = g.phase === 'lobby' ? '0%' : `${Math.max(0, ((g.round_position - 1) / Math.max(1, g.total_rounds)) * 100)}%`;
  $('leaderboard').innerHTML = scoreRows(state.leaderboard, 10);
  setMessage($('playerMessage'), '');
  stopTimer();
  switch (g.phase) {
    case 'lobby': renderLobby(); break;
    case 'slogan': renderSlogan(r); break;
    case 'slogan_reveal': renderSloganReveal(r); break;
    case 'logo_wait': renderLogoWait(r); break;
    case 'logo_active': renderLogoActive(r); break;
    case 'logo_reveal': renderLogoReveal(r); break;
    case 'finished': renderFinished(); break;
  }
}

function renderLobby() {
  $('mainStage').innerHTML = `<div class="waiting"><div class="pulse"></div><h2>You’re in!</h2><p class="muted">Waiting for the host to start the game.</p><div class="pill" style="display:inline-block">Game ${escapeHtml(gameCode)}</div></div>`;
}

function renderSlogan(r) {
  const submitted = state.my_answer?.slogan_submitted;
  $('mainStage').innerHTML = `<div class="eyebrow center">Game 1 · Guess the Brand</div><div class="slogan center">“${escapeHtml(r.slogan)}”</div>${submitted ? `<div class="answer-card"><div class="muted small">Your answer is locked</div><div style="font-size:28px;font-weight:900;margin-top:6px">${escapeHtml(state.my_answer.slogan_answer)}</div><p class="muted">${state.game.slogan_submitted_count}/${state.game.player_count} answers submitted. Waiting for the host to reveal.</p></div>` : `<form id="sloganForm" class="form"><input id="sloganAnswer" class="input" maxlength="100" placeholder="Type the brand name" autocomplete="off" required><button class="btn primary" type="submit">Submit Answer</button></form><p class="center muted small">Once submitted, your brand answer is locked.</p>`}`;
  if (!submitted) { $('sloganForm').addEventListener('submit', submitSlogan); setTimeout(() => $('sloganAnswer')?.focus(), 50); }
}

async function submitSlogan(e) {
  e.preventDefault();
  const answer = $('sloganAnswer').value.trim();
  if (!answer) return;
  $('sloganForm').querySelector('button').disabled = true;
  try {
    const { error } = await supabase.rpc('submit_slogan', { p_game_code: gameCode, p_answer: answer });
    if (error) throw error;
    await refreshState();
  } catch (err) { setMessage($('playerMessage'), friendlyError(err), 'bad'); $('sloganForm')?.querySelector('button')?.removeAttribute('disabled'); }
}

function renderSloganReveal(r) {
  const mine = state.my_answer;
  const resultText = mine?.slogan_submitted ? (mine.slogan_correct ? 'You got the brand right!' : `Your answer: ${escapeHtml(mine.slogan_answer)}`) : 'No brand answer submitted.';
  $('mainStage').innerHTML = `<div class="eyebrow center">Brand Reveal</div><div class="slogan center">“${escapeHtml(r.slogan)}”</div><div class="brand-answer center">${escapeHtml(r.brand)}</div><div class="answer-card ${mine?.slogan_correct ? 'good' : 'bad'}" style="margin-top:16px"><b>${resultText}</b></div><div class="divider"></div><h3 class="section-title">Who got it right?</h3>${namesHtml(state.slogan_correct_players)}<div class="waiting"><div class="pulse"></div><p class="muted">Waiting for the host to open the logo challenge.</p></div>`;
}

function logoQuestionHtml(r, interactive) {
  const leftClass = selectedLogoSide === 'left' ? 'selected' : '';
  const rightClass = selectedLogoSide === 'right' ? 'selected' : '';
  const image = localLogoPath(r.round_number, 'question') || r.question_image;
  return `<div class="logo-frame"><img src="${escapeHtml(image)}" alt="Two logo choices for ${escapeHtml(r.brand)}"><button id="hotLeft" class="hotspot left ${interactive ? 'enabled' : ''} ${leftClass}" ${interactive ? '' : 'disabled'} aria-label="Choose left logo"></button><button id="hotRight" class="hotspot right ${interactive ? 'enabled' : ''} ${rightClass}" ${interactive ? '' : 'disabled'} aria-label="Choose right logo"></button></div><div class="choice-row"><button id="chooseLeft" class="btn secondary ${leftClass}" ${interactive ? '' : 'disabled'}>LEFT LOGO</button><button id="chooseRight" class="btn secondary ${rightClass}" ${interactive ? '' : 'disabled'}>RIGHT LOGO</button></div>`;
}

function bindPlayerLogoFallback(r, answer = false) {
  bindLogoFallback($('mainStage').querySelector('img'), r.brand, answer);
}

function renderLogoWait(r) {
  $('mainStage').innerHTML = `<div class="eyebrow center">Game 2 · Spot the Correct Logo</div><h2 class="center">${escapeHtml(r.brand)}</h2><p class="center muted">The host will start the ${state.game.logo_duration_seconds}-second timer. Choices are disabled until then.</p>${logoQuestionHtml(r, false)}<div class="waiting"><div class="pulse"></div><p class="muted">Get ready…</p></div>`;
  bindPlayerLogoFallback(r);
}

function renderLogoActive(r) {
  $('mainStage').innerHTML = `<div class="eyebrow center">Game 2 · Spot the Correct Logo</div><h2 class="center">${escapeHtml(r.brand)}</h2><div id="timer" class="timer">10.0</div>${logoQuestionHtml(r, true)}<p id="logoChoiceNote" class="center muted small">You can change your choice until the timer reaches zero.</p>`;
  bindPlayerLogoFallback(r);
  bindLogoChoices(); startTimer();
}

function bindLogoChoices() {
  $('hotLeft')?.addEventListener('click', () => chooseLogo('left'));
  $('hotRight')?.addEventListener('click', () => chooseLogo('right'));
  $('chooseLeft')?.addEventListener('click', () => chooseLogo('left'));
  $('chooseRight')?.addEventListener('click', () => chooseLogo('right'));
}

async function chooseLogo(side) {
  if (remainingMs(state.game.logo_deadline, serverOffset) <= 0) return;
  selectedLogoSide = side;
  for (const id of ['hotLeft', 'hotRight', 'chooseLeft', 'chooseRight']) $(id)?.classList.remove('selected');
  for (const id of side === 'left' ? ['hotLeft', 'chooseLeft'] : ['hotRight', 'chooseRight']) $(id)?.classList.add('selected');
  $('logoChoiceNote').textContent = `Selected ${side.toUpperCase()}. You may change it before time expires.`;
  try {
    const { error } = await supabase.rpc('submit_logo', { p_game_code: gameCode, p_side: side });
    if (error) throw error;
  } catch (err) { setMessage($('playerMessage'), friendlyError(err), 'bad'); }
}

function startTimer() {
  stopTimer();
  const tick = () => {
    const ms = remainingMs(state.game.logo_deadline, serverOffset);
    if ($('timer')) $('timer').textContent = formatCountdown(ms);
    if (ms <= 0) {
      stopTimer();
      for (const id of ['hotLeft', 'hotRight', 'chooseLeft', 'chooseRight']) { const el = $(id); if (el) el.disabled = true; }
      if ($('logoChoiceNote')) $('logoChoiceNote').textContent = selectedLogoSide ? `Time! Your final choice is ${selectedLogoSide.toUpperCase()}. Waiting for reveal.` : 'Time! No logo answer was submitted.';
    }
  };
  tick(); timerHandle = setInterval(tick, 100);
}

function stopTimer() { if (timerHandle) clearInterval(timerHandle); timerHandle = null; }

function renderLogoReveal(r) {
  const mine = state.my_answer;
  const verdict = mine?.logo_submitted ? (mine.logo_correct ? 'You spotted the correct logo!' : `Your choice: ${(mine.logo_answer || '').toUpperCase()}`) : 'No logo answer submitted.';
  const answerImage = localLogoPath(r.round_number, 'answer') || r.answer_image;
  $('mainStage').innerHTML = `<div class="eyebrow center">Correct Logo Reveal</div><h2 class="center">${escapeHtml(r.brand)}</h2><div class="logo-frame"><img src="${escapeHtml(answerImage)}" alt="Correct ${escapeHtml(r.brand)} logo reveal"></div><div class="answer-card ${mine?.logo_correct ? 'good' : 'bad'}" style="margin-top:16px"><b>${verdict}</b></div><div class="divider"></div><h3 class="section-title">Who got the logo right?</h3>${namesHtml(state.logo_correct_players)}<div class="waiting"><div class="pulse"></div><p class="muted">Waiting for the host to continue.</p></div>`;
  bindPlayerLogoFallback(r, true);
}

function renderFinished() {
  const me = state.leaderboard.find(x => x.player_id === state.player.id);
  $('progressBar').style.width = '100%';
  $('mainStage').innerHTML = `<div class="center"><div class="eyebrow">Game Complete</div><h1 class="round-title">Final Score</h1><div class="big-number">${me?.total_score ?? 0}/${(state.game.total_rounds || 37) * 2}</div><p class="muted">${escapeHtml(state.player.name)}, thanks for playing!</p></div><div class="divider"></div><h3 class="section-title">Final Leaderboard</h3>${scoreRows(state.leaderboard)}`;
}

window.addEventListener('beforeunload', () => { if (fallbackHandle) clearInterval(fallbackHandle); stopTimer(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && gameCode) refreshState(); });
init().catch(err => { show('configWarning'); $('configWarning').querySelector('.muted').textContent = friendlyError(err); });
