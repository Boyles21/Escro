require('dotenv').config();

console.log('ESCRO SERVER BUILD CHECK: PRODUCTION-LIVE-FIX');
console.log('DATABASE_URL present:', Boolean(process.env.DATABASE_URL));
console.log('NODE_ENV:', process.env.NODE_ENV);

const express = require('express');
const pool = require('./db.js');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// Safe request logging
app.use((req, res, next) => {
  console.log(`[Incoming Request] ${req.method} ${req.originalUrl}`);
  next();
});

app.use(express.json({ limit: '1mb' }));

// Home route
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'Escro API'
  });
});

// Database health check
app.get('/health/db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() AS database_time');
    res.status(200).json({
      status: 'connected',
      database_time: result.rows[0].database_time
    });
  } catch (error) {
    console.error('[Database] Health check failed:', error.message);
    res.status(500).json({ status: 'error', message: 'Database connection failed' });
  }
});

// Demo transaction creation endpoint
app.post('/api/transactions/initiate', async (req, res) => {
  try {
    const { buyer_id, seller_id, amount, description } = req.body || {};
    const numericAmount = Number(amount);

    if (!buyer_id || !seller_id || !Number.isFinite(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({ error: 'buyer_id, seller_id, and a positive amount are required' });
    }

    const verificationPin = String(Math.floor(1000 + Math.random() * 9000));

    const result = await pool.query(
      `INSERT INTO transactions (buyer_id, seller_id, amount, description, status, verification_pin, created_at)
       VALUES ($1, $2, $3, $4, 'PENDING', $5, NOW())
       RETURNING id, buyer_id, seller_id, amount, description, status, created_at`,
      [buyer_id, seller_id, numericAmount, description || null, verificationPin]
    );

    return res.status(201).json({
      message: 'Transaction created successfully in sandbox mode.',
      transaction: result.rows[0],
      verification_pin: verificationPin
    });
  } catch (error) {
    console.error('[Transactions] Initiation failed:', error.message);
    return res.status(500).json({ error: 'Could not initiate transaction' });
  }
});

// Instagram webhook verification
app.get('/api/webhook/instagram', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expectedToken = process.env.INSTAGRAM_VERIFY_TOKEN;

  if (mode === 'subscribe' && expectedToken && token === expectedToken) {
    console.log('[Instagram] Webhook verification successful.');
    return res.status(200).send(challenge);
  }

  console.warn('[Instagram] Webhook verification failed.');
  return res.sendStatus(403);
});

// Instagram webhook event handler
app.post('/api/webhook/instagram', async (req, res) => {
  try {
    const body = req.body;

    // LOUD ENTRY LOG: This will print the instant Meta touches your server
    console.log('[Instagram Webhook Root Hit] Payload received!');

    if (body?.object !== 'instagram' || !Array.isArray(body.entry)) {
      console.warn('[Instagram] Invalid webhook payload received.');
      return res.status(400).send('Invalid Instagram webhook payload');
    }

    for (const entry of body.entry) {
      if (Array.isArray(entry.messaging)) {
        for (const event of entry.messaging) {
          if (!event || !event.message || event.message.is_echo) continue;

          const senderId = event.sender?.id;
          // FIX 1: Convert incoming string to lowercase natively to avoid regex crashing on capital letters
          const messageText = typeof event.message.text === 'string' ? event.message.text.trim().toLowerCase() : '';

          console.log(`[Instagram Bot] Text parsed from Sender ID ${senderId}: "${messageText}"`);

          if (!senderId || !messageText) continue;

          // Match command: verify <transactionId> <4-digit PIN>
          const match = messageText.match(/^verify\s\(+(\S+)\\)s+(\d{4})\$/);

          if (!match) {
            console.log('[Instagram] Message text did not match verification command syntax rules.');
            continue;
          }

          const transactionId = match[1];
          const suppliedPin = match[2];

          console.log(`[Instagram Bot] Querying database for Transaction ID: ${transactionId} with PIN: ${suppliedPin}`);

          const transactionResult = await pool.query(
            `SELECT id, status, verification_pin FROM transactions WHERE id::text = $1 LIMIT 1`,
            [transactionId]
          );

          if (transactionResult.rowCount === 0) {
            console.log('[Instagram] Verification failed: transaction record not found.');
            continue;
          }

          const transaction = transactionResult.rows[0];
          console.log(`[Database Record Found] ID: ${transaction.id}, Current Status: ${transaction.status}`);

          if (transaction.status !== 'FUNDS_HELD') {
            console.log(`[Instagram Rejection] Transaction status is ${transaction.status}. Must be FUNDS_HELD to verify.`);
            continue;
          }

          if (String(transaction.verification_pin) !== suppliedPin) {
            console.log('[Instagram Rejection] Verification code mismatch.');
            continue;
          }

          // Success path: Update row
          const updateResult = await pool.query(
            `UPDATE transactions SET status = 'COMPLETED' WHERE id::text = $1 AND status = 'FUNDS_HELD' RETURNING id`,
            [transactionId]
          );

          if (updateResult.rowCount === 1) {
            console.log(`🎉 [Escrow Released] Transaction #${transactionId} successfully set to COMPLETED.`);
          }
        }
      }
    }

    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('[Instagram] Webhook handler failed:', error.message);
    return res.status(500).send('Webhook handler error');
  }
});

// FIX 2: Fully wired-up Paystack Webhook Handler to update status dynamically
app.post('/api/payment/webhook', async (req, res) => {
  try {
    const event = req.body;

    if (event && event.event === 'charge.success') {
      const transactionId = event.data.metadata?.transaction_id;
      
      console.log(`[Paystack Webhook Triggered] Payment received for Transaction ID: ${transactionId}`);

      if (transactionId) {
        await pool.query(
          `UPDATE transactions SET status = 'FUNDS_HELD' WHERE id::text = $1 AND status = 'PENDING'`,
          [String(transactionId)]
        );
        console.log(`[Database Update] Transaction #${transactionId} moved from PENDING to FUNDS_HELD.`);
      }
      return res.status(200).send('EVENT_RECEIVED');
    }

    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('[Paystack] Webhook handler failed:', error.message);
    return res.status(500).send('Webhook handler error');
  }
});

// Manual verification endpoint
app.post('/api/transactions/verify-pin', async (req, res) => {
  try {
    const { transaction_id, pin } = req.body || {};
    if (!transaction_id || !pin) return res.status(400).json({ error: 'transaction_id and pin are required' });

    const result = await pool.query(
      `UPDATE transactions SET status = 'COMPLETED' WHERE id::text = $1 AND verification_pin::text = $2 AND status = 'FUNDS_HELD' RETURNING id, status`,
      [String(transaction_id), String(pin)]
    );

    if (result.rowCount === 0) return res.status(400).json({ error: 'Invalid operation parameters' });
    return res.status(200).json({ message: 'Verification successful', transaction: result.rows[0] });
  } catch (error) {
    console.error('[Transactions] PIN verification failed:', error.message);
    return res.status(500).json({ error: 'Could not verify transaction PIN' });
  }
});

// Scheduled cron task
cron.schedule('0 * * * *', async () => {
  try {
    await pool.query(`UPDATE transactions SET status = 'FORCE_RELEASED' WHERE status = 'FUNDS_HELD' AND created_at < NOW() - INTERVAL '7 days'`);
  } catch (error) {
    console.error('[Cron] Error:', error.message);
  }
});

app.listen(PORT, () => {
  console.log(`Escro server listening on port ${PORT}`);
});
