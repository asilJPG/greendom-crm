// Большое табло весов CAS AD через Web Serial (Chrome/Edge) + удобный ручной ввод для сенсорного экрана.
// Протокол CAS AD (не менять): 9600 8N1, DTR/RTS выкл., ENQ(05) -> ACK(06) -> DC1(11) -> кадр 01 02 S|U знак вес kg 03 04.
import { parseDecimal } from './num.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAndroid = /Android/i.test(navigator.userAgent || '');

// Текущее подключение (сессия порта). null — весы не подключены.
const SC = { sess: null, connecting: false, userDisconnected: false };

const state = {
  mode: 'manual', // 'scale' | 'manual'
  gross: 0,
  stable: false,
  online: false,
  note: '', // пояснение, почему работает ручной ввод (нет USB на телефоне и т.п.)
};

let toastFn = () => {};

const hasSerial = () => 'serial' in navigator && !!navigator.serial;

function tareKg() {
  const v = parseDecimal($('tare-g')?.value);
  if (v === null) return 0;
  if (Number.isNaN(v) || v < 0) return NaN;
  return v / 1000;
}

function manualKg() {
  return parseDecimal($('sc-manual-in')?.value);
}

export function getActiveWeightKg() {
  if (state.mode === 'manual' || !SC.sess) {
    const v = manualKg();
    if (v === null) return { ok: false, error: 'Введите вес больше 0 кг' };
    if (Number.isNaN(v)) return { ok: false, error: 'Неверный вес. Пример: 1,5 или 1.5' };
    if (v <= 0) return { ok: false, error: 'Введите вес больше 0 кг' };
    return { ok: true, net: Math.round(v * 1000) / 1000 };
  }
  const tare = tareKg();
  if (Number.isNaN(tare)) return { ok: false, error: 'Неверная тара (граммы). Пример: 350' };
  if (!state.online) return { ok: false, error: 'Нет сигнала с весов' };
  if (!state.stable) return { ok: false, error: 'Дождитесь, пока вес устоится' };
  const net = Math.round((state.gross - tare) * 1000) / 1000;
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
  if (!dig || !stat) return;
  const serial = hasSerial();
  const connected = !!SC.sess;

  $('sc-conn').hidden = !serial || connected;
  $('sc-conn').disabled = SC.connecting;
  $('sc-off').hidden = !connected;
  $('sc-manual-box').hidden = !(state.mode === 'manual' || !connected);
  $('sc-mode-btn').hidden = !connected;
  $('sc-mode-btn').textContent = state.mode === 'manual' ? 'Переключить на весы' : 'Ввести вручную';

  if (state.mode === 'manual' || !connected) {
    const v = manualKg();
    const okV = typeof v === 'number' && Number.isFinite(v) && v > 0;
    dig.innerHTML = `${okV ? v.toFixed(3) : Number.isNaN(v) ? '—' : '0.000'}<small>кг</small>`;
    dig.className = 'sc-digits' + (okV ? ' manual' : '');
    stat.className = 'sc-stat';
    stat.textContent = Number.isNaN(v)
      ? 'Неверный вес. Пример: 1,5 или 1.5'
      : state.note
        ? state.note
        : !connected
          ? (serial ? 'Ручной ввод (подключите весы для авточтения)' : 'Ручной ввод веса')
          : 'Режим ручного ввода';
    if (grossEl) grossEl.textContent = '—';
    return;
  }

  const tare = tareKg();
  const net = Math.max(0, Math.round((state.gross - (Number.isNaN(tare) ? 0 : tare)) * 1000) / 1000);
  if (grossEl) grossEl.textContent = `${state.gross.toFixed(3)} кг`;

  if (Number.isNaN(tare)) {
    dig.innerHTML = `—<small>кг</small>`;
    dig.className = 'sc-digits';
    stat.className = 'sc-stat';
    stat.textContent = 'Неверная тара (граммы)';
  } else if (!state.online) {
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

function waitBuf(sess, pred, ms) {
  return new Promise((res) => {
    const t0 = Date.now();
    (function tick() {
      if (sess.closing) return res(null);
      const v = pred();
      if (v !== null) return res(v);
      if (Date.now() - t0 > ms) return res(null);
      setTimeout(tick, 20);
    })();
  });
}

// Парсинг потоковых ASCII-строк для других весов (CAS ER/SW/CI, китайские весы, Mettler и т.д.),
// которые сами шлют вес по RS-232 строками вида "ST,GS,+  1.250kg", "US,NT, 0.500 kg", " 1.250 kg", "=052.100".
function tryParseStreamLine(line, sess) {
  const s = line.trim();
  if (!s) return false;
  // CAS AD кадр обрабатывается отдельно в pollOnce
  if (s.includes('\x01') || s.includes('\x02')) return false;

  // Формат с реверсом цифр (некоторые китайские весы шлют "=052.100" -> 1.250)
  const rev = /^=(\d+\.\d+)$/.exec(s);
  if (rev) {
    const val = parseFloat(rev[1].split('').reverse().join(''));
    if (Number.isFinite(val)) {
      updateStreamWeight(val, null, sess);
      return true;
    }
  }

  // Стандартный ASCII-формат: [ST|US|S|U] ... [+-]? 12.345 [kg|g]?
  const m = /(?:^|[^A-Z])(ST|US|OL)?[^0-9+-]*([+-]?)\s*(\d+(?:\.\d+)?)\s*(kg|g|кг|г)?/i.exec(s);
  if (!m) return false;
  if (m[1] && m[1].toUpperCase() === 'OL') return false;
  let val = parseFloat(m[3]);
  if (!Number.isFinite(val)) return false;
  if (m[2] === '-') val = -val;
  if (m[4] && /^(g|г)$/i.test(m[4])) val = val / 1000;
  const flagStable = m[1] ? m[1].toUpperCase() === 'ST' : null;
  updateStreamWeight(val, flagStable, sess);
  return true;
}

function updateStreamWeight(val, flagStable, sess) {
  const now = Date.now();
  sess.lastStreamAt = now;
  // Эти весы работают в потоковом/событийном режиме (не CAS AD ENQ/DC1) —
  // отключаем опрос ENQ, чтобы он не сбрасывал вес в «Нет ответа» через 2.5 сек!
  if (!sess.isStream) {
    sess.isStream = true;
    clearInterval(sess.pollTimer);
    sess.pollTimer = null;
  }
  state.online = true;
  state.gross = val;
  if (flagStable !== null) {
    clearTimeout(sess.stableTimer);
    state.stable = flagStable;
  } else {
    // Если весы не присылают флаг ST/US — считаем вес устоявшимся через 1.2 сек без изменений
    clearTimeout(sess.stableTimer);
    if (Math.abs(val - (sess.lastVal ?? NaN)) <= 0.015) {
      if (!sess.stableSince) sess.stableSince = now;
      state.stable = now - sess.stableSince >= 1200;
    } else {
      sess.stableSince = now;
      state.stable = false;
    }
    sess.lastVal = val;
    if (!state.stable && val >= 0.02) {
      sess.stableTimer = setTimeout(() => {
        if (!sess.closing && SC.sess === sess && state.online && Math.abs(state.gross - val) <= 0.015) {
          state.stable = true;
          renderDisplay();
        }
      }, 1200);
    }
  }
  renderDisplay();
}

async function pollOnce(sess) {
  if (sess.closing || sess.polling || sess.isStream || SC.sess !== sess) return;
  sess.polling = true;
  try {
    sess.buf.length = 0;
    await sess.writer.write(Uint8Array.of(0x05)); // ENQ
    const ack = await waitBuf(sess, () => (sess.buf.length ? sess.buf[0] : null), 900);
    if (sess.closing) return;
    if (ack !== 0x06) { state.online = false; renderDisplay(); return; }
    sess.buf.length = 0;
    await sess.writer.write(Uint8Array.of(0x11)); // DC1
    const frame = await waitBuf(sess, () => {
      const i = sess.buf.indexOf(0x04);
      return i >= 0 ? sess.buf.slice(0, i + 1) : null;
    }, 1500);
    if (sess.closing) return;
    if (!frame) { state.online = false; renderDisplay(); return; }
    const m = /\x01\x02([SU])\s*([-+]?)\s*(\d+(?:\.\d+)?)/.exec(String.fromCharCode(...frame));
    if (m) {
      state.online = true;
      state.stable = m[1] === 'S';
      state.gross = (m[2] === '-' ? -1 : 1) * parseFloat(m[3]);
      renderDisplay();
    }
  } catch {
    if (!sess.closing) { state.online = false; renderDisplay(); }
  } finally {
    sess.polling = false;
  }
}

/**
 * Полностью закрывает сессию: останавливает опрос, отменяет чтение (await), снимает блокировки
 * reader/writer и закрывает порт. Идемпотентна. fromLoop=true — вызвана из цикла чтения (reader уже освобождён).
 */
function closeSession(sess, { fromLoop = false } = {}) {
  if (!sess) return Promise.resolve();
  if (sess.closingPromise) return sess.closingPromise;
  sess.closing = true;
  clearInterval(sess.pollTimer);
  clearTimeout(sess.stableTimer);
  if (SC.sess === sess) {
    SC.sess = null;
    state.online = false;
    state.stable = false;
    state.mode = 'manual';
    renderDisplay();
  }
  sess.closingPromise = (async () => {
    if (!fromLoop) {
      try { await sess.reader.cancel(); } catch {}
      try { await sess.loop; } catch {}
    }
    // дождаться завершения текущей записи (ENQ/DC1), чтобы снять lock writer без ошибок
    for (let i = 0; i < 25 && sess.polling; i++) await sleep(20);
    try { sess.writer.releaseLock(); } catch {}
    try {
      await sess.port.close();
    } catch (e) {
      // порт мог исчезнуть физически (выдернули USB) — это нормально
      if (e && e.name !== 'NetworkError' && e.name !== 'InvalidStateError') console.warn('Весы: порт не закрылся', e);
    }
  })();
  return sess.closingPromise;
}

async function openPort(port) {
  // Если предыдущая сессия этого порта ещё закрывается — дождаться
  if (SC.sess) await closeSession(SC.sess);
  try {
    await port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
  } catch (e) {
    // Порт остался открытым после сбоя: закрываем и пробуем ещё раз
    if (e && e.name === 'InvalidStateError') {
      try { await port.close(); } catch {}
      await port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
    } else {
      throw e;
    }
  }
  try { await port.setSignals({ dataTerminalReady: false, requestToSend: false }); } catch {}
  await sleep(300);

  const sess = {
    port,
    reader: port.readable.getReader(),
    writer: port.writable.getWriter(),
    buf: [],
    lineBuf: '',
    lastStreamAt: 0,
    lastVal: null,
    stableSince: 0,
    pollTimer: null,
    polling: false,
    closing: false,
    closingPromise: null,
    loop: null,
  };
  sess.loop = (async () => {
    try {
      for (;;) {
        const { value, done } = await sess.reader.read();
        if (done) break;
        if (value) {
          sess.buf.push(...value);
          // Параллельно проверяем текстовые строки для потоковых весов
          for (const b of value) {
            if (b === 0x0a || b === 0x0d) {
              if (sess.lineBuf) {
                tryParseStreamLine(sess.lineBuf, sess);
                sess.lineBuf = '';
              }
            } else if (b >= 0x20 && b <= 0x7e) {
              sess.lineBuf += String.fromCharCode(b);
              if (sess.lineBuf.length > 120) sess.lineBuf = sess.lineBuf.slice(-120);
            }
          }
        }
      }
    } catch {
      // ошибка чтения: обычно USB выдернули
    } finally {
      try { sess.reader.releaseLock(); } catch {}
    }
    // без await: closeSession сама ждёт этот цикл, когда вызвана снаружи
    if (!sess.closing) {
      closeSession(sess, { fromLoop: true });
      toastFn('Весы отключились. Можно подключить снова или ввести вес вручную', true);
    }
  })();

  SC.sess = sess;
  state.mode = 'scale';
  state.note = '';
  state.online = false;
  renderDisplay();
  sess.pollTimer = setInterval(() => pollOnce(sess), 400);
  pollOnce(sess);
}

function fallbackToManual(note) {
  state.mode = 'manual';
  state.note = note;
  renderDisplay();
  $('sc-manual-in')?.focus();
}

async function connectByUser() {
  if (SC.connecting || SC.sess) return;
  if (!hasSerial()) return fallbackToManual('Этот браузер не поддерживает подключение весов — вводите вес вручную');
  SC.connecting = true;
  renderDisplay();
  try {
    let port;
    try {
      port = await navigator.serial.requestPort();
    } catch (e) {
      const name = e && e.name;
      if (name === 'NotFoundError' && !isAndroid) return; // пользователь закрыл окно выбора порта
      if (isAndroid || name === 'NotFoundError' || name === 'SecurityError' || name === 'NotSupportedError' || name === 'TypeError') {
        return fallbackToManual('На этом устройстве браузер не видит USB-весы — вводите вес вручную');
      }
      toastFn('Не удалось выбрать порт весов: ' + (e && e.message ? e.message : name), true);
      return fallbackToManual('Весы не подключены — вводите вес вручную');
    }
    SC.userDisconnected = false;
    await openPort(port);
  } catch (e) {
    toastFn('Не удалось открыть порт весов: ' + (e && e.message ? e.message : 'ошибка'), true);
    fallbackToManual(isAndroid
      ? 'На этом устройстве USB-весы не поддерживаются — вводите вес вручную'
      : 'Весы не подключились — проверьте кабель или вводите вес вручную');
  } finally {
    SC.connecting = false;
    renderDisplay();
  }
}

export async function autoConnectScale() {
  renderDisplay();
  if (!hasSerial() || SC.sess || SC.connecting || SC.userDisconnected) return;
  SC.connecting = true;
  try {
    const ports = await navigator.serial.getPorts();
    if (ports && ports[0]) await openPort(ports[0]);
  } catch {
    // тихо: остаётся ручной ввод
  } finally {
    SC.connecting = false;
    renderDisplay();
  }
}

export function initScale(toast) {
  toastFn = toast || (() => {});
  $('sc-conn').onclick = connectByUser;
  $('sc-off').onclick = async () => {
    const b = $('sc-off');
    b.disabled = true;
    SC.userDisconnected = true; // не переподключать автоматически при переходе между экранами
    try {
      await closeSession(SC.sess);
    } finally {
      b.disabled = false;
      renderDisplay();
    }
  };
  $('sc-mode-btn').onclick = () => {
    state.mode = state.mode === 'manual' ? 'scale' : 'manual';
    renderDisplay();
  };
  $('sc-manual-in').oninput = renderDisplay;
  $('tare-g').oninput = renderDisplay;

  if (hasSerial()) {
    try {
      navigator.serial.addEventListener('connect', () => {
        if (!SC.userDisconnected && !SC.sess) autoConnectScale();
      });
      navigator.serial.addEventListener('disconnect', (e) => {
        if (SC.sess && e.target === SC.sess.port) {
          closeSession(SC.sess);
          toastFn('Весы отключились (USB). Переподключатся сами при появлении сигнала', true);
        }
      });
      // Если весы включили позже моноблока (например, после отключения света), подхватим порт автоматически
      setInterval(() => {
        if (!SC.userDisconnected && !SC.sess && !SC.connecting && !$('ops-shell')?.hidden) {
          autoConnectScale();
        }
      }, 3000);
    } catch {}
  }
  renderDisplay();
}
