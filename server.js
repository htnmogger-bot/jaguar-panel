import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import pg from 'pg';
import {
  Client,
  GatewayIntentBits,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';

const { Pool } = pg;
const app = express();
const PORT = Number(process.env.PORT || 3000);

const required = ['DATABASE_URL','PANEL_PASSWORD','SESSION_SECRET','BOT_API_SECRET','REVANTPAY_API_KEY','DISCORD_BOT_TOKEN','DISCORD_CLIENT_ID','DISCORD_GUILD_ID','DISCORD_ROLE_ID'];
for (const k of required) {
  if (!process.env[k]) throw new Error(`Variável obrigatória ausente: ${k}`);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const REVANT_BASE = 'https://api.revantpay.com/v1';
const OFFER_PRICE = Number(process.env.JAGUAR_PRICE || 10.90);
const OFFER_DAYS = Number(process.env.JAGUAR_DAYS || 7);
const OFFER_NAME = process.env.JAGUAR_PRODUCT_NAME || `JAGUAR CLIENT - ${OFFER_DAYS} DIAS`;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

function safeEq(a, b) {
  const aa = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function sign(value) {
  return crypto.createHmac('sha256', process.env.SESSION_SECRET).update(value).digest('hex');
}

function setSession(res) {
  const payload = `admin.${Date.now()}`;
  const token = `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
  res.cookie('jaguar_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    maxAge: 7 * 86400000
  });
}

function isAdmin(req) {
  const raw = req.cookies?.jaguar_session || '';
  const [p, sig] = raw.split('.');
  if (!p || !sig) return false;
  try {
    const payload = Buffer.from(p, 'base64url').toString('utf8');
    return payload.startsWith('admin.') && safeEq(sig, sign(payload));
  } catch {
    return false;
  }
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Não autorizado' });
  next();
}

function requireBot(req, res, next) {
  const secret = req.get('X-Bot-Secret') || '';
  if (!safeEq(secret, process.env.BOT_API_SECRET)) return res.status(401).json({ error: 'Bot não autorizado' });
  next();
}

function generateKey() {
  const part = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `JAGUAR-${part()}-${part()}-${part()}-${part()}`;
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price NUMERIC(12,2) NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      download_url TEXT NOT NULL DEFAULT '',
      tutorial_url TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      external_id TEXT UNIQUE NOT NULL,
      charge_id TEXT UNIQUE,
      discord_user_id TEXT,
      customer_name TEXT,
      customer_email TEXT,
      product_id BIGINT,
      product_name TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      days INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      license_key TEXT,
      pix_code TEXT,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS licenses (
      id BIGSERIAL PRIMARY KEY,
      key TEXT UNIQUE NOT NULL,
      hwid TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE licenses ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';
    ALTER TABLE licenses ADD COLUMN IF NOT EXISTS discord_user_id TEXT;
    ALTER TABLE licenses ADD COLUMN IF NOT EXISTS order_id UUID;
    ALTER TABLE licenses ADD COLUMN IF NOT EXISTS product_name TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS product_id BIGINT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS pix_code TEXT;

    CREATE TABLE IF NOT EXISTS webhook_events (
      id BIGSERIAL PRIMARY KEY,
      charge_id TEXT NOT NULL,
      event TEXT NOT NULL,
      raw JSONB NOT NULL,
      received_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(charge_id, event)
    );
  `);

  const existing = await pool.query('SELECT id FROM products WHERE name=$1 LIMIT 1', [OFFER_NAME]);
  if (!existing.rowCount) {
    await pool.query(
      'INSERT INTO products(name,price,description,active) VALUES($1,$2,$3,TRUE)',
      [OFFER_NAME, OFFER_PRICE, 'JAGUAR CLIENT 1.8.9']
    );
  }
}

async function createRevantPixOrder({ discordUserId, customerName, customerEmail, amount = OFFER_PRICE, days = OFFER_DAYS, productId = null, productName = OFFER_NAME }) {
  const cleanUserId = String(discordUserId || '').trim();
  const safeAmount = Number(amount);
  const safeDays = Math.max(1, Math.min(3650, Number(days || OFFER_DAYS)));
  if (!/^\d{17,20}$/.test(cleanUserId)) throw new Error('Discord User ID inválido');
  if (!(safeAmount >= 5)) throw new Error('Valor mínimo da Revant Pay é R$ 5,00');

  const id = crypto.randomUUID();
  const externalId = `jaguar_${id}`;
  await pool.query(`
    INSERT INTO orders(id,external_id,discord_user_id,customer_name,customer_email,product_id,product_name,amount,days,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
  `, [id, externalId, cleanUserId, customerName || null, customerEmail || null, productId, productName, safeAmount, safeDays]);

  try {
    const response = await fetch(`${REVANT_BASE}/charges/pix`, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.REVANTPAY_API_KEY,
        'Content-Type': 'application/json',
        'Idempotency-Key': id
      },
      body: JSON.stringify({
        amount: safeAmount,
        description: productName,
        customer_name: customerName || undefined,
        ...(customerEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail) ? { customer_email: customerEmail } : {}),
        external_id: externalId,
        webhook_url: `${PUBLIC_BASE_URL}/webhooks/revantpay`
      })
    });

    const charge = await response.json().catch(() => ({}));
    if (!response.ok) {
      await pool.query("UPDATE orders SET status='failed' WHERE id=$1", [id]);
      const revantError = charge?.error?.message || (typeof charge?.error === 'string' ? charge.error : '') || charge?.message || `HTTP ${response.status}`;
      throw new Error(`Revant Pay: ${revantError}`);
    }

    const chargeId = charge.charge_id || charge.id || null;
    const pix = charge.pix || {};
    await pool.query('UPDATE orders SET charge_id=$2, pix_code=$3 WHERE id=$1', [id, chargeId, pix.qr_code || null]);

    return {
      order_id: id,
      external_id: externalId,
      charge_id: chargeId,
      status: charge.status,
      amount: charge.amount ?? safeAmount,
      pix: {
        qr_code: pix.qr_code || null,
        qr_code_url: pix.qr_code_url || null,
        qr_code_base64: pix.qr_code_base64 || null,
        expires_at: pix.expires_at || null
      }
    };
  } catch (error) {
    await pool.query("UPDATE orders SET status='failed' WHERE id=$1", [id]);
    throw error;
  }
}

async function createLicense({ days, source='manual', discordUserId=null, orderId=null, productName=OFFER_NAME }) {
  const safeDays = Math.max(1, Math.min(3650, Number(days || OFFER_DAYS)));
  const expires = new Date(Date.now() + safeDays * 86400000);
  for (let i = 0; i < 10; i++) {
    const key = generateKey();
    try {
      const r = await pool.query(`
        INSERT INTO licenses(key,expires_at,status,source,discord_user_id,order_id,product_name)
        VALUES($1,$2,'active',$3,$4,$5,$6)
        RETURNING key,expires_at,status
      `, [key, expires, source, discordUserId, orderId, productName]);
      return r.rows[0];
    } catch (e) {
      if (e.code !== '23505') throw e;
    }
  }
  throw new Error('Não foi possível gerar uma key única');
}

async function discordRequest(path, options = {}) {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) throw new Error(`Discord ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

async function deliverDiscord(userId, licenseKey, days) {
  if (!userId) return { dm: false, role: false };
  let dm = false, role = false;
  try {
    const channel = await discordRequest('/users/@me/channels', {
      method: 'POST',
      body: JSON.stringify({ recipient_id: userId })
    });
    await discordRequest(`/channels/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: `✅ **JAGUAR CLIENT**\n\nPagamento confirmado!\n\n🔑 Sua licença: **${licenseKey}**\n⏳ Validade: **${days} dias**\n\nNão compartilhe essa chave.`
      })
    });
    dm = true;
  } catch (e) {
    console.error('[Discord DM]', e.message);
  }

  try {
    await discordRequest(`/guilds/${process.env.DISCORD_GUILD_ID}/members/${userId}/roles/${process.env.DISCORD_ROLE_ID}`, {
      method: 'PUT',
      body: ''
    });
    role = true;
  } catch (e) {
    console.error('[Discord ROLE]', e.message);
  }
  return { dm, role };
}

async function processRevantEvent(eventPayload) {
  const event = eventPayload?.event || eventPayload?.type || '';
  const data = eventPayload?.data || eventPayload;
  const chargeId = data?.charge_id || data?.id || '';
  if (!event || !chargeId) return;

  try {
    await pool.query('INSERT INTO webhook_events(charge_id,event,raw) VALUES($1,$2,$3)', [chargeId, event, eventPayload]);
  } catch (e) {
    if (e.code === '23505') return;
    throw e;
  }

  const order = await pool.query('SELECT * FROM orders WHERE charge_id=$1 LIMIT 1', [chargeId]);
  if (!order.rowCount) return;
  const o = order.rows[0];

  if (event === 'charge.paid' || event === 'payment.approved') {
    if (o.status === 'paid' && o.license_key) return;
    const existing = await pool.query('SELECT key FROM licenses WHERE order_id=$1 LIMIT 1', [o.id]);
    let licenseKey = existing.rowCount ? existing.rows[0].key : null;
    if (!licenseKey) {
      const lic = await createLicense({ days: o.days, source: 'revantpay', discordUserId: o.discord_user_id, orderId: o.id, productName: o.product_name });
      licenseKey = lic.key;
    }
    await pool.query("UPDATE orders SET status='paid', license_key=$2, paid_at=COALESCE(paid_at,NOW()) WHERE id=$1", [o.id, licenseKey]);
    const discord = await deliverDiscord(o.discord_user_id, licenseKey, o.days);
    console.log(`[PAID] ${o.external_id} -> ${licenseKey}`, discord);
    return;
  }

  if (event === 'charge.refunded' || event === 'payment.refunded') {
    await pool.query("UPDATE orders SET status='refunded' WHERE id=$1", [o.id]);
    if (o.license_key) await pool.query("UPDATE licenses SET status='revoked' WHERE key=$1", [o.license_key]);
    return;
  }

  const failedEvents = new Set(['charge.failed','payment.failed','charge.expired','payment.expired','charge.cancelled','payment.cancelled']);
  if (failedEvents.has(event)) {
    const status = event.includes('expired') ? 'expired' : event.includes('cancel') ? 'cancelled' : 'failed';
    await pool.query("UPDATE orders SET status=$2 WHERE id=$1 AND status='pending'", [o.id, status]);
  }
}

function verifyRevantSignature(raw, header) {
  const secret = process.env.REVANTPAY_WEBHOOK_SECRET || '';
  if (!secret) return null; // caller will use server-side verification fallback
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map(p => p.trim().split('=')));
  const timestamp = parts.t || '';
  const signature = parts.v1 || '';
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  return safeEq(signature, expected);
}

// Login/painel
app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (!safeEq(req.body.password, process.env.PANEL_PASSWORD)) return res.status(401).send('Senha inválida');
  setSession(res);
  res.redirect('/');
});
app.get('/logout', (req, res) => { res.clearCookie('jaguar_session'); res.redirect('/'); });
app.get('/api/session', (req, res) => res.json({ authenticated: isAdmin(req) }));

// Webhook precisa do corpo bruto.
app.post('/webhooks/revantpay', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const raw = req.body.toString('utf8');
    const eventPayload = JSON.parse(raw);
    const verification = verifyRevantSignature(raw, req.get('X-Revantpay-Signature') || '');

    if (verification === false) return res.status(401).end();

    if (verification === null) {
      const data = eventPayload?.data || eventPayload;
      const chargeId = data?.charge_id || data?.id || '';
      if (!chargeId) return res.status(400).end();
      const check = await fetch(`${REVANT_BASE}/charges/${encodeURIComponent(chargeId)}`, {
        headers: { 'x-api-key': process.env.REVANTPAY_API_KEY }
      });
      const charge = await check.json().catch(() => ({}));
      const statusOk = ['approved', 'paid'].includes(charge?.status);
      const externalId = charge?.external_id || '';
      const local = await pool.query('SELECT id FROM orders WHERE charge_id=$1 AND external_id=$2 LIMIT 1', [chargeId, externalId]);
      const event = eventPayload?.event || eventPayload?.type || '';
      const refundEvent = event === 'charge.refunded' || event === 'payment.refunded';
      if ((!statusOk && !refundEvent) || !local.rowCount) return res.status(401).end();
    }

    res.status(200).end();
    await processRevantEvent(eventPayload);
  } catch (e) {
    console.error('[Revant webhook]', e);
    if (!res.headersSent) res.status(400).end();
  }
});

app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

app.get('/api/dashboard', requireAdmin, async (req, res) => {
  const [licenses, active, sales, revenue] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS n FROM licenses'),
    pool.query("SELECT COUNT(*)::int AS n FROM licenses WHERE status='active' AND expires_at > NOW()"),
    pool.query("SELECT COUNT(*)::int AS n FROM orders WHERE status='paid'"),
    pool.query("SELECT COALESCE(SUM(amount),0)::numeric(12,2) AS n FROM orders WHERE status='paid'")
  ]);
  res.json({ licenses: licenses.rows[0].n, active: active.rows[0].n, sales: sales.rows[0].n, revenue: Number(revenue.rows[0].n) });
});

app.get('/api/licenses', requireAdmin, async (req, res) => {
  const q = String(req.query.q || '').trim();
  const r = q
    ? await pool.query(`SELECT id,key,hwid,expires_at,status,source,discord_user_id,product_name,created_at FROM licenses WHERE key ILIKE $1 OR COALESCE(discord_user_id,'') ILIKE $1 ORDER BY id DESC LIMIT 200`, [`%${q}%`])
    : await pool.query(`SELECT id,key,hwid,expires_at,status,source,discord_user_id,product_name,created_at FROM licenses ORDER BY id DESC LIMIT 200`);
  res.json(r.rows);
});

app.post('/api/licenses', requireAdmin, async (req, res) => {
  const n = Math.max(1, Math.min(100, Number(req.body?.quantity || 1)));
  const out = [];
  for (let i = 0; i < n; i++) out.push(await createLicense({ days: req.body?.days }));
  res.json(out);
});

app.post('/api/licenses/:key/revoke', requireAdmin, async (req, res) => {
  const r = await pool.query("UPDATE licenses SET status='revoked' WHERE key=$1 RETURNING key,status", [req.params.key]);
  if (!r.rowCount) return res.status(404).json({ error: 'Key não encontrada' });
  res.json(r.rows[0]);
});

app.post('/api/licenses/:key/unbind', requireAdmin, async (req, res) => {
  const r = await pool.query('UPDATE licenses SET hwid=NULL WHERE key=$1 RETURNING key,hwid', [req.params.key]);
  if (!r.rowCount) return res.status(404).json({ error: 'Key não encontrada' });
  res.json(r.rows[0]);
});

app.post('/api/licenses/:key/extend', requireAdmin, async (req, res) => {
  const days = Math.max(1, Math.min(3650, Number(req.body?.days || 7)));
  const r = await pool.query("UPDATE licenses SET expires_at = GREATEST(expires_at,NOW()) + ($2 || ' days')::interval, status='active' WHERE key=$1 RETURNING key,expires_at,status", [req.params.key, days]);
  if (!r.rowCount) return res.status(404).json({ error: 'Key não encontrada' });
  res.json(r.rows[0]);
});

app.get('/api/orders', requireAdmin, async (req, res) => {
  const r = await pool.query('SELECT id,external_id,charge_id,discord_user_id,customer_name,customer_email,product_name,amount,days,status,license_key,paid_at,created_at FROM orders ORDER BY created_at DESC LIMIT 200');
  res.json(r.rows);
});

app.post('/api/checkout', requireAdmin, async (req, res) => {
  try {
    const result = await createRevantPixOrder({
      discordUserId: req.body?.discord_user_id,
      customerName: req.body?.customer_name,
      customerEmail: req.body?.customer_email,
      amount: req.body?.amount ?? OFFER_PRICE,
      days: req.body?.days ?? OFFER_DAYS,
      productId: req.body?.product_id ?? null,
      productName: req.body?.product_name ?? OFFER_NAME
    });
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/bot/checkout', requireBot, async (req, res) => {
  try {
    const product = await pool.query('SELECT * FROM products WHERE id=$1 AND active=TRUE LIMIT 1', [req.body?.product_id]);
    if (!product.rowCount) return res.status(404).json({ error: 'Produto não encontrado' });
    const p = product.rows[0];
    const result = await createRevantPixOrder({
      discordUserId: req.body?.discord_user_id,
      customerName: req.body?.customer_name,
      customerEmail: req.body?.customer_email,
      amount: p.price,
      days: OFFER_DAYS,
      productId: p.id,
      productName: p.name
    });
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, revant_configured: true, discord_configured: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// Discord bot
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const commands = [
  new SlashCommandBuilder().setName('config-verificacao').setDescription('Publica o painel de verificação.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('produtos').setDescription('Lista os produtos ativos.'),
  new SlashCommandBuilder()
    .setName('produto-criar').setDescription('Cria um produto.')
    .addStringOption(o => o.setName('nome').setDescription('Nome').setRequired(true))
    .addNumberOption(o => o.setName('preco').setDescription('Preço em reais').setRequired(true))
    .addStringOption(o => o.setName('descricao').setDescription('Descrição').setRequired(true))
    .addStringOption(o => o.setName('download').setDescription('Link de download'))
    .addStringOption(o => o.setName('tutorial').setDescription('Link do tutorial')),
  new SlashCommandBuilder().setName('comprar').setDescription('Gera um PIX para comprar o JAGUAR.').addIntegerOption(o => o.setName('produto').setDescription('ID do produto').setRequired(true))
].map(c => c.toJSON());

function isDiscordAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || interaction.member?.roles?.cache?.has(process.env.ADMIN_ROLE_ID);
}

client.once(Events.ClientReady, async c => {
  console.log(`Bot conectado como ${c.user.tag}`);
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
    await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID), { body: commands });
    console.log('Comandos Discord registrados.');
  } catch (e) {
    console.error('Falha ao registrar comandos Discord:', e.message);
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'config-verificacao') {
        if (!isDiscordAdmin(interaction)) return interaction.reply({ content: 'Sem permissão.', ephemeral: true });
        const embed = new EmbedBuilder().setTitle('🔐 Verificação').setDescription('Clique no botão abaixo para receber acesso.').setColor(0x5865F2);
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('verify').setLabel('Verificar').setEmoji('🔐').setStyle(ButtonStyle.Primary));
        await interaction.channel.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: 'Painel publicado.', ephemeral: true });
      }

      if (interaction.commandName === 'produto-criar') {
        if (!isDiscordAdmin(interaction)) return interaction.reply({ content: 'Sem permissão.', ephemeral: true });
        const name = interaction.options.getString('nome');
        const price = interaction.options.getNumber('preco');
        const description = interaction.options.getString('descricao');
        const download = interaction.options.getString('download') || '';
        const tutorial = interaction.options.getString('tutorial') || '';
        const r = await pool.query('INSERT INTO products(name,price,description,download_url,tutorial_url) VALUES($1,$2,$3,$4,$5) RETURNING id', [name,price,description,download,tutorial]);
        return interaction.reply(`✅ Produto criado com ID **${r.rows[0].id}**.`);
      }

      if (interaction.commandName === 'produtos') {
        const r = await pool.query('SELECT id,name,price,description FROM products WHERE active=TRUE ORDER BY id DESC');
        if (!r.rowCount) return interaction.reply('Nenhum produto cadastrado.');
        return interaction.reply(r.rows.map(p => `**${p.id} — ${p.name}** — R$ ${Number(p.price).toFixed(2)}\n${p.description}`).join('\n\n').slice(0, 1900));
      }

      if (interaction.commandName === 'comprar') {
        const productId = interaction.options.getInteger('produto');
        const r = await pool.query('SELECT * FROM products WHERE id=$1 AND active=TRUE LIMIT 1', [productId]);
        if (!r.rowCount) return interaction.reply({ content: 'Produto não encontrado.', ephemeral: true });
        const p = r.rows[0];
        await interaction.deferReply({ ephemeral: true });
        const charge = await createRevantPixOrder({
          discordUserId: interaction.user.id,
          customerName: interaction.user.globalName || interaction.user.username,
          amount: Number(p.price),
          days: OFFER_DAYS,
          productId: p.id,
          productName: p.name
        });
        const pix = charge.pix || {};
        const embed = new EmbedBuilder()
          .setTitle('💳 Pagamento PIX')
          .setDescription(`**Produto:** ${p.name}\n**Valor:** R$ ${Number(p.price).toFixed(2)}\n\n**Copia e cola:**\n\`\`\`${pix.qr_code || 'QR Code não retornado'}\`\`\`\n\nApós a confirmação, sua licença será enviada por DM.`)
          .setColor(0x2ECC71);
        return interaction.editReply({ embeds: [embed] });
      }
    }

    if (interaction.isButton() && interaction.customId === 'verify') {
      const roleId = process.env.VERIFIED_ROLE_ID || process.env.DISCORD_ROLE_ID;
      const member = await interaction.guild.members.fetch(interaction.user.id);
      await member.roles.add(roleId);
      return interaction.reply({ content: '✅ Você foi verificado.', ephemeral: true });
    }
  } catch (error) {
    console.error('[Discord]', error);
    if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: '❌ Ocorreu um erro.', ephemeral: true }).catch(() => {});
    else if (interaction.deferred) await interaction.editReply('❌ Ocorreu um erro.').catch(() => {});
  }
});

await ensureSchema();
app.listen(PORT, () => console.log(`JAGUAR PANEL + BOT na porta ${PORT}`));
client.login(process.env.DISCORD_BOT_TOKEN);
