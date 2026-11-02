const { Pool } = require('pg');
const express = require('express');
require('dotenv').config();


const PORT = process.env.PORT || 3000;

const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const db = new Pool({
  connectionString: process.env.DATABASE_URL
});

const app = express();

app.get('/', (req, res) => {
    res.send('Pozdrav, svijete!?');
})

app.listen(PORT, () => console.log(`Aplikacija radi na ${BASE_URL}`));