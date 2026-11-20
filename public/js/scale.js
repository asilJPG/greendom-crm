// Драйвер весов CAS AD через Web Serial (Chrome/Edge на компьютере и Android).
// Протокол: ENQ(05) -> ACK(06) -> DC1(11) -> кадр 01 02 S|U знак вес kg 03 04.
const SC = { port: null, reader: null, writer: null, buf: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);

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

export function updateScaleUi() {
  const has = 'serial' in navigator;
  $('sc-conn').hidden = !has || !!SC.port;
  $('sc-off').hidden = !SC.port;
  $('scale-pill').textContent = !has ? 'только Chrome/Edge' : SC.port ? 'подключены' : 'не подключены';
  $('scale-state').textContent = !has
    ? 'Чтение весов через браузер работает в Chrome или Edge на компьютере и Android. Введите вес вручную.'
    : SC.port
      ? 'Весы подключены. Нажмите «С весов» рядом с полем веса.'
      : 'Весы не подключены. Подключите кабель и нажмите «Подключить весы», выберите порт.';
  document.querySelectorAll('.sc-read').forEach((b) => (b.hidden = !has));
}

async function openPort(port) {
  await port.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
  try {
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  } catch {}
  await sleep(300);
  SC.port = port;
  SC.buf = [];
  SC.reader = port.readable.getReader();
  SC.writer = port.writable.getWriter();
  (async () => {
    try {
      for (;;) {
        const { value, done } = await SC.reader.read();
        if (done) break;
        SC.buf.push(...value);
      }
    } catch {}
    SC.port = null;
    updateScaleUi();
  })();
  updateScaleUi();
}

export async function autoConnectScale() {
  updateScaleUi();
  if (!('serial' in navigator) || SC.port) return;
  try {
    const [p] = await navigator.serial.getPorts();
    if (p) await openPort(p);
  } catch {}
}

async function readWeight() {
  SC.buf.length = 0;
  await SC.writer.write(Uint8Array.of(5));
  const ack = await waitBuf(() => (SC.buf.length ? SC.buf[0] : null), 1500);
  if (ack !== 6) throw new Error('Весы не ответили. Проверьте кабель и включите весы');
  SC.buf.length = 0;
  await SC.writer.write(Uint8Array.of(0x11));
  const frame = await waitBuf(() => {
    const i = SC.buf.indexOf(4);
    return i >= 0 ? SC.buf.slice(0, i + 1) : null;
  }, 3000);
  if (!frame) throw new Error('Весы не прислали вес');
  const m = /\x01\x02([SU])\s*([-+]?)\s*(\d+(?:\.\d+)?)/.exec(String.fromCharCode(...frame));
  if (!m) throw new Error('Не удалось разобрать ответ весов');
  if (m[1] !== 'S') throw new Error('Вес не устоялся, подождите и нажмите ещё раз');
  return (m[2] === '-' ? -1 : 1) * parseFloat(m[3]);
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
    try {
      SC.reader.cancel();
      SC.writer.releaseLock();
      await SC.port.close();
    } catch {}
    SC.port = null;
    updateScaleUi();
  };
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('.sc-read');
    if (!b) return;
    b.disabled = true;
    try {
      if (!SC.port) await openPort(await navigator.serial.requestPort());
      const gross = await readWeight();
      const net = Math.round((gross - (+$('tare-g').value || 0) / 1000) * 1000) / 1000;
      if (net <= 0) throw new Error('Вес не больше веса ящика');
      const target = $(b.dataset.t);
      target.value = net.toFixed(3);
      target.dispatchEvent(new Event('input'));
    } catch (err) {
      if (err.name !== 'NotFoundError') toast(err.message, true);
    } finally {
      b.disabled = false;
    }
  });
  updateScaleUi();
}
