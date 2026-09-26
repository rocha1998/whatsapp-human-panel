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
  const diagnosticId = crypto.randomUUID();
  let diagnosticStage = 'recebimento';
  const diagnostic = (event, details = {}) => {
    console.log(`[WEBHOOK] ${event}`, { requestId: diagnosticId, ...details });
  };
  diagnostic('POST recebido', { timestamp: new Date().toISOString() });
  // Diagnóstico temporário: não registrar credenciais nem cabeçalhos.
  console.log('🔥 WEBHOOK RECEBIDO DA META', new Date().toISOString());
  console.log('BODY:', JSON.stringify(req.body, (key, value) => {
    if (/token|secret|authorization|password/i.test(key)) return '[REDACTED]';
    if (typeof value !== 'string') return value;
    for (const name of ['META_APP_SECRET', 'META_VERIFY_TOKEN', 'META_ACCESS_TOKEN']) {
      if (process.env[name]) value = value.split(process.env[name]).join('[REDACTED]');
    }
    return value.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  }));

  const appSecret = process.env.META_APP_SECRET;
  if (typeof appSecret !== 'string' || !appSecret.trim()) {
    diagnostic('interrompido: META_APP_SECRET ausente ou vazio', { httpStatus: 503 });
    return res.sendStatus(503);
  }

  if (!Buffer.isBuffer(req.rawBody)) {
    diagnostic('interrompido: rawBody indisponivel', { httpStatus: 400 });
    return res.sendStatus(400);
  }

  const signature = req.get('X-Hub-Signature-256');
  if (typeof signature !== 'string' || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) {
    diagnostic('interrompido: assinatura ausente ou formato invalido', { httpStatus: 403 });
    return res.sendStatus(403);
  }

  const expected = crypto.createHmac('sha256', appSecret).update(req.rawBody).digest();
  const received = Buffer.from(signature.slice(7), 'hex');
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
    diagnostic('interrompido: assinatura divergente', { httpStatus: 403 });
    return res.sendStatus(403);
  }
  diagnostic('assinatura validada');

  // Responda rápido à Meta; processe o payload logo em seguida.
  res.sendStatus(200);
  diagnostic('HTTP 200 enviado; processamento ainda pendente');

  try {
    diagnosticStage = 'interpretacao do payload';
    const entries = req.body.entry || [];
    diagnostic('payload interpretado', {
      whatsappBusinessAccount: req.body.object === 'whatsapp_business_account',
      entriesCount: Array.isArray(entries) ? entries.length : null,
      entriesIsArray: Array.isArray(entries)
    });
    for (const entry of entries) {
      diagnosticStage = 'interpretacao de changes';
      diagnostic('entry encontrada', {
        changesCount: Array.isArray(entry.changes) ? entry.changes.length : null
      });
      for (const change of entry.changes || []) {
        diagnosticStage = 'interpretacao de value';
        const value = change.value || {};
        const phoneNumberId = value.metadata?.phone_number_id;
        diagnostic('change encontrada', {
          messagesField: change.field === 'messages',
          phoneNumberIdPresent: Boolean(phoneNumberId),
          messagesCount: Array.isArray(value.messages) ? value.messages.length : null,
          statusesCount: Array.isArray(value.statuses) ? value.statuses.length : null
        });
        if (!phoneNumberId) {
          diagnostic('change ignorada: metadata.phone_number_id ausente');
          continue;
        }

        diagnosticStage = 'busca de cliente ativo';
        diagnostic('buscando cliente ativo pelo phone_number_id');
        const clientResult = await pool.query(
          "SELECT * FROM clients WHERE phone_number_id = $1 AND status = 'active' LIMIT 1",
          [phoneNumberId]
        );
        const client = clientResult.rows[0];
        if (!client) {
          diagnostic('change ignorada: nenhum cliente ativo corresponde ao phone_number_id');
          continue;
        }
        diagnostic('cliente ativo encontrado');

        // Atualiza status de mensagens enviadas
        diagnosticStage = 'processamento de statuses';
        for (const status of value.statuses || []) {
          if (status.id) {
            diagnosticStage = 'atualizacao de status no PostgreSQL';
            await pool.query('UPDATE messages SET status = $1 WHERE meta_message_id = $2', [status.status, status.id]);
            diagnostic('atualizacao de status concluida');
          }
        }

        diagnosticStage = 'leitura de messages';
        if (!value.messages || (Array.isArray(value.messages) && value.messages.length === 0)) {
          diagnostic('change sem mensagens recebidas');
        }
        for (const msg of value.messages || []) {
          diagnosticStage = 'interpretacao da mensagem';
          diagnostic('mensagem encontrada', {
            fromPresent: Boolean(msg.from),
            messageIdPresent: Boolean(msg.id),
            textType: msg.type === 'text',
            textBodyPresent: Boolean(msg.text?.body)
          });
          const waId = msg.from;
          const displayName = value.contacts?.find(c => c.wa_id === waId)?.profile?.name || null;
          const body = msg.text?.body || `[${msg.type || 'mensagem'}]`;

          diagnosticStage = 'gravacao de contacts';
          diagnostic('processando contato');
          const contactResult = await pool.query(`
            INSERT INTO contacts (client_id, wa_id, display_name, last_seen_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (client_id, wa_id)
            DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, contacts.display_name), last_seen_at = NOW()
            RETURNING *
          `, [client.id, waId, displayName]);
          const contact = contactResult.rows[0];
          diagnostic('contato processado', { rows: contactResult.rowCount });

          diagnosticStage = 'gravacao de conversations';
          diagnostic('processando conversa');
          const convResult = await pool.query(`
            INSERT INTO conversations (client_id, contact_id, unread_count, last_message_at)
            VALUES ($1, $2, 1, NOW())
            ON CONFLICT (client_id, contact_id)
            DO UPDATE SET unread_count = conversations.unread_count + 1, status = 'open', last_message_at = NOW()
            RETURNING *
          `, [client.id, contact.id]);
          const conv = convResult.rows[0];
          diagnostic('conversa processada', { rows: convResult.rowCount });

          diagnosticStage = 'gravacao de messages';
          diagnostic('gravando mensagem');
          const messageResult = await pool.query(`
            INSERT INTO messages (conversation_id, meta_message_id, direction, message_type, body, status)
            VALUES ($1, $2, 'in', $3, $4, 'received')
            ON CONFLICT (meta_message_id) DO NOTHING
          `, [conv.id, msg.id, msg.type || 'text', body]);
          diagnostic(messageResult.rowCount > 0 ? 'mensagem gravada' : 'mensagem duplicada: insercao ignorada', {
            rows: messageResult.rowCount
          });
        }
      }
    }
    diagnostic('processamento concluido');
  } catch (err) {
    // Somente codigos conhecidos: message/detail/stack podem conter dados sensiveis.
    const safeErrors = {
      '23502': 'campo obrigatorio ausente',
      '23503': 'violacao de chave estrangeira',
      '23505': 'violacao de unicidade',
      '23514': 'violacao de CHECK',
      '42P01': 'tabela inexistente',
      '42703': 'coluna inexistente',
      '42P10': 'restricao incompativel com ON CONFLICT',
      '42501': 'permissao insuficiente',
      '22P02': 'formato de valor invalido',
      '28P01': 'falha de autenticacao no banco',
      '3D000': 'banco inexistente',
      '53300': 'limite de conexoes',
      'ECONNREFUSED': 'conexao recusada',
      'ECONNRESET': 'conexao interrompida',
      'ETIMEDOUT': 'tempo de conexao esgotado',
      'ENOTFOUND': 'host nao resolvido'
    };
    const knownCode = Object.hasOwn(safeErrors, err?.code) ? err.code : null;
    console.error('[WEBHOOK ERROR]', {
      requestId: diagnosticId,
      stage: diagnosticStage,
      code: knownCode || 'UNCLASSIFIED',
      reason: knownCode ? safeErrors[knownCode] : (err instanceof TypeError ? 'estrutura ou tipo inesperado' : 'erro nao classificado; detalhes omitidos'),
      responseAlreadySent: res.headersSent
    });
    console.error('Webhook processing failed.');
  }
});

module.exports = router;
