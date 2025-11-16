const { Client, LocalAuth } = require('@adiwajshing/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const path = require('path');
const config = require('./config');
const db = require('./lib/utils').initDB();

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
    console.log(`✅ ${config.BOT_NAME} is ONLINE and ready to cause trouble.`);
  }
});

// Load all commands
const commandFiles = fs.readdirSync('./commands').filter(f => f.endsWith('.js'));
const commands = {};
for (const file of commandFiles) {
  const cmd = require(`./commands/${file}`);
  commands[cmd.name] = cmd;
}

// Handle incoming messages
client.ev.on('messages.upsert', async ({ messages }) => {
  const msg = messages[0];
  if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

  const from = msg.key.remoteJid;
  const sender = msg.key.participant || from;
  const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
  const isGroup = from.endsWith('@g.us');

  // Detect View Once & auto-save to OWNER DM
  if (msg.message?.viewOnceMessageV2) {
    console.log("👀 Caught a View Once! Saving to owner's DM...");
    const media = await client.downloadMediaMessage(msg);
    await client.sendMessage(config.OWNER_NUMBER, { image: media, caption: `🤫 Stole this from ${from}. You’re welcome.` });
    return;
  }

  // If message starts with "yeet"
  if (body.toLowerCase().startsWith('yeet ')) {
    const args = body.slice(5).trim().split(' ');
    const cmdName = args.shift().toLowerCase();
    const command = commands[cmdName];

    if (!command) {
      await client.sendMessage(from, { text: "🙄 Unknown command. Type ‘yeet help’ unless you enjoy disappointment." });
      return;
    }

    try {
      await command.execute(client, msg, args, { from, sender, isGroup, db });
    } catch (e) {
      console.error(e);
      await client.sendMessage(from, { text: "💥 Oops. I tripped. Blame my creator." });
    }
  }
});

client.initialize();