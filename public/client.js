(() => {
  const socket = io();

  // ---------------------------------------------------------------------
  // Estado local
  // ---------------------------------------------------------------------
  const state = {
    clientId: null,
    name: '',
    code: null,
    currentRoundId: null,
    goAtLocal: null, // performance.now() al recibir 'go'
    hasActed: false,
    latencyMs: null,
  };

  function getClientId() {
    let id = null;
    try { id = localStorage.getItem('pulsadorF1_clientId'); } catch (e) { /* ignore */ }
    if (!id) {
      id = 'p_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      try { localStorage.setItem('pulsadorF1_clientId', id); } catch (e) { /* ignore */ }
    }
    return id;
  }

  function getSavedName() {
    try { return localStorage.getItem('pulsadorF1_name') || ''; } catch (e) { return ''; }
  }
  function saveName(name) {
    try { localStorage.setItem('pulsadorF1_name', name); } catch (e) { /* ignore */ }
  }

  state.clientId = getClientId();

  // ---------------------------------------------------------------------
  // Utilidades de pantalla
  // ---------------------------------------------------------------------
  const screens = {
    join: document.getElementById('screen-join'),
    lobby: document.getElementById('screen-lobby'),
    race: document.getElementById('screen-race'),
    results: document.getElementById('screen-results'),
  };
  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove('active'));
    screens[name].classList.add('active');
  }

  function fmtMs(ms) {
    return (ms / 1000).toFixed(3).replace('.', ',') + ' s';
  }

  // ---------------------------------------------------------------------
  // Pantalla: unirse
  // ---------------------------------------------------------------------
  const inputName = document.getElementById('input-name');
  const inputCode = document.getElementById('input-code');
  const btnJoin = document.getElementById('btn-join');
  const joinError = document.getElementById('join-error');

  inputName.value = getSavedName();

  // Si el enlace trae ?room=CODE, precarga el código
  const params = new URLSearchParams(location.search);
  if (params.get('room')) inputCode.value = params.get('room').toUpperCase();

  function doJoin() {
    const name = inputName.value.trim();
    if (!name) {
      joinError.textContent = 'Escribe tu nombre para continuar.';
      joinError.hidden = false;
      inputName.focus();
      return;
    }
    joinError.hidden = true;
    saveName(name);
    btnJoin.disabled = true;
    socket.emit('joinRoom', { code: inputCode.value.trim(), name, clientId: state.clientId }, (res) => {
      btnJoin.disabled = false;
      if (!res || !res.ok) {
        joinError.textContent = (res && res.error) || 'No se pudo unir a la sala.';
        joinError.hidden = false;
        return;
      }
      state.code = res.code;
      state.name = res.you.name;
      document.getElementById('room-code-label').textContent = res.code;
      document.getElementById('my-name-label').textContent = res.you.name;
      const url = new URL(location.href);
      url.searchParams.set('room', res.code);
      history.replaceState(null, '', url);
      renderPlayers(res.players);
      if (res.state === 'results' || res.state === 'lobby') {
        showScreen('lobby');
      } else {
        showScreen('lobby'); // si hay ronda en curso, esperamos al siguiente evento
      }
    });
  }
  btnJoin.addEventListener('click', doJoin);
  inputName.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  inputCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

  // ---------------------------------------------------------------------
  // Pantalla: lobby
  // ---------------------------------------------------------------------
  const playerList = document.getElementById('player-list');
  const feed = document.getElementById('feed');
  const btnStart = document.getElementById('btn-start');
  const btnReset = document.getElementById('btn-reset');
  const btnCopyLink = document.getElementById('btn-copy-link');
  const btnRename = document.getElementById('btn-rename');

  function renderPlayers(players) {
    playerList.innerHTML = '';
    players.forEach((p) => {
      const li = document.createElement('li');
      const ping = p.id === state.clientId && state.latencyMs != null ? `${Math.round(state.latencyMs)} ms` : '';
      li.innerHTML = `
        <span class="pname"><span class="dot ${p.connected ? '' : 'off'}"></span>${escapeHtml(p.name)}${p.id === state.clientId ? ' (tú)' : ''}</span>
        <span class="meta">
          ${p.bestMs != null ? `<span>mejor: ${fmtMs(p.bestMs)}</span>` : ''}
          <span>${p.wins} 🏆</span>
          <span>${p.points} pts</span>
          ${ping ? `<span class="ping">${ping}</span>` : ''}
        </span>`;
      playerList.appendChild(li);
    });
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function addFeedItem(container, text) {
    const div = document.createElement('div');
    div.className = 'feed-item';
    div.textContent = text;
    container.prepend(div);
    while (container.children.length > 6) container.removeChild(container.lastChild);
  }

  btnStart.addEventListener('click', () => socket.emit('startRound'));
  btnReset.addEventListener('click', () => {
    if (confirm('¿Reiniciar el marcador de la sala?')) socket.emit('resetScoreboard');
  });
  btnCopyLink.addEventListener('click', async () => {
    const url = new URL(location.href);
    url.searchParams.set('room', state.code);
    try {
      await navigator.clipboard.writeText(url.toString());
      btnCopyLink.textContent = '✅ Copiado';
      setTimeout(() => (btnCopyLink.textContent = '🔗 Copiar enlace'), 1500);
    } catch (e) {
      prompt('Copia el enlace:', url.toString());
    }
  });
  btnRename.addEventListener('click', () => {
    const name = prompt('Tu nombre:', state.name);
    if (name && name.trim()) {
      state.name = name.trim();
      saveName(state.name);
      document.getElementById('my-name-label').textContent = state.name;
      socket.emit('renamePlayer', { name: state.name });
    }
  });

  // ---------------------------------------------------------------------
  // Pantalla: carrera (semaforo)
  // ---------------------------------------------------------------------
  const bulbs = [...document.querySelectorAll('.bulb')];
  const raceStatus = document.getElementById('race-status');
  const raceFeed = document.getElementById('race-feed');
  const btnSpace = document.getElementById('btn-space');

  function resetSemaphore() {
    bulbs.forEach((b) => b.classList.remove('on'));
    raceStatus.textContent = 'Prepárate…';
    raceStatus.className = 'race-status';
    raceFeed.innerHTML = '';
    btnSpace.disabled = false;
  }

  function actNow(fromKeyboard) {
    if (state.hasActed || !state.currentRoundId) return;
    state.hasActed = true;
    btnSpace.disabled = true;
    let elapsedMs = 0;
    if (state.goAtLocal != null) {
      elapsedMs = performance.now() - state.goAtLocal;
      raceStatus.textContent = `¡Pulsado! ${fmtMs(elapsedMs)}`;
      raceStatus.className = 'race-status go';
    } else {
      raceStatus.textContent = '¡SALIDA NULA! Has pulsado antes de tiempo';
      raceStatus.className = 'race-status false-start';
    }
    socket.emit('press', { roundId: state.currentRoundId, elapsedMs });
  }

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (screens.race.classList.contains('active')) e.preventDefault();
    if (e.repeat) return;
    actNow(true);
  });
  btnSpace.addEventListener('click', () => actNow(false));

  // ---------------------------------------------------------------------
  // Eventos del servidor
  // ---------------------------------------------------------------------
  socket.on('players', ({ players }) => renderPlayers(players));

  socket.on('system', ({ message }) => addFeedItem(feed, message));

  socket.on('roundArm', ({ roundId }) => {
    state.currentRoundId = roundId;
    state.goAtLocal = null;
    state.hasActed = false;
    resetSemaphore();
    showScreen('race');
  });

  socket.on('light', ({ roundId, index }) => {
    if (roundId !== state.currentRoundId) return;
    const bulb = bulbs[index - 1];
    if (bulb) bulb.classList.add('on');
    if (index === bulbs.length) raceStatus.textContent = 'Listos…';
  });

  socket.on('go', ({ roundId }) => {
    if (roundId !== state.currentRoundId) return;
    state.goAtLocal = performance.now();
    bulbs.forEach((b) => b.classList.remove('on'));
    if (!state.hasActed) {
      raceStatus.textContent = '¡YA! ¡PULSA ESPACIO!';
      raceStatus.className = 'race-status go';
    }
  });

  socket.on('playerActed', ({ roundId, name, falseStart }) => {
    if (roundId !== state.currentRoundId) return;
    addFeedItem(raceFeed, falseStart ? `🚫 ${name} — salida nula` : `✅ ${name} ha pulsado`);
  });

  socket.on('roundResult', (data) => {
    state.currentRoundId = null;
    renderResults(data);
    showScreen('results');
  });

  // ---------------------------------------------------------------------
  // Pantalla: resultados
  // ---------------------------------------------------------------------
  const championBanner = document.getElementById('champion-banner');
  const podium = document.getElementById('podium');
  const incidents = document.getElementById('incidents');
  const scoreboardBody = document.getElementById('scoreboard-body');
  const btnAgain = document.getElementById('btn-again');

  btnAgain.addEventListener('click', () => socket.emit('startRound'));

  function renderResults({ ranking, falseStarts, dnfs, champion }) {
    championBanner.textContent = champion
      ? `🏁 ¡${champion.name} es el más rápido con ${fmtMs(champion.elapsedMs)}!`
      : 'Nadie ha marcado un tiempo válido en esta ronda.';

    podium.innerHTML = '';
    ranking.forEach((r) => {
      const li = document.createElement('li');
      li.className = `p${r.position}`;
      li.innerHTML = `<span class="pos">${r.position}</span><span class="pname">${escapeHtml(r.name)}</span><span class="ptime">${fmtMs(r.elapsedMs)}</span>`;
      podium.appendChild(li);
    });

    incidents.innerHTML = '';
    falseStarts.forEach((f) => {
      const div = document.createElement('div');
      div.className = 'incident false-start';
      div.textContent = `🚫 ${f.name} — salida nula`;
      incidents.appendChild(div);
    });
    dnfs.forEach((f) => {
      const div = document.createElement('div');
      div.className = 'incident dnf';
      div.textContent = `⏱️ ${f.name} — no ha pulsado a tiempo`;
      incidents.appendChild(div);
    });
  }

  socket.on('players', ({ players }) => {
    // También refresca el marcador de la pantalla de resultados si está visible
    scoreboardBody.innerHTML = '';
    players
      .slice()
      .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name))
      .forEach((p, idx) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${idx + 1}</td><td>${escapeHtml(p.name)}${p.id === state.clientId ? ' (tú)' : ''}</td><td>${p.points}</td><td>${p.wins}</td><td>${p.bestMs != null ? fmtMs(p.bestMs) : '—'}</td>`;
        scoreboardBody.appendChild(tr);
      });
  });

  // ---------------------------------------------------------------------
  // Latencia aproximada (informativa)
  // ---------------------------------------------------------------------
  socket.on('pongCheck', (sentAt) => {
    state.latencyMs = Date.now() - sentAt;
  });
  setInterval(() => socket.emit('pingCheck', Date.now()), 3000);
})();
