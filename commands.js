// commands.js - Yeetbot command handler
// Features:
// - Owner/sudo permission system
// - TikTok download (video + photos + audio) via TikWM
// - Generic downloads via yt-dlp (Instagram, YouTube, etc.)
// - .vv         : save view-once / status media or text (reply to it)
// - .tostatus   : send replied media/text as your own status
// - .getpp      : get profile picture of replied user
// - .dont       : change Yeetbot font (normal / wide)
// - .warn       : warn user in group (5 warns -> kick)
// - .kick       : kick replied/mentioned user in group
// - .lockgroup  : lock group (only admins can send)
// - .acceptall  : accept all pending join requests
// - .addsudo / .delsudo / .listsudo : manage sudo users (owner only)

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const mime = require('mime-types');
const axios = require('axios');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

const PREFIX = process.env.PREFIX || '.';
const YTDLP_PATH = path.join(__dirname, 'yt-dlp.exe');
const DATA_FILE = path.join(__dirname, 'data', 'yeetbot-data.json');
const FFMPEG_PATH = path.join(__dirname, 'ffmpeg.exe'); // (if not already present, keep this line)

// OWNER config:
// - If OWNER_JID is set in .env, use it directly (e.g. 1260...@lid)
// - Else, if OWNER_NUMBER is set, build <number>@s.whatsapp.net
const RAW_OWNER_JID = (process.env.OWNER_JID || '').trim();
const OWNER_NUMBER = (process.env.OWNER_NUMBER || '').replace(/[^0-9]/g, '');
let OWNER_JID = null;

if (RAW_OWNER_JID) {
  OWNER_JID = RAW_OWNER_JID;
} else if (OWNER_NUMBER) {
  OWNER_JID = OWNER_NUMBER + '@s.whatsapp.net';
}

// --------- Simple JSON "database" ---------

let db = {
  sudo: [],
  warns: {},
  font: 'normal',
  settings: {
    antiDeleteMessage: false,
    antiDeleteStatus: false,   // reserved for later
    autoViewStatus: false,     // reserved for later
    autoReactStatus: false,    // reserved for later
  },
};

function loadDb() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);

      db.sudo = parsed.sudo || [];
      db.warns = parsed.warns || {};
      db.font = parsed.font || 'normal';
      db.settings = {
        ...db.settings,
        ...(parsed.settings || {}),
      };
    }
  } catch (e) {
    console.error('Failed to load DB file:', e);
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Failed to save DB file:', e);
  }
}

loadDb();

// --------- Font handling ---------

// Simple "wide" font using fullwidth Unicode characters
const normalChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const wideChars =
  'ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺ' +
  'ａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ' +
  '０１２３４５６７８９';

// Monospace style (𝙰𝚄𝚃𝙷𝙾𝚁 etc.)
const monoChars =
  '𝙰𝙱𝙲𝙳𝙴𝙵𝙶𝙷𝙸𝙹𝙺𝙻𝙼𝙽𝙾𝙿𝚀𝚁𝚂𝚃𝚄𝚅𝚆𝚇𝚈𝚉' +
  '𝚊𝚋𝚌𝚍𝚎𝚏𝚐𝚑𝚒𝚓𝚔𝚕𝚖𝚗𝚘𝚙𝚚𝚛𝚜𝚝𝚞𝚟𝚠𝚡𝚢𝚣' +
  '𝟶𝟷𝟸𝟹𝟺𝟻𝟼𝟽𝟾𝟿';

// "Serif" / Times-like bold style
const serifChars =
  '𝐀𝐁𝐂𝐃𝐄𝐅𝐆𝐇𝐈𝐉𝐊𝐋𝐌𝐍𝐎𝐏𝐐𝐑𝐒𝐓𝐔𝐕𝐖𝐗𝐘𝐙' +
  '𝐚𝐛𝐜𝐝𝐞𝐟𝐠𝐡𝐢𝐣𝐤𝐥𝐦𝐧𝐨𝐩𝐪𝐫𝐬𝐭𝐮𝐯𝐰𝐱𝐲𝐳' +
  '𝟎𝟏𝟐𝟑𝟒𝟓𝟔𝟕𝟖𝟗';

function applyFont(text) {
  let map = null;

  if (db.font === 'wide') {
    map = wideChars;
  } else if (db.font === 'mono') {
    map = monoChars;
  } else if (db.font === 'serif') {
    map = serifChars;
  }

  if (!map) return text; // 'normal' or unknown => no styling

  let out = '';
  for (const ch of text) {
    const idx = normalChars.indexOf(ch);
    if (idx !== -1) out += map[idx];
    else out += ch;
  }
  return out;
}

// Convenience: wrap outgoing text
function fmt(text) {
  return applyFont(text);
}

// --------- Helpers ---------

function getTargetFromContext(msg) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  if (!ctx) return null;
  if (ctx.participant) return ctx.participant;
  if (ctx.mentionedJid && ctx.mentionedJid.length > 0) return ctx.mentionedJid[0];
  return null;
}

// Find quotedMessage regardless of which message type holds contextInfo
function getQuotedMessage(msg) {
  const m = msg.message || {};
  const candidates = [
    m.extendedTextMessage,
    m.imageMessage,
    m.videoMessage,
    m.documentMessage,
    m.audioMessage,
    m.stickerMessage,
  ];

  for (const c of candidates) {
    if (c && c.contextInfo && c.contextInfo.quotedMessage) {
      return c.contextInfo.quotedMessage;
    }
  }
  return null;
}

async function isGroupAdmin(sock, groupJid, userJid) {
  try {
    const meta = await sock.groupMetadata(groupJid);
    const adminIds = meta.participants
      .filter((p) => p.admin)
      .map((p) => p.id);
    return adminIds.includes(userJid);
  } catch (e) {
    console.error('Error checking group admin status:', e);
    return false;
  }
}

// --------- yt-dlp generic download (non-TikTok) ---------

function downloadWithYtdlp(url, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const outDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    const outputTemplate = path.join(outDir, '%(id)s.%(ext)s');

    const cmd = YTDLP_PATH;
    const args = [
      url,
      '-o',
      outputTemplate,
      '--no-playlist',
      '--print',
      'after_move:filepath',
      ...extraArgs,
    ];

    console.log('Running:', cmd, args.join(' '));

    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) {
        console.error('yt-dlp error:', err);
        if (stderr) console.error('stderr:', stderr.toString());
        return reject(err);
      }

      const lines = stdout
        .toString()
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      if (!lines.length) {
        return reject(new Error('yt-dlp returned no filename'));
      }

      const filepath = lines[lines.length - 1];
      console.log('yt-dlp downloaded file:', filepath);
      resolve(filepath);
    });
  });
}

async function sendDownloadedFile(sock, from, msg, filepath, url, asDocument = false) {
  const buffer = fs.readFileSync(filepath);
  const ext = path.extname(filepath).toLowerCase();
  const mimetype = mime.lookup(ext) || 'application/octet-stream';
  const caption = fmt(`Downloaded from ${url}`);

  try {
    if (!asDocument && mimetype.startsWith('video/')) {
      await sock.sendMessage(
        from,
        { video: buffer, mimetype, caption },
        { quoted: msg }
      );
    } else if (!asDocument && mimetype.startsWith('image/')) {
      await sock.sendMessage(
        from,
        { image: buffer, mimetype, caption },
        { quoted: msg }
      );
    } else if (!asDocument && mimetype.startsWith('audio/')) {
      await sock.sendMessage(
        from,
        { audio: buffer, mimetype, caption },
        { quoted: msg }
      );
    } else {
      await sock.sendMessage(
        from,
        {
          document: buffer,
          mimetype,
          fileName: path.basename(filepath),
          caption,
        },
        { quoted: msg }
      );
    }
  } finally {
    fs.unlink(filepath, () => {});
  }
}

// --------- TikTok via TikWM API (video + photos + audio) ---------

async function handleTikTokCommand(sock, msg, from, cmd, args) {
  const url = args[0];
  if (!url) {
    await sock.sendMessage(
      from,
      { text: fmt(`Please provide a TikTok URL, e.g. ${PREFIX}${cmd} https://www.tiktok.com/...`) },
      { quoted: msg }
    );
    return;
  }

  try {
    console.log('Using TikWM API for TikTok:', url);

    const apiUrl = 'https://tikwm.com/api/';
    const res = await axios.post(
      apiUrl,
      { url, hd: 1 },
      {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
        timeout: 15000,
      }
    );

    const body = res.data;
    if (!body || body.code !== 0 || !body.data) {
      console.error('TikWM bad response:', body);
      throw new Error('TikTok API returned an error.');
    }

    const info = body.data;
    const title = info.title || 'TikTok';
    console.log('TikTok info:', {
      type: info.type,
      images: info.images ? info.images.length : 0,
    });

    if (cmd === 'tiktokaudio') {
      const audioUrl =
        info.music ||
        (info.music_info && (info.music_info.play || info.music_info.original)) ||
        info.play;
      if (!audioUrl) {
        throw new Error('No audio URL found for this TikTok.');
      }

      const audioRes = await axios.get(audioUrl, {
        responseType: 'arraybuffer',
        timeout: 20000,
      });
      const audioBuffer = Buffer.from(audioRes.data);

      await sock.sendMessage(
        from,
        {
          audio: audioBuffer,
          mimetype: 'audio/mpeg',
          caption: fmt(title),
        },
        { quoted: msg }
      );
      return;
    }

    // Image post / carousel
    if (info.images && info.images.length > 0) {
      const total = info.images.length;
      for (let i = 0; i < total; i++) {
        const imgUrl = info.images[i];
        const imgRes = await axios.get(imgUrl, {
          responseType: 'arraybuffer',
          timeout: 20000,
        });
        const imgBuffer = Buffer.from(imgRes.data);

        const cap = fmt(`${title} (${i + 1}/${total})`);
        await sock.sendMessage(
          from,
          {
            image: imgBuffer,
            mimetype: 'image/jpeg',
            caption: cap,
          },
          { quoted: msg }
        );
      }
      return;
    }

    // Video
    const videoUrl = info.hdplay || info.play;
    if (!videoUrl) {
      throw new Error('No video URL found for this TikTok.');
    }

    const videoRes = await axios.get(videoUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });
    const videoBuffer = Buffer.from(videoRes.data);

    await sock.sendMessage(
      from,
      {
        video: videoBuffer,
        mimetype: 'video/mp4',
        caption: fmt(title),
      },
      { quoted: msg }
    );
  } catch (err) {
    console.error('TikTok command error:', err);
    await sock.sendMessage(
      from,
      { text: fmt(`Failed to download from TikTok.\nError: ${err.message}`) },
      { quoted: msg }
    );
  }
}

// --------- Generic download handler (non-TikTok) ---------

async function handleDownloadCommand(sock, msg, from, cmd, args) {
  const url = args[0];
  if (!url) {
    await sock.sendMessage(
      from,
      { text: fmt(`Please provide a URL, e.g. ${PREFIX}${cmd} https://...`) },
      { quoted: msg }
    );
    return;
  }

  try {
    if (cmd === 'ytmp3' || cmd === 'song') {
      const filepath = await downloadWithYtdlp(url, [
        '-f',
        'bestaudio/best',
        '--extract-audio',
        '--audio-format',
        'mp3',
      ]);
      await sendDownloadedFile(sock, from, msg, filepath, url);
      return;
    }

    if (cmd === 'ytmp3doc') {
      const filepath = await downloadWithYtdlp(url, [
        '-f',
        'bestaudio/best',
        '--extract-audio',
        '--audio-format',
        'mp3',
      ]);
      await sendDownloadedFile(sock, from, msg, filepath, url, true);
      return;
    }

    // Generic best-quality video/image
    const filepath = await downloadWithYtdlp(url, ['-f', 'bv*+ba/b']);
    await sendDownloadedFile(sock, from, msg, filepath, url);
  } catch (err) {
    console.error(`Download command error (${cmd}):`, err);
    await sock.sendMessage(
      from,
      { text: fmt(`Failed to download media from that URL.\nError: ${err.message}`) },
      { quoted: msg }
    );
  }
}

// --------- .vv (save view-once / status) & .tostatus & .getpp ---------

// --------- .vv (save view-once / status / forwarded media) ---------

async function handleVv(sock, msg, from) {
  try {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    const quoted = ctx?.quotedMessage;

    if (!ctx || !quoted || Object.keys(quoted).length === 0) {
      await sock.sendMessage(
        from,
        {
          text: fmt(
            'Reply to a view-once message or forwarded status/media with .vv.'
          ),
        },
        { quoted: msg }
      );
      return;
    }

    // Unwrap view-once / ephemeral wrappers
    let inner = quoted;
    if (inner.viewOnceMessageV2) {
      inner = inner.viewOnceMessageV2.message || {};
    } else if (inner.viewOnceMessageV2Extension) {
      inner = inner.viewOnceMessageV2Extension.message || {};
    }

    const mediaType =
      (inner.imageMessage && 'image') ||
      (inner.videoMessage && 'video') ||
      (inner.audioMessage && 'audio') ||
      (inner.documentMessage && 'document');

    // --- Media case ---
    if (mediaType) {
      try {
        const tempMsg = { message: inner };
        const buffer = await downloadMediaMessage(tempMsg, 'buffer', {});

        // Caption / attached text
        const caption =
          inner.imageMessage?.caption ||
          inner.videoMessage?.caption ||
          inner.documentMessage?.caption ||
          inner.audioMessage?.caption ||
          inner.conversation ||
          inner.extendedTextMessage?.text ||
          '';

        const cap = caption ? fmt(caption) : undefined;

        if (mediaType === 'image') {
          await sock.sendMessage(
            from,
            { image: buffer, mimetype: 'image/jpeg', caption: cap },
            { quoted: msg }
          );
        } else if (mediaType === 'video') {
          await sock.sendMessage(
            from,
            { video: buffer, mimetype: 'video/mp4', caption: cap },
            { quoted: msg }
          );
        } else if (mediaType === 'audio') {
          await sock.sendMessage(
            from,
            {
              audio: buffer,
              mimetype: 'audio/ogg; codecs=opus',
              caption: cap,
            },
            { quoted: msg }
          );
        } else if (mediaType === 'document') {
          await sock.sendMessage(
            from,
            {
              document: buffer,
              fileName: 'file',
              caption: cap,
            },
            { quoted: msg }
          );
        }
        return;
      } catch (e) {
        console.error('vv media download error:', e);
        await sock.sendMessage(
          from,
          {
            text: fmt(
              'Could not download that media. Try forwarding the status/message to Yeetbot, then reply with .vv.'
            ),
          },
          { quoted: msg }
        );
        return;
      }
    }

    // --- Text-only case ---
    const text =
      inner.conversation ||
      inner.extendedTextMessage?.text ||
      quoted.conversation ||
      quoted.extendedTextMessage?.text;

    if (text) {
      await sock.sendMessage(
        from,
        { text: fmt(text) },
        { quoted: msg }
      );
      return;
    }

    await sock.sendMessage(
      from,
      { text: fmt('Unsupported message type for .vv') },
      { quoted: msg }
    );
  } catch (e) {
    console.error('vv error:', e);
    await sock.sendMessage(
      from,
      { text: fmt('An error occurred while processing .vv.') },
      { quoted: msg }
    );
  }
}

// .swipe - save replied status/view-once to owner's personal DM
async function handleSwipe(sock, msg, from) {
  // Prefer explicit OWNER_JID; fall back to the logged-in account's JID
  const targetJid = OWNER_JID || (sock.user && sock.user.id);
  if (!targetJid) {
    await sock.sendMessage(
      from,
      { text: fmt('Owner JID is not available, cannot use .swipe.') },
      { quoted: msg }
    );
    return;
  }

  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctx?.quotedMessage;
  if (!quoted) {
    await sock.sendMessage(
      from,
      { text: fmt('Reply to a status or view-once message with .swipe.') },
      { quoted: msg }
    );
    return;
  }

  let inner = quoted;
  if (inner.viewOnceMessageV2) {
    inner = inner.viewOnceMessageV2.message || {};
  } else if (inner.viewOnceMessageV2Extension) {
    inner = inner.viewOnceMessageV2Extension.message || {};
  }

  const originJid = ctx?.participant || ctx?.remoteJid || from;
  const originId = originJid ? originJid.split('@')[0] : 'unknown';
  const baseCaption = fmt(`Saved status from @${originId}`);

  const mediaType =
    (inner.imageMessage && 'image') ||
    (inner.videoMessage && 'video') ||
    (inner.audioMessage && 'audio') ||
    (inner.documentMessage && 'document');

  try {
    if (mediaType) {
      const tempMsg = { message: inner };
      const buffer = await downloadMediaMessage(tempMsg, 'buffer', {});

      // original caption/text if present
      const originalCaption =
        inner.imageMessage?.caption ||
        inner.videoMessage?.caption ||
        inner.documentMessage?.caption ||
        inner.audioMessage?.caption ||
        inner.conversation ||
        inner.extendedTextMessage?.text ||
        '';

      const cap = originalCaption
        ? `${baseCaption}\n\n${fmt(originalCaption)}`
        : baseCaption;

      if (mediaType === 'image') {
        await sock.sendMessage(targetJid, {
          image: buffer,
          mimetype: 'image/jpeg',
          caption: cap,
          mentions: originJid ? [originJid] : [],
        });
      } else if (mediaType === 'video') {
        await sock.sendMessage(targetJid, {
          video: buffer,
          mimetype: 'video/mp4',
          caption: cap,
          mentions: originJid ? [originJid] : [],
        });
      } else if (mediaType === 'audio') {
        const isPtt =
          inner.audioMessage && inner.audioMessage.ptt;
        const label = originalCaption
          ? fmt(originalCaption)
          : fmt(isPtt ? '[Voice note]' : '[Audio message]');

        // 1) Card text
        await sock.sendMessage(targetJid, {
          text: `${headerText}\n\n${label}`,
          mentions,
        });

        // 2) Actual audio
        await sock.sendMessage(targetJid, {
          audio: buffer,
          mimetype: inner.audioMessage?.mimetype || 'audio/ogg; codecs=opus',
          ptt: !!isPtt,
        });
      } else if (mediaType === 'document') {
        await sock.sendMessage(targetJid, {
          document: buffer,
          fileName: 'file',
          caption: cap,
          mentions: originJid ? [originJid] : [],
        });
      }
      return;
    }

    // Text status / message
    const text =
      inner.conversation ||
      inner.extendedTextMessage?.text ||
      quoted.conversation ||
      quoted.extendedTextMessage?.text;

    if (text) {
      await sock.sendMessage(targetJid, {
        text: `${baseCaption}\n\n${fmt(text)}`,
        mentions: originJid ? [originJid] : [],
      });
      return;
    }

    await sock.sendMessage(
      from,
      { text: fmt('Unsupported message type for .swipe') },
      { quoted: msg }
    );
  } catch (e) {
    console.error('swipe error:', e);
    await sock.sendMessage(
      from,
      { text: fmt('Failed to save status with .swipe.') },
      { quoted: msg }
    );
  }
}

async function handleToStatus(sock, msg, from) {
  const quoted = getQuotedMessage(msg);
  if (!quoted) {
    await sock.sendMessage(
      from,
      { text: fmt('Reply to a message or status to send it as your status.') },
      { quoted: msg }
    );
    return;
  }

  let inner = quoted;
  if (inner.viewOnceMessageV2) {
    inner = inner.viewOnceMessageV2.message || {};
  } else if (inner.viewOnceMessageV2Extension) {
    inner = inner.viewOnceMessageV2Extension.message || {};
  }

  const statusJid = 'status@broadcast';

  const mediaType =
    (inner.imageMessage && 'image') ||
    (inner.videoMessage && 'video') ||
    (inner.audioMessage && 'audio') ||
    (inner.documentMessage && 'document');

  if (mediaType) {
    const tempMsg = { message: inner };
    const buffer = await downloadMediaMessage(tempMsg, 'buffer', {});
    const caption =
      inner.imageMessage?.caption ||
      inner.videoMessage?.caption ||
      '';

    if (mediaType === 'image') {
      await sock.sendMessage(statusJid, {
        image: buffer,
        mimetype: 'image/jpeg',
        caption: fmt(caption),
      });
    } else if (mediaType === 'video') {
      await sock.sendMessage(statusJid, {
        video: buffer,
        mimetype: 'video/mp4',
        caption: fmt(caption),
      });
    } else if (mediaType === 'audio') {
      await sock.sendMessage(statusJid, {
        audio: buffer,
        mimetype: 'audio/ogg; codecs=opus',
      });
    } else if (mediaType === 'document') {
      await sock.sendMessage(statusJid, {
        document: buffer,
        fileName: 'file',
      });
    }

    await sock.sendMessage(
      from,
      { text: fmt('Status updated ✅') },
      { quoted: msg }
    );
    return;
  }

  const text =
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    quoted.conversation ||
    quoted.extendedTextMessage?.text;

  if (text) {
    await sock.sendMessage(statusJid, { text: fmt(text) });
    await sock.sendMessage(
      from,
      { text: fmt('Text status updated ✅') },
      { quoted: msg }
    );
    return;
  }

  await sock.sendMessage(
    from,
    { text: fmt('Unsupported message type for .tostatus') },
    { quoted: msg }
  );
}

async function handleGetPp(sock, msg, from) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  const target = ctx?.participant || (ctx?.mentionedJid && ctx.mentionedJid[0]);
  if (!target) {
    await sock.sendMessage(
      from,
      { text: fmt('Reply to a user (or mention) to get their profile picture.') },
      { quoted: msg }
    );
    return;
  }

  try {
    const url = await sock.profilePictureUrl(target, 'image').catch(() => null);
    if (!url) {
      await sock.sendMessage(
        from,
        { text: fmt('No profile picture found for that user.') },
        { quoted: msg }
      );
      return;
    }

    const res = await axios.get(url, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(res.data);

    await sock.sendMessage(
      from,
      {
        image: buffer,
        mimetype: 'image/jpeg',
        caption: fmt(`Profile picture of ${target}`),
      },
      { quoted: msg }
    );
  } catch (e) {
    console.error('getpp error:', e);
    await sock.sendMessage(
      from,
      { text: fmt('Failed to get profile picture.') },
      { quoted: msg }
    );
  }
}

// --------- .toimage (sticker -> image) & .tovideo (sticker -> video) ---------

async function handleToImage(sock, msg, from) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctx?.quotedMessage;
  if (!quoted || !quoted.stickerMessage) {
    await sock.sendMessage(
      from,
      { text: fmt('Reply to a sticker with .toimage.') },
      { quoted: msg }
    );
    return;
  }

  if (!fs.existsSync(FFMPEG_PATH)) {
    await sock.sendMessage(
      from,
      { text: fmt('ffmpeg.exe not found in Yeetbot folder.') },
      { quoted: msg }
    );
    return;
  }

  try {
    const tmpDir = path.join(__dirname, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const id = Date.now() + '-' + Math.floor(Math.random() * 1000);
    const webpPath = path.join(tmpDir, `sticker-${id}.webp`);
    const outPath = path.join(tmpDir, `sticker-${id}.jpg`);

    const tempMsg = { message: { stickerMessage: quoted.stickerMessage } };
    const buffer = await downloadMediaMessage(tempMsg, 'buffer', {});
    fs.writeFileSync(webpPath, buffer);

    await new Promise((resolve, reject) => {
      execFile(
        FFMPEG_PATH,
        ['-y', '-i', webpPath, outPath],
        (err) => (err ? reject(err) : resolve())
      );
    });

    const img = fs.readFileSync(outPath);
    await sock.sendMessage(
      from,
      {
        image: img,
        mimetype: 'image/jpeg',
        caption: fmt('Converted from sticker.'),
      },
      { quoted: msg }
    );

    fs.unlink(webpPath, () => {});
    fs.unlink(outPath, () => {});
  } catch (e) {
    console.error('toimage error:', e);
    await sock.sendMessage(
      from,
      { text: fmt('Failed to convert sticker to image.') },
      { quoted: msg }
    );
  }
}

async function handleToVideo(sock, msg, from) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctx?.quotedMessage;
  if (!quoted || !quoted.stickerMessage) {
    await sock.sendMessage(
      from,
      { text: fmt('Reply to a sticker with .tovideo.') },
      { quoted: msg }
    );
    return;
  }

  if (!fs.existsSync(FFMPEG_PATH)) {
    await sock.sendMessage(
      from,
      { text: fmt('ffmpeg.exe not found in Yeetbot folder.') },
      { quoted: msg }
    );
    return;
  }

  try {
    const tmpDir = path.join(__dirname, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const id = Date.now() + '-' + Math.floor(Math.random() * 1000);
    const webpPath = path.join(tmpDir, `sticker-${id}.webp`);
    const outPath = path.join(tmpDir, `sticker-${id}.mp4`);

    const tempMsg = { message: { stickerMessage: quoted.stickerMessage } };
    const buffer = await downloadMediaMessage(tempMsg, 'buffer', {});
    fs.writeFileSync(webpPath, buffer);

    await new Promise((resolve, reject) => {
      execFile(
        FFMPEG_PATH,
        [
          '-y',
          '-i',
          webpPath,
          '-movflags',
          'faststart',
          '-pix_fmt',
          'yuv420p',
          outPath,
        ],
        (err) => (err ? reject(err) : resolve())
      );
    });

    const video = fs.readFileSync(outPath);
    await sock.sendMessage(
      from,
      {
        video,
        mimetype: 'video/mp4',
        caption: fmt('Converted from sticker.'),
      },
      { quoted: msg }
    );

    fs.unlink(webpPath, () => {});
    fs.unlink(outPath, () => {});
  } catch (e) {
    console.error('tovideo error:', e);
    await sock.sendMessage(
      from,
      { text: fmt('Failed to convert sticker to video.') },
      { quoted: msg }
    );
  }
}


// --------- .sticker (image/video/gif -> sticker) ---------

async function handleSticker(sock, msg, from) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  const quoted = ctx?.quotedMessage;

  if (!quoted) {
    await sock.sendMessage(
      from,
      { text: fmt('Reply to an image/video/GIF with .sticker.') },
      { quoted: msg }
    );
    return;
  }

  if (!fs.existsSync(FFMPEG_PATH)) {
    await sock.sendMessage(
      from,
      { text: fmt('ffmpeg.exe not found in Yeetbot folder.') },
      { quoted: msg }
    );
    return;
  }

  // Determine media type from quoted message
  let mediaMessage = null;
  if (quoted.imageMessage) {
    mediaMessage = { imageMessage: quoted.imageMessage };
  } else if (quoted.videoMessage) {
    mediaMessage = { videoMessage: quoted.videoMessage };
  } else if (quoted.documentMessage) {
    // some clients send GIFs or images as documents with mimetype
    const mimeType = quoted.documentMessage.mimetype || '';
    if (mimeType.startsWith('image/') || mimeType.startsWith('video/')) {
      mediaMessage = { documentMessage: quoted.documentMessage };
    }
  }

  if (!mediaMessage) {
    await sock.sendMessage(
      from,
      {
        text: fmt(
          'Unsupported media. Reply to an image, video, or GIF message with .sticker.'
        ),
      },
      { quoted: msg }
    );
    return;
  }

  try {
    const tmpDir = path.join(__dirname, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const id = Date.now() + '-' + Math.floor(Math.random() * 1000);
    const inPath = path.join(tmpDir, `sticker-src-${id}`);
    const outPath = path.join(tmpDir, `sticker-${id}.webp`);

    const tempMsg = { message: mediaMessage };
    const buffer = await downloadMediaMessage(tempMsg, 'buffer', {});
    fs.writeFileSync(inPath, buffer);

    // ffmpeg command to convert to WebP sticker
    // Scale to max 512x512, keep aspect ratio, max 15 fps, no audio
    const args = [
      '-y',
      '-i',
      inPath,
      '-vf',
      'scale=512:512:force_original_aspect_ratio=decrease,fps=15',
      '-loop',
      '0',
      '-an',
      outPath,
    ];

    await new Promise((resolve, reject) => {
      execFile(FFMPEG_PATH, args, (err) => (err ? reject(err) : resolve()));
    });

    const webp = fs.readFileSync(outPath);
    await sock.sendMessage(
      from,
      { sticker: webp },
      { quoted: msg }
    );

    fs.unlink(inPath, () => {});
    fs.unlink(outPath, () => {});
  } catch (e) {
    console.error('sticker error:', e);
    await sock.sendMessage(
      from,
      { text: fmt('Failed to create sticker.') },
      { quoted: msg }
    );
  }
}

// --------- Group commands: .warn, .kick, .lockgroup, .acceptall ---------

async function handleWarn(sock, msg, from, sender) {
  const isGroup = from.endsWith('@g.us');
  if (!isGroup) {
    await sock.sendMessage(
      from,
      { text: fmt('.warn can only be used in groups.') },
      { quoted: msg }
    );
    return;
  }

  const isAdmin = await isGroupAdmin(sock, from, sender);
  if (!isAdmin) {
    await sock.sendMessage(
      from,
      { text: fmt('You must be a group admin to use .warn.') },
      { quoted: msg }
    );
    return;
  }

  const target = getTargetFromContext(msg);
  if (!target) {
    await sock.sendMessage(
      from,
      { text: fmt('Reply to a user or mention them to warn.') },
      { quoted: msg }
    );
    return;
  }

  if (!db.warns[from]) db.warns[from] = {};
  const current = db.warns[from][target] || 0;
  const next = current + 1;
  db.warns[from][target] = next;
  saveDb();

  if (next >= 5) {
    try {
      await sock.groupParticipantsUpdate(from, [target], 'remove');
      db.warns[from][target] = 0;
      saveDb();
      await sock.sendMessage(
        from,
        {
          text: fmt(`@${target.split('@')[0]} has reached 5 warns and was kicked.`),
          mentions: [target],
        },
        { quoted: msg }
      );
    } catch (e) {
      console.error('Error kicking after warn:', e);
      await sock.sendMessage(
        from,
        {
          text: fmt(
            `@${target.split('@')[0]} has 5 warns but I could not kick (am I admin?).`
          ),
          mentions: [target],
        },
        { quoted: msg }
      );
    }
  } else {
    await sock.sendMessage(
      from,
      {
        text: fmt(
          `@${target.split('@')[0]} warned (${next}/5).`
        ),
        mentions: [target],
      },
      { quoted: msg }
    );
  }
}

// --------- .clearwarn / .unwarn (reset warns for a user) ---------

async function handleClearWarn(sock, msg, from, sender) {
  const isGroup = from.endsWith('@g.us');
  if (!isGroup) {
    await sock.sendMessage(
      from,
      { text: fmt('.clearwarn can only be used in groups.') },
      { quoted: msg }
    );
    return;
  }

  const isAdmin = await isGroupAdmin(sock, from, sender);
  if (!isAdmin) {
    await sock.sendMessage(
      from,
      { text: fmt('You must be a group admin to use .clearwarn.') },
      { quoted: msg }
    );
    return;
  }

  const target = getTargetFromContext(msg);
  if (!target) {
    await sock.sendMessage(
      from,
      {
        text: fmt(
          'Reply to a user or mention them with .clearwarn or .unwarn to reset their warns.'
        ),
      },
      { quoted: msg }
    );
    return;
  }

  if (!db.warns[from] || !db.warns[from][target]) {
    await sock.sendMessage(
      from,
      {
        text: fmt(
          `@${target.split('@')[0]} has no warns recorded in this group.`
        ),
        mentions: [target],
      },
      { quoted: msg }
    );
    return;
  }

  db.warns[from][target] = 0;
  saveDb();

  await sock.sendMessage(
    from,
    {
      text: fmt(
        `Warns for @${target.split('@')[0]} have been reset to 0 in this group.`
      ),
      mentions: [target],
    },
    { quoted: msg }
  );
}

async function handleKick(sock, msg, from, sender) {
  const isGroup = from.endsWith('@g.us');
  if (!isGroup) {
    await sock.sendMessage(
      from,
      { text: fmt('.kick can only be used in groups.') },
      { quoted: msg }
    );
    return;
  }

  const isAdmin = await isGroupAdmin(sock, from, sender);
  if (!isAdmin) {
    await sock.sendMessage(
      from,
      { text: fmt('You must be a group admin to use .kick.') },
      { quoted: msg }
    );
    return;
  }

  const target = getTargetFromContext(msg);
  if (!target) {
    await sock.sendMessage(
      from,
      { text: fmt('Reply to a user or mention them to kick.') },
      { quoted: msg }
    );
    return;
  }

  try {
    await sock.groupParticipantsUpdate(from, [target], 'remove');
    await sock.sendMessage(
      from,
      {
        text: fmt(`@${target.split('@')[0]} has been kicked.`),
        mentions: [target],
      },
      { quoted: msg }
    );
  } catch (e) {
    console.error('kick error:', e);
    await sock.sendMessage(
      from,
      { text: fmt('Failed to kick. Am I admin?') },
      { quoted: msg }
    );
  }
}

async function handleLockGroup(sock, msg, from, sender) {
  const isGroup = from.endsWith('@g.us');
  if (!isGroup) {
    await sock.sendMessage(
      from,
      { text: fmt('.lockgroup can only be used in groups.') },
      { quoted: msg }
    );
    return;
  }

  const isAdmin = await isGroupAdmin(sock, from, sender);
  if (!isAdmin) {
    await sock.sendMessage(
      from,
      { text: fmt('You must be a group admin to use .lockgroup.') },
      { quoted: msg }
    );
    return;
  }

  try {
    await sock.groupSettingUpdate(from, 'announcement');
    await sock.sendMessage(
      from,
      { text: fmt('Group locked. Only admins can send messages.') },
      { quoted: msg }
    );
  } catch (e) {
    console.error('lockgroup error:', e);
    await sock.sendMessage(
      from,
      { text: fmt('Failed to lock group settings.') },
      { quoted: msg }
    );
  }
}

async function handleAcceptAll(sock, msg, from, sender) {
  const isGroup = from.endsWith('@g.us');
  if (!isGroup) {
    await sock.sendMessage(
      from,
      { text: fmt('.acceptall can only be used in groups.') },
      { quoted: msg }
    );
    return;
  }

  const isAdmin = await isGroupAdmin(sock, from, sender);
  if (!isAdmin) {
    await sock.sendMessage(
      from,
      { text: fmt('You must be a group admin to use .acceptall.') },
      { quoted: msg }
    );
    return;
  }

  try {
    // Baileys API names can change; this may need tweaking if it throws.
    const reqs = await sock.groupRequestParticipantsList(from);
    if (!reqs || !reqs.length) {
      await sock.sendMessage(
        from,
        { text: fmt('No pending join requests.') },
        { quoted: msg }
      );
      return;
    }

    const ids = reqs.map((r) => r.jid || r.id || r.userJid).filter(Boolean);
    if (!ids.length) {
      await sock.sendMessage(
        from,
        { text: fmt('No valid request IDs found.') },
        { quoted: msg }
      );
      return;
    }

    await sock.groupRequestParticipantsUpdate(from, ids, 'approve');

    await sock.sendMessage(
      from,
      {
        text: fmt(`Approved ${ids.length} pending requests.`),
      },
      { quoted: msg }
    );
  } catch (e) {
    console.error('acceptall error:', e);
    await sock.sendMessage(
      from,
      { text: fmt('Failed to accept join requests (API may have changed).') },
      { quoted: msg }
    );
  }
}

// --------- .tag and .tagall ---------

async function handleTag(sock, msg, from, args) {
  if (!from.endsWith('@g.us')) {
    await sock.sendMessage(
      from,
      { text: fmt('.tag can only be used in groups.') },
      { quoted: msg }
    );
    return;
  }

  try {
    const meta = await sock.groupMetadata(from);
    const ids = meta.participants.map((p) => p.id);
    const text = args.length ? args.join(' ') : 'No message provided';

    await sock.sendMessage(
      from,
      {
        text: fmt(text),
        mentions: ids,
      },
      { quoted: msg }
    );
  } catch (e) {
    console.error('tag error:', e);
    await sock.sendMessage(
      from,
      { text: fmt('Failed to tag group members.') },
      { quoted: msg }
    );
  }
}

async function handleTagAll(sock, msg, from) {
  if (!from.endsWith('@g.us')) {
    await sock.sendMessage(
      from,
      { text: fmt('.tagall can only be used in groups.') },
      { quoted: msg }
    );
    return;
  }

  try {
    const meta = await sock.groupMetadata(from);
    const ids = meta.participants.map((p) => p.id);
    const lines = ids.map((jid) => `@${jid.split('@')[0]}`);
    const text = lines.join('\n');

    await sock.sendMessage(
      from,
      {
        text: fmt(text),
        mentions: ids,
      },
      { quoted: msg }
    );
  } catch (e) {
    console.error('tagall error:', e);
    await sock.sendMessage(
      from,
      { text: fmt('Failed to tag all members.') },
      { quoted: msg }
    );
  }
}

// --------- Sudo management (.addsudo / .delsudo / .listsudo) ---------

async function handleAddSudo(sock, msg, from, senderIsOwner) {
  if (!senderIsOwner) {
    await sock.sendMessage(
      from,
      { text: fmt('Only the bot owner can add sudo users.') },
      { quoted: msg }
    );
    return;
  }

  const target = getTargetFromContext(msg);
  if (!target) {
    await sock.sendMessage(
      from,
      { text: fmt('Reply to a user or mention them to add as sudo.') },
      { quoted: msg }
    );
    return;
  }

  if (!db.sudo.includes(target)) {
    db.sudo.push(target);
    saveDb();
  }

  await sock.sendMessage(
    from,
    {
      text: fmt(`@${target.split('@')[0]} added as sudo.`),
      mentions: [target],
    },
    { quoted: msg }
  );
}

async function handleDelSudo(sock, msg, from, senderIsOwner) {
  if (!senderIsOwner) {
    await sock.sendMessage(
      from,
      { text: fmt('Only the bot owner can remove sudo users.') },
      { quoted: msg }
    );
    return;
  }

  const target = getTargetFromContext(msg);
  if (!target) {
    await sock.sendMessage(
      from,
      { text: fmt('Reply to a user or mention them to remove from sudo.') },
      { quoted: msg }
    );
    return;
  }

  db.sudo = db.sudo.filter((j) => j !== target);
  saveDb();

  await sock.sendMessage(
    from,
    {
      text: fmt(`@${target.split('@')[0]} removed from sudo.`),
      mentions: [target],
    },
    { quoted: msg }
  );
}

async function handleListSudo(sock, from) {
  if (!db.sudo.length) {
    await sock.sendMessage(
      from,
      { text: fmt('No sudo users configured.') },
      { quoted: null }
    );
    return;
  }
  const lines = db.sudo.map((j) => `- ${j}`);
  await sock.sendMessage(
    from,
    { text: fmt('Sudo users:\n' + lines.join('\n')) },
    { quoted: null }
  );
}

// --------- .dont (font switcher) ---------

async function handleDont(sock, msg, from, args) {
  const styleRaw = (args[0] || '').toLowerCase();
  const supported = ['normal', 'wide', 'mono', 'serif'];

  if (!styleRaw) {
    await sock.sendMessage(
      from,
      {
        text: fmt(
          `Current font: ${db.font}\nUse ${PREFIX}dont one of: ${supported.join(
            ', '
          )}`
        ),
      },
      { quoted: msg }
    );
    return;
  }

  if (!supported.includes(styleRaw)) {
    await sock.sendMessage(
      from,
      {
        text: fmt(
          `Unsupported font.\nSupported fonts: ${supported.join(', ')}`
        ),
      },
      { quoted: msg }
    );
    return;
  }

  db.font = styleRaw;
  saveDb();

  await sock.sendMessage(
    from,
    { text: fmt(`Font changed to ${styleRaw}.`) },
    { quoted: msg }
  );
}

// --------- Message cache for anti-delete ---------

const messageCache = new Map();

function cacheMessage(msg) {
  try {
    const id = msg.key && msg.key.id;
    if (!id) return;

    // Unwrap ephemeral / view-once wrappers
    const inner = unwrapMessageContent(msg.message || {});

    const hasText =
      !!(inner.conversation || inner.extendedTextMessage?.text);
    const hasMedia =
      !!(
        inner.imageMessage ||
        inner.videoMessage ||
        inner.audioMessage ||
        inner.documentMessage ||
        inner.stickerMessage
      );

    // Only cache messages that actually carry user content.
    // This avoids overwriting the original with later empty/protocol updates.
    if (!hasText && !hasMedia) {
      // console.log('cacheMessage: skipping non-content message for id', id);
      return;
    }

    messageCache.set(id, msg);

    // Prevent unbounded growth
    if (messageCache.size > 2000) {
      const first = messageCache.keys().next().value;
      if (first) messageCache.delete(first);
    }
  } catch (e) {
    console.error('cacheMessage error:', e);
  }
}

function unwrapMessageContent(message) {
  let inner = message || {};
  if (inner.ephemeralMessage) {
    inner = inner.ephemeralMessage.message || {};
  }
  if (inner.viewOnceMessageV2) {
    inner = inner.viewOnceMessageV2.message || {};
  } else if (inner.viewOnceMessageV2Extension) {
    inner = inner.viewOnceMessageV2Extension.message || {};
  }
  return inner;
}

function extractTextOrCaption(inner) {
  if (!inner) return '';
  return (
    inner.imageMessage?.caption ||
    inner.videoMessage?.caption ||
    inner.documentMessage?.caption ||
    inner.audioMessage?.caption ||
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    ''
  );
}

function formatTimestampLines(tsSeconds) {
  if (!tsSeconds) return '';
  const d = new Date(tsSeconds * 1000);
  const dateStr = d.toLocaleDateString();
  const timeStr = d.toLocaleTimeString();
  return `TIME: ${timeStr}\nDATE: ${dateStr}`;
}

// --------- Anti-delete + anti-edit for chats/groups + status ---------

async function handleMessageUpdate(sock, upd) {
  try {
    if (!db.settings) return;
    const antiDelMsg = !!db.settings.antiDeleteMessage;
    const antiDelStatus = !!db.settings.antiDeleteStatus;
    if (!antiDelMsg && !antiDelStatus) return;

    const { key, update } = upd || {};
    const msgUpdate = update?.message || {};
    const edited = msgUpdate.editedMessage;

    const targetJid = OWNER_JID || (sock.user && sock.user.id);
    if (!targetJid) {
      console.log('Anti-delete: no OWNER_JID or sock.user.id');
      return;
    }

    // ---------- Anti-EDIT ----------
    if (edited && edited.message && antiDelMsg) {
      const orig = key && key.id ? messageCache.get(key.id) : null;

      const remoteJid =
        (orig && orig.key.remoteJid) ||
        key?.remoteJid ||
        key?.remoteJidAlt;
      if (!remoteJid) return;

      const remoteJidAlt =
        (orig && orig.key.remoteJidAlt) ||
        key?.remoteJidAlt ||
        remoteJid;

        const isGroup = remoteJid.endsWith('@g.us');

        // sender JID
        let fromJid;
        if (isGroup) {
          const participantAlt =
            (orig && orig.key.participantAlt) || orig?.key.participant;
          fromJid = participantAlt || orig?.key.participant || remoteJid;
        } else {
          fromJid = remoteJidAlt || remoteJid;
        }
        const senderBare = fromJid ? fromJid.split('@')[0] : 'unknown';

        // sender labels
        const pushName = orig && orig.pushName;
        const senderDisplay = pushName || senderBare; // nice name for CHAT in PM
        const senderAt = `@${senderBare}`;           // numeric mention for SENT BY / EDITED BY

        // CHAT label
        let chatLabel;
        if (isGroup) {
          let groupName = remoteJidAlt || remoteJid;
          try {
            const meta = await sock.groupMetadata(remoteJid);
            groupName = meta.subject || groupName;
          } catch (e) {
            console.error('Anti-edit: groupMetadata error:', e);
          }
          chatLabel = groupName;
        } else {
          // private chat: CHAT should be plain name (no @)
          chatLabel = senderDisplay;
        }

        const ts =
          (orig && Number(orig.messageTimestamp)) ||
          Number(orig?.message?.messageTimestamp) ||
          Number(update?.messageTimestamp) ||
          0;
        const tsLines = formatTimestampLines(ts);

        const headerLines = [
          '🚨 EDITED MESSAGE! 🚨',
          `CHAT: ${chatLabel}`,
          `SENT BY: ${senderAt}`,
          tsLines,
          `EDITED BY: ${senderAt}`,
          '',
        ].filter(Boolean);
        const headerText = headerLines.map((l) => fmt(l)).join('\n');

      const oldInner = orig ? unwrapMessageContent(orig.message) : null;
      const newInner = unwrapMessageContent(edited.message);

      const oldText = extractTextOrCaption(oldInner);
      const newText = extractTextOrCaption(newInner);

      const bodyLines = [
        headerText,
        `ORIGINAL: ${oldText || '[not cached]'}`,
        `EDITED TO: ${newText || '[unrecognized]'}`,
      ];

      const fullText = bodyLines.join('\n');

      const mediaType =
        (newInner.imageMessage && 'image') ||
        (newInner.videoMessage && 'video') ||
        (newInner.audioMessage && 'audio') ||
        (newInner.documentMessage && 'document') ||
        (newInner.stickerMessage && 'sticker');

      const mentions = fromJid ? [fromJid] : [];

      if (mediaType) {
        try {
          const tempMsg = { message: newInner };
          const buffer = await downloadMediaMessage(tempMsg, 'buffer', {});

          if (mediaType === 'image') {
            await sock.sendMessage(targetJid, {
              image: buffer,
              mimetype: 'image/jpeg',
              caption: fullText,
              mentions,
            });
          } else if (mediaType === 'video') {
            await sock.sendMessage(targetJid, {
              video: buffer,
              mimetype: 'video/mp4',
              caption: fullText,
              mentions,
            });
            } else if (mediaType === 'audio') {
            const isPtt =
              inner.audioMessage && inner.audioMessage.ptt;
            const label = originalCaption
              ? fmt(originalCaption)
              : fmt(isPtt ? '[Voice note]' : '[Audio message]');

            // 1) Card text
            await sock.sendMessage(targetJid, {
              text: `${headerText}\n\n${label}`,
              mentions,
            });

            // 2) Actual audio
            await sock.sendMessage(targetJid, {
              audio: buffer,
              mimetype: inner.audioMessage?.mimetype || 'audio/ogg; codecs=opus',
              ptt: !!isPtt,
            });
          } else if (mediaType === 'document') {
            await sock.sendMessage(targetJid, {
              document: buffer,
              fileName: 'file',
              caption: fullText,
              mentions,
            });
          } else if (mediaType === 'sticker') {
            // Card text + sticker
            await sock.sendMessage(targetJid, {
              text: fullText,
              mentions,
            });
            await sock.sendMessage(targetJid, {
              sticker: buffer,
            });
          }
        } catch (e) {
          console.error('Anti-edit media download error:', e);
          await sock.sendMessage(targetJid, { text: fullText, mentions });
        }
      } else {
        await sock.sendMessage(targetJid, { text: fullText, mentions });
      }

      // After handling the edit, update cache so future deletes use the edited content
      if (orig && key && key.id) {
        const updatedMsg = { ...orig, message: edited.message };
        messageCache.set(key.id, updatedMsg);
      }

      return;
    }

    // ---------- Anti-DELETE (messageStubType: 1 on your setup) ----------
    if (update && update.message === null && update.messageStubType === 1) {
      const revokedKey = update.key || key;
      if (!revokedKey || !revokedKey.id) {
        console.log('Anti-delete: revokedKey missing id', revokedKey);
        return;
      }

      console.log('Anti-delete: revoke detected for', revokedKey);

      // First try id from update.key
      let orig = messageCache.get(revokedKey.id);

      // Fallback to outer key.id
      if (!orig && key && key.id && key.id !== revokedKey.id) {
        console.log(
          'Anti-delete: trying fallback cache lookup for outer key.id',
          key.id
        );
        orig = messageCache.get(key.id);
      }

      if (!orig) {
        console.log('Anti-delete: original message not found in cache');
        return;
      }

      const remoteJid = orig.key.remoteJid;
      const inner = unwrapMessageContent(orig.message);

      const remoteJidAlt =
        orig.key.remoteJidAlt || key?.remoteJidAlt || revokedKey.remoteJidAlt;

      const ts =
        Number(orig.messageTimestamp) ||
        Number(orig.message?.messageTimestamp) ||
        Number(update?.messageTimestamp) ||
        0;
      const tsLines = formatTimestampLines(ts);

      // ----- STATUS anti-delete -----
      if (remoteJid === 'status@broadcast') {
        if (!antiDelStatus) {
          console.log('Anti-delete-status disabled; ignoring status revoke');
          return;
        }

        const authorJid =
          orig.key.participant ||
          orig.key.remoteJidAlt ||
          targetJid;
        const authorId = authorJid ? authorJid.split('@')[0] : 'unknown';

        const headerLines = [
          '🚨 DELETED STATUS! 🚨',
          `AUTHOR: @${authorId}`,
          tsLines,
          '',
        ].filter(Boolean);

        const headerText = headerLines.map((l) => fmt(l)).join('\n');
        const mentions = authorJid ? [authorJid] : [];

        const mediaTypeStatus =
          (inner.imageMessage && 'image') ||
          (inner.videoMessage && 'video') ||
          (inner.audioMessage && 'audio') ||
          (inner.documentMessage && 'document') ||
          (inner.stickerMessage && 'sticker');

        const textStatus = extractTextOrCaption(inner);

        if (mediaTypeStatus) {
          try {
            const tempMsg = { message: inner };
            const buffer = await downloadMediaMessage(tempMsg, 'buffer', {});

            const fullCaption = textStatus
              ? `${headerText}\n\n${fmt(textStatus)}`
              : headerText;

            if (mediaTypeStatus === 'image') {
              await sock.sendMessage(targetJid, {
                image: buffer,
                mimetype: 'image/jpeg',
                caption: fullCaption,
                mentions,
              });
            } else if (mediaTypeStatus === 'video') {
              await sock.sendMessage(targetJid, {
                video: buffer,
                mimetype: 'video/mp4',
                caption: fullCaption,
                mentions,
              });
              } else if (mediaType === 'audio') {
              const isPtt =
                inner.audioMessage && inner.audioMessage.ptt;
              const label = originalCaption
                ? fmt(originalCaption)
                : fmt(isPtt ? '[Voice note]' : '[Audio message]');

              // 1) Card text
              await sock.sendMessage(targetJid, {
                text: `${headerText}\n\n${label}`,
                mentions,
              });

              // 2) Actual audio
              await sock.sendMessage(targetJid, {
                audio: buffer,
                mimetype: inner.audioMessage?.mimetype || 'audio/ogg; codecs=opus',
                ptt: !!isPtt,
              });
            } else if (mediaType === 'document') {
              await sock.sendMessage(targetJid, {
                document: buffer,
                fileName: 'file',
                caption: fullCaption,
                mentions,
              });
            } else if (mediaTypeStatus === 'sticker') {
              await sock.sendMessage(targetJid, {
                text: fullCaption,
                mentions,
              });
              await sock.sendMessage(targetJid, {
                sticker: buffer,
              });
            }
            return;
          } catch (e) {
            console.error('Anti-delete-status media error:', e);
            // Fallback to text-only:
          }
        }

        const body = textStatus
          ? `${headerText}\n\n${fmt(textStatus)}`
          : headerText;
        await sock.sendMessage(targetJid, { text: body, mentions });
        return;
      }

      // ----- Normal chat/group delete -----
      if (!antiDelMsg) return;

      const isGroup = remoteJid.endsWith('@g.us');

      // figure out sender
      const participantAlt =
        (orig && orig.key.participantAlt) || orig?.key.participant;
      const fromJid = isGroup
        ? (participantAlt || orig.key.participant || remoteJid)
        : remoteJidAlt || remoteJid;
      const senderBare = fromJid ? fromJid.split('@')[0] : 'unknown';

      // sender display name
      const pushNameDel = orig && orig.pushName;
      const senderDisplayDel = pushNameDel || senderBare;
      const senderAtDel = `@${senderBare}`; // numeric mention

      // CHAT label
      let chatLabelDel;
      if (isGroup) {
        chatLabelDel = remoteJidAlt || remoteJid;
        try {
          const meta = await sock.groupMetadata(remoteJid);
          chatLabelDel = meta.subject || chatLabelDel;
        } catch (e) {
          console.error('Anti-delete: groupMetadata error:', e);
        }
      } else {
        // private chat: CHAT should be plain name, SENT BY: @digits
        chatLabelDel = senderDisplayDel;
      }

      const headerLines = [
        '🚨 DELETED MESSAGE! 🚨',
        `CHAT: ${chatLabelDel}`,
        `SENT BY: ${senderAtDel}`,
        tsLines,
        '',
      ].filter(Boolean);
      const headerText = headerLines.map((l) => fmt(l)).join('\n');

      const mediaType =
        (inner.imageMessage && 'image') ||
        (inner.videoMessage && 'video') ||
        (inner.audioMessage && 'audio') ||
        (inner.documentMessage && 'document') ||
        (inner.stickerMessage && 'sticker');

      const mentions = fromJid ? [fromJid] : [];

      if (mediaType) {
        const tempMsg = { message: inner };
        const buffer = await downloadMediaMessage(tempMsg, 'buffer', {});

        const originalCaption = extractTextOrCaption(inner);

        const caption = originalCaption
          ? `${headerText}\n\n${fmt(originalCaption)}`
          : headerText;

        if (mediaType === 'image') {
          await sock.sendMessage(targetJid, {
            image: buffer,
            mimetype: 'image/jpeg',
            caption,
            mentions,
          });
        } else if (mediaType === 'video') {
          await sock.sendMessage(targetJid, {
            video: buffer,
            mimetype: 'video/mp4',
            caption,
            mentions,
          });
        } else if (mediaType === 'audio') {
          await sock.sendMessage(targetJid, {
            audio: buffer,
            mimetype: 'audio/ogg; codecs=opus',
            caption,
            mentions,
          });
        } else if (mediaType === 'document') {
          await sock.sendMessage(targetJid, {
            document: buffer,
            fileName: 'file',
            caption,
            mentions,
          });
        } else if (mediaType === 'sticker') {
          await sock.sendMessage(targetJid, {
            text: caption,
            mentions,
          });
          await sock.sendMessage(targetJid, {
            sticker: buffer,
          });
        }
        return;
      }

      const text = extractTextOrCaption(inner);

      if (text) {
        await sock.sendMessage(targetJid, {
          text: `${headerText}\n\n${fmt(text)}`,
          mentions,
        });
        return;
      }

      console.log(
        'Anti-delete: unsupported deleted content inner=',
        JSON.stringify(inner, null, 2)
      );

      await sock.sendMessage(targetJid, {
        text: `${headerText}\n\n[Unsupported deleted content]`,
        mentions,
      });
      return;
    }

    // If neither edit nor known delete, ignore.
  } catch (e) {
    console.error('handleMessageUpdate (anti-delete/edit) error:', e);
  }
}

// --------- Generic ON/OFF setting handler ---------

async function handleToggleSetting(sock, msg, from, args, key, displayName) {
  const val = (args[0] || '').toLowerCase();
  if (val !== 'on' && val !== 'off') {
    await sock.sendMessage(
      from,
      { text: fmt(`Usage: ${PREFIX}${displayName} on/off`) },
      { quoted: msg }
    );
    return;
  }

  const enabled = val === 'on';
  if (!db.settings) db.settings = {};
  db.settings[key] = enabled;
  saveDb();

  await sock.sendMessage(
    from,
    {
      text: fmt(
        `${displayName} ${enabled ? 'enabled ✅' : 'disabled ❌'}`
      ),
    },
    { quoted: msg }
  );
}

// --------- Main command router ---------

async function handleCommand(sock, msg, from, rawText) {
  const text = (rawText || '').trim();
  if (!text.startsWith(PREFIX)) return; // not a command

  const withoutPrefix = text.slice(PREFIX.length).trim();
  const [cmdNameRaw, ...args] = withoutPrefix.split(/\s+/);
  const cmd = (cmdNameRaw || '').toLowerCase();

  const isGroup = from.endsWith('@g.us');
  const sender = isGroup ? (msg.key.participant || from) : from;
  const fromMe = !!msg.key.fromMe;

  // Owner = the WhatsApp account Yeetbot is logged in as (fromMe),
  // OR an explicit OWNER_JID if provided.
  const senderIsOwner = fromMe || (OWNER_JID && sender === OWNER_JID);
  const senderIsSudo = db.sudo.includes(sender);

  console.log(
    'Command:',
    cmd,
    'Args:',
    args,
    'Sender:',
    sender,
    'fromMe:',
    fromMe
  );

  // Enforce permissions only if some owner config exists;
  // otherwise, bot is open to everyone.
  if (OWNER_JID || OWNER_NUMBER) {
    if (!senderIsOwner && !senderIsSudo) {
      await sock.sendMessage(
        from,
        { text: fmt('You are not authorized to use Yeetbot commands.') },
        { quoted: msg }
      );
      return;
    }
  }

  // --- Basic commands ---

  if (cmd === 'ping') {
    await sock.sendMessage(from, { text: fmt('Pong from Yeetbot ✅') }, { quoted: msg });
    return;
  }

  if (cmd === 'menu' || cmd === 'help') {
    const menuText = [
      '🟢 *Yeetbot Menu*',
      '',
      '▪️ *Basic*',
      `${PREFIX}ping               - Test if Yeetbot is alive`,
      `${PREFIX}menu               - Show this help`,
      '',
      '▪️ *TikTok*',
      `${PREFIX}tiktok URL         - Download TikTok video or photos (HD if possible)`,
      `${PREFIX}tiktokaudio URL    - Download TikTok audio (MP3)`,
      '',
      '▪️ *Downloads (yt-dlp)*',
      `${PREFIX}instagram URL      - Download Instagram reel/video or photos`,
      `${PREFIX}facebook URL       - Download Facebook video`,
      `${PREFIX}twitter URL        - Download Twitter/X video`,
      `${PREFIX}download URL       - Generic media download`,
      `${PREFIX}video URL          - Alias for download`,
      `${PREFIX}ytmp3 URL          - YouTube (or others) audio MP3`,
      `${PREFIX}ytmp3doc URL       - Same as ytmp3 but as document`,
      '',
      '▪️ *Media / Status*',
      `${PREFIX}vv                 - Save replied view-once or status media/text`,
      `${PREFIX}swipe              - Save replied status/view-once to your DM`,
      `${PREFIX}tostatus           - Send replied message/status as your status`,
      `${PREFIX}getpp              - Get profile picture of replied user`,
      `${PREFIX}toimage            - Convert replied sticker to image`,
      `${PREFIX}tovideo            - Convert replied sticker to video`,
      '',
      '▪️ *Font*',
      `${PREFIX}dont normal|wide|mono|serif   - Change Yeetbot font`,
      '',
      '▪️ *Group*',
      `${PREFIX}warn               - Warn user (5 warns -> kick) [admins only]`,
      `${PREFIX}clearwarn          - Reset warns for replied/mentioned user [admins only]`,
      `${PREFIX}unwarn             - Alias for clearwarn`,
      `${PREFIX}kick               - Kick replied/mentioned user [admins only]`,
      `${PREFIX}lockgroup          - Lock group (admins only)`,
      `${PREFIX}acceptall          - Accept all join requests (admins only)`,
      `${PREFIX}tag [msg]          - Tag everyone, but text is just [msg]`,
      `${PREFIX}tagall             - Tag everyone on separate lines`,
      '',
      '▪️ *Owner / Sudo*',
      `${PREFIX}ryoikitenkai-sudonomi/addsudo - Add sudo (owner only, reply/mention)`,
      `${PREFIX}delsudo            - Remove sudo (owner only)`,
      `${PREFIX}listsudo           - List sudo users`,
      `${PREFIX}antideletemessage on/off - Forward deleted messages to owner`,
      `${PREFIX}antideletestatus on/off - Forward deleted statuses to owner`,
    ].join('\n');

    await sock.sendMessage(from, { text: fmt(menuText) }, { quoted: msg });
    return;
  }

  // --- Font command ---
  if (cmd === 'dont' || cmd === "don't") {
    await handleDont(sock, msg, from, args);
    return;
  }

  // --- Sudo management ---
  if (cmd === 'addsudo' || cmd === 'ryoikitenkai-sudonomi') {
    await handleAddSudo(sock, msg, from, senderIsOwner);
    return;
  }

  if (cmd === 'delsudo') {
    await handleDelSudo(sock, msg, from, senderIsOwner);
    return;
  }

  if (cmd === 'listsudo') {
    await handleListSudo(sock, from);
    return;
  }

  // --- Media / Status commands ---
  if (cmd === 'vv') {
    await handleVv(sock, msg, from);
    return;
  }

  if (cmd === 'swipe') {
    await handleSwipe(sock, msg, from);
    return;
  }

  if (cmd === 'tostatus') {
    await handleToStatus(sock, msg, from);
    return;
  }

  if (cmd === 'getpp') {
    await handleGetPp(sock, msg, from);
    return;
  }

  if (cmd === 'toimage') {
    await handleToImage(sock, msg, from);
    return;
  }

  if (cmd === 'tovideo') {
    await handleToVideo(sock, msg, from);
    return;
  }

  if (cmd === 'sticker') {
    await handleSticker(sock, msg, from);
    return;
  }

  if (cmd === 'antideletemessage') {
    await handleToggleSetting(
      sock,
      msg,
      from,
      args,
      'antiDeleteMessage',
      'antideletemessage'
    );
    return;
  }

  if (cmd === 'antideletestatus') {
    await handleToggleSetting(
      sock,
      msg,
      from,
      args,
      'antiDeleteStatus',
      'antideletestatus'
    );
    return;
  }

  // --- TikTok commands ---
  if (cmd === 'tiktok' || cmd === 'tiktokaudio') {
    await handleTikTokCommand(sock, msg, from, cmd, args);
    return;
  }

  // --- Group commands ---
  if (cmd === 'warn') {
    await handleWarn(sock, msg, from, sender);
    return;
  }

  if (cmd === 'kick') {
    await handleKick(sock, msg, from, sender);
    return;
  }

  if (cmd === 'lockgroup') {
    await handleLockGroup(sock, msg, from, sender);
    return;
  }

  if (cmd === 'acceptall') {
    await handleAcceptAll(sock, msg, from, sender);
    return;
  }

  if (cmd === 'clearwarn' || cmd === 'unwarn') {
    await handleClearWarn(sock, msg, from, sender);
    return;
  }

  if (cmd === 'tag') {
    await handleTag(sock, msg, from, args);
    return;
  }

  if (cmd === 'tagall') {
    await handleTagAll(sock, msg, from);
    return;
  }

  // --- Download-related commands using yt-dlp (non-TikTok) ---
  const downloadCommands = [
    'instagram',
    'facebook',
    'twitter',
    'download',
    'video',
    'ytmp3',
    'ytmp3doc',
    'song',
  ];

  if (downloadCommands.includes(cmd)) {
    await handleDownloadCommand(sock, msg, from, cmd, args);
    return;
  }

  // Unknown command
  await sock.sendMessage(
    from,
    { text: fmt(`Unknown command: ${PREFIX}${cmd}`) },
    { quoted: msg }
  );
}

module.exports = {
  handleCommand,
  cacheMessage,
  handleMessageUpdate,
};
