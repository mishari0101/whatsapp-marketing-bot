require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { handleMessage } = require('./handlers/messageHandler');

// ====================== BAILEYS BOT ======================

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Flux Media Bot', 'Chrome', '120.0.0'],
    generateHighQualityLinkPreview: true,
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nQR Code scan பண்ணுங்க:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;

      console.log('Connection closed. Reconnecting:', shouldReconnect);
      // 3 sec gap: rapid reconnect loop varaama irukka
      if (shouldReconnect) setTimeout(startBot, 3000);
    } else if (connection === 'open') {
      console.log('✅ Bot Ready! (Baileys + Groq AI)');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // messages[0] mattum illa, batch-la vara ella messages-um process pannu
    for (const msg of messages) {
      // 'notify'  = pudhu customer messages
      // 'append'  = nee phone-la irundhu customer-kitta anuppina (fromMe) messages sila time ippadi varum.
      //             Idhu illana human takeover (bot auto-pause) work aagaadhu.
      //             Pazhaya history sync messages-a handler-ulla timestamp check-la ignore pannum.
      const allowed = type === 'notify' || (type === 'append' && msg.key.fromMe);
      if (!allowed) continue;

      try {
        await handleMessage(sock, msg);
      } catch (err) {
        console.error('handleMessage error:', err);
      }
    }
  });
}

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

startBot();