// server.js - the web server. It serves the pages in /public
// and the API under /api.
//
// Locally:   node server.js   (or npm start)
// On Vercel: Vercel detects this Express app automatically (module.exports = app)
//            and sends every request to it.
const express = require('express');
const path = require('path');
const db = require('./db');
const { requireAuth } = require('./auth');

// The database is opened once, then reused for every request.
let readyPromise;
function ready() {
  if (!readyPromise) {
    readyPromise = db.init().catch((err) => {
      readyPromise = null; // allow a retry on the next request
      throw err;
    });
  }
  return readyPromise;
}

function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Vercel/Render sit behind a proxy (needed for https links)

  // Make every request wait for the database to be ready (once per instance).
  app.use(async (req, res, next) => {
    try {
      await ready();
      next();
    } catch (err) {
      next(err);
    }
  });

  app.use(express.json({ limit: '20kb' }));

  // A few simple browser-safety headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.use(express.static(path.join(__dirname, 'public')));

  // Public routes (sign up, log in, reset password)
  app.use('/api', require('./routes/auth'));

  // Everything below needs a logged-in user
  app.use('/api', requireAuth);
  app.use('/api', require('./routes/skills'));
  app.use('/api', require('./routes/users'));
  app.use('/api', require('./routes/requests'));
  app.use('/api', require('./routes/messages'));
  app.use('/api', require('./routes/rooms'));

  // Unknown API route -> JSON error
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // Safety net: any unexpected error becomes a JSON message, never a crash
  app.use((err, req, res, next) => {
    console.error(err);
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request' });
    res.status(500).json({ error: 'Something went wrong on the server' });
  });

  return app;
}

const app = createApp();

// Local / Render / Railway / any normal Node host: start a real listener.
if (require.main === module) {
  ready()
    .then(() => {
      const PORT = process.env.PORT || 3000;
      app.listen(PORT, '0.0.0.0', () => {
        console.log('\nSkill Swap is running: http://localhost:' + PORT);
      });
    })
    .catch((err) => {
      console.error('Could not start the server:', err);
      process.exit(1);
    });
}

// Vercel's zero-config Express support looks for exactly this export.
module.exports = app;
