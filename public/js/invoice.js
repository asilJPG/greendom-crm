// Формирование товарной накладной по продаже: предпросмотр, Печать/PDF и PNG-картинка для Telegram.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kg = (v) => (v == null ? '—' : Number(v).toFixed(3));
const money = (v) => Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });

let currentSale = null;
let currentMeta = { crop: 'Клубника', cur: 'сум' };

function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.slice(0, 10).split('-');
  return d.length === 3 ? `${d[2]}.${d[1]}.${d[0]} ${ts.slice(11, 16)}`.trim() : ts;
}

function buildInvoiceHtml(sale, { crop, cur }) {
  const rows = sale.items.map((it, idx) => `
    <tr>
      <td class="num">${idx + 1}</td>
      <td>${esc(crop ? `${crop} · ${it.grade}` : it.grade)}</td>
      <td class="num">${kg(it.net_kg)}</td>
      <td class="num">${it.price_per_kg != null ? money(it.price_per_kg) : '—'}</td>
      <td class="num"><b>${money(it.amount)}</b></td>
    </tr>`).join('');

  return `
    <div class="inv-sheet" id="inv-sheet">
      <div class="inv-head">
        <div>
          <div class="inv-title">Товарная накладная №${esc(sale.sale_id)}</div>
          <div class="inv-date">от ${esc(fmtDate(sale.ts))}</div>
        </div>
        <div class="inv-brand">Склад${crop ? ' · ' + esc(crop) : ''}</div>
      </div>
      <div class="inv-meta">
        <div><span>Покупатель:</span> <b>${esc(sale.customer || '—')}</b></div>
        ${sale.user_name ? `<div><span>Отпустил:</span> <b>${esc(sale.user_name)}</b></div>` : ''}
        ${sale.note ? `<div><span>Примечание:</span> ${esc(sale.note)}</div>` : ''}
      </div>
      <table class="inv-tbl">
        <thead>
          <tr><th class="num">№</th><th>Товар / Сорт</th><th class="num">Вес, кг</th><th class="num">Цена, ${esc(cur)}</th><th class="num">Сумма, ${esc(cur)}</th></tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td colspan="2"><b>Итого</b></td>
            <td class="num"><b>${kg(sale.total_kg)} кг</b></td>
            <td></td>
            <td class="num"><b>${money(sale.total_amount)} ${esc(cur)}</b></td>
          </tr>
        </tfoot>
      </table>
      <div class="inv-signs">
        <div>Отпустил ___________________</div>
        <div>Принял ___________________</div>
      </div>
    </div>`;
}

// Рендерит чёткую 2x Retina PNG-накладную на Canvas для отправки в Telegram / WhatsApp
function renderInvoicePng(sale, { crop, cur }) {
  const scale = 2;
  const W = 720;
  const pad = 40;
  const rowH = 38;
  const H = 290 + sale.items.length * rowH + (sale.note ? 26 : 0) + 90;

  const canvas = document.createElement('canvas');
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  // Фон
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // Внешняя тонкая рамка
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 1;
  ctx.strokeRect(16, 16, W - 32, H - 32);

  const font = (w, s) => `${w} ${s}px Figtree, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;

  // Шапка
  let y = pad + 18;
  ctx.fillStyle = '#000000';
  ctx.font = font(700, 24);
  ctx.fillText(`Товарная накладная №${sale.sale_id}`, pad, y);

  ctx.fillStyle = '#6b6b70';
  ctx.font = font(600, 14);
  const brandText = `Склад${crop ? ' · ' + crop : ''}`;
  ctx.fillText(brandText, W - pad - ctx.measureText(brandText).width, y - 4);

  y += 24;
  ctx.fillStyle = '#474747';
  ctx.font = font(400, 14);
  ctx.fillText(`от ${fmtDate(sale.ts)}`, pad, y);

  y += 18;
  ctx.strokeStyle = 'rgba(0,0,0,0.1)';
  ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();

  // Метаданные
  y += 28;
  ctx.fillStyle = '#6b6b70'; ctx.font = font(500, 14);
  ctx.fillText('Покупатель:', pad, y);
  ctx.fillStyle = '#000000'; ctx.font = font(700, 15);
  ctx.fillText(sale.customer || '—', pad + 100, y);

  if (sale.user_name) {
    y += 24;
    ctx.fillStyle = '#6b6b70'; ctx.font = font(500, 14);
    ctx.fillText('Отпустил:', pad, y);
    ctx.fillStyle = '#000000'; ctx.font = font(600, 14);
    ctx.fillText(sale.user_name, pad + 100, y);
  }
  if (sale.note) {
    y += 24;
    ctx.fillStyle = '#6b6b70'; ctx.font = font(500, 14);
    ctx.fillText('Примечание:', pad, y);
    ctx.fillStyle = '#474747'; ctx.font = font(400, 14);
    ctx.fillText(String(sale.note).slice(0, 65), pad + 100, y);
  }

  // Заголовок таблицы
  y += 30;
  ctx.fillStyle = '#f4f4f5';
  ctx.fillRect(pad, y, W - pad * 2, 34);
  ctx.fillStyle = '#474747';
  ctx.font = font(600, 12.5);
  const cols = [pad + 10, pad + 48, W - pad - 240, W - pad - 130, W - pad - 10];
  ctx.fillText('№', cols[0], y + 22);
  ctx.fillText('Товар / Сорт', cols[1], y + 22);
  const rightText = (txt, x, yy) => ctx.fillText(txt, x - ctx.measureText(txt).width, yy);
  rightText('Вес, кг', cols[2], y + 22);
  rightText(`Цена, ${cur}`, cols[3], y + 22);
  rightText(`Сумма, ${cur}`, cols[4], y + 22);

  y += 34;
  sale.items.forEach((it, idx) => {
    y += rowH;
    ctx.fillStyle = '#000000';
    ctx.font = font(400, 14);
    ctx.fillText(String(idx + 1), cols[0], y - 12);
    ctx.fillText(crop ? `${crop} · ${it.grade}` : it.grade, cols[1], y - 12);
    rightText(kg(it.net_kg), cols[2], y - 12);
    rightText(it.price_per_kg != null ? money(it.price_per_kg) : '—', cols[3], y - 12);
    ctx.font = font(600, 14);
    rightText(money(it.amount), cols[4], y - 12);

    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
  });

  // Итого
  y += 34;
  ctx.fillStyle = '#000000';
  ctx.font = font(700, 16);
  ctx.fillText('ИТОГО', cols[0], y);
  rightText(`${kg(sale.total_kg)} кг`, cols[2], y);
  rightText(`${money(sale.total_amount)} ${cur}`, cols[4], y);

  // Подписи
  y += 58;
  ctx.fillStyle = '#474747';
  ctx.font = font(400, 13.5);
  ctx.fillText('Отпустил ______________________', pad, y);
  const rightSign = 'Принял ______________________';
  ctx.fillText(rightSign, W - pad - ctx.measureText(rightSign).width, y);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

export function openInvoice(sale, meta) {
  currentSale = sale;
  currentMeta = meta;
  $('inv-body').innerHTML = buildInvoiceHtml(sale, meta);
  $('inv-dlg').showModal();
}

export function initInvoice(toast) {
  $('inv-close').onclick = () => $('inv-dlg').close();
  $('inv-print').onclick = () => {
    if (!currentSale) return;
    $('print-root').innerHTML = buildInvoiceHtml(currentSale, currentMeta);
    window.print();
  };
  $('inv-png').onclick = async () => {
    if (!currentSale) return;
    const blob = await renderInvoicePng(currentSale, currentMeta);
    if (!blob) return toast('Не удалось сформировать картинку', true);
    const filename = `nakladnaya_${currentSale.sale_id}.png`;
    const file = new File([blob], filename, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: `Накладная №${currentSale.sale_id}` });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Картинка PNG сохранена');
  };
}
