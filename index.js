require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// External URL (lokalno) traži SSL, Internal URL (na Renderu) ne
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : false,
});

const app = express();

app.get('/', async (req, res) => {
  const { rows } = await db.query(
    "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'ACTIVE') AS active FROM passes"
  );
  res.send(`
    <h1>Propusnice</h1>
    <p>Ukupno propusnica: <b>${rows[0].total}</b></p>
    <p>Aktivnih propusnica: <b>${rows[0].active}</b></p>
  `);
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