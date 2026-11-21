// Ввод чисел с телефона и моноблока: принимаем и «1,5», и «1.5» (type="number" в Chromium превращал «1,5» в 15).
// Поля веса/цены/сумм — type="text" inputmode="decimal", значение разбираем здесь.

/** Разбор десятичного числа. '' → null, мусор → NaN, иначе Number. Пробелы (в т.ч. неразрывные) игнорируются. */
export function parseDecimal(raw) {
  const s = String(raw ?? '').trim().replace(/[\s  ]/g, '').replace(',', '.');
  if (s === '') return null;
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Читает число из поля ввода и проверяет его.
 * @param {HTMLInputElement|string} elOrId
 * @param {{label?:string, required?:boolean, positive?:boolean, min?:number, max?:number}} [o]
 * @returns {{ok:true, value:number|null} | {ok:false, error:string}}
 */
export function readDecimal(elOrId, o = {}) {
  const el = typeof elOrId === 'string' ? document.getElementById(elOrId) : elOrId;
  const label = o.label || 'Число';
  const v = parseDecimal(el ? el.value : '');
  const bad = (error) => {
    if (el) { el.setAttribute('aria-invalid', 'true'); el.classList.add('bad-input'); }
    return { ok: false, error };
  };
  if (el) { el.removeAttribute('aria-invalid'); el.classList.remove('bad-input'); }
  if (v === null) return o.required || o.positive ? bad(`Укажите: ${label.toLowerCase()}`) : { ok: true, value: null };
  if (Number.isNaN(v)) return bad(`${label}: неверное число «${el.value.trim()}». Пример: 1,5 или 1.5`);
  if (o.positive && v <= 0) return bad(`${label}: должно быть больше 0`);
  const min = o.min ?? 0;
  if (v < min) return bad(`${label}: не может быть меньше ${min}`);
  if (o.max != null && v > o.max) return bad(`${label}: слишком большое значение`);
  return { ok: true, value: v };
}

/** Снимает подсветку ошибки при вводе (подключить один раз). */
export function clearInvalidOnInput(root = document) {
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('bad-input')) {
      t.classList.remove('bad-input');
      t.removeAttribute('aria-invalid');
    }
  });
}

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
