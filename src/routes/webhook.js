const express = require('express');
const crypto = require('crypto');
const pool = require('../db');

const router = express.Router();

router.get('/webhook', (req, res) => {
  const verifyToken = process.env.META_VERIFY_TOKEN;
  if (typeof verifyToken !== 'string' || !verifyToken.trim()) {
    return res.sendStatus(503);
  }

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' &&
      typeof token === 'string' && token.trim() && token === verifyToken &&
      typeof challenge === 'string' && challenge.trim()) {
    return res.status(200).type('text/plain').send(challenge);
  }
  return res.sendStatus(403);
});

router.post('/webhook', async (req, res) => {
  const appSecret = process.env.META_APP_SECRET;
  if (typeof appSecret !== 'string' || !appSecret.trim()) {
    return res.sendStatus(503);
  }

  if (!Buffer.isBuffer(req.rawBody)) return res.sendStatus(400);

  const signature = req.get('X-Hub-Signature-256');
  if (typeof signature !== 'string' || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) {
    return res.sendStatus(403);
  }

  const expected = crypto.createHmac('sha256', appSecret).update(req.rawBody).digest();
  const received = Buffer.from(signature.slice(7), 'hex');
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    return res.sendStatus(403);
  }

  // Responda rápido à Meta; processe o payload logo em seguida.
  res.sendStatus(200);

  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const phoneNumberId = value.metadata?.phone_number_id;
        if (!phoneNumberId) continue;

        const clientResult = await pool.query(
          "SELECT * FROM clients WHERE phone_number_id = $1 AND status = 'active' LIMIT 1",
          [phoneNumberId]
        );
        const client = clientResult.rows[0];
        if (!client) continue;

        // Atualiza status de mensagens enviadas
        for (const status of value.statuses || []) {
          if (status.id) {
            await pool.query('UPDATE messages SET status = $1 WHERE meta_message_id = $2', [status.status, status.id]);
          }
        }

        for (const msg of value.messages || []) {
          const waId = msg.from;
          const displayName = value.contacts?.find(c => c.wa_id === waId)?.profile?.name || null;
          const body = msg.text?.body || `[${msg.type || 'mensagem'}]`;

          const contactResult = await pool.query(`
            INSERT INTO contacts (client_id, wa_id, display_name, last_seen_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (client_id, wa_id)
            DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, contacts.display_name), last_seen_at = NOW()
            RETURNING *
          `, [client.id, waId, displayName]);
          const contact = contactResult.rows[0];

          const convResult = await pool.query(`
            INSERT INTO conversations (client_id, contact_id, unread_count, last_message_at)
            VALUES ($1, $2, 1, NOW())
            ON CONFLICT (client_id, contact_id)
            DO UPDATE SET unread_count = conversations.unread_count + 1, status = 'open', last_message_at = NOW()
            RETURNING *
          `, [client.id, contact.id]);
          const conv = convResult.rows[0];

          await pool.query(`
            INSERT INTO messages (conversation_id, meta_message_id, direction, message_type, body, status)
            VALUES ($1, $2, 'in', $3, $4, 'received')
            ON CONFLICT (meta_message_id) DO NOTHING
          `, [conv.id, msg.id, msg.type || 'text', body]);
        }
      }
    }
  } catch (err) {
    console.error('Webhook processing failed.');
  }
});

module.exports = router;
