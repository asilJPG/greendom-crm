// Экранная цифровая клавиатура (POS-нампад) для сенсорного моноблока.
// Включается автоматически по параметру ?kiosk=1 (запоминается в localStorage; отключить: ?kiosk=0).

const NUMERIC_IDS = new Set(['sc-manual-in', 'tare-g', 'sl-price', 'sl-amt-ov']);
const DECIMAL_IDS = new Set(['sc-manual-in']);
const SUM_IDS = new Set(['sl-price', 'sl-amt-ov']);

function detectKiosk() {
  try {
    const qs = new URLSearchParams(location.search);
    if (qs.get('kiosk') === '1') localStorage.setItem('kiosk', '1');
    if (qs.get('kiosk') === '0') localStorage.removeItem('kiosk');
    return localStorage.getItem('kiosk') === '1';
  } catch {
    return false;
  }
}

export function initNumpad() {
  if (!detectKiosk()) return;
  document.body.classList.add('kiosk');

  // На моноблоке отключаем системную экранную клавиатуру Windows для цифровых полей,
  // чтобы она не перекрывала наш нампад.
  for (const id of NUMERIC_IDS) {
    const el = document.getElementById(id);
    if (el) el.setAttribute('inputmode', 'none');
  }

  const pad = document.createElement('div');
  pad.id = 'kiosk-numpad';
  pad.className = 'numpad';
  pad.hidden = true;
  pad.innerHTML = `
    <div class="np-head">
      <div style="min-width:0;flex:1">
        <div class="np-lbl" id="np-lbl">Ввод</div>
        <div class="np-val" id="np-val">0</div>
      </div>
      <button type="button" class="np-close" id="np-close" aria-label="Закрыть">✕</button>
    </div>
    <div class="np-grid" id="np-grid">
      <button type="button" data-k="7">7</button>
      <button type="button" data-k="8">8</button>
      <button type="button" data-k="9">9</button>
      <button type="button" class="np-fn" data-k="back">⌫</button>
      <button type="button" data-k="4">4</button>
      <button type="button" data-k="5">5</button>
      <button type="button" data-k="6">6</button>
      <button type="button" class="np-fn" data-k="clear">C</button>
      <button type="button" data-k="1">1</button>
      <button type="button" data-k="2">2</button>
      <button type="button" data-k="3">3</button>
      <button type="button" class="np-fn" id="np-dot" data-k=".">.</button>
      <button type="button" data-k="0">0</button>
      <button type="button" class="np-fn" id="np-000" data-k="000">000</button>
      <button type="button" class="np-ok" data-k="done">Готово</button>
    </div>`;
  document.body.appendChild(pad);

  let target = null;
  const valEl = document.getElementById('np-val');
  const lblEl = document.getElementById('np-lbl');
  const dotBtn = document.getElementById('np-dot');
  const k000Btn = document.getElementById('np-000');

  const getLabel = (inp) => {
    if (inp.id === 'lg-pw') return 'Пароль';
    const lbl = document.querySelector(`label[for="${inp.id}"]`);
    return (lbl && lbl.textContent.trim()) || inp.placeholder || 'Ввод числа';
  };

  const syncDisplay = () => {
    if (!target) return;
    const isPw = target.type === 'password';
    valEl.textContent = target.value ? (isPw ? '•'.repeat(target.value.length) : target.value) : '0';
  };

  const openFor = (inp) => {
    target = inp;
    lblEl.textContent = getLabel(inp);
    const allowDot = DECIMAL_IDS.has(inp.id);
    const allow000 = SUM_IDS.has(inp.id);
    dotBtn.disabled = !allowDot;
    dotBtn.style.opacity = allowDot ? '1' : '.35';
    k000Btn.disabled = !allow000;
    k000Btn.style.opacity = allow000 ? '1' : '.35';
    syncDisplay();
    pad.hidden = false;
  };

  const closePad = () => {
    pad.hidden = true;
    target = null;
  };

  // Открываем нампад при нажатии на цифровые поля (и на поле пароля входа, если пароль цифровой)
  const isTarget = (el) => el && el.tagName === 'INPUT' && (NUMERIC_IDS.has(el.id) || el.id === 'lg-pw');

  document.addEventListener('focusin', (e) => {
    if (isTarget(e.target)) openFor(e.target);
  });
  document.addEventListener('pointerdown', (e) => {
    if (pad.contains(e.target)) return;
    if (isTarget(e.target)) {
      openFor(e.target);
    } else if (!pad.hidden) {
      closePad();
    }
  });

  document.getElementById('np-close').onclick = closePad;
  document.getElementById('np-grid').onclick = (e) => {
    const b = e.target.closest('button[data-k]');
    if (!b || b.disabled || !target) return;
    const k = b.dataset.k;
    let v = target.value || '';

    if (k === 'done') {
      const wasLogin = target.id === 'lg-pw';
      closePad();
      if (wasLogin && v) document.getElementById('lg-go')?.click();
      return;
    }
    if (k === 'clear') {
      v = '';
    } else if (k === 'back') {
      v = v.slice(0, -1);
    } else if (k === '.') {
      if (!v.includes('.') && !v.includes(',')) v = (v || '0') + '.';
    } else if (k === '000') {
      if (v && v !== '0') v += '000';
    } else {
      v = v === '0' && target.id !== 'lg-pw' ? k : v + k;
    }

    target.value = v;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    syncDisplay();
  };
}
