require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./db');

(async () => {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Defina ADMIN_EMAIL e ADMIN_PASSWORD no .env');
  const hash = await bcrypt.hash(password, 12);
  await pool.query(`
    INSERT INTO admins (email, password_hash)
    VALUES ($1,$2)
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
  `, [email, hash]);
  console.log('Admin criado/atualizado:', email);
  await pool.end();
})().catch(async err => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
