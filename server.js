require('dotenv').config();

console.log('ESCRO SERVER BUILD CHECK: 2026-10-16-C');
console.log('DATABASE_URL present:', Boolean(process.env.DATABASE_URL));
console.log('NODE_ENV:', process.env.NODE_ENV);

const express = require('express');
const pool = require('./db.js');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// Safe request logging. Never log secrets or full request bodies.
app.use((req, res, next) => {
  console.log(`[Request] ${req.method} ${req.originalUrl}`);
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

    res.status(500).json({
      status: 'error',
      message: 'Database connection failed'
    });
  }
});

// Demo transaction creation endpoint
app.post('/api/transactions/initiate', async (req, res) => {
  try {
    const { buyer_id, seller_id, amount, description } = req.body || {};
    const numericAmount = Number(amount);

    if (
      !buyer_id ||
      !seller_id ||
      !Number.isFinite(numericAmount) ||
      numericAmount <= 0
    ) {
      return res.status(400).json({
        error: 'buyer_id, seller_id, and a positive amount are required'
      });
    }

    const verificationPin = String(
      Math.floor(1000 + Math.random() * 9000)
    );

    const result = await pool.query(
      `INSERT INTO transactions
       (buyer_id, seller_id, amount, description, status,
        verification_pin, created_at)
       VALUES ($1, $2, $3, $4, 'PENDING', $5, NOW())
       RETURNING id, buyer_id, seller_id, amount,
                 description, status, created_at`,
      [
        buyer_id,
        seller_id,
        numericAmount,
        description || null,
        verificationPin
      ]
    );

    // Demo only. Do not expose PINs this way in production.
    return res.status(201).json({
      message:
        'Transaction created. Payment integration must be completed before using real funds.',
      transaction: result.rows[0],
      verification_pin: verificationPin
    });
  } catch (error) {
    console.error('[Transactions] Initiation failed:', error.message);

    return res.status(500).json({
      error: 'Could not initiate transaction'
    });
  }
});

// Instagram webhook verification
app.get('/api/webhook/instagram', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expectedToken = process.env.INSTAGRAM_VERIFY_TOKEN;

  if (
    mode === 'subscribe' &&
    expectedToken &&
    token === expectedToken
  ) {
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

    console.log(
      '[Instagram] Webhook object:',
      body?.object || 'missing'
    );

    if (
      body?.object !== 'instagram' ||
      !Array.isArray(body.entry)
    ) {
      console.warn('[Instagram] Invalid webhook payload received.');
      return res.status(400).send('Invalid Instagram webhook payload');
    }

    console.log('[Instagram] Entry count:', body.entry.length);

    for (const entry of body.entry) {
      console.log(
        '[Instagram] Entry fields:',
        Object.keys(entry || {})
      );

      // Actual messaging events commonly arrive here.
      if (Array.isArray(entry.messaging)) {
        console.log(
          '[Instagram] Messaging event count:',
          entry.messaging.length
        );

        for (const event of entry.messaging) {
          if (!event || !event.message || event.message.is_echo) {
            continue;
          }

          const senderId = event.sender?.id;

          const messageText =
            typeof event.message.text === 'string'
              ? event.message.text.trim()
              : '';

          console.log(
            '[Instagram] Incoming messaging event received.',
            {
              hasSenderId: Boolean(senderId),
              hasText: Boolean(messageText),
              messageType: event.message?.attachments?.length
                ? 'attachment'
                : 'text'
            }
          );

          if (!senderId || !messageText) {
            continue;
          }

          // Demo command: verify <transactionId> <4-digit PIN>
          const match = messageText.match(
            /^verify\s+(\S+)\s+(\d{4})$/i
          );

          if (!match) {
            console.log(
              '[Instagram] Message did not match the verification command.'
            );
            continue;
          }

          const transactionId = match[1];
          const suppliedPin = match[2];

          const transactionResult = await pool.query(
            `SELECT id, status, verification_pin
             FROM transactions
             WHERE id::text = $1
             LIMIT 1`,
            [transactionId]
          );

          if (transactionResult.rowCount === 0) {
            console.log(
              '[Instagram] Verification failed: transaction not found.'
            );
            continue;
          }

          const transaction = transactionResult.rows[0];

          if (
            transaction.status !== 'FUNDS_HELD' ||
            String(transaction.verification_pin) !== suppliedPin
          ) {
            console.log(
              '[Instagram] Verification failed: status or PIN did not match.'
            );
            continue;
          }

          // Conditional update prevents completing a transaction
          // that is no longer in FUNDS_HELD status.
          const updateResult = await pool.query(
            `UPDATE transactions
             SET status = 'COMPLETED',
                 completed_at = NOW()
             WHERE id::text = $1
               AND status = 'FUNDS_HELD'
               AND verification_pin::text = $2
             RETURNING id`,
            [transactionId, suppliedPin]
          );

          if (updateResult.rowCount === 1) {
            console.log(
              '[Instagram] Transaction verification completed:',
              transactionId
            );
          } else {
            console.log(
              '[Instagram] Transaction status changed before verification could complete.'
            );
          }
        }
      } else {
        console.log('[Instagram] Messaging events: not an array');
      }

      // Meta's Test button may send a changes payload.
      // Log its structure without logging private message content.
      if (Array.isArray(entry.changes)) {
        console.log(
          '[Instagram] Change event count:',
          entry.changes.length
        );

        for (const change of entry.changes) {
          console.log('[Instagram] Change event received:', {
            field: change?.field || 'unknown',
            valueKeys:
              change?.value && typeof change.value === 'object'
                ? Object.keys(change.value)
                : []
          });
        }
      }
    }

    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error(
      '[Instagram] Webhook handler failed:',
      error.message
    );

    return res.status(500).send('Webhook handler error');
  }
});

// Paystack webhook placeholder.
// Does not mark payments as paid without verification.
app.post('/api/payment/webhook', async (req, res) => {
  try {
    const event = req.body;

    if (
      event?.event !== 'charge.success' ||
      !event?.data?.reference
    ) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    console.warn(
      '[Paystack] Sandbox placeholder received a charge.success event. Signature and payment details are not verified.'
    );

    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error(
      '[Paystack] Webhook handler failed:',
      error.message
    );

    return res.status(500).send('Webhook handler error');
  }
});

// Demo-only PIN verification endpoint.
// Authentication and authorization are required before production.
app.post('/api/transactions/verify-pin', async (req, res) => {
  try {
    const { transaction_id, pin } = req.body || {};

    if (!transaction_id || !pin) {
      return res.status(400).json({
        error: 'transaction_id and pin are required'
      });
    }

    const result = await pool.query(
      `UPDATE transactions
       SET status = 'COMPLETED',
           completed_at = NOW()
       WHERE id::text = $1
         AND verification_pin::text = $2
         AND status = 'FUNDS_HELD'
       RETURNING id, status, completed_at`,
      [String(transaction_id), String(pin)]
    );

    if (result.rowCount === 0) {
      return res.status(400).json({
        error:
          'Transaction not found, PIN invalid, or funds are not held'
      });
    }

    return res.status(200).json({
      message: 'Verification successful',
      transaction: result.rows[0]
    });
  } catch (error) {
    console.error(
      '[Transactions] PIN verification failed:',
      error.message
    );

    return res.status(500).json({
      error: 'Could not verify transaction PIN'
    });
  }
});

// Demo-only scheduled release.
// This changes database status only. It does not transfer money.
cron.schedule('0 * * * *', async () => {
  try {
    const result = await pool.query(
      `UPDATE transactions
       SET status = 'FORCE_RELEASED'
       WHERE status = 'FUNDS_HELD'
         AND created_at < NOW() - INTERVAL '7 days'
       RETURNING id`
    );

    if (result.rowCount > 0) {
      console.log(
        `[Cron] Marked ${result.rowCount} expired transaction(s) FORCE_RELEASED (database status only).`
      );
    }
  } catch (error) {
    console.error(
      '[Cron] Expired transaction check failed:',
      error.message
    );
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Escro server listening on port ${PORT}`);
});