const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendText } = require('../services/meta');
const { encrypt } = require('../utils/crypto');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { client_id, q } = req.query;
  const params = [];
  const where = [];
  if (client_id) { params.push(client_id); where.push(`c.client_id = $${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`(ct.wa_id ILIKE $${params.length} OR ct.display_name ILIKE $${params.length})`); }

  const sql = `
    SELECT c.id, c.status, c.unread_count, c.last_message_at,
           cl.name AS client_name, ct.wa_id, ct.display_name,
           (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_body
    FROM conversations c
    JOIN clients cl ON cl.id = c.client_id
    JOIN contacts ct ON ct.id = c.contact_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY c.last_message_at DESC
    LIMIT 200
  `;
  const [conversations, clients] = await Promise.all([
    pool.query(sql, params),
    pool.query("SELECT id, name FROM clients WHERE status='active' ORDER BY name")
  ]);
  res.render('index', { conversations: conversations.rows, clients: clients.rows, filters: req.query });
});

router.get('/conversation/:id', async (req, res) => {
  const id = req.params.id;
  const convResult = await pool.query(`
    SELECT c.*, cl.name AS client_name, cl.phone_number_id, cl.encrypted_access_token,
           ct.wa_id, ct.display_name
    FROM conversations c
    JOIN clients cl ON cl.id = c.client_id
    JOIN contacts ct ON ct.id = c.contact_id
    WHERE c.id = $1
  `, [id]);
  const conv = convResult.rows[0];
  if (!conv) return res.sendStatus(404);

  await pool.query('UPDATE conversations SET unread_count = 0 WHERE id = $1', [id]);
  const messages = await pool.query('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC', [id]);
  res.render('conversation', { conv, messages: messages.rows, error: null });
});

router.post('/conversation/:id/reply', async (req, res) => {
  const id = req.params.id;
  const text = (req.body.text || '').trim();
  if (!text) return res.redirect(`/conversation/${id}`);

  const convResult = await pool.query(`
    SELECT c.*, cl.phone_number_id, cl.encrypted_access_token, cl.name AS client_name, ct.wa_id, ct.display_name
    FROM conversations c
    JOIN clients cl ON cl.id = c.client_id
    JOIN contacts ct ON ct.id = c.contact_id
    WHERE c.id = $1
  `, [id]);
  const conv = convResult.rows[0];
  if (!conv) return res.sendStatus(404);

  try {
    const meta = await sendText(conv, conv.wa_id, text);
    const metaId = meta.messages?.[0]?.id || null;
    await pool.query(`
      INSERT INTO messages (conversation_id, meta_message_id, direction, message_type, body, status)
      VALUES ($1, $2, 'out', 'text', $3, 'sent')
    `, [id, metaId, text]);
    await pool.query('UPDATE conversations SET last_message_at = NOW(), assigned_to = $2 WHERE id = $1', [id, req.session.adminId]);
    res.redirect(`/conversation/${id}`);
  } catch (err) {
    console.error(err.response?.data || err.message || err);
    const messages = await pool.query('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC', [id]);
    res.status(500).render('conversation', { conv, messages: messages.rows, error: 'Falha ao enviar. Verifique token, janela de atendimento e configuração da Meta.' });
  }
});

router.post('/conversation/:id/close', async (req, res) => {
  await pool.query("UPDATE conversations SET status='closed' WHERE id=$1", [req.params.id]);
  res.redirect('/');
});

router.get('/clients', async (req, res) => {
  const result = await pool.query('SELECT id, name, phone_number_id, waba_id, status, created_at FROM clients ORDER BY id DESC');
  res.render('clients', { clients: result.rows, error: null });
});

router.post('/clients', async (req, res) => {
  const { name, phone_number_id, waba_id, access_token } = req.body;
  try {
    await pool.query(`
      INSERT INTO clients (name, phone_number_id, waba_id, encrypted_access_token)
      VALUES ($1,$2,$3,$4)
    `, [name.trim(), phone_number_id.trim(), (waba_id || '').trim() || null, encrypt(access_token.trim())]);
    res.redirect('/clients');
  } catch (err) {
    const result = await pool.query('SELECT id, name, phone_number_id, waba_id, status, created_at FROM clients ORDER BY id DESC');
    res.status(400).render('clients', { clients: result.rows, error: err.message });
  }
});

module.exports = router;
