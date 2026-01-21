// index.js - clean Yeetbot entry with anti-delete support

require('dotenv').config();

const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const {
  handleCommand,
  cacheMessage,
  handleMessageUpdate,
} = require('./commands');

async function startYeetbot() {
  console.log('=== YEETBOT STARTING (CLEAN MODE) ===');

  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();
  console.log('Using Baileys version:', version);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'info' }),
    // we handle QR manually below
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, qr } = update;

    if (qr) {
      console.log(
        '\nScan this QR code with WhatsApp (Settings → Linked devices → Link a device):\n'
      );
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      console.log('✅ Yeetbot connected to WhatsApp!');
    } else if (connection === 'close') {
      console.log('❌ Connection closed. Restarting...');
      startYeetbot().catch((err) => console.error('Restart error:', err));
    } else if (connection) {
      console.log('Connection state:', connection);
    }
  });

  // Main message handler
sock.ev.on('messages.upsert', async (m) => {
  const msg = m.messages[0];
  if (!msg || !msg.message) return;

  // Cache every incoming message for anti-delete, etc.
  cacheMessage(msg);

  const from = msg.key.remoteJid;

  const rawText =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    msg.message.videoMessage?.caption ||
    '';

  const fromMe = !!msg.key.fromMe;

  console.log('Received message from', from, 'fromMe:', fromMe, ':', rawText);

  try {
    await handleCommand(sock, msg, from, rawText);
  } catch (err) {
    console.error('Error in handleCommand:', err);
    try {
      await sock.sendMessage(
        from,
        { text: 'An internal error occurred in Yeetbot.' },
        { quoted: msg }
      );
    } catch {
      // ignore secondary errors
    }
  }
});

  // Updates: used for delete (revoke) detection
sock.ev.on('messages.update', async (updates) => {
  console.log('messages.update raw:', JSON.stringify(updates, null, 2));

  for (const upd of updates) {
    await handleMessageUpdate(sock, upd);
  }
});
}

startYeetbot().catch((err) => {
  console.error('Fatal error starting Yeetbot:', err);
});