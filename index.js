require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { auth: jwtCheck, requiredScopes, UnauthorizedError } = require('express-oauth2-jwt-bearer');
const { auth, requiresAuth } = require('express-openid-connect');


const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// External URL (lokalno) traži SSL, Internal URL (na Renderu) ne
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : false,
});

const app = express();
app.set('trust proxy', 1); // render je iza https proxyja

// OIDC prijava automatski dodaje rute /login i /logout
app.use(auth({
  authRequired: false,  // stranice su javne, osim onih koje sami zaštitimo
  auth0Logout: true,   // odjava odjavljuje i s Auth0, ne samo iz aplikacije
  baseURL: BASE_URL,
  issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
  clientID: process.env.AUTH0_CLIENT_ID,
  clientSecret: process.env.AUTH0_CLIENT_SECRET,
  secret: process.env.SESSION_SECRET,
  authorizationParams: { response_type: 'code', scope: 'openid profile email' },
}));

const checkToken = jwtCheck({
  audience: process.env.AUTH0_AUDIENCE,
  issuerBaseURL: process.env.AUTH0_ISSUER_BASE_URL,
});

const toJson = (p) => ({
  id: p.id,
  name: p.name,
  document: p.document,
  issuedAt: p.issued_at,
  status: p.status,
});

async function findPass(id) {
  try {
    const { rows } = await db.query('SELECT * FROM passes WHERE id = $1', [id]);
    return rows[0] || null;
  } catch (err) {
    if (err.code === '22P02') return null; // Ako ulaz ne bude oblika UUID
    throw err;
  }
}

app.get('/', async (req, res) => {
  const { rows } = await db.query(
    "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'ACTIVE') AS active FROM passes"
  );
  const loggedIn = req.oidc.isAuthenticated();
  res.send(`
    <h1>Propusnice</h1>
    <p>Ukupno propusnica: <b>${rows[0].total}</b></p>
    <p>Aktivnih propusnica: <b>${rows[0].active}</b></p>
    ${loggedIn
      ? `<p>Prijavljeni ste kao ${req.oidc.user.email || req.oidc.user.name}.</p>
         <p><a href="/admin">Pregled propusnica</a> | <a href="/logout">Odjava</a></p>`
      : `<p><a href="/login">Prijava</a></p>`}
  `);
});

// Adresa iz QR koda
app.get('/info/:id', async (req, res) => {
  const p = await findPass(req.params.id);
  if (!p) {
    return res.status(404).send('<h1>Propusnica ne postoji</h1>');
  }
  res.send(`
    <h1>Propusnica</h1>
    <p>Status: <b>${p.status}</b></p>
    <p>Ime i prezime: ${p.name}</p>
    <p>Dokument: ${p.document}</p>
    <p>Vrijeme izdavanja: ${p.issued_at.toISOString()}</p>
  `);
});

// requiresAuth(): neprijavljenog korisnika šalje na prijavu
app.get('/admin', requiresAuth(), async (req, res) => {
  const { rows } = await db.query('SELECT * FROM passes ORDER BY issued_at DESC');
  const list = rows.map((p) => `
    <tr>
      <td><a href="/info/${p.id}">${p.id}</a></td>
      <td>${p.name}</td>
      <td>${p.document}</td>
      <td>${p.issued_at.toISOString()}</td>
      <td>${p.status}</td>
      <td>
        ${p.status === 'ACTIVE'
          ? `<form method="post" action="/admin/${p.id}/cancel" style="display:inline">
               <button>Poništi</button>
             </form>`
          : ''}
        <form method="post" action="/admin/${p.id}/delete" style="display:inline"
              onsubmit="return confirm('Obrisati propusnicu?')">
          <button>Obriši</button>
        </form>
      </td>
    </tr>`).join('');

  res.send(`
    <p><a href="/">Početna</a> | <a href="/logout">Odjava</a></p>
    <h1>Propusnice</h1>
    <table border="1" cellpadding="6" style="border-collapse:collapse">
      <tr><th>ID</th><th>Ime i prezime</th><th>Dokument</th><th>Izdana</th><th>Status</th><th></th></tr>
      ${list || '<tr><td colspan="6">Nema propusnica</td></tr>'}
    </table>
  `);
});

app.post('/admin/:id/cancel', requiresAuth(), async (req, res) => {
  if (await findPass(req.params.id)) {
    await db.query("UPDATE passes SET status = 'CANCELLED' WHERE id = $1", [req.params.id]);
  }
  res.redirect('/admin');
});

app.post('/admin/:id/delete', requiresAuth(), async (req, res) => {
  if (await findPass(req.params.id)) {
    await db.query('DELETE FROM passes WHERE id = $1', [req.params.id]);
  }
  res.redirect('/admin');
});

app.post('/passes', checkToken, requiredScopes('create:passes'), express.json(), async (req, res) => {
  const { name, document } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || typeof document !== 'string' || !document.trim()) {
    return res.status(400).json({ error: 'ime i dokument su obavezni' });
  }

  const id = crypto.randomUUID();
  await db.query(
    'INSERT INTO passes (id, name, document) VALUES ($1, $2, $3)',
    [id, name.trim(), document.trim()]
  );

  const png = await QRCode.toBuffer(`${BASE_URL}/info/${id}`);
  res.status(201).location(`${BASE_URL}/passes/${id}`).type('image/png').send(png);
});

app.get('/passes/:id', checkToken, requiredScopes('read:passes'), async (req, res) => {
  const p = await findPass(req.params.id);
  if (!p) return res.status(404).json({ error: 'Propusnica ne postoji' });
  res.json(toJson(p));
});


app.use((err, req, res, next) => {
  if (err instanceof UnauthorizedError) {
    if (err.headers) res.set(err.headers);
    return res.status(err.status === 403 ? 403 : 401).json({ error: err.message });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Neispravan JSON' });
  }
  console.error(err); 
  res.status(500).send('Greška na serveru');
});

async function start() {
  await db.query(`CREATE TABLE IF NOT EXISTS passes (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    document TEXT NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'ACTIVE'
  )`);
  app.listen(PORT, () => console.log(`Aplikacija radi na ${BASE_URL}`));
}

start();