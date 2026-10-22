
require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const pool = require('./db.js');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

console.log('ESCRO SERVER BUILD CHECK: SCHEMA-FIX-2026-10-22');
console.log('DATABASE_URL present:', Boolean(process.env.DATABASE_URL));
console.log('NODE_ENV:', process.env.NODE_ENV || 'development');

// Preserve the original request bytes for Paystack signature verification.
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  },
}));

app.use((req, res, next) => {
  console.log(`[Request] ${req.method} ${req.originalUrl}`);
  next();
});

// Homepage
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'Escro API',
  });
});

// Database health check
app.get('/health/db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() AS database_time');

    res.status(200).json({
      status: 'connected',
      database_time: result.rows[0].database_time,
    });
  } catch (error) {
    console.error('[Database] Health check failed:', error.message);

    res.status(500).json({
      status: 'error',
      message: 'Database connection failed',
    });
  }
});

// Create a transaction in demo mode.
// This does not collect or confirm payment.
app.post('/api/transactions/initiate', async (req, res) => {
  try {
    const { buyer_id, seller_id, amount } = req.body || {};

    const buyerId = Number(buyer_id);
    const sellerId = Number(seller_id);
    const numericAmount = Number(amount);

    if (
      !Number.isInteger(buyerId) ||
      buyerId <= 0 ||
      !Number.isInteger(sellerId) ||
      sellerId <= 0 ||
      !Number.isFinite(numericAmount) ||
      numericAmount <= 0
    ) {
      return res.status(400).json({
        error: 'Valid buyer_id, seller_id, and positive amount are required',
      });
    }

    // Generate a four-digit delivery PIN.
    const deliveryPin = String(crypto.randomInt(1000, 10000));

    const result = await pool.query(
      `INSERT INTO transactions
        (
          buyer_id,
          seller_id,
          amount,
          escrow_status,
          delivery_pin,
          automated_release_at,
          created_at
        )
       VALUES ($1, $2, $3, 'PENDING', $4, NULL, NOW())
       RETURNING
          id,
          buyer_id,
          seller_id,
          amount,
          escrow_status,
          automated_release_at,
          created_at`,
      [buyerId, sellerId, numericAmount, deliveryPin]
    );

    const response = {
      message: 'Transaction created in demo mode. Payment is not yet confirmed.',
      transaction: result.rows[0],
    };

    // Only expose the PIN when explicitly running in sandbox mode.
    if (process.env.ESCRO_SANDBOX_MODE === 'true') {
      response.delivery_pin = deliveryPin;
    }

    return res.status(201).json(response);
  } catch (error) {
    console.error('[Transactions] Initiation failed:', error.message);

    return res.status(500).json({
      error: 'Could not initiate transaction',
    });
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

// Collect Instagram message events from supported webhook structures.
function collectInstagramMessageEvents(entry) {
  const events = [];

  if (Array.isArray(entry.messaging)) {
    for (const event of entry.messaging) {
      if (event && event.message) {
        events.push(event);
      }
    }
  }

  if (Array.isArray(entry.changes)) {
    for (const change of entry.changes) {
      if (change?.field !== 'messages' || !change.value) {
        continue;
      }

      const value = change.value;

      if (value.message) {
        events.push({
          sender: value.sender,
          recipient: value.recipient,
          timestamp: value.timestamp,
          message: value.message,
        });
      }

      if (Array.isArray(value.messages)) {
        for (const message of value.messages) {
          events.push({
            sender: value.sender ||
              (message.from ? { id: message.from } : undefined),
            recipient: value.recipient,
            timestamp: value.timestamp,
            message,
          });
        }
      }
    }
  }

  return events;
}

// Process a verification command.
// Example: verify 5 4169
async function processInstagramMessage(event) {
  if (!event || !event.message || event.message.is_echo) {
    return;
  }

  const senderId = event.sender?.id;

  const rawText =
    typeof event.message.text === 'string'
      ? event.message.text.trim()
      : '';

  if (!senderId || !rawText) {
    return;
  }

  console.log(`[Instagram] Incoming message from sender ${senderId}`);

  // Correct regular expression.
  // Matches: verify 5 4169
  const match = rawText.match(/^verify\s+(\d+)\s+(\d{4})$/i);

  if (!match) {
    console.log(
      '[Instagram] Message does not match: verify <transaction_id> <4-digit PIN>'
    );
    return;
  }

  const transactionId = match[1];
  const suppliedPin = match[2];

  const transactionResult = await pool.query(
    `SELECT id, escrow_status, delivery_pin
       FROM transactions
      WHERE id::text = $1
      LIMIT 1`,
    [transactionId]
  );

  if (transactionResult.rowCount === 0) {
    console.log(`[Instagram] Transaction ${transactionId} not found.`);
    return;
  }

  const transaction = transactionResult.rows[0];

  if (transaction.escrow_status !== 'FUNDS_HELD') {
    console.log(
      `[Instagram] Transaction ${transactionId} is ${transaction.escrow_status}; expected FUNDS_HELD.`
    );
    return;
  }

  if (String(transaction.delivery_pin) !== suppliedPin) {
    console.log(
      `[Instagram] Incorrect delivery PIN for transaction ${transactionId}.`
    );
    return;
  }

  // Records delivery confirmation only.
  // It does not transfer money or pay out the seller.
  const updateResult = await pool.query(
    `UPDATE transactions
        SET escrow_status = 'DELIVERY_CONFIRMED'
      WHERE id::text = $1
        AND escrow_status = 'FUNDS_HELD'
        AND delivery_pin::text = $2
      RETURNING id, escrow_status`,
    [transactionId, suppliedPin]
  );

  if (updateResult.rowCount === 1) {
    console.log(
      `[Instagram] Transaction ${transactionId} delivery confirmed. No payout was initiated.`
    );
  }
}

// Instagram webhook receiver
app.post('/api/webhook/instagram', async (req, res) => {
  try {
    const body = req.body;

    console.log('[Instagram Webhook] POST received.');

    if (
      body?.object !== 'instagram' ||
      !Array.isArray(body.entry)
    ) {
      console.warn('[Instagram] Invalid webhook payload.');
      return res.status(400).send('Invalid Instagram webhook payload');
    }

    for (const entry of body.entry) {
      const events = collectInstagramMessageEvents(entry);

      console.log(
        `[Instagram] Message events found: ${events.length}`
      );

      for (const event of events) {
        await processInstagramMessage(event);
      }
    }

    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('[Instagram] Webhook handler failed:', error.message);

    return res.status(500).send('Webhook handler error');
  }
});

// Paystack webhook.
// Verifies the webhook signature and checks the transaction amount
// and currency before changing PENDING to FUNDS_HELD.
app.post('/api/payment/webhook', async (req, res) => {
  try {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    const signature = req.get('x-paystack-signature');

    if (!secretKey) {
      console.error('[Paystack] PAYSTACK_SECRET_KEY is not configured.');
      return res.status(500).send('Payment webhook is not configured');
    }

    if (!signature || !req.rawBody) {
      console.warn('[Paystack] Missing signature or request body.');
      return res.sendStatus(401);
    }

    const expectedSignature = crypto
      .createHmac('sha512', secretKey)
      .update(req.rawBody)
      .digest('hex');

    const receivedBuffer = Buffer.from(signature, 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

    if (
      receivedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
    ) {
      console.warn('[Paystack] Invalid webhook signature.');
      return res.sendStatus(401);
    }

    const event = req.body;

    if (
      event?.event !== 'charge.success' ||
      event?.data?.status !== 'success'
    ) {
      return res.status(200).send('EVENT_RECEIVED');
    }

    const transactionId = event.data.metadata?.transaction_id;
    const amountKobo = Number(event.data.amount);
    const currency = event.data.currency;

    if (
      !transactionId ||
      !Number.isFinite(amountKobo) ||
      currency !== 'NGN'
    ) {
      console.warn('[Paystack] Invalid payment metadata, amount, or currency.');
      return res.status(400).send('Invalid payment event');
    }

    const result = await pool.query(
      `SELECT id, amount, escrow_status
         FROM transactions
        WHERE id::text = $1
        LIMIT 1`,
      [String(transactionId)]
    );

    if (result.rowCount === 0) {
      console.warn(`[Paystack] Transaction ${transactionId} not found.`);
      return res.status(404).send('Transaction not found');
    }

    const transaction = result.rows[0];
    const expectedKobo = Math.round(Number(transaction.amount) * 100);

    if (amountKobo !== expectedKobo) {
      console.warn(`[Paystack] Amount mismatch for transaction ${transactionId}.`);
      return res.status(400).send('Payment amount mismatch');
    }

    if (transaction.escrow_status === 'FUNDS_HELD') {
      return res.status(200).send('EVENT_RECEIVED');
    }

    if (transaction.escrow_status !== 'PENDING') {
      console.warn(
        `[Paystack] Transaction ${transactionId} has status ${transaction.escrow_status}.`
      );
      return res.status(200).send('EVENT_RECEIVED');
    }

    await pool.query(
      `UPDATE transactions
          SET escrow_status = 'FUNDS_HELD'
        WHERE id::text = $1
          AND escrow_status = 'PENDING'`,
      [String(transactionId)]
    );

    console.log(
      `[Paystack] Payment verified for transaction ${transactionId}.`
    );

    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('[Paystack] Webhook handler failed:', error.message);

    return res.status(500).send('Webhook handler error');
  }
});

// Manual delivery PIN verification endpoint.
// This records delivery confirmation, not payment release.
app.post('/api/transactions/verify-pin', async (req, res) => {
  try {
    const { transaction_id, pin } = req.body || {};

    if (
      !transaction_id ||
      !/^\d{4}$/.test(String(pin || ''))
    ) {
      return res.status(400).json({
        error: 'transaction_id and a four-digit PIN are required',
      });
    }

    const result = await pool.query(
      `UPDATE transactions
          SET escrow_status = 'DELIVERY_CONFIRMED'
        WHERE id::text = $1
          AND delivery_pin::text = $2
          AND escrow_status = 'FUNDS_HELD'
      RETURNING id, escrow_status`,
      [String(transaction_id), String(pin)]
    );

    if (result.rowCount === 0) {
      return res.status(400).json({
        error: 'Transaction not found, PIN incorrect, or funds are not held',
      });
    }

    return res.status(200).json({
      message: 'Delivery PIN verified. No payout was initiated.',
      transaction: result.rows[0],
    });
  } catch (error) {
    console.error('[Transactions] PIN verification failed:', error.message);

    return res.status(500).json({
      error: 'Could not verify transaction PIN',
    });
  }
});

// Scheduled safety check.
// This deliberately does not automatically release funds.
cron.schedule('0 * * * *', async () => {
  try {
    const result = await pool.query(
      `SELECT id
         FROM transactions
        WHERE escrow_status = 'FUNDS_HELD'
          AND automated_release_at IS NOT NULL
          AND automated_release_at <= NOW()`
    );

    if (result.rowCount > 0) {
      console.warn(
        `[Cron] ${result.rowCount} transaction(s) reached their release deadline. Review them manually. No funds were released.`
      );
    }
  } catch (error) {
    console.error(
      '[Cron] Expired transaction check failed:',
      error.message
    );
  }
});

app.listen(PORT, () => {
  console.log(`Escro server listening on port ${PORT}`);
});
