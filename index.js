const { Client, LocalAuth } = require('@adiwajshing/baileys');
const qrcode = require('qrcode-terminal');

console.log("🚀 YeetBot FRESH — No GitHub. No Yarn. No Errors.");

const client = new Client({
  auth: new LocalAuth({ dataPath: './sessions' }),
  printQRInTerminal: true,
});

client.ev.on('qr', qr => {
  qrcode.generate(qr, { small: true });
  console.log('\n📱 SCAN THIS QR WITH WHATSAPP → Settings > Linked Devices\n');
});

client.ev.on('connection.update', update => {
  const { connection } = update;
  if (connection === 'open') {
    console.log('✅ YeetBot is ONLINE. Say “yeet hello” in any chat!');
  }
});

client.ev.on('messages.upsert', async ({ messages }) => {
  const msg = messages[0];
  if (!msg.message) return;

  const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
  const from = msg.key.remoteJid;

  if (body.toLowerCase().startsWith('yeet hello')) {
    await client.sendMessage(from, { text: "😏 Fresh start, huh? Not bad. Type ‘yeet help’ for more." });
  }

  if (body.toLowerCase().startsWith('yeet help')) {
    await client.sendMessage(from, { text: "Commands: yeet hello | Full features coming after success!" });
  }
});

client.initialize();
