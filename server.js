
require('dotenv').config();

const crypto = require('crypto');
const axios = require('axios');
const express = require('express');
const pool = require('./db.js');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;
const SANDBOX_MODE = process.env.ESCRO_SANDBOX_MODE === 'true';
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;
const RELEASE_HOURS = 48;

console.log('ESCRO SERVER BUILD CHECK: PAYMENT-SECURITY-2026-10-22');
console.log('DATABASE_URL present:', Boolean(process.env.DATABASE_URL));
console.log('NODE_ENV:', process.env.NODE_ENV || 'development');
console.log('SANDBOX_MODE:', SANDBOX_MODE);

// Preserve raw request bytes for Paystack signature verification.
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  },
}));

app.use((req, res, next) => {
  console.log(`[Request] ${req.method} ${req.path}`);
  next();
});

// --------------------------------------------------
// HOMEPAGE
// --------------------------------------------------

app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'Escro API',
    mode: SANDBOX_MODE ? 'sandbox' : 'restricted',
  });
});

// --------------------------------------------------
// DATABASE HEALTH CHECK
// --------------------------------------------------

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

// --------------------------------------------------
// CREATE TRANSACTION AND INITIALIZE PAYSTACK CHECKOUT
// SANDBOX ONLY
// --------------------------------------------------

app.post('/api/transactions/initiate', async (req, res) => {
  let transactionId;
  let reference;

  try {
    if (!SANDBOX_MODE) {
      return res.status(403).json({
        error: 'Payment initialization is disabled outside sandbox mode.',
      });
    }

    const secretKey = process.env.PAYSTACK_SECRET_KEY;

    if (!secretKey || !secretKey.startsWith('sk_test_')) {
      return res.status(503).json({
        error: 'A Paystack test secret key must be configured.',
      });
    }

    const { buyer_id, seller_id, amount, email } = req.body || {};

    const buyerId = Number(buyer_id);
    const sellerId = Number(seller_id);
    const numericAmount = Number(amount);
    const emailAddress =
      typeof email === 'string' ? email.trim().toLowerCase() : '';

    const amountKobo = Math.round(numericAmount * 100);

    if (
      !Number.isSafeInteger(buyerId) ||
      buyerId <= 0 ||
      !Number.isSafeInteger(sellerId) ||
      sellerId <= 0 ||
      buyerId === sellerId ||
      !Number.isFinite(numericAmount) ||
      numericAmount <= 0 ||
      !Number.isSafeInteger(amountKobo) ||
      amountKobo <= 0 ||
      Math.abs(numericAmount * 100 - amountKobo) > 0.000001 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailAddress)
    ) {
      return res.status(400).json({
        error: 'Provide valid buyer_id, seller_id, amount, and email. Amount must be in naira with at most two decimal places.',
      });
    }

    const usersResult = await pool.query(
      `SELECT id
         FROM users
        WHERE id = ANY($1::integer[])`,
      [[buyerId, sellerId]]
    );

    if (usersResult.rowCount !== 2) {
      return res.status(400).json({
        error: 'Both buyer and seller must exist in the users table.',
      });
    }

    const deliveryPin = String(crypto.randomInt(1000, 10000));

    const created = await pool.query(
      `INSERT INTO transactions (
          buyer_id,
          seller_id,
          amount,
          escrow_status,
          delivery_pin,
          automated_release_at,
          created_at,
          updated_at,
          delivery_pin_attempts
       )
       VALUES ($1, $2, $3, 'PENDING', $4, NULL, NOW(), NOW(), 0)
       RETURNING id, buyer_id, seller_id, amount, escrow_status, created_at`,
      [buyerId, sellerId, amountKobo / 100, deliveryPin]
    );

    transactionId = created.rows[0].id;

    reference =
      `ESCRO-${transactionId}-${crypto.randomBytes(8).toString('hex')}`;

    await pool.query(
      `UPDATE transactions
          SET paystack_reference = $1,
              updated_at = NOW()
        WHERE id = $2`,
      [reference, transactionId]
    );

    let paystackResponse;

    try {
      paystackResponse = await axios.post(
        'https://api.paystack.co/transaction/initialize',
        {
          email: emailAddress,
          amount: String(amountKobo),
          currency: 'NGN',
          reference,
          metadata: {
            transaction_id: transactionId,
            service: 'Escro',
          },
        },
        {
          headers: {
            Authorization: `Bearer ${secretKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        }
      );
    } catch (error) {
      // Preserve PENDING and the reference because a network timeout
      // does not prove that Paystack failed to initialize checkout.
      console.error(
        '[Paystack] Initialization request failed:',
        error.response?.data?.message || error.message
      );

      return res.status(502).json({
        error: 'Checkout initialization could not be confirmed. Check the transaction before retrying.',
        transaction_id: transactionId,
        reference,
      });
    }

    const paymentData = paystackResponse.data?.data;

    if (
      paystackResponse.data?.status !== true ||
      !paymentData?.authorization_url ||
      paymentData.reference !== reference
    ) {
      console.error('[Paystack] Invalid initialization response.');

      return res.status(502).json({
        error: 'Paystack did not return a valid checkout response.',
        transaction_id: transactionId,
        reference,
      });
    }

    console.log(
      `[Paystack] Checkout initialized for transaction ${transactionId}.`
    );

    return res.status(201).json({
      message: 'Sandbox checkout initialized. Payment is not yet confirmed.',
      transaction: {
        ...created.rows[0],
        paystack_reference: reference,
      },
      payment_url: paymentData.authorization_url,
      reference,
      delivery_pin: deliveryPin,
    });
  } catch (error) {
    console.error(
      '[Transactions] Initiation failed:',
      error.response?.data?.message || error.message
    );

    return res.status(500).json({
      error: 'Could not initiate transaction.',
      ...(transactionId ? { transaction_id: transactionId } : {}),
    });
  }
});

// --------------------------------------------------
// INSTAGRAM WEBHOOK VERIFICATION
// --------------------------------------------------

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

// --------------------------------------------------
// INSTAGRAM MESSAGE EVENT NORMALIZATION
// --------------------------------------------------

function collectInstagramMessageEvents(entry) {
  const events = [];

  if (Array.isArray(entry.messaging)) {
    for (const event of entry.messaging) {
      if (event?.message) {
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

// --------------------------------------------------
// DELIVERY PIN VERIFICATION HELPER
// --------------------------------------------------

async function verifyDeliveryPin(transactionId, suppliedPin) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `SELECT id, escrow_status, delivery_pin,
              delivery_pin_attempts, delivery_pin_locked_until
         FROM transactions
        WHERE id = $1
        FOR UPDATE`,
      [transactionId]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'NOT_FOUND' };
    }

    const transaction = result.rows[0];

    if (transaction.escrow_status !== 'FUNDS_HELD') {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'INVALID_STATUS' };
    }

    if (
      transaction.delivery_pin_locked_until &&
      new Date(transaction.delivery_pin_locked_until) > new Date()
    ) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'LOCKED' };
    }

    if (String(transaction.delivery_pin) !== String(suppliedPin)) {
      const attempts = Number(transaction.delivery_pin_attempts || 0) + 1;
      const lockUntil = attempts >= PIN_MAX_ATTEMPTS
        ? new Date(Date.now() + PIN_LOCK_MINUTES * 60 * 1000)
        : null;

      await client.query(
        `UPDATE transactions
            SET delivery_pin_attempts = $2,
                delivery_pin_locked_until = $3,
                updated_at = NOW()
          WHERE id = $1`,
        [transactionId, attempts, lockUntil]
      );

      await client.query('COMMIT');

      return {
        ok: false,
        reason: lockUntil ? 'LOCKED' : 'INCORRECT_PIN',
      };
    }

    const updated = await client.query(
      `UPDATE transactions
          SET escrow_status = 'DELIVERY_CONFIRMED',
              delivery_confirmed_at = NOW(),
              delivery_pin_locked_until = NULL,
              updated_at = NOW()
        WHERE id = $1
          AND escrow_status = 'FUNDS_HELD'
      RETURNING id, escrow_status, delivery_confirmed_at`,
      [transactionId]
    );

    await client.query('COMMIT');

    if (updated.rowCount !== 1) {
      return { ok: false, reason: 'INVALID_STATUS' };
    }

    return { ok: true, transaction: updated.rows[0] };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// --------------------------------------------------
// PROCESS INSTAGRAM VERIFICATION COMMAND
// Example: verify 5 4169
// --------------------------------------------------

async function processInstagramMessage(event) {
  if (!event?.message || event.message.is_echo) {
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

  const match = rawText.match(/^verify\s+(\d+)\s+(\d{4})$/i);

  if (!match) {
    console.log('[Instagram] Message is not a verification command.');
    return;
  }

  // IMPORTANT:
  // This verifies the PIN but does not yet associate the Instagram
  // sender with a trusted buyer, seller, or courier account.
  // Do not use this as production authorization.
  const transactionId = Number(match[1]);
  const suppliedPin = match[2];

  if (!Number.isSafeInteger(transactionId) || transactionId <= 0) {
    return;
  }

  const result = await verifyDeliveryPin(transactionId, suppliedPin);

  if (result.ok) {
    console.log(
      `[Instagram] Delivery confirmed for transaction ${transactionId}. No payout initiated.`
    );
  } else {
    console.log(
      `[Instagram] Verification unsuccessful for transaction ${transactionId}: ${result.reason}`
    );
  }
}

// --------------------------------------------------
// INSTAGRAM WEBHOOK RECEIVER
// --------------------------------------------------

app.post('/api/webhook/instagram', async (req, res) => {
  try {
    const body = req.body;

    if (
      body?.object !== 'instagram' ||
      !Array.isArray(body.entry)
    ) {
      console.warn('[Instagram] Invalid webhook payload.');
      return res.status(400).send('Invalid Instagram webhook payload');
    }

    for (const entry of body.entry) {
      const events = collectInstagramMessageEvents(entry);

      console.log(`[Instagram] Message events found: ${events.length}`);

      for (const event of events) {
        try {
          await processInstagramMessage(event);
        } catch (error) {
          console.error(
            '[Instagram] Message processing failed:',
            error.message
          );
        }
      }
    }

    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    console.error('[Instagram] Webhook handler failed:', error.message);
    return res.status(500).send('Webhook handler error');
  }
});

// --------------------------------------------------
// PAYSTACK WEBHOOK
// Verifies signature, reference, amount, currency and status.
// --------------------------------------------------

app.post('/api/payment/webhook', async (req, res) => {
  try {
    const secretKey = process.env.PAYSTACK_SECRET_KEY;
    const signature = req.get('x-paystack-signature');

    if (!secretKey) {
      console.error('[Paystack] Secret key is not configured.');
      return res.status(500).send('Payment webhook is not configured');
    }

    if (!signature || !req.rawBody) {
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

    if (event?.event !== 'charge.success') {
      return res.status(200).send('EVENT_RECEIVED');
    }

    const data = event.data;
    const reference = data?.reference;
    const transactionId = data?.metadata?.transaction_id;
    const amountKobo = Number(data?.amount);
    const currency = data?.currency;

    if (
      data?.status !== 'success' ||
      typeof reference !== 'string' ||
      !reference ||
      !transactionId ||
      !Number.isSafeInteger(Number(transactionId)) ||
      !Number.isSafeInteger(amountKobo) ||
      amountKobo <= 0 ||
      currency !== 'NGN'
    ) {
      console.warn('[Paystack] Invalid payment event fields.');
      return res.status(400).send('Invalid payment event');
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const result = await client.query(
        `SELECT id, amount, escrow_status, paystack_reference
           FROM transactions
          WHERE id = $1
          FOR UPDATE`,
        [Number(transactionId)]
      );

      if (result.rowCount === 0) {
        await client.query('ROLLBACK');
        console.warn('[Paystack] Transaction not found.');
        return res.status(404).send('Transaction not found');
      }

      const transaction = result.rows[0];

      if (transaction.paystack_reference !== reference) {
        await client.query('ROLLBACK');
        console.warn('[Paystack] Reference mismatch.');
        return res.status(400).send('Payment reference mismatch');
      }

      const expectedKobo = Math.round(Number(transaction.amount) * 100);

      if (amountKobo !== expectedKobo) {
        await client.query('ROLLBACK');
        console.warn('[Paystack] Amount mismatch.');
        return res.status(400).send('Payment amount mismatch');
      }

      if (transaction.escrow_status === 'FUNDS_HELD') {
        await client.query('COMMIT');
        return res.status(200).send('EVENT_RECEIVED');
      }

      if (transaction.escrow_status !== 'PENDING') {
        await client.query('ROLLBACK');
        console.warn(
          `[Paystack] Cannot confirm transaction in status ${transaction.escrow_status}.`
        );
        return res.status(200).send('EVENT_RECEIVED');
      }

      await client.query(
        `UPDATE transactions
            SET escrow_status = 'FUNDS_HELD',
                payment_confirmed_at = NOW(),
                automated_release_at =
                  NOW() + ($2 * INTERVAL '1 hour'),
                updated_at = NOW()
          WHERE id = $1
            AND escrow_status = 'PENDING'`,
        [transaction.id, RELEASE_HOURS]
      );

      await client.query('COMMIT');

      console.log(
        `[Paystack] Payment confirmed for transaction ${transaction.id}. Release deadline scheduled for review.`
      );

      return res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('[Paystack] Webhook failed:', error.message);
    return res.status(500).send('Webhook handler error');
  }
});

// --------------------------------------------------
// MANUAL PIN ENDPOINT
// Disabled until proper user/courier authentication exists.
// --------------------------------------------------

app.post('/api/transactions/verify-pin', (req, res) => {
  return res.status(403).json({
    error: 'Manual PIN verification is disabled until authenticated buyer, seller, or courier access is implemented.',
  });
});

// --------------------------------------------------
// RELEASE DEADLINE MONITOR
// This does not automatically transfer money.
// --------------------------------------------------

cron.schedule('0 * * * *', async () => {
  try {
    const result = await pool.query(
      `SELECT id, escrow_status, automated_release_at, dispute_status
         FROM transactions
        WHERE escrow_status IN ('FUNDS_HELD', 'DELIVERY_CONFIRMED')
          AND automated_release_at IS NOT NULL
          AND automated_release_at <= NOW()
          AND dispute_status = 'NONE'
        ORDER BY automated_release_at ASC`
    );

    if (result.rowCount > 0) {
      console.warn(
        `[Cron] ${result.rowCount} transaction(s) have reached their release-review deadline. No funds were released.`
      );

      for (const transaction of result.rows) {
        console.warn(
          `[Cron] Review transaction ${transaction.id}, status ${transaction.escrow_status}.`
        );
      }
    }
  } catch (error) {
    console.error('[Cron] Release deadline check failed:', error.message);
  }
});

// --------------------------------------------------
// GLOBAL ERROR HANDLER
// --------------------------------------------------

app.use((error, req, res, next) => {
  console.error('[Server] Unhandled request error:', error.message);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    error: 'An unexpected server error occurred.',
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`Escro server listening on port ${PORT}`);
});
