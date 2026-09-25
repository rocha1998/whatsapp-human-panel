const axios = require('axios');
const { decrypt } = require('../utils/crypto');

async function sendText(client, to, text) {
  const version = process.env.META_GRAPH_VERSION || 'v23.0';
  const token = decrypt(client.encrypted_access_token);
  const url = `https://graph.facebook.com/${version}/${client.phone_number_id}/messages`;

  const { data } = await axios.post(url, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: text }
  }, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    timeout: 20000
  });

  return data;
}

module.exports = { sendText };
