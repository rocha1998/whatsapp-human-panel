require('dotenv').config();
const sessionSecret = process.env.SESSION_SECRET;
if (typeof sessionSecret !== 'string' || !sessionSecret.trim()) {
  console.error('SESSION_SECRET não está configurado.');
  process.exit(1);
}

const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const pool = require('./db');
const path = require('path');
const authRoutes = require('./routes/auth');
const webhookRoutes = require('./routes/webhook');
const panelRoutes = require('./routes/panel');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const sessionMaxAge = 8 * 60 * 60 * 1000;

if (isProduction) app.set('trust proxy', 1);

app.get('/health', (_, res) => res.status(200).json({ ok: true }));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => {
    if (req.method === 'POST' && req.path === '/webhook') {
      req.rawBody = Buffer.from(buf);
    }
  }
}));
app.use(express.static(path.join(__dirname, 'public')));
const sessionMiddleware = session({
  store: new PgSession({
    pool,
    schemaName: 'public',
    tableName: 'user_sessions',
    createTableIfMissing: false,
    ttl: sessionMaxAge / 1000,
    errorLog: () => console.error('Session storage error.')
  }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: isProduction, maxAge: sessionMaxAge }
});
app.use((req, res, next) => {
  sessionMiddleware(req, res, err => {
    if (err) {
      console.error('Session storage error.');
      if (res.headersSent) return next(new Error('Session storage error.'));
      return res.sendStatus(503);
    }
    next();
  });
});

app.use(authRoutes);
app.use(webhookRoutes);
app.use(panelRoutes);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Painel em http://localhost:${port}`));
