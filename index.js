const { Client, LocalAuth } = require('@adiwajshing/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const path = require('path');

// Create folders if missing
['./temp', './sessions', './database'].forEach(dir => fs.ensureDirSync(dir));

console.log("🚀 YeetBot is booting up... Try not to embarrass me.");

const client = new Client({
  auth: new LocalAuth({ dataPath: './sessions' }),
  printQRInTerminal: true,
});

client.ev.on('qr', qr => {
  qrcode.generate(qr, { small: true });
  console.log('📱 Scan this QR code with WhatsApp (Settings > Linked Devices)');
});

client.ev.on('creds.update', () => console.log("🔐 Session updated."));

client.ev.on('connection.update', update => {
  const { connection, lastDisconnect } = update;
  if (connection === 'close') {
    console.log("🔌 Disconnected. Reconnecting...");
    setTimeout(() => client.initialize(), 2000);
  } else if (connection === 'open') {
    console.log(`✅ YeetBot is ONLINE and ready to cause trouble.`);
  }
});

// Mock command system for now
client.ev.on('messages.upsert', async ({ messages }) => {
  const msg = messages[0];
  if (!msg.message) return;

  const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
  const from = msg.key.remoteJid;

  if (body.toLowerCase().startsWith('yeet help')) {
    await client.sendMessage(from, { text: "😏 I’m YeetBot. Type ‘yeet download <link>’ or ‘yeet sticker’ after replying to media. More features coming soon!" });
  }

  if (body.toLowerCase().startsWith('yeet hello')) {
    await client.sendMessage(from, { text: "Well well well… look who decided to say hi. Took you long enough." });
  }
});

client.initialize();
