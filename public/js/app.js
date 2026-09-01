// ============================================================
// Adaptyvi produktyvumo palaikymo sistema – žiniatinklio sąsaja
// ============================================================

// ============================================================
// BŪSENOS KINTAMIEJI
// ============================================================

let ws;                          // WebSocket jungtis
let soundMuted = false;          // Garso nutildymas
let currentMode = 'idle';        // Aktyvus režimas
let modes = [];                  // Visi režimai
let sessionStart = null;         // Sesijos pradžia
let sessionTimer = null;         // Sesijos laikmatis
let pomodoroEnd = null;          // Pomodoro pabaigos laikas
let pomodoroInterval = null;     // Pomodoro atnaujinimo intervalas
let pomodoroTotalSec = 0;        // Pomodoro bendra trukmė sekundėmis
let editingMode = null;          // Redaguojamo režimo pavadinimas (null = naujas)
let checkInTimer = null;         // Aktyvumo patikrinimo laikmatis
let checkInTimeout = 30;         // Patikrinimo laukimo laikas
let boxData = { completedBlocks: 0, unlockTarget: 3 }; // Dėžutės progresas
let lastServoLocked = true;      // Paskutinė dėžutės užrakto būsena (iš ESP32)
let recentBoxUnlock = 0;         // Paskutinio box_unlocked event'o laikas (suderinamumas su backend'u)
let boxJustEarnedUnlock = false; // True tik kai dėžutė atrakinta dėl pasiekto tikslo (ne rankiniu būdu)
let lastLedColorChange = false;  // Vėliava nurodyti ar paskutinis updateLed kvietimas buvo dėl spalvos
let tempChart, humChart, luxChart; // Chart.js grafikai

// ============================================================
// REŽIMŲ PAVADINIMŲ VERTIMAS (atvaizdavimui)
// ============================================================
// Sistemos viduje (DB, MQTT, kodas) vartojami originalūs pavadinimai
// (Focus, Break, idle). Vartotojui rodome lietuviškas versijas.

const MODE_DISPLAY_NAMES = {
  'idle': 'Neaktyvus',
  'Focus': 'Gilus darbas',
  'Break': 'Pertrauka'
};

function getModeDisplayName(modeName) {
  if (!modeName) return 'Neaktyvus';
  return MODE_DISPLAY_NAMES[modeName] || modeName;
}

// LED spalvų vertimas (atvaizdavimui)
const LED_COLOR_NAMES = {
  'blue': 'Mėlyna',
  'red': 'Raudona',
  'green': 'Žalia',
  'white': 'Balta',
  'yellow': 'Geltona'
};

function getLedColorDisplay(color) {
  if (!color) return '–';
  // Pasirinktinė spalva (HEX) – paliekame kaip yra
  if (color.startsWith('#')) return color;
  return LED_COLOR_NAMES[color] || color;
}

// ============================================================
// WEBSOCKET JUNGTIS
// ============================================================

function connectWS() {
  ws = new WebSocket(`ws://${location.host}`);

  ws.onopen = () => {
    setConnectionStatus(true);
  };

  ws.onclose = () => {
    setConnectionStatus(false);
    setTimeout(connectWS, 2000);
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleWSMessage(msg);
  };
}

// Apdorojame įeinančius WebSocket pranešimus
function handleWSMessage(msg) {
  switch (msg.type) {
    case 'init':
      // Pradinė būsena prisijungus
      if (msg.data.sensorData) updateSensors(msg.data.sensorData);
      if (msg.data.mode) {
        currentMode = msg.data.mode;
        updateModeDisplay();
      }
      if (msg.data.espConnected !== undefined) updateESPStatus(msg.data.espConnected);
      if (msg.data.soundMuted !== undefined) {
        soundMuted = msg.data.soundMuted;
        document.getElementById('sound-enabled').checked = !soundMuted;
      }
      if (msg.data.session && msg.data.session.active) {
        restoreSession(msg.data.session);
      }
      if (msg.data.box) {
        boxData = msg.data.box;
        updateBoxProgress();
      }
      break;

    case 'sensor_update':
      if (msg.data) updateSensors(msg.data);
      if (msg.data.espConnected !== undefined) updateESPStatus(msg.data.espConnected);
      break;

    case 'esp_status':
      if (msg.data) updateESPStatus(msg.data.connected);
      break;

    case 'mode_update':
      if (msg.data) {
        currentMode = msg.data.mode || 'idle';
        updateModeDisplay();
        if (msg.data.mode === 'idle') {
          stopPomodoro();
          stopSessionTimer();
        } else {
          // Pradedame sesijos laikmatį kai režimas ne idle
          if (!sessionTimer) startSessionTimer();
          if (msg.data.session && msg.data.session.active) {
            restoreSession(msg.data.session);
          }
        }
      }
      break;

    case 'checkin_request':
      showCheckInModal(msg.data.timeout);
      break;

    case 'checkin_confirmed':
      hideCheckInModal();
      break;

    case 'checkin_missed':
      hideCheckInModal();
      break;

    case 'block_complete':
      // Backend nesuderinamumo apsauga: jei ką tik gavom box_unlocked (prieš ms),
      // o atsiunčiamame completedBlocks yra 0 - vadinasi backend siunčia seną formatą
      // (resetintą reikšmę). Tada modale rodome unlockTarget kaip pasiekimą (pvz. 1/1).
      const justUnlockedFlag = msg.data.justUnlocked === true ||
        (recentBoxUnlock && Date.now() - recentBoxUnlock < 1000);
      const displayCompleted = justUnlockedFlag && msg.data.completedBlocks === 0
        ? msg.data.unlockTarget
        : msg.data.completedBlocks;

      showBlockCompleteModal({ ...msg.data, completedBlocks: displayCompleted, justUnlocked: justUnlockedFlag });

      if (msg.data.completedBlocks !== undefined) {
        // Po atrakinimo DB jau resetuotas - dėžutės kortelė rodo naują ciklą (0)
        boxData.completedBlocks = justUnlockedFlag ? 0 : msg.data.completedBlocks;
        if (msg.data.unlockTarget) boxData.unlockTarget = msg.data.unlockTarget;
        updateBoxProgress();
      }
      break;

    case 'box_unlocked':
      // Žymime laiką, kad block_complete žinotų jog vyko atrakinimas
      recentBoxUnlock = Date.now();
      // Pažymime, kad dėžutė atrakinta sąžiningai (pasiekus tikslą) - rodyti pilną progresą
      boxJustEarnedUnlock = true;
      break;

    case 'new_event':
      loadEvents();
      break;
  }

  // Toast pranešimai
  if (msg.type !== 'sensor_update' && msg.type !== 'esp_status' && msg.type !== 'init') {
    handleToastEvents(msg);
  }

  // Atnaujinti statistiką po bloko
  if (msg.type === 'block_complete') {
    loadSessionStats();
  }
}

// ============================================================
// PRISIJUNGIMO IR ESP32 BŪSENA
// ============================================================

function setConnectionStatus(connected) {
  const indicator = document.getElementById('conn-indicator');
  indicator.className = 'connection-indicator ' + (connected ? 'connected' : 'disconnected');
  document.getElementById('conn-text').textContent = connected ? 'Prisijungta' : 'Atsijungta';
}

function updateESPStatus(connected) {
  const dot = document.getElementById('esp-dot');
  const text = document.getElementById('esp-text');
  const settingStatus = document.getElementById('esp-setting-status');

  dot.className = 'status-dot' + (connected ? ' on' : '');
  text.textContent = connected ? 'Prisijungęs' : 'Atjungtas';

  if (settingStatus) {
    settingStatus.textContent = connected ? 'Prisijungęs' : 'Atjungtas';
    settingStatus.style.color = connected ? 'var(--success)' : 'var(--danger)';
  }
}

// ============================================================
// JUTIKLIŲ ATNAUJINIMAS
// ============================================================

// Smooth skaičių animacija
function animateValue(elementId, newValue, decimals = 1) {
  const el = document.getElementById(elementId);
  const current = parseFloat(el.textContent) || 0;
  const diff = newValue - current;

  if (Math.abs(diff) < 0.05) {
    el.textContent = newValue.toFixed(decimals);
    return;
  }

  const steps = 15;
  const stepValue = diff / steps;
  let step = 0;

  function tick() {
    step++;
    if (step >= steps) {
      el.textContent = newValue.toFixed(decimals);
      return;
    }
    const val = current + stepValue * step;
    el.textContent = val.toFixed(decimals);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function updateSensors(d) {
  if (d.temperature !== undefined) {
    animateValue('temp', d.temperature, 1);
    document.getElementById('temp-bar').style.width = Math.min((d.temperature / 40) * 100, 100) + '%';
  }
  if (d.humidity !== undefined) {
    animateValue('hum', d.humidity, 1);
    document.getElementById('hum-bar').style.width = Math.min(d.humidity, 100) + '%';
  }
  if (d.light !== undefined) {
    animateValue('lux', d.light, 0);
    document.getElementById('lux-bar').style.width = Math.min((d.light / 1000) * 100, 100) + '%';
  }

  // Aktuatorių būsena
  if (d.fanOn !== undefined) {
    document.getElementById('fan-dot').className = 'status-dot' + (d.fanOn ? ' on' : '');
    document.getElementById('fan-text').textContent = d.fanOn ? 'Įjungtas' : 'Išjungtas';
  }

  if (d.ledColor) {
    document.getElementById('led-info').textContent = getLedColorDisplay(d.ledColor) + ' / ' + (d.ledBrightness || 30);
    const colorMap = { blue: '#4466ff', red: '#ff4455', green: '#44cc66', white: '#eeeeee', yellow: '#ffcc33' };
    document.getElementById('led-preview').style.background = colorMap[d.ledColor] || (d.ledColor.startsWith('#') ? d.ledColor : '#4466ff');

    // Sinchronizuojam rankinio valdymo elementus su faktine LED būsena.
    // Atnaujinam tik kai vartotojas šiuo metu nesąveikauja su tais elementais.
    syncManualLedControls(d.ledColor, d.ledBrightness);
  }

  if (d.servoLocked !== undefined) {
    const stateChanged = lastServoLocked !== d.servoLocked;
    lastServoLocked = d.servoLocked;
    document.getElementById('servo-icon').textContent = d.servoLocked ? '🔒' : '🔓';
    document.getElementById('servo-info').textContent = d.servoLocked ? 'Užrakinta' : 'Atrakinta';
    updateRewardBadge(d.servoLocked);
    // Užrakinus atgal - resetinamas "earned unlock" flag'as. Naujas ciklas prasideda.
    if (d.servoLocked) boxJustEarnedUnlock = false;
    // Perpiešiame progresą - kai atrakinta rodome pilną, kai užrakinta - faktinį skaičių
    if (stateChanged) updateBoxProgress();
  }
}

// Atvaizduoja „Pasiimkite atlygį" indikatorių dėžutės progreso bloke
// kai dėžutė yra atrakinta (kviečia vartotoją pasiimti atlygį)
function updateRewardBadge(servoLocked) {
  const progress = document.getElementById('box-progress');
  if (!progress) return;

  let badge = progress.querySelector('.reward-badge');
  if (!servoLocked) {
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'reward-badge';
      badge.innerHTML = '🎁 Pasiimkite atlygį iš dėžutės';
      progress.appendChild(badge);
    }
  } else {
    if (badge) badge.remove();
  }
}

// ============================================================
// REŽIMŲ VALDYMAS
// ============================================================

// Užkrauti režimus iš serverio
async function loadModes() {
  const res = await fetch('/api/modes');
  modes = await res.json();
  renderModeButtons();
}

// Atvaizduoti režimų mygtukus
function renderModeButtons() {
  const container = document.getElementById('mode-buttons');

  let html = modes.map(m => {
    const timerText = m.timerDuration > 0 ? `${m.timerDuration} min` : 'Be laikmačio';
    const isActive = currentMode === m.name;
    // Aktyvaus režimo negalima redaguoti - pakeitimai įsigaliotų tik perjungus iš naujo,
    // todėl gear ikona vizualiai blokuojama ir paspaudus tik informuojama vartotoją
    const editAttrs = isActive
      ? `class="mode-btn-edit is-disabled" onclick="event.stopPropagation(); notifyEditBlocked()" title="Sustabdykite režimą, kad galėtumėte jį redaguoti"`
      : `class="mode-btn-edit" onclick="event.stopPropagation(); openModeEditor('${m.name}')" title="Redaguoti"`;
    return `
    <div class="mode-btn ${isActive ? 'active' : ''}" data-mode="${m.name}" onclick="setMode('${m.name}')">
      <span ${editAttrs}>⚙</span>
      <span class="mode-btn-icon">${m.icon}</span>
      <span class="mode-btn-label">${getModeDisplayName(m.name)}</span>
      <span class="mode-btn-desc">${m.description || ''}</span>
      <span class="mode-btn-timer">${timerText}</span>
    </div>
  `;
  }).join('');

  // „Sustabdyti" mygtukas visada paskutinis. Kai jau esame Neaktyvus
  // (currentMode === 'idle'), mygtukas vizualiai pilkas – nieko sustabdyti nereikia.
  const idleDisabled = currentMode === 'idle';
  html += `
    <div class="mode-btn idle-btn${idleDisabled ? ' is-disabled' : ''}" data-mode="idle" onclick="setMode('idle')">
      <span class="mode-btn-icon">○</span>
      <span class="mode-btn-label">Sustabdyti</span>
    </div>
  `;

  container.innerHTML = html;
}

// Atnaujinti aktyvaus režimo atvaizdavimą
function updateModeDisplay() {
  document.getElementById('session-mode-name').textContent = getModeDisplayName(currentMode);

  // Perrender mygtukus, kad atsinaujintų ir „is-disabled" būsena „Sustabdyti" mygtukui
  if (modes.length > 0) {
    renderModeButtons();
  } else {
    // Jei režimų dar neužkrauta – tik atnaujinam active klasę
    document.querySelectorAll('.mode-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.mode === currentMode);
    });
  }

  // Session bar glow pagal režimo spalvą
  updateSessionGlow();

  // Atnaujinti favicon ir title pagal režimą
  updateFavicon();
}

// Session bar spalvinis glow
function updateSessionGlow() {
  const bar = document.getElementById('session-bar');
  const fill = document.getElementById('session-progress-fill');
  // Pašaliname visus glow klasius
  bar.className = 'session-bar';
  bar.style.boxShadow = '';
  bar.style.borderColor = '';
  fill.style.width = '0%';

  if (currentMode === 'idle') {
    fill.style.background = 'transparent';
    return;
  }

  const mode = modes.find(m => m.name === currentMode);
  if (mode) {
    if (mode.ledColor.startsWith('#')) {
      // Pasirinktinė spalva – taikome inline glow
      bar.style.boxShadow = `0 0 20px ${mode.ledColor}25, inset 0 0 20px ${mode.ledColor}0d`;
      bar.style.borderColor = `${mode.ledColor}4d`;
      fill.style.background = mode.ledColor;
    } else {
      bar.classList.add('glow-' + mode.ledColor);
      const colorMap = { 'blue': '#4466ff', 'red': '#ff4455', 'green': '#44cc66', 'white': '#cccccc', 'yellow': '#ffcc33' };
      fill.style.background = colorMap[mode.ledColor] || '#4466ff';
    }
  }
}

// Favicon ir naršyklės title atnaujinimas
function updateFavicon() {
  const colorMap = {
    'blue': '#4466ff', 'red': '#ff4455', 'green': '#44cc66',
    'white': '#cccccc', 'yellow': '#ffcc33'
  };

  // Gauname spalvą iš aktyvaus režimo nustatymų
  let color = '#888888';
  let emoji = '⚪';

  if (currentMode !== 'idle') {
    const mode = modes.find(m => m.name === currentMode);
    if (mode) {
      if (mode.ledColor.startsWith('#')) {
        color = mode.ledColor;
        emoji = '🔵';
      } else {
        color = colorMap[mode.ledColor] || '#4466ff';
        emoji = mode.ledColor === 'blue' ? '🔵' : mode.ledColor === 'green' ? '🟢' : mode.ledColor === 'red' ? '🔴' : mode.ledColor === 'yellow' ? '🟡' : '⚪';
      }
    }
  }

  // Generuojame favicon iš canvas
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');

  ctx.beginPath();
  ctx.arc(16, 16, 14, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(16, 16, 6, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  let link = document.querySelector("link[rel='icon']");
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = canvas.toDataURL();

  // Title
  if (currentMode === 'idle') {
    document.title = 'Adaptyvi produktyvumo sistema';
  } else {
    document.title = `${emoji} ${getModeDisplayName(currentMode)} – Adaptyvi produktyvumo sistema`;
  }

  // Saugome emoji vėlesniam naudojimui pomodoro title'e
  window._modeEmoji = emoji;
}

// Aktyvuoti režimą (su patvirtinimu tik jei pomodoro laikmatis aktyvus)
async function setMode(mode) {
  // Patvirtinimo prašome TIK jei pomodoro laikmatis aktyvus (yra countdown)
  if (currentMode !== 'idle' && mode !== currentMode && pomodoroEnd !== null) {
    const targetName = getModeDisplayName(mode);
    const currentName = getModeDisplayName(currentMode);
    showConfirmModal(
      mode === 'idle' ? 'Baigti sesiją?' : `Perjungti į „${targetName}"?`,
      mode === 'idle'
        ? 'Dabartinė sesija bus nutraukta. Blokas nebus užskaitytas.'
        : `Dabartinė „${currentName}" sesija bus nutraukta ir perjungta į „${targetName}". Neužbaigtas blokas nebus užskaitytas.`,
      () => doSetMode(mode)
    );
    return;
  }
  doSetMode(mode);
}

// Faktinis režimo keitimas (be patvirtinimo)
async function doSetMode(mode) {
  // Sustabdome pomodoro ir sesiją prieš keičiant
  stopPomodoro();
  stopSessionTimer();

  // Jei aktyvuojamas režimas su „Užrakinti pradėjus sesiją" ir dėžutė šiuo metu
  // atrakinta – iš anksto ją užrakinam (kad nauja sesija prasidėtų su uždara dėžute).
  if (mode !== 'idle') {
    const modeData = modes.find(m => m.name === mode);
    const boxIsUnlocked = lastServoLocked === false;
    if (modeData && modeData.servoLockOnStart && boxIsUnlocked) {
      await setServo(true, true); // silent - sistema automatiškai užrakina pradedant sesiją
    }
  }

  await fetch('/api/mode/activate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode })
  });

  // Kai sustabdome sesiją (idle) – išjungiame apšvietimą ir ventiliatorių.
  // Spalva paliekama paskutinė, todėl iš naujo įjungus rankiniu būdu
  // ar pasirinkus režimą, atsistato anksčiau buvusi būsena.
  if (mode === 'idle') {
    const color = getLedColor ? getLedColor() : 'blue';
    await fetch('/api/led', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color, brightness: 0 })
    });
    // Išjungiame ventiliatorių (silent - kad neparodytų rankinio valdymo toast'o)
    await fetch('/api/fan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: false })
    });
  }

  loadEvents();
}

// ============================================================
// SESIJOS LAIKMATIS
// ============================================================

function startSessionTimer() {
  sessionStart = Date.now();
  if (sessionTimer) clearInterval(sessionTimer);
  sessionTimer = setInterval(updateSessionTime, 1000);
}

function stopSessionTimer() {
  if (sessionTimer) clearInterval(sessionTimer);
  sessionTimer = null;
  sessionStart = null;
  document.getElementById('session-time').textContent = '00:00:00';
}

function updateSessionTime() {
  if (!sessionStart) return;
  const elapsed = Date.now() - sessionStart;
  const h = String(Math.floor(elapsed / 3600000)).padStart(2, '0');
  const m = String(Math.floor((elapsed % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0');
  document.getElementById('session-time').textContent = `${h}:${m}:${s}`;
}

// ============================================================
// POMODORO LAIKMATIS
// ============================================================

function startPomodoro(durationMin, endTime) {
  pomodoroTotalSec = durationMin * 60;
  pomodoroEnd = endTime || (Date.now() + pomodoroTotalSec * 1000);

  document.getElementById('pomodoro-section').style.display = 'flex';

  if (pomodoroInterval) clearInterval(pomodoroInterval);
  pomodoroInterval = setInterval(updatePomodoro, 1000);
  updatePomodoro();
}

function stopPomodoro() {
  if (pomodoroInterval) clearInterval(pomodoroInterval);
  pomodoroInterval = null;
  pomodoroEnd = null;
  document.getElementById('pomodoro-section').style.display = 'none';
  document.getElementById('pomodoro-time').textContent = '00:00';

  // Atstatyti žiedą
  const ring = document.getElementById('pomodoro-ring');
  ring.style.strokeDashoffset = '0';
}

function updatePomodoro() {
  if (!pomodoroEnd) return;

  const remaining = Math.max(0, pomodoroEnd - Date.now());
  const remainingSec = Math.ceil(remaining / 1000);
  const min = String(Math.floor(remainingSec / 60)).padStart(2, '0');
  const sec = String(remainingSec % 60).padStart(2, '0');

  document.getElementById('pomodoro-time').textContent = `${min}:${sec}`;

  // Atnaujinti naršyklės title su likusiu laiku
  const emoji = window._modeEmoji || '⚪';
  document.title = `${emoji} ${min}:${sec} ${getModeDisplayName(currentMode)} – Adaptyvi produktyvumo sistema`;

  // Atnaujinti žiedą
  const circumference = 276.46;
  const elapsed = pomodoroTotalSec - remainingSec;
  const progress = elapsed / pomodoroTotalSec;
  const offset = circumference * progress;

  document.getElementById('pomodoro-ring').style.strokeDashoffset = offset;

  // Atnaujinti session bar progress fill
  const fill = document.getElementById('session-progress-fill');
  fill.style.width = (progress * 100) + '%';

  if (remaining <= 0) {
    stopPomodoro();
  }
}

// Atkurti sesiją po prisijungimo
function restoreSession(sessionData) {
  if (sessionData.active) {
    sessionStart = sessionData.startTime;
    if (!sessionTimer) {
      sessionTimer = setInterval(updateSessionTime, 1000);
    }

    if (sessionData.timerEnd) {
      const durationMs = sessionData.timerEnd - sessionData.startTime;
      startPomodoro(durationMs / 60000, sessionData.timerEnd);
    }
  }
}

// ============================================================
// AKTYVUMO PATIKRINIMAS (Check-in)
// ============================================================

function showCheckInModal(timeout) {
  // Apsauga: jei modalas jau rodomas (laukiame ankstesnio patvirtinimo),
  // nereiksetinti laikmačio iš naujo. Šis bug'as pasireiškia kai serveris
  // siunčia dublikuotus checkin_request event'us (pvz. interval < timeout).
  const modal = document.getElementById('checkin-modal');
  if (!modal.classList.contains('hidden')) return;

  checkInTimeout = timeout || 30;
  let remaining = checkInTimeout;

  modal.classList.remove('hidden');
  document.getElementById('checkin-time').textContent = formatSeconds(remaining);
  document.getElementById('checkin-bar').style.width = '100%';

  if (checkInTimer) clearInterval(checkInTimer);
  checkInTimer = setInterval(() => {
    remaining--;
    document.getElementById('checkin-time').textContent = formatSeconds(remaining);
    document.getElementById('checkin-bar').style.width = ((remaining / checkInTimeout) * 100) + '%';

    if (remaining <= 0) {
      clearInterval(checkInTimer);
    }
  }, 1000);
}

function hideCheckInModal() {
  document.getElementById('checkin-modal').classList.add('hidden');
  if (checkInTimer) clearInterval(checkInTimer);
}

function confirmCheckIn() {
  fetch('/api/checkin/confirm', { method: 'POST' });
  hideCheckInModal();
}

function endSession() {
  hideCheckInModal();
  // Jei iškviečiama iš check-in modalo – tiesiai baigiame
  doSetMode('idle');
}

// Saugus sesijos baigimas su patvirtinimu (iš mygtuko)
function endSessionSafe() {
  if (currentMode === 'idle') return;
  if (pomodoroEnd !== null) {
    // Pomodoro aktyvus – prašome patvirtinimo
    showConfirmModal(
      'Baigti sesiją?',
      'Dabartinė sesija bus nutraukta. Neužbaigtas blokas nebus užskaitytas.',
      () => doSetMode('idle')
    );
  } else {
    // Be pomodoro – tiesiog baigiame
    doSetMode('idle');
  }
}

function formatSeconds(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

// ============================================================
// DĖŽUTĖS PROGRESAS
// ============================================================

function updateBoxProgress() {
  const { completedBlocks, unlockTarget } = boxData;

  // Pilną progresą rodome tik tada, kai dėžutė atrakinta dėl pasiekto tikslo
  // (boxJustEarnedUnlock = true). Jei vartotojas atrakino rankiniu būdu - rodome
  // faktinį completedBlocks skaičių, kad nebūtų klaidinama, jog tikslas pasiektas.
  const displayCount = boxJustEarnedUnlock ? unlockTarget : completedBlocks;
  const pct = Math.min((displayCount / unlockTarget) * 100, 100);

  document.getElementById('box-count').textContent = `${displayCount} / ${unlockTarget}`;
  document.getElementById('box-fill').style.width = pct + '%';

  // Nustatymų skiltis
  const targetInput = document.getElementById('box-target');
  if (targetInput) targetInput.value = unlockTarget;
}

async function updateBoxTarget() {
  const target = parseInt(document.getElementById('box-target').value);
  if (target > 0) {
    await fetch('/api/box', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unlockTarget: target })
    });
    boxData.unlockTarget = target;
    updateBoxProgress();
  }
}

async function resetBox() {
  if (confirm('Ar tikrai norite atstatyti dėžutės progresą?')) {
    await fetch('/api/box/reset', { method: 'POST' });
    boxData.completedBlocks = 0;
    updateBoxProgress();
  }
}

// ============================================================
// BLOKO PABAIGOS MODALAS
// ============================================================

function showBlockCompleteModal(data) {
  document.getElementById('block-complete-modal').classList.remove('hidden');
  document.getElementById('block-complete-desc').textContent =
    `Sėkmingai užbaigėte „${getModeDisplayName(data.mode)}" bloką (${data.duration} min)`;

  const wasUnlocked = data.justUnlocked === true;

  document.getElementById('block-complete-info').innerHTML = `
    <p style="margin-bottom:8px">Užbaigti blokai: <strong>${data.completedBlocks} / ${data.unlockTarget}</strong></p>
    ${wasUnlocked ? '<p style="color:var(--success)">🎉 Dėžutė atrakinta!</p>' : ''}
  `;

  // Kontekstiniai mygtukai pagal paskutinį režimą
  const nextBtn = document.getElementById('block-next-btn');
  const repeatBtn = document.getElementById('block-repeat-btn');
  const lastMode = data.mode;
  const lastModeLower = (lastMode || '').toLowerCase();

  // Bendras helper'is – uždaro modal, pašalina "Dėžutė atrakinta" toast'ą
  // (kad nelikt rodoma "atrakinta", kai useris jau pradėjo naują sesiją)
  const closeAndDismiss = () => {
    closeBlockModal();
    if (wasUnlocked) dismissToast('box-unlocked');
  };

  // Pakartojimo mygtukas – matomas visada (jei režimas vis dar egzistuoja)
  const modeExists = modes.some(m => m.name === lastMode);
  if (modeExists) {
    repeatBtn.style.display = '';
    repeatBtn.textContent = 'Pakartoti';
    repeatBtn.onclick = () => { closeAndDismiss(); doSetMode(lastMode); };
  } else {
    repeatBtn.style.display = 'none';
  }

  // Pagrindinis mygtukas – siūlo logišką tęsinį
  if (lastModeLower === 'focus') {
    // Po gilaus darbo siūlome pertrauką
    nextBtn.textContent = 'Pradėti pertrauką';
    nextBtn.onclick = () => { closeAndDismiss(); doSetMode('Break'); };
  } else if (lastModeLower === 'break') {
    // Po pertraukos siūlome gilų darbą
    nextBtn.textContent = 'Pradėti gilų darbą';
    nextBtn.onclick = () => { closeAndDismiss(); doSetMode('Focus'); };
  } else {
    // Po vartotojo sukurto režimo – siūlome pertrauką (visada universalus poilsis)
    nextBtn.textContent = 'Pradėti pertrauką';
    nextBtn.onclick = () => { closeAndDismiss(); doSetMode('Break'); };
  }
}

function closeBlockModal() {
  document.getElementById('block-complete-modal').classList.add('hidden');
}

// ============================================================
// REŽIMO REDAKTORIUS
// ============================================================

// Vartotojas paspaudė redagavimo ikoną ant aktyvaus režimo - aktyvaus režimo
// negalima redaguoti, nes pakeitimai įsigaliotų tik perjungus jį iš naujo.
// Vietoj klaidos pranešimo - švelnus toast su nurodymu kaip elgtis.
function notifyEditBlocked() {
  showToast('Šis režimas šiuo metu aktyvus. Sustabdykite jį, kad galėtumėte redaguoti.', 'info', 4000);
}

function openModeEditor(modeName) {
  editingMode = modeName || null;
  const modal = document.getElementById('mode-editor-modal');
  const title = document.getElementById('mode-editor-title');
  const deleteBtn = document.getElementById('editor-delete-btn');

  if (editingMode) {
    // Redaguojame esamą
    title.textContent = 'Redaguoti režimą';
    const mode = modes.find(m => m.name === editingMode);
    if (!mode) return;

    document.getElementById('editor-name').value = mode.name;
    document.getElementById('editor-name').disabled = mode.isDefault;
    document.getElementById('editor-desc').value = mode.description || '';
    document.getElementById('editor-timer-enabled').checked = mode.timerDuration > 0;
    document.getElementById('editor-timer').value = mode.timerDuration || 25;

    // Spalvos nustatymas – jei tai ne standartinė spalva, rodome custom picker
    const standardColors = ['blue', 'red', 'green', 'white', 'yellow'];
    if (standardColors.includes(mode.ledColor)) {
      document.getElementById('editor-led-color').value = mode.ledColor;
      document.getElementById('editor-custom-color').classList.add('hidden');
    } else {
      document.getElementById('editor-led-color').value = 'custom';
      document.getElementById('editor-custom-color').value = mode.ledColor;
      document.getElementById('editor-custom-color').classList.remove('hidden');
    }

    document.getElementById('editor-led-bright').value = mode.ledBrightness;
    document.getElementById('editor-led-bright').nextElementSibling.textContent = mode.ledBrightness;
    document.getElementById('editor-fan-control').value = mode.fanControl;
    document.getElementById('editor-fan-threshold').value = mode.fanThreshold;
    document.getElementById('editor-checkin-enabled').checked = !!mode.checkInEnabled;
    document.getElementById('editor-checkin-interval').value = mode.checkInInterval;
    document.getElementById('editor-checkin-timeout').value = mode.checkInTimeout;
    document.getElementById('editor-missed-action').value = mode.missedCheckInAction;
    document.getElementById('editor-sound-start').checked = !!mode.buzzerOnStart;
    document.getElementById('editor-sound-end').checked = !!mode.buzzerOnEnd;
    document.getElementById('editor-sound-checkin').checked = !!mode.buzzerOnCheckIn;
    document.getElementById('editor-servo-lock').checked = !!mode.servoLockOnStart;

    // Ikona
    document.querySelectorAll('.icon-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.icon === mode.icon);
    });

    deleteBtn.style.display = mode.isDefault ? 'none' : 'block';
  } else {
    // Naujas režimas
    title.textContent = 'Naujas režimas';
    document.getElementById('editor-name').value = '';
    document.getElementById('editor-name').disabled = false;
    document.getElementById('editor-desc').value = '';
    document.getElementById('editor-timer-enabled').checked = true;
    document.getElementById('editor-timer').value = 25;
    document.getElementById('editor-led-color').value = 'blue';
    document.getElementById('editor-custom-color').classList.add('hidden');
    document.getElementById('editor-led-bright').value = 30;
    document.getElementById('editor-led-bright').nextElementSibling.textContent = '30';
    document.getElementById('editor-fan-control').value = 'auto';
    document.getElementById('editor-fan-threshold').value = 26;
    document.getElementById('editor-checkin-enabled').checked = false;
    document.getElementById('editor-checkin-interval').value = 25;
    document.getElementById('editor-checkin-timeout').value = 30;
    document.getElementById('editor-missed-action').value = 'stop';
    document.getElementById('editor-sound-start').checked = false;
    document.getElementById('editor-sound-end').checked = true;
    document.getElementById('editor-sound-checkin').checked = true;
    document.getElementById('editor-servo-lock').checked = false;
    document.querySelectorAll('.icon-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelector('.icon-btn[data-icon="◉"]').classList.add('active');
    deleteBtn.style.display = 'none';
  }

  toggleFanThreshold();
  toggleCheckInFields();
  toggleTimerFields();
  modal.classList.remove('hidden');
}

function closeModeEditor() {
  document.getElementById('mode-editor-modal').classList.add('hidden');
  editingMode = null;
}

// Išsaugoti režimą
async function saveModeEditor() {
  const name = document.getElementById('editor-name').value.trim();
  if (!name) { alert('Įveskite režimo pavadinimą'); return; }

  const selectedIcon = document.querySelector('.icon-btn.active');

  const timerEnabled = document.getElementById('editor-timer-enabled').checked;

  const data = {
    icon: selectedIcon ? selectedIcon.dataset.icon : '◉',
    description: document.getElementById('editor-desc').value,
    timerDuration: timerEnabled ? (parseFloat(document.getElementById('editor-timer').value) || 25) : 0,
    ledColor: getEditorColor(),
    ledBrightness: parseInt(document.getElementById('editor-led-bright').value) || 30,
    fanControl: document.getElementById('editor-fan-control').value,
    fanThreshold: parseFloat(document.getElementById('editor-fan-threshold').value) || 26,
    checkInEnabled: document.getElementById('editor-checkin-enabled').checked,
    checkInInterval: parseFloat(document.getElementById('editor-checkin-interval').value) || 25,
    checkInTimeout: parseInt(document.getElementById('editor-checkin-timeout').value) || 30,
    missedCheckInAction: document.getElementById('editor-missed-action').value,
    buzzerOnStart: document.getElementById('editor-sound-start').checked,
    buzzerOnEnd: document.getElementById('editor-sound-end').checked,
    buzzerOnCheckIn: document.getElementById('editor-sound-checkin').checked,
    servoLockOnStart: document.getElementById('editor-servo-lock').checked
  };

  if (editingMode) {
    // Atnaujinti
    await fetch(`/api/modes/${editingMode}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } else {
    // Sukurti naują
    data.name = name;
    const res = await fetch('/api/modes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    const result = await res.json();
    if (result.error) { alert(result.error); return; }
  }

  closeModeEditor();
  loadModes();
}

// Ištrinti režimą
async function deleteMode() {
  if (!editingMode) return;
  if (!confirm(`Ar tikrai norite ištrinti režimą "${editingMode}"?`)) return;

  await fetch(`/api/modes/${editingMode}`, { method: 'DELETE' });
  closeModeEditor();
  loadModes();
}

// Pasirinkti ikoną
function selectIcon(btn) {
  document.querySelectorAll('.icon-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

// Rodyti/slėpti ventiliatoriaus slenkstį
function toggleFanThreshold() {
  const field = document.getElementById('fan-threshold-field');
  const control = document.getElementById('editor-fan-control').value;
  field.style.display = control === 'auto' ? 'flex' : 'none';
}

// Rodyti/slėpti patikrinimo nustatymus ir susieti garso nustatymą
function toggleCheckInFields() {
  const enabled = document.getElementById('editor-checkin-enabled').checked;
  const fields = document.getElementById('checkin-fields');
  const soundCheckIn = document.getElementById('editor-sound-checkin');
  const soundCheckInRow = soundCheckIn.closest('.editor-field');

  // Sklandus laukų atidarymas/uždarymas
  if (enabled) {
    fields.classList.remove('collapsed');
  } else {
    fields.classList.add('collapsed');
  }

  // Garso signalas patikrinimo metu – paslepiamas su animacija jei patikrinimas išjungtas
  if (soundCheckInRow) {
    soundCheckInRow.classList.add('collapsible-row');
    if (enabled) {
      soundCheckInRow.classList.remove('collapsed-row');
    } else {
      soundCheckInRow.classList.add('collapsed-row');
      soundCheckIn.checked = false;
    }
  }
}

// Rodyti/slėpti laikmačio trukmę
function toggleTimerFields() {
  const enabled = document.getElementById('editor-timer-enabled').checked;
  const fields = document.getElementById('timer-fields');
  if (enabled) {
    fields.classList.remove('collapsed');
  } else {
    fields.classList.add('collapsed');
  }
}

// ============================================================
// RANKINIS VALDYMAS
// ============================================================

async function toggleFan(state) {
  await fetch('/api/fan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state })
  });
  showToast(state ? 'Ventiliatorius įjungtas' : 'Ventiliatorius išjungtas', 'info');
}

async function buzzer() {
  await fetch('/api/buzzer', { method: 'POST' });
  showToast('Garso signalas suaktyvintas', 'info');
}

async function setServo(locked, silent = false) {
  await fetch('/api/servo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locked })
  });
  // Atrakinimo atveju toast'as jau parodomas per box_unlocked event'ą (jei buvo pasiektas tikslas).
  // Čia rodome tik tada, kai useris rankiniu būdu pakeičia būseną - dezutes uzrakinimui visada,
  // o atrakinimui tik kai tai ne automatinis pasiekimas.
  // silent=true naudojama, kai funkcija kviečiama programiškai (pvz. doSetMode automatinis užrakinimas)
  if (silent) return;
  if (locked) {
    showToast('Dėžutė užrakinta', 'info');
  } else {
    showToast('Dėžutė atrakinta rankiniu būdu', 'info');
  }
}

let ledLastBrightness = 30;

// Rankinio valdymo spalvos pasirinkimas
function onLedColorChange() {
  const select = document.getElementById('led-color');
  const picker = document.getElementById('led-custom-color');
  if (select.value === 'custom') {
    picker.classList.remove('hidden');
    picker.click();
  } else {
    picker.classList.add('hidden');
    lastLedColorChange = true; // pažymime, kad pasikeitė spalva (ne ryškumas)
    updateLed();
  }
}

function updateLedCustom() {
  lastLedColorChange = true;
  updateLed();
}

// Režimo redaktoriaus spalvos pasirinkimas
function onEditorColorChange() {
  const select = document.getElementById('editor-led-color');
  const picker = document.getElementById('editor-custom-color');
  if (select.value === 'custom') {
    picker.classList.remove('hidden');
  } else {
    picker.classList.add('hidden');
  }
}

function getLedColor() {
  const select = document.getElementById('led-color');
  if (select.value === 'custom') {
    return document.getElementById('led-custom-color').value;
  }
  return select.value;
}

// Sinchronizuoja rankinio valdymo LED kontrolerius su faktine sistemos būsena.
// Neperrašo elementų, su kuriais vartotojas šiuo metu sąveikauja (turi focus).
function syncManualLedControls(color, brightness) {
  const colorSelect = document.getElementById('led-color');
  const customPicker = document.getElementById('led-custom-color');
  const brightSlider = document.getElementById('led-brightness');
  const brightVal = document.getElementById('led-bright-val');

  // Atnaujinam spalvą tik jei select neturi focus
  if (color && colorSelect && document.activeElement !== colorSelect) {
    if (color.startsWith('#')) {
      // Pasirinktinė (HEX) spalva
      colorSelect.value = 'custom';
      if (customPicker) {
        customPicker.value = color;
        customPicker.classList.remove('hidden');
      }
    } else {
      // Predefined spalva
      const knownColors = ['blue', 'red', 'green', 'white', 'yellow'];
      if (knownColors.includes(color)) {
        colorSelect.value = color;
        if (customPicker) customPicker.classList.add('hidden');
      }
    }
  }

  // Atnaujinam ryškumą tik jei slider neturi focus (vartotojas šiuo metu netampo)
  if (brightness !== undefined && brightSlider && document.activeElement !== brightSlider) {
    brightSlider.value = brightness;
    if (brightVal) brightVal.textContent = brightness;
    // Įsimenam paskutinį ryškumą įjungimui per „Įjungti" mygtuką
    if (brightness > 0) ledLastBrightness = brightness;
  }
}

function getEditorColor() {
  const select = document.getElementById('editor-led-color');
  if (select.value === 'custom') {
    return document.getElementById('editor-custom-color').value;
  }
  return select.value;
}

async function toggleLed(on) {
  if (on) {
    document.getElementById('led-brightness').value = ledLastBrightness;
    updateLedLabel();
    // silent=true - kad neparodytų papildomo "spalva pakeista" toast'o
    await updateLed(true);
    showToast('Apšvietimas įjungtas', 'info');
  } else {
    ledLastBrightness = parseInt(document.getElementById('led-brightness').value) || 30;
    const color = getLedColor();
    await fetch('/api/led', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color, brightness: 0 })
    });
    showToast('Apšvietimas išjungtas', 'info');
  }
}

async function updateLed(silent = false) {
  const color = getLedColor();
  const brightness = parseInt(document.getElementById('led-brightness').value);
  const brightnessChanged = brightness !== ledLastBrightness;
  ledLastBrightness = brightness;
  await fetch('/api/led', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ color, brightness })
  });
  if (!silent) {
    // Vienas toast'as priklausomai nuo to, kas pasikeitė. Spalva turi prioritetą,
    // nes vartotojas spalvą keičia sąmoningai per select/picker.
    if (brightnessChanged && !lastLedColorChange) {
      showToast(`Apšvietimo ryškumas: ${brightness}%`, 'info');
    } else {
      showToast(`Apšvietimo spalva pakeista: ${getLedColorDisplay(color)}`, 'info');
    }
    lastLedColorChange = false;
  }
}

// Vėliava nurodyti ar paskutinis updateLed kvietimas buvo dėl spalvos -
// deklaruota viršuje kartu su kitais globaliais kintamaisiais

function updateLedLabel() {
  document.getElementById('led-bright-val').textContent = document.getElementById('led-brightness').value;
}

// ============================================================
// SKIRTUKAI
// ============================================================

function switchTab(tab) {
  document.querySelectorAll('.content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));

  document.getElementById('tab-' + tab).classList.remove('hidden');
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');

  if (tab === 'history') loadHistory('1h');
  if (tab === 'log') loadEvents();
}

// ============================================================
// GRAFIKAI
// ============================================================

function getChartOptions() {
  const style = getComputedStyle(document.documentElement);
  const gridColor = style.getPropertyValue('--border').trim();
  const textColor = style.getPropertyValue('--text-muted').trim();

  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: true,
        backgroundColor: 'rgba(30, 32, 48, 0.95)',
        titleColor: '#e8eaf0',
        bodyColor: '#e8eaf0',
        borderColor: 'rgba(108, 122, 255, 0.3)',
        borderWidth: 1,
        cornerRadius: 8,
        padding: 10,
        titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
        bodyFont: { family: "'JetBrains Mono', monospace", size: 13, weight: 'bold' },
        displayColors: false,
        callbacks: {
          title: function(items) {
            if (!items.length) return '';
            const idx = items[0].dataIndex;
            const chart = items[0].chart;
            if (chart._fullTimestamps && chart._fullTimestamps[idx]) {
              return chart._fullTimestamps[idx];
            }
            return items[0].label;
          }
        }
      }
    },
    scales: {
      x: { ticks: { color: textColor, maxTicksLimit: 8, font: { size: 10 } }, grid: { color: gridColor, drawBorder: false } },
      y: { ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor, drawBorder: false } }
    },
    elements: {
      point: { radius: 0, hoverRadius: 5, hoverBorderWidth: 2 },
      line: { tension: 0.3, borderWidth: 2 }
    },
    hover: {
      mode: 'index',
      intersect: false
    }
  };
}

function createChart(canvasId, color) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  return new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [{ data: [], borderColor: color, backgroundColor: color + '15', fill: true }] },
    options: getChartOptions()
  });
}

async function loadHistory(period, btnEl) {
  if (btnEl) {
    document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
    btnEl.classList.add('active');
  }

  const res = await fetch(`/api/history?period=${period}`);
  const data = await res.json();

  // Tuščios būsenos žinutės atvaizdavimas
  updateChartEmptyState(data.length === 0);

  const labels = data.map(d => new Date(d.timestamp).toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit' }));
  const fullTimestamps = data.map(d => new Date(d.timestamp).toLocaleString('lt-LT', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }));

  tempChart.data.labels = labels;
  tempChart.data.datasets[0].data = data.map(d => d.temperature);
  tempChart._fullTimestamps = fullTimestamps;
  tempChart.update();

  humChart.data.labels = labels;
  humChart.data.datasets[0].data = data.map(d => d.humidity);
  humChart._fullTimestamps = fullTimestamps;
  humChart.update();

  luxChart.data.labels = labels;
  luxChart.data.datasets[0].data = data.map(d => d.light);
  luxChart._fullTimestamps = fullTimestamps;
  luxChart.update();
}

// Rodyti/slėpti „nėra duomenų" žinutę kiekvienam grafikui
function updateChartEmptyState(isEmpty) {
  document.querySelectorAll('.chart-box').forEach(box => {
    let emptyMsg = box.querySelector('.chart-empty');
    if (isEmpty) {
      if (!emptyMsg) {
        emptyMsg = document.createElement('div');
        emptyMsg.className = 'chart-empty';
        emptyMsg.textContent = 'Pasirinktame laikotarpyje duomenų nėra';
        box.appendChild(emptyMsg);
      }
      box.classList.add('is-empty');
    } else {
      if (emptyMsg) emptyMsg.remove();
      box.classList.remove('is-empty');
    }
  });
}

// ============================================================
// ĮVYKIŲ ŽURNALAS
// ============================================================

// Žurnalo įrašo aprašymo lietuvinimas (režimų pavadinimai ir LED spalvos)
function translateLogDescription(desc) {
  if (!desc) return desc;
  let result = desc;

  // Režimų pavadinimai (žodinis atitikmuo, atsižvelgiant į žodžio ribas)
  result = result.replace(/\bFocus\b/g, 'Gilus darbas');
  result = result.replace(/\bBreak\b/g, 'Pertrauka');
  result = result.replace(/\bIdle\b/gi, 'Neaktyvus');

  // LED spalvos – verčiamos tik atskirais žodžiais (ne hex viduriuose)
  result = result.replace(/\bred\b/g, 'raudona');
  result = result.replace(/\bblue\b/g, 'mėlyna');
  result = result.replace(/\bgreen\b/g, 'žalia');
  result = result.replace(/\bwhite\b/g, 'balta');
  result = result.replace(/\byellow\b/g, 'geltona');

  return result;
}

// Žurnalo state'as - filtruojama ir rūšiuojama client-side
let allEvents = [];           // Visi gauti įrašai (iš serverio)
let logSortDesc = true;       // true = naujausi pirma, false = seniausi pirma
let logTypeFilter = 'all';    // 'all' arba konkretus tipas

async function loadEvents() {
  const res = await fetch('/api/events');
  allEvents = await res.json();
  renderLog();
}

// Atvaizduoti žurnalą pagal aktualų filtrą ir rūšiavimą
function renderLog() {
  const container = document.getElementById('log-container');
  const emptyMsg = document.getElementById('log-empty');

  // Sinchronizuojam dropdown reikšmę su state'u (paskambinus iš onchange)
  const typeSelect = document.getElementById('log-type-filter');
  if (typeSelect) logTypeFilter = typeSelect.value;

  // 1. Filtruojam
  let filtered = logTypeFilter === 'all'
    ? allEvents.slice()
    : allEvents.filter(e => e.type === logTypeFilter);

  // 2. Rūšiuojam pagal laiką
  filtered.sort((a, b) => {
    const ta = new Date(a.timestamp).getTime();
    const tb = new Date(b.timestamp).getTime();
    return logSortDesc ? tb - ta : ta - tb;
  });

  // 3. Atvaizduojam
  if (filtered.length === 0) {
    container.innerHTML = '';
    emptyMsg.classList.remove('hidden');
    return;
  }
  emptyMsg.classList.add('hidden');

  container.innerHTML = filtered.map(e => {
    const time = new Date(e.timestamp).toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `
      <div class="log-row">
        <span class="log-time">${time}</span>
        <span class="log-type"><span class="log-badge ${e.type}">${e.type}</span></span>
        <span class="log-desc">${translateLogDescription(e.description)}</span>
      </div>`;
  }).join('');
}

// Perjungti rūšiavimo kryptį (paspaudus „Laikas" stulpelio antraštę)
function toggleLogSort() {
  logSortDesc = !logSortDesc;
  const arrow = document.getElementById('log-sort-arrow');
  if (arrow) arrow.textContent = logSortDesc ? '▼' : '▲';
  renderLog();
}

// ============================================================
// NUSTATYMAI
// ============================================================

function toggleTheme() {
  const html = document.documentElement;
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);

  // Atnaujinti grafikų spalvas
  if (tempChart && humChart && luxChart) {
    const opts = getChartOptions();
    [tempChart, humChart, luxChart].forEach(chart => {
      chart.options.scales = opts.scales;
      chart.update();
    });
  }
}

function toggleSound() {
  soundMuted = !document.getElementById('sound-enabled').checked;
  localStorage.setItem('soundMuted', soundMuted);
  fetch('/api/sound', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ muted: soundMuted })
  });
}

function loadSettings() {
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);

  const savedSound = localStorage.getItem('soundMuted');
  if (savedSound !== null) {
    soundMuted = savedSound === 'true';
    document.getElementById('sound-enabled').checked = !soundMuted;
  }
}

// ============================================================
// UŽRAŠAI (Sticky Notes)
// ============================================================

const NOTE_COLORS = ['yellow', 'blue', 'green', 'pink', 'purple', 'orange'];

// Formatuoja užrašo datą protingai: "Šiandien 14:23", "Vakar 09:15",
// "12 geg. 11:47" (šiemet), "12 geg. 2024" (kitais metais).
// Naudoja note.id kaip timestamp - id sukuriamas su Date.now() addNote() metu.
function formatNoteDate(note) {
  const ts = typeof note.id === 'number' ? note.id : Date.parse(note.id);
  if (!ts || isNaN(ts)) return note.createdAt || '–'; // fallback senesniems
  const date = new Date(ts);
  const now = new Date();
  const time = date.toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit' });

  // Lygina tik dienos dalį (be laiko)
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((dayStart(now) - dayStart(date)) / 86400000);

  if (dayDiff === 0) return `Šiandien ${time}`;
  if (dayDiff === 1) return `Vakar ${time}`;
  if (dayDiff < 7) {
    const weekdays = ['Sk', 'Pr', 'An', 'Tr', 'Kt', 'Pn', 'Št'];
    return `${weekdays[date.getDay()]} ${time}`;
  }
  const months = ['saus.', 'vas.', 'kov.', 'bal.', 'geg.', 'birž.', 'liep.', 'rugp.', 'rugs.', 'spal.', 'lapkr.', 'gruod.'];
  const day = date.getDate();
  const month = months[date.getMonth()];
  if (date.getFullYear() === now.getFullYear()) return `${day} ${month} ${time}`;
  return `${day} ${month} ${date.getFullYear()}`;
}

// Pilnas data ir laikas tooltip'ui (hover)
function formatNoteDateFull(note) {
  const ts = typeof note.id === 'number' ? note.id : Date.parse(note.id);
  if (!ts || isNaN(ts)) return note.createdAt || '';
  const date = new Date(ts);
  return date.toLocaleString('lt-LT', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

function loadNotes() {
  const saved = localStorage.getItem('stickyNotes');
  return saved ? JSON.parse(saved) : [];
}

function saveNotes(notes) {
  localStorage.setItem('stickyNotes', JSON.stringify(notes));
}

function addNote() {
  const notes = loadNotes();
  const note = {
    id: Date.now(),
    text: '',
    color: 'yellow',
    pinned: false,
    // Paliekamas dėl suderinamumo - naujesni užrašai datą gauna iš id
    createdAt: new Date().toLocaleTimeString('lt-LT', { hour: '2-digit', minute: '2-digit' })
  };
  notes.unshift(note);
  saveNotes(notes);
  renderNotes();

  // Fokusuojame naują užrašą
  setTimeout(() => {
    const textarea = document.querySelector(`[data-note-id="${note.id}"] .sticky-note-text`);
    if (textarea) textarea.focus();
  }, 100);
}

function deleteNote(id) {
  let notes = loadNotes();
  notes = notes.filter(n => n.id !== id);
  saveNotes(notes);
  renderNotes();
}

function updateNoteText(id, text) {
  const notes = loadNotes();
  const note = notes.find(n => n.id === id);
  if (note) {
    note.text = text;
    saveNotes(notes);
  }
}

function changeNoteColor(id, color) {
  const notes = loadNotes();
  const note = notes.find(n => n.id === id);
  if (note) {
    note.color = color;
    saveNotes(notes);
    renderNotes();
  }
}

// Perjungia prisegimą - prisegti užrašai rikiuojasi viršuje
function toggleNotePin(id) {
  const notes = loadNotes();
  const note = notes.find(n => n.id === id);
  if (note) {
    note.pinned = !note.pinned;
    saveNotes(notes);
    renderNotes();
  }
}

function renderNotes() {
  const notes = loadNotes();
  const container = document.getElementById('notes-container');

  if (notes.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:40px 20px; color:var(--text-muted)">
        <div style="font-size:32px; margin-bottom:12px">📝</div>
        <p style="font-size:13px">Kol kas užrašų nėra</p>
        <p style="font-size:12px; margin-top:4px">Spauskite "+ Naujas" kad pridėtumėte</p>
      </div>
    `;
    return;
  }

  // Rūšiavimas: prisegti pirmiausia (naujausias prisegtas viršuje),
  // tada nepriejungti (naujausias viršuje pagal id, kuris yra timestamp)
  const sorted = notes.slice().sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return b.id - a.id;
  });

  container.innerHTML = sorted.map(note => {
    const dateLabel = formatNoteDate(note);
    const dateFull = formatNoteDateFull(note);
    const pinClass = note.pinned ? ' is-pinned' : '';
    const pinTitle = note.pinned ? 'Atsegti' : 'Prisegti';
    return `
    <div class="sticky-note${pinClass}" data-color="${note.color}" data-note-id="${note.id}">
      ${note.pinned ? '<span class="sticky-note-pin-indicator" title="Prisegtas">📌</span>' : ''}
      <textarea class="sticky-note-text" placeholder="Rašykite čia..."
        oninput="updateNoteText(${note.id}, this.value)">${note.text}</textarea>
      <div class="sticky-note-footer">
        <span class="sticky-note-time" title="${dateFull}">${dateLabel}</span>
        <div class="sticky-note-actions">
          ${NOTE_COLORS.map(c => `<div class="note-color-btn ${c}" onclick="changeNoteColor(${note.id}, '${c}')"></div>`).join('')}
          <button class="note-pin-btn${note.pinned ? ' active' : ''}" onclick="toggleNotePin(${note.id})" title="${pinTitle}">📌</button>
          <button class="note-delete-btn" onclick="deleteNote(${note.id})" title="Ištrinti">✕</button>
        </div>
      </div>
    </div>
  `;
  }).join('');
}

function toggleNotesPanel() {
  const panel = document.getElementById('notes-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    renderNotes();
  }
}

// ============================================================
// PATVIRTINIMO MODALAS
// ============================================================

let confirmCallback = null;

function showConfirmModal(title, message, onConfirm) {
  confirmCallback = onConfirm;
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-desc').textContent = message;
  document.getElementById('confirm-modal').classList.remove('hidden');
}

function hideConfirmModal() {
  document.getElementById('confirm-modal').classList.add('hidden');
  confirmCallback = null;
}

function doConfirm() {
  if (confirmCallback) confirmCallback();
  hideConfirmModal();
}

// ============================================================
// CONFETTI ANIMACIJA
// ============================================================

function launchConfetti() {
  const container = document.createElement('div');
  container.className = 'confetti-container';
  document.body.appendChild(container);

  const colors = ['#6c7aff', '#3dd68c', '#ffb84d', '#ff5c6c', '#5bc4ff', '#ffd05b', '#e177f5'];
  const shapes = ['square', 'circle'];

  for (let i = 0; i < 80; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    const color = colors[Math.floor(Math.random() * colors.length)];
    const shape = shapes[Math.floor(Math.random() * shapes.length)];
    const size = 6 + Math.random() * 8;

    piece.style.left = Math.random() * 100 + '%';
    piece.style.width = size + 'px';
    piece.style.height = size + 'px';
    piece.style.background = color;
    piece.style.borderRadius = shape === 'circle' ? '50%' : '2px';
    piece.style.animationDuration = (1.5 + Math.random() * 2) + 's';
    piece.style.animationDelay = Math.random() * 0.8 + 's';

    container.appendChild(piece);
  }

  // Pašaliname po animacijos
  setTimeout(() => container.remove(), 4000);
}

// ============================================================
// TOAST PRANEŠIMAI
// ============================================================

function showToast(message, type = 'info', duration = 3500, toastId = null) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  if (toastId) toast.dataset.toastId = toastId;
  toast.innerHTML = `
    <span class="toast-icon">${type === 'success' ? '✓' : type === 'warning' ? '⚠' : type === 'error' ? '✕' : 'ℹ'}</span>
    <span class="toast-text">${message}</span>
  `;
  container.appendChild(toast);

  // Animacija
  requestAnimationFrame(() => toast.classList.add('show'));

  // Automatinis pašalinimas po nurodyto laiko (numatytasis 3.5 s)
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// Pašalinti konkretų toast'ą pagal ID (pvz. kai useris reaguoja į jį)
function dismissToast(toastId) {
  document.querySelectorAll(`.toast[data-toast-id="${toastId}"]`).forEach(t => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  });
}

// Toast pranešimai pagal WebSocket įvykius
function handleToastEvents(msg) {
  switch (msg.type) {
    case 'mode_update':
      if (msg.data && msg.data.mode && msg.data.mode !== 'idle') {
        showToast(`Režimas aktyvuotas: ${msg.data.mode}`, 'success');
      } else if (msg.data && msg.data.mode === 'idle') {
        showToast('Sesija sustabdyta', 'info');
      }
      break;
    case 'checkin_confirmed':
      showToast('Aktyvumo patikrinimas patvirtintas ✓', 'success');
      break;
    case 'checkin_missed':
      showToast('Aktyvumo patikrinimas praleistas', 'warning');
      break;
    case 'block_complete':
      // Jei tame pačiame įvykyje dėžutė atrakinta, paliekame box_unlocked rodyti toast'ą
      const isUnlockEvent = msg.data.justUnlocked === true ||
        (recentBoxUnlock && Date.now() - recentBoxUnlock < 1000);
      if (!isUnlockEvent) {
        showToast(`Blokas užbaigtas! (${msg.data.duration} min)`, 'success');
        launchConfetti();
      }
      break;
    case 'box_unlocked':
      showToast('🎉 Dėžutė atrakinta! Pasiimkite atlygį ir uždarykite dangtį prieš naują sesiją.', 'success', 6000, 'box-unlocked');
      launchConfetti();
      break;
  }
}

// ============================================================
// SESIJOS STATISTIKA
// ============================================================

async function loadSessionStats() {
  try {
    const res = await fetch('/api/stats/today');
    const stats = await res.json();
    
    document.getElementById('stat-blocks').textContent = stats.blocksToday;
    document.getElementById('stat-time').textContent = formatMinutes(stats.totalMinutes);
    document.getElementById('stat-streak').textContent = stats.streak;
  } catch (e) {
    // API dar neegzistuoja – rodome nulius
  }
}

function formatMinutes(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h} val ${m > 0 ? m + ' min' : ''}`;
}

// ============================================================
// PIN KODO MODALAS IR NUSTATYMAI
// ============================================================

let boxPin = localStorage.getItem('boxPin') || '0000';
let pinEnabled = localStorage.getItem('pinEnabled') === 'true';

// Atrakinti mygtuko paspaudimo apdorojimas – jei PIN įjungtas, rodome modalą;
// jei išjungtas, atrakinama iš karto.
function handleUnlockClick() {
  if (pinEnabled) {
    showPinModal();
  } else {
    setServo(false); // setServo pats parodo toast'ą
  }
}

// Atnaujinti „Atrakinti" mygtuko išvaizdą pagal pinEnabled būseną
function updateUnlockButton() {
  const btn = document.getElementById('unlock-btn');
  if (!btn) return;
  btn.textContent = pinEnabled ? 'Atrakinti \u00A0🔐' : 'Atrakinti';
}

// PIN įjungimo/išjungimo toggle (nustatymai)
function togglePinEnabled() {
  pinEnabled = document.getElementById('pin-enabled').checked;
  localStorage.setItem('pinEnabled', pinEnabled ? 'true' : 'false');
  applyPinFieldsState();
  updateUnlockButton();
  showToast(pinEnabled ? 'PIN kodas įjungtas' : 'PIN kodas išjungtas', 'info');
}

// Pritaikyti PIN įvedimo lauko būseną (aktyvus/pilkas) pagal pinEnabled
function applyPinFieldsState() {
  const pinInput = document.getElementById('box-pin');
  const pinSaveBtn = document.getElementById('pin-save-btn');
  const pinRow = document.getElementById('pin-input-row');
  if (!pinInput || !pinSaveBtn || !pinRow) return;

  if (pinEnabled) {
    pinInput.disabled = false;
    pinSaveBtn.disabled = false;
    pinRow.classList.remove('disabled-row');
  } else {
    pinInput.disabled = true;
    pinSaveBtn.disabled = true;
    pinRow.classList.add('disabled-row');
  }
}

function showPinModal() {
  document.getElementById('pin-modal').classList.remove('hidden');
  document.getElementById('pin-error').classList.add('hidden');
  // Išvalome laukus
  for (let i = 1; i <= 4; i++) {
    document.getElementById('pin-input-' + i).value = '';
  }
  document.getElementById('pin-input-1').focus();
}

function hidePinModal() {
  document.getElementById('pin-modal').classList.add('hidden');
}

function pinNext(num) {
  const current = document.getElementById('pin-input-' + num);
  if (current.value.length === 1 && num < 4) {
    document.getElementById('pin-input-' + (num + 1)).focus();
  }
  // Automatiškai tikrinti kai visi 4 įvesti
  if (num === 4 && current.value.length === 1) {
    verifyPin();
  }
}

function pinBack(e, num) {
  if (e.key === 'Backspace' && num > 1) {
    const current = document.getElementById('pin-input-' + num);
    if (current.value === '') {
      document.getElementById('pin-input-' + (num - 1)).focus();
    }
  }
}

function verifyPin() {
  let entered = '';
  for (let i = 1; i <= 4; i++) {
    entered += document.getElementById('pin-input-' + i).value;
  }

  if (entered === boxPin) {
    hidePinModal();
    setServo(false); // setServo pats parodo toast'ą
  } else {
    document.getElementById('pin-error').classList.remove('hidden');
    // Išvalome ir grąžiname fokusą
    for (let i = 1; i <= 4; i++) {
      document.getElementById('pin-input-' + i).value = '';
    }
    document.getElementById('pin-input-1').focus();
  }
}

function updateBoxPin() {
  if (!pinEnabled) {
    showToast('Pirmiausia įjunkite PIN kodą nustatymuose', 'warning');
    return;
  }
  const pinInput = document.getElementById('box-pin');
  const pin = pinInput.value;
  if (pin.length !== 4 || !/^\d{4}$/.test(pin)) {
    showToast('PIN kodas turi būti 4 skaitmenys', 'warning');
    return;
  }
  boxPin = pin;
  localStorage.setItem('boxPin', pin);
  // Po išsaugojimo PIN kodas paslepiamas (rodomi taškeliai)
  pinInput.type = 'password';
  showToast('PIN kodas atnaujintas', 'success');
}

function loadBoxPin() {
  const storedPin = localStorage.getItem('boxPin');
  boxPin = storedPin || '0000';
  pinEnabled = localStorage.getItem('pinEnabled') === 'true';

  const pinInput = document.getElementById('box-pin');
  if (pinInput) {
    if (storedPin) {
      // PIN jau išsaugotas – rodom taškelius
      pinInput.value = boxPin;
      pinInput.type = 'password';
    } else {
      // PIN dar nenustatytas – tuščia, su placeholder
      pinInput.value = '';
      pinInput.type = 'text';
      pinInput.placeholder = '0000 (numatytasis)';
    }

    // Kai vartotojas pradeda redaguoti – rodom skaičius (text), kad matytų ką rašo.
    // Kai išeina iš lauko (blur) – grąžinam į password (jei buvo išsaugotas).
    pinInput.addEventListener('focus', () => {
      pinInput.type = 'text';
    });
    pinInput.addEventListener('blur', () => {
      // Jei laukas tuščias arba PIN dar nenustatytas – paliekam text
      if (pinInput.value && localStorage.getItem('boxPin')) {
        pinInput.type = 'password';
      }
    });
  }

  const pinEnabledCheckbox = document.getElementById('pin-enabled');
  if (pinEnabledCheckbox) pinEnabledCheckbox.checked = pinEnabled;

  applyPinFieldsState();
  updateUnlockButton();
}

// ============================================================
// KLAVIATŪROS SPARTIEJI KLAVIŠAI
// ============================================================

document.addEventListener('keydown', (e) => {
  // Ignoruojame kai rašoma į input/textarea (bet ne PIN laukus)
  const isPinInput = e.target.classList.contains('pin-digit');
  if ((e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') && !isPinInput) return;

  const checkinModal = document.getElementById('checkin-modal');
  const confirmModal = document.getElementById('confirm-modal');
  const blockModal = document.getElementById('block-complete-modal');
  const editorModal = document.getElementById('mode-editor');
  const pinModal = document.getElementById('pin-modal');

  // Space – patvirtinti check-in
  if (e.code === 'Space' && !checkinModal.classList.contains('hidden')) {
    e.preventDefault();
    confirmCheckIn();
    return;
  }

  // Enter – patvirtinti
  if (e.code === 'Enter') {
    if (!pinModal.classList.contains('hidden')) {
      e.preventDefault();
      verifyPin();
      return;
    }
    if (!confirmModal.classList.contains('hidden')) {
      e.preventDefault();
      doConfirm();
      return;
    }
    if (!blockModal.classList.contains('hidden')) {
      e.preventDefault();
      document.getElementById('block-next-btn').click();
      return;
    }
  }

  // Escape – uždaryti modalus
  if (e.code === 'Escape') {
    if (!pinModal.classList.contains('hidden')) {
      hidePinModal();
      return;
    }
    if (!checkinModal.classList.contains('hidden')) {
      endSession();
      return;
    }
    if (!confirmModal.classList.contains('hidden')) {
      hideConfirmModal();
      return;
    }
    if (!blockModal.classList.contains('hidden')) {
      closeBlockModal();
      return;
    }
    if (!editorModal.classList.contains('hidden')) {
      closeModeEditor();
      return;
    }
    // Uždaryti notes panelį
    const notesPanel = document.getElementById('notes-panel');
    if (!notesPanel.classList.contains('hidden')) {
      toggleNotesPanel();
      return;
    }
  }
});

// ============================================================
// INICIALIZACIJA
// ============================================================

window.onload = () => {
  loadSettings();
  connectWS();
  loadModes();
  loadSessionStats();
  loadBoxPin();

  const style = getComputedStyle(document.documentElement);
  tempChart = createChart('tempChart', style.getPropertyValue('--sensor-temp').trim());
  humChart = createChart('humChart', style.getPropertyValue('--sensor-hum').trim());
  luxChart = createChart('luxChart', style.getPropertyValue('--sensor-lux').trim());

  loadHistory('1h');
  loadEvents();
};
