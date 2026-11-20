// Уведомления в Telegram-группу о приходе и продаже.
// Переменные окружения в Vercel:
//   TG_BOT_TOKEN  — токен бота от @BotFather
//   TG_CHAT_ID    — ID группы (например -1001234567890; можно несколько через запятую)
//   TG_THREAD_ID  — (необязательно) ID темы в группе-форуме

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const kg = (v) => Number(v || 0).toFixed(3);
const money = (v) => Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });

async function sendTelegram(html) {
  if (typeof globalThis.__TEST_TG === 'function') {
    globalThis.__TEST_TG(html);
    return;
  }
  const token = (process.env.TG_BOT_TOKEN || '').trim();
  const rawChats = (process.env.TG_CHAT_ID || '').trim();
  if (!token || !rawChats) return;

  const chats = rawChats.split(',').map((s) => s.trim()).filter(Boolean);
  const threadRaw = (process.env.TG_THREAD_ID || '').trim();
  const threadId = threadRaw && Number.isInteger(Number(threadRaw)) ? Number(threadRaw) : null;

  await Promise.all(
    chats.map(async (chatId) => {
      try {
        const body = {
          chat_id: chatId,
          text: html,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        };
        if (threadId) body.message_thread_id = threadId;
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(4000),
        });
        if (!r.ok) {
          console.error('TG sendMessage error:', r.status, await r.text().catch(() => ''));
        }
      } catch (e) {
        console.error('TG sendMessage failed:', e.message || e);
      }
    })
  );
}

async function notifyIntake({ grade, net_kg, balance_kg, user_name, note, source }) {
  const lines = [
    `📥 <b>Приход на склад</b>${source ? ` <i>(${esc(source)})</i>` : ''}`,
    '',
    `Сорт: <b>${esc(grade)}</b>`,
    `Вес: <b>${kg(net_kg)} кг</b>`,
  ];
  if (balance_kg !== undefined && balance_kg !== null) {
    lines.push(`Остаток по сорту: ${kg(balance_kg)} кг`);
  }
  if (user_name) lines.push(`Сотрудник: ${esc(user_name)}`);
  if (note) lines.push(`Заметка: ${esc(note)}`);
  await sendTelegram(lines.join('\n'));
}

async function notifySale({ sale_id, customer, items, total_kg, total_amount, currency = 'сум', user_name, note, source }) {
  const itemLines = (items || []).map((it) => {
    const pricePart = it.price_per_kg != null ? ` × ${money(it.price_per_kg)}` : '';
    const amtPart = it.amount != null ? ` = <b>${money(it.amount)} ${esc(currency)}</b>` : '';
    return `• ${esc(it.grade)} — ${kg(it.net_kg)} кг${pricePart}${amtPart}`;
  });
  const lines = [
    `💰 <b>Продажа${sale_id ? ` №${esc(sale_id)}` : ''}</b>${source ? ` <i>(${esc(source)})</i>` : ''}`,
    '',
    `Покупатель: <b>${esc(customer || '—')}</b>`,
    ...itemLines,
    '',
    `Итого: <b>${kg(total_kg)} кг</b> на <b>${money(total_amount)} ${esc(currency)}</b>`,
  ];
  if (user_name) lines.push(`Сотрудник: ${esc(user_name)}`);
  if (note) lines.push(`Заметка: ${esc(note)}`);
  await sendTelegram(lines.join('\n'));
}

module.exports = { sendTelegram, notifyIntake, notifySale };
