// Уведомления в Telegram-группу о приходе и продаже.
// Переменные окружения в Vercel:
//   TG_BOT_TOKEN  — токен бота от @BotFather
//   TG_CHAT_ID    — ID группы (например -1001234567890; можно несколько через запятую)
//   TG_THREAD_ID  — (необязательно) ID темы в группе-форуме

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const kg = (v) => Number(v || 0).toFixed(3);
const money = (v) => Number(v || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });

const PER_MESSAGE_MS = 5000;

// opts.deadline (мс, Date.now()) — общий срок для пачки сообщений: запрос не ждёт дольше остатка.
async function sendTelegram(html, opts = {}) {
  if (typeof globalThis.__TEST_TG === 'function') {
    await globalThis.__TEST_TG(html);
    return { ok: true, configured: true, results: [{ ok: true, test: true }] };
  }
  const token = (process.env.TG_BOT_TOKEN || '').trim();
  const rawChats = (process.env.TG_CHAT_ID || '').trim();
  if (!token || !rawChats) {
    return { ok: false, configured: false, has_token: Boolean(token), has_chat_id: Boolean(rawChats), results: [] };
  }

  const chats = rawChats.split(',').map((s) => s.trim()).filter(Boolean);
  const threadRaw = (process.env.TG_THREAD_ID || '').trim();
  const threadId = threadRaw && Number.isInteger(Number(threadRaw)) ? Number(threadRaw) : null;

  const postOne = async (chatId) => {
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
      signal: AbortSignal.timeout(Math.max(200, Math.min(PER_MESSAGE_MS, (opts.deadline || Infinity) - Date.now()))),
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok && Boolean(data.ok), data };
  };

  const results = await Promise.all(
    chats.map(async (chatId) => {
      try {
        let res = await postOne(chatId);
        // Если Telegram перевёл группу в супергруппу, повторяем отправку на новый migrate_to_chat_id
        const migrated = res.data?.parameters?.migrate_to_chat_id;
        if (!res.ok && migrated) {
          res = await postOne(String(migrated));
        }
        if (!res.ok) {
          console.error('TG sendMessage error:', res.status, res.data?.description || '');
        }
        return { chatId, ok: res.ok, status: res.status, description: res.data?.description || '', migrated_to: migrated || null };
      } catch (e) {
        console.error('TG sendMessage failed:', e.name || 'Error', String(e.message || '').replace(/bot[^/\s]+/g, 'bot***'));
        return { chatId, ok: false, status: 0, description: e.message || String(e) };
      }
    })
  );
  return { ok: results.every((x) => x.ok), configured: true, results };
}

async function notifyIntake({ grade, net_kg, balance_kg, user_name, note, source }, opts) {
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
  return sendTelegram(lines.join('\n'), opts);
}

// Много приходов в одной пачке моноблока — одно сводное сообщение вместо потока.
async function notifyIntakeSummary({ rows, balances = {}, source }, opts) {
  const by = new Map();
  for (const r of rows) {
    const g = by.get(r.grade) || { n: 0, kg: 0 };
    g.n += 1;
    g.kg = Math.round((g.kg + Number(r.net_kg || 0)) * 1000) / 1000;
    by.set(r.grade, g);
  }
  const total = [...by.values()].reduce((a, g) => a + g.kg, 0);
  const lines = [
    `📥 <b>Приход на склад: ${rows.length} записей</b>${source ? ` <i>(${esc(source)})</i>` : ''}`,
    '',
    ...[...by.entries()].map(([g, v]) => {
      const bal = balances[g] !== undefined && balances[g] !== null ? `, остаток ${kg(balances[g])} кг` : '';
      return `• ${esc(g)} — ${kg(v.kg)} кг (${v.n} шт.)${bal}`;
    }),
    '',
    `Итого: <b>${kg(total)} кг</b>`,
  ];
  return sendTelegram(lines.join('\n'), opts);
}

// Сводка о продажах, не поместившихся в лимит отдельных сообщений.
async function notifySalesSummary({ sales, currency = 'сум', source }, opts) {
  const totalKg = sales.reduce((a, s) => a + Number(s.total_kg || 0), 0);
  const totalAmt = sales.reduce((a, s) => a + Number(s.total_amount || 0), 0);
  const lines = [
    `💰 <b>Ещё продаж: ${sales.length}</b>${source ? ` <i>(${esc(source)})</i>` : ''}`,
    '',
    `Итого: <b>${kg(totalKg)} кг</b> на <b>${money(totalAmt)} ${esc(currency)}</b>`,
  ];
  return sendTelegram(lines.join('\n'), opts);
}

// Параллельная отправка с общим бюджетом времени: ответ моноблоку не задерживается дольше budgetMs.
async function sendMany(jobs, budgetMs = 7000) {
  if (!jobs.length) return { ok: true, sent: 0, timeout: false };
  const deadline = Date.now() + budgetMs;
  let timer;
  const all = Promise.allSettled(jobs.map((job) => job({ deadline })));
  const res = await Promise.race([all, new Promise((resolve) => { timer = setTimeout(() => resolve(null), budgetMs); })]);
  clearTimeout(timer);
  if (!res) {
    console.error('TG: бюджет времени исчерпан, часть сообщений не дождались');
    return { ok: false, sent: jobs.length, timeout: true };
  }
  return { ok: res.every((r) => r.status === 'fulfilled' && r.value && r.value.ok !== false), sent: jobs.length, timeout: false };
}

async function notifySale({ sale_id, customer, items, total_kg, total_amount, currency = 'сум', user_name, note, source }, opts) {
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
  return sendTelegram(lines.join('\n'), opts);
}

module.exports = { sendTelegram, sendMany, notifyIntake, notifyIntakeSummary, notifySale, notifySalesSummary };
