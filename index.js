// index.js
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const fs = require('fs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
app.use(bodyParser.json());

// CONFIG: environment variables
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';      // set this in Railway
const SEND_TOKEN = process.env.SEND_TOKEN || '';               // set a secret token to protect /send
const QR_TOKEN = process.env.QR_TOKEN || '';                   // optional token to view QR image
const SESSION_DIR = process.env.SESSION_DIR || '/data/session';// where session files are stored (persistent volume)

// ensure session dir exists
fs.mkdirSync(SESSION_DIR, { recursive: true });

// WhatsApp client with LocalAuth storing in SESSION_DIR
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR, clientId: 'railway-listener' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  }
});

let lastQrDataUrl = null;

// show QR in logs and keep a PNG data URL for /qr endpoint
client.on('qr', async (qr) => {
  console.log('QR RECEIVED - scan this with WhatsApp -> Linked devices -> Link a device');
  qrcode.generate(qr, { small: true });
  try {
    lastQrDataUrl = await QRCode.toDataURL(qr);
  } catch (err) {
    console.error('Failed to create QR data URL', err);
  }
});

client.on('ready', () => {
  console.log('WhatsApp client ready ✅');
});

client.on('authenticated', () => {
  console.log('Authenticated - session saved');
});

client.on('auth_failure', (msg) => {
  console.error('Auth failure', msg);
});

// Incoming message handler (only group messages)
client.on('message', async (msg) => {
  try {
    if (!msg.from.endsWith('@g.us')) return; // only handle group messages

    const chat = await msg.getChat();
    const sender = msg.author || msg._data.notifyName || msg.from;
    const payload = {
      group: chat.name || msg.from,
      sender: sender,
      text: msg.body || '',
      hasMedia: !!msg.hasMedia
    };

    if (msg.hasMedia) {
      const media = await msg.downloadMedia(); // { data, mimetype, filename }
      payload.media = {
        data: media.data,
        mimetype: media.mimetype,
        filename: media.filename || 'file'
      };
    }

    if (N8N_WEBHOOK_URL) {
      // send to your n8n webhook
      await axios.post(N8N_WEBHOOK_URL, payload, { timeout: 10000 });
      console.log('Forwarded incoming group message to n8n:', payload.group, payload.sender);
    } else {
      console.log('N8N_WEBHOOK_URL not set; incoming payload:', payload);
    }
  } catch (err) {
    console.error('Error processing message', err);
  }
});

// Simple route to view the QR (protected by QR_TOKEN if set)
app.get('/qr', (req, res) => {
  if (QR_TOKEN && req.query.token !== QR_TOKEN && req.headers['authorization'] !== `Bearer ${QR_TOKEN}`) {
    return res.status(401).send('Unauthorized');
  }
  if (!lastQrDataUrl) return res.status(404).send('QR not generated yet — check logs');
  const img = Buffer.from(lastQrDataUrl.split(',')[1], 'base64');
  res.setHeader('Content-Type', 'image/png');
  res.send(img);
});

// Protected send endpoint - n8n will call this to forward messages to groups
app.post('/send', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  if (SEND_TOKEN && authHeader !== `Bearer ${SEND_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { groupName, message, media } = req.body;
  if (!groupName || (!message && !media)) {
    return res.status(400).json({ error: 'Missing groupName or message/media' });
  }

  try {
    const chats = await client.getChats();
    const target = chats.find(c => c.name === groupName);
    if (!target) return res.status(404).json({ error: 'Group not found in your account' });

    if (media) {
      // media: { data: "<base64>", mimetype: "image/jpeg", filename: "photo.jpg" }
      const msgMedia = new MessageMedia(media.mimetype, media.data, media.filename || 'file');
      if (message) await target.sendMessage(message);
      await target.sendMessage(msgMedia);
    } else {
      await target.sendMessage(message);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('Error sending message', err);
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listener HTTP running on port ${PORT}`));
client.initialize();
