
require('dotenv').config();

console.log('ESCRO SERVER BUILD CHECK: 2026-10-16-B');
console.log('DATABASE_URL present:', Boolean(process.env.DATABASE_URL));
console.log('NODE_ENV:', process.env.NODE_ENV);

const express = require('express');
const pool = require('./db.js');
const cron = require('node-cron');

const app = express();
app.use(express.json());

// ==========================================
// 1. HEALTH CHECK ROUTE
// ==========================================
app.get('/', (req, res) => {
    res.send('Escrow Bot Sandbox Engine is running smoothly!');
});

// ==========================================
// 2. INITIATE TRANSACTION
// ==========================================
app.post('/api/transactions/initiate', async (req, res) => {
    try {
        const {
            buyer_username,
            seller_username,
            amount,
            buyer_email
        } = req.body;

        if (
            !buyer_username ||
            !seller_username ||
            !amount ||
            !buyer_email ||
            !Number.isFinite(Number(amount)) ||
            Number(amount) <= 0
        ) {
            return res.status(400).json({
                error: 'Valid buyer, seller, amount and email are required.'
            });
        }

        const buyerRes = await pool.query(
            `INSERT INTO users (username)
             VALUES ($1)
             ON CONFLICT (username)
             DO UPDATE SET username = EXCLUDED.username
             RETURNING id`,
            [buyer_username]
        );

        const sellerRes = await pool.query(
            `INSERT INTO users (username)
             VALUES ($1)
             ON CONFLICT (username)
             DO UPDATE SET username = EXCLUDED.username
             RETURNING id`,
            [seller_username]
        );

        const buyerId = buyerRes.rows[0].id;
        const sellerId = sellerRes.rows[0].id;

        // Sandbox PIN generation only. Use a cryptographically secure
        // generator and protected PIN storage before production use.
        const deliveryPin = String(
            Math.floor(1000 + Math.random() * 9000)
        );

        const automatedReleaseAt = new Date(
            Date.now() + 48 * 60 * 60 * 1000
        );

        const transactionRes = await pool.query(
            `INSERT INTO transactions
             (buyer_id, seller_id, amount, escrow_status,
              delivery_pin, automated_release_at)
             VALUES ($1, $2, $3, 'PENDING', $4, $5)
             RETURNING id`,
            [
                buyerId,
                sellerId,
                Number(amount),
                deliveryPin,
                automatedReleaseAt
            ]
        );

        const transactionId = transactionRes.rows[0].id;

        // Placeholder only. This is NOT a real Paystack checkout URL.
        const simulatedCheckoutUrl =
            `https://paystack.com/${transactionId}`;

        return res.status(201).json({
            message: '[SANDBOX ACTIVE] Escrow record registered successfully.',
            transaction_id: transactionId,
            status: 'PENDING',
            payment_url: simulatedCheckoutUrl,
            verification_pin: deliveryPin,
            auto_release_time: automatedReleaseAt
        });
    } catch (error) {
        console.error('Initialization Error:', error.message);
        return res.status(500).json({
            error: 'Unable to initialize transaction.'
        });
    }
});

// ==========================================
// 3A. INSTAGRAM WEBHOOK VERIFICATION
// ==========================================
app.get('/api/webhook/instagram', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const verifyToken = process.env.INSTAGRAM_VERIFY_TOKEN;

    if (
        mode === 'subscribe' &&
        verifyToken &&
        token === verifyToken &&
        challenge
    ) {
        console.log('[Instagram] Webhook verification successful.');
        return res.status(200).send(challenge);
    }

    return res.status(403).send('Verification failed');
});

// ==========================================
// 3B. INSTAGRAM WEBHOOK MESSAGE HANDLER
// ==========================================
app.post('/api/webhook/instagram', async (req, res) => {
    // Acknowledge the webhook payload. This endpoint does not itself
    // send a reply DM; that requires an authenticated Instagram API call.
    try {
        const body = req.body;

        if (body?.object !== 'instagram' || !Array.isArray(body.entry)) {
            return res.status(404).send('Not an Instagram event');
        }

        for (const entry of body.entry) {
            if (!Array.isArray(entry.messaging)) continue;

            for (const event of entry.messaging) {
                if (!event.message || event.message.is_echo) continue;

                const senderId = event.sender?.id;
                const messageText = event.message.text?.trim() || '';

                if (!senderId || !messageText) continue;

                console.log(
                    `[Instagram] Incoming message from sender ${senderId}`
                );

                const parts = messageText.split(/\s+/);

                if (parts[0].toLowerCase() !== 'verify') continue;

                const transactionId = parts[1];
                const inputPin = parts[2];

                if (!transactionId || !inputPin) {
                    console.log(
                        '[Instagram] Verification command is incomplete.'
                    );
                    continue;
                }

                const txRes = await pool.query(
                    `SELECT id, escrow_status, delivery_pin
                     FROM transactions
                     WHERE id = $1`,
                    [transactionId]
                );

                if (txRes.rows.length === 0) {
                    console.log('[Instagram] Transaction not found.');
                    continue;
                }

                const transaction = txRes.rows[0];

                if (transaction.escrow_status !== 'FUNDS_HELD') {
                    console.log(
                        `[Instagram] Transaction status: ${transaction.escrow_status}`
                    );
                    continue;
                }

                if (String(transaction.delivery_pin) !== inputPin) {
                    console.log('[Instagram] Incorrect delivery PIN.');
                    continue;
                }

                // Atomic conditional update prevents completing a
                // transaction that has already changed state.
                const updateRes = await pool.query(
                    `UPDATE transactions
                     SET escrow_status = 'COMPLETED'
                     WHERE id = $1
                       AND escrow_status = 'FUNDS_HELD'
                       AND delivery_pin = $2
                     RETURNING id`,
                    [transactionId, inputPin]
                );

                if (updateRes.rowCount === 1) {
                    console.log(
                        `[Instagram] Transaction ${transactionId} marked COMPLETED.`
                    );
                } else {
                    console.log(
                        '[Instagram] Transaction changed before verification completed.'
                    );
                }
            }
        }

        return res.status(200).send('EVENT_RECEIVED');
    } catch (error) {
        console.error(
            'Instagram webhook error:',
            error.message,
            error.code || ''
        );

        return res.status(500).json({
            error: 'Instagram webhook processing failed.'
        });
    }
});

// ==========================================
// 4. MANUAL DELIVERY PIN VERIFICATION
// ==========================================
app.post('/api/transactions/verify-pin', async (req, res) => {
    try {
        const { transaction_id, delivery_pin } = req.body;

        if (!transaction_id || !delivery_pin) {
            return res.status(400).json({
                error: 'transaction_id and delivery_pin are required.'
            });
        }

        const updateRes = await pool.query(
            `UPDATE transactions
             SET escrow_status = 'COMPLETED'
             WHERE id = $1
               AND escrow_status = 'FUNDS_HELD'
               AND delivery_pin = $2
             RETURNING id`,
            [transaction_id, String(delivery_pin)]
        );

        if (updateRes.rowCount === 0) {
            return res.status(400).json({
                error: 'Transaction not found, PIN incorrect, or funds not held.'
            });
        }

        return res.status(200).json({
            status: 'success',
            message: 'Delivery PIN verified; transaction marked completed.'
        });
    } catch (error) {
        console.error('PIN verification error:', error.message, error.code || '');

        return res.status(500).json({
            error: 'PIN verification failed.'
        });
    }
});

// ==========================================
// 5. PAYSTACK WEBHOOK
// ==========================================
// IMPORTANT: Before production, verify the Paystack signature using the
// raw request body and validate transaction ID, amount and currency.
// Do not treat an unverified webhook as proof of payment.
app.post('/api/payment/webhook', async (req, res) => {
    try {
        const event = req.body;

        if (event?.event !== 'charge.success') {
            return res.status(200).json({
                message: 'Event received and ignored.'
            });
        }

        const transactionId = event.data?.metadata?.transaction_id;

        if (!transactionId) {
            console.error('[Paystack] Missing transaction_id metadata.');
            return res.status(400).json({
                error: 'Missing transaction metadata.'
            });
        }

        const updateRes = await pool.query(
            `UPDATE transactions
             SET escrow_status = 'FUNDS_HELD'
             WHERE id = $1
               AND escrow_status = 'PENDING'
             RETURNING id`,
            [transactionId]
        );

        return res.status(200).json({
            status: 'received',
            updated: updateRes.rowCount === 1
        });
    } catch (error) {
        console.error('Payment webhook error:', error.message, error.code || '');

        return res.status(500).json({
            error: 'Payment webhook processing failed.'
        });
    }
});

// ==========================================
// 6. AUTOMATED RELEASE TIMER
// ==========================================
// This updates a database status only. It does not transfer or pay out
// money. Add dispute checks and a real, verified payout workflow before
// using this with actual transactions.
cron.schedule('0 * * * *', async () => {
    try {
        const result = await pool.query(
            `UPDATE transactions
             SET escrow_status = 'FORCE_RELEASED'
             WHERE escrow_status = 'FUNDS_HELD'
               AND automated_release_at <= NOW()
             RETURNING id`
        );

        if (result.rowCount > 0) {
            console.log(
                `[Cron] ${result.rowCount} transaction(s) marked FORCE_RELEASED.`
            );
        }
    } catch (error) {
        console.error(
            'Cron Job Failure:',
            error.message,
            'code:',
            error.code || 'unknown'
        );
    }
});

// ==========================================
// 7. SERVER INITIALIZATION
// ==========================================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Server is running successfully on port ${PORT}`);
});
