// Большое табло весов CAS AD через Web Serial (Chrome/Edge) + удобный ручной ввод для сенсорного экрана.
// Протокол CAS AD: ENQ(05) -> ACK(06) -> DC1(11) -> кадр 01 02 S|U знак вес kg 03 04.
const SC = { port: null, reader: null, writer: null, buf: [], pollTimer: null, polling: false };
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  mode: 'manual', // 'scale' | 'manual'
  gross: 0,
  stable: false,
  online: false,
  manualKg: null,
};

function tareKg() {
  return Math.max(0, (Number($('tare-g')?.value) || 0) / 1000);
}

export function getActiveWeightKg() {
  if (state.mode === 'manual' || !SC.port) {
    const v = Number($('sc-manual-in')?.value);
    if (!Number.isFinite(v) || v <= 0) return { ok: false, error: 'Введите вес больше 0 кг' };
    return { ok: true, net: Math.round(v * 1000) / 1000 };
  }
  if (!state.online) return { ok: false, error: 'Нет сигнала с весов' };
  if (!state.stable) return { ok: false, error: 'Дождитесь, пока вес устоится' };
  const net = Math.round((state.gross - tareKg()) * 1000) / 1000;
  if (net <= 0) return { ok: false, error: 'Вес меньше веса пустого ящика' };
  return { ok: true, net };
}

export function clearManualWeight() {
  const inp = $('sc-manual-in');
  if (inp) inp.value = '';
  renderDisplay();
}

export function renderDisplay() {
  const dig = $('sc-digits');
  const stat = $('sc-stat');
  const grossEl = $('sc-gross');
  const hasSerial = 'serial' in navigator;
  if (!dig || !stat) return;

  $('sc-conn').hidden = !hasSerial || !!SC.port;
  $('sc-off').hidden = !SC.port;
  $('sc-manual-box').hidden = !(state.mode === 'manual' || !SC.port);
  $('sc-mode-btn').hidden = !SC.port;
  $('sc-mode-btn').textContent = state.mode === 'manual' ? 'Переключить на весы' : 'Ввести вручную';

  if (state.mode === 'manual' || !SC.port) {
    const v = Number($('sc-manual-in')?.value || 0);
    dig.innerHTML = `${v > 0 ? v.toFixed(3) : '0.000'}<small>кг</small>`;
    dig.className = 'sc-digits' + (v > 0 ? ' manual' : '');
    stat.className = 'sc-stat';
    stat.textContent = !SC.port
      ? (hasSerial ? 'Ручной ввод (подключите весы для авточтения)' : 'Ручной ввод веса')
      : 'Режим ручного ввода';
    if (grossEl) grossEl.textContent = '—';
    return;
  }

  const net = Math.max(0, Math.round((state.gross - tareKg()) * 1000) / 1000);
  if (grossEl) grossEl.textContent = `${state.gross.toFixed(3)} кг`;

  if (!state.online) {
    dig.innerHTML = `—<small>кг</small>`;
    dig.className = 'sc-digits';
    stat.className = 'sc-stat';
    stat.textContent = 'Нет ответа от весов…';
  } else if (state.gross < 0.02) {
    dig.innerHTML = `0.000<small>кг</small>`;
    dig.className = 'sc-digits';
    stat.className = 'sc-stat';
    stat.textContent = 'Поставьте ящик на весы';
  } else if (state.stable) {
    dig.innerHTML = `${net.toFixed(3)}<small>кг</small>`;
    dig.className = 'sc-digits stable';
    stat.className = 'sc-stat stable';
    stat.textContent = 'Вес устоялся — можно записывать';
  } else {
    dig.innerHTML = `${net.toFixed(3)}<small>кг</small>`;
    dig.className = 'sc-digits settling';
    stat.className = 'sc-stat settling';
    stat.textContent = 'Вес меняется…';
  }
}

function waitBuf(pred, ms) {
  return new Promise((res) => {
    const t0 = Date.now();
    (function tick() {
      const v = pred();
      if (v !== null) return res(v);
      if (Date.now() - t0 > ms) return res(null);
      setTimeout(tick, 20);
    })();
  });
}

async function pollOnce() {
  if (!SC.port || !SC.writer || SC.polling) return;
  SC.polling = true;
  try {
    SC.buf.length = 0;
    await SC.writer.write(Uint8Array.of(5));
    const ack = await waitBuf(() => (SC.buf.length ? SC.buf[0] : null), 900);
    if (ack !== 6) { state.online = false; renderDisplay(); return; }
    SC.buf.length = 0;
    await SC.writer.write(Uint8Array.of(0x11));
    const frame = await waitBuf(() => {
      const i = SC.buf.indexOf(4);
      return i >= 0 ? SC.buf.slice(0, i + 1) : null;
    }, 1500);
    if (!frame) { state.online = false; renderDisplay(); return; }
    const m = /\x01\x02([SU])\s*([-+]?)\s*(\d+(?:\.\d+)?)/.exec(String.fromCharCode(...frame));
    if (m) {
      state.online = true;
      state.stable = m[1] === 'S';
      state.gross = (m[2] === '-' ? -1 : 1) * parseFloat(m[3]);
      renderDisplay();
    }
  } catch {
    state.online = false;
    renderDisplay();
  } finally {
    SC.polling = false;
  }
}

function startPolling() {
  clearInterval(SC.pollTimer);
  SC.pollTimer = setInterval(pollOnce, 400);
  pollOnce();
}

async function openPort(port) {
  await port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
  try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch {}
  await sleep(300);
  SC.port = port;
  SC.buf = [];
  SC.reader = port.readable.getReader();
  SC.writer = port.writable.getWriter();
  state.mode = 'scale';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await SC.reader.read();
        if (done) break;
        SC.buf.push(...value);
      }
    } catch {}
    clearInterval(SC.pollTimer);
    SC.port = null;
    state.online = false;
    state.mode = 'manual';
    renderDisplay();
  })();
  renderDisplay();
  startPolling();
}

export async function autoConnectScale() {
  renderDisplay();
  if (!('serial' in navigator) || SC.port) return;
  try {
    const [p] = await navigator.serial.getPorts();
    if (p) await openPort(p);
  } catch {}
}

export function initScale(toast) {
  $('sc-conn').onclick = async () => {
    try {
      await openPort(await navigator.serial.requestPort());
    } catch (e) {
      if (e.name !== 'NotFoundError') toast('Не удалось открыть порт: ' + e.message, true);
    }
  };
  $('sc-off').onclick = async () => {
    clearInterval(SC.pollTimer);
    try {
      SC.reader.cancel();
      SC.writer.releaseLock();
      await SC.port.close();
    } catch {}
    SC.port = null;
    state.online = false;
    state.mode = 'manual';
    renderDisplay();
  };
  $('sc-mode-btn').onclick = () => {
    state.mode = state.mode === 'manual' ? 'scale' : 'manual';
    renderDisplay();
  };
  $('sc-manual-in').oninput = renderDisplay;
  $('tare-g').oninput = renderDisplay;
  renderDisplay();
}
