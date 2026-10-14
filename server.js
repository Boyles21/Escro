const express = require('express');
const pool = require('./db.js'); // Import our actual database pool connection
const cron = require('node-cron');
require('dotenv').config();      

const app = express();
app.use(express.json()); 

// ==========================================
// 1. HEALTH CHECK ROUTE
// ==========================================
app.get('/', (req, res) => {
    res.send('TrustDM Sandbox Engine is running smoothly!');
});

// ==========================================
// 2. INITIATE TRANSACTION ROUTE (Sandbox Simulator)
// ==========================================
app.post('/api/transactions/initiate', async (req, res) => {
    try {
        const { buyer_username, seller_username, amount, buyer_email } = req.body;

        if (!buyer_username || !seller_username || !amount || !buyer_email) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        let buyerRes = await pool.query(
            'INSERT INTO users (username) VALUES (\$1) ON CONFLICT (username) DO UPDATE SET username=EXCLUDED.username RETURNING id',
            [buyer_username]
        );
        const buyerId = buyerRes.rows[0].id;

        let sellerRes = await pool.query(
            'INSERT INTO users (username) VALUES (\$1) ON CONFLICT (username) DO UPDATE SET username=EXCLUDED.username RETURNING id',
            [seller_username]
        );
        const sellerId = sellerRes.rows[0].id;

        const delivery_pin = Math.floor(1000 + Math.random() * 9000).toString();
        const automated_release_at = new Date(Date.now() + 48 * 60 * 60 * 1000);

        const transactionRes = await pool.query(
            `INSERT INTO transactions (buyer_id, seller_id, amount, escrow_status, delivery_pin, automated_release_at) 
             VALUES ($1, $2, $3, 'PENDING', $4, $5) 
             RETURNING id`,
            [buyerId, sellerId, amount, delivery_pin, automated_release_at]
        );
        const transactionId = transactionRes.rows[0].id;

        const simulatedCheckoutUrl = `https://paystack.com{transactionId}`;

        res.status(201).json({
            message: '[SANDBOX ACTIVE] Escrow record registered successfully!',
            transaction_id: transactionId,
            status: 'PENDING',
            payment_url: simulatedCheckoutUrl, 
            verification_pin: delivery_pin,
            auto_release_time: automated_release_at
        });

    } catch (error) {
        console.error("Initialization Error:", error.message);
        res.status(500).json({ error: 'Internal pipeline optimization error' });
    }
});

// ==========================================
// 3A. INSTAGRAM WEBHOOK VERIFICATION (For Meta Setup)
// ==========================================
// Meta pings this route once when you link your app to verify your server ownership
app.get('/api/webhook/instagram', (req, res) => {
    const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'my_secure_trustdm_token_123';
    
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('[Meta Webhook] Successfully verified by Facebook servers!');
            return res.status(200).send(challenge);
        }
        return res.status(403).send('Verification token mismatch');
    }
    res.status(400).send('Missing verification parameters');
});

// ==========================================
// 3. INSTAGRAM WEBHOOK CHATBOT CONTROLLER
// ==========================================
// This endpoint catches real incoming messages forwarded to your server from Instagram servers
app.post('/api/webhook/instagram', async (req, res) => {
    try {
        const body = req.body;

        // Meta wraps messaging bundles inside nested entry objects
        if (body.object === 'instagram') {
            for (const entry of body.entry) {
                // Loop through array elements to fetch messaging text data chunks
                if (entry.messaging && entry.messaging[0]) {
                    const event = entry.messaging[0];
                    const senderId = event.sender.id;     // The unique Meta numerical ID for the chatter
                    const messageText = event.message.text ? event.message.text.trim().toLowerCase() : '';

                    console.log(`[Instagram Bot] Message parsed from Meta Sender ID: ${senderId}. Text: "${messageText}"`);

                    // A. CHAT COMMAND COMMAND LAYER: Check if user wants to execute verification
                    if (messageText.startsWith('verify ')) {
                        // Expected chat message format pattern: "verify [transaction_id] [pin]"
                        // Example message string parameter: "verify 5 4169"
                        const parts = messageText.split(' ');
                        const transactionId = parts[1];
                        const inputPin = parts[2];

                        if (!transactionId || !inputPin) {
                            console.log(`[Bot Action] Informing user of invalid format instructions`);
                            return res.status(200).json({ status: "success", reply: "Please use format: verify [transaction_id] [pin]" });
                        }

                        // Query database to evaluate matching criteria loops
                        const txRes = await pool.query("SELECT * FROM transactions WHERE id = \$1", [transactionId]);
                        
                        if (txRes.rows.length === 0) {
                            return res.status(200).json({ status: "success", reply: "Transaction record not found." });
                        }

                        const transaction = txRes.rows[0];

                        if (transaction.escrow_status !== 'FUNDS_HELD') {
                            return res.status(200).json({ status: "success", reply: `Cannot verify. Status is currently ${transaction.escrow_status}` });
                        }

                        if (transaction.delivery_pin !== inputPin) {
                            return res.status(200).json({ status: "success", reply: "Wrong verification PIN code. Delivery unconfirmed." });
                        }

                        // Success match validation path: Update PostgreSQL table state parameters
                        await pool.query("UPDATE transactions SET escrow_status = 'COMPLETED' WHERE id = \$1", [transactionId]);
                        console.log(`[Bot Action] PIN successfully validated. Escrow cleared for execution routing parameters.`);

                        return res.status(200).json({
                            status: "success",
                            reply: `🎉 PIN Verified! Escrow transaction #${transactionId} released. Payout routing instructions sent to seller.`
                        });
                    }

                    // B. DEFAULT CATCH-ALL BOT RESPONSE LAYOUT
                    console.log(`[Bot Action] Standard default instruction template dispatched`);
                }
            }
            // Always tell Meta we received the message packet successfully by hitting an HTTP 200 return condition
            return res.status(200).send('EVENT_RECEIVED');
        }

        res.status(404).send('NOT_AN_INSTAGRAM_EVENT');
    } catch (error) {
        console.error("Instagram Bot Parsing Exception:", error);
        res.status(500).json({ error: 'Internal chat response loop failure' });
    }
});

// ==========================================
// 4. VERIFY DELIVERY PIN ROUTE (Manual Route)
// ==========================================
app.post('/api/transactions/verify-pin', async (req, res) => {
    try {
        const { transaction_id, delivery_pin } = req.body;

        if (!transaction_id || !delivery_pin) {
            return res.status(400).json({ error: "Missing transaction_id or delivery_pin" });
        }

        const txRes = await pool.query("SELECT * FROM transactions WHERE id = \$1", [transaction_id]);
        if (txRes.rows.length === 0) return res.status(404).json({ error: "Transaction record not found" });

        const transaction = txRes.rows[0];

        if (transaction.escrow_status !== 'FUNDS_HELD') {
            return res.status(400).json({ error: `Cannot verify PIN. Transaction is currently ${transaction.escrow_status}` });
        }

        if (transaction.delivery_pin !== delivery_pin.toString()) {
            return res.status(401).json({ error: "Invalid verification PIN. Delivery unconfirmed." });
        }

        await pool.query(`UPDATE transactions SET escrow_status = 'COMPLETED' WHERE id = $1`, [transaction_id]);
        res.status(200).json({ status: 'success', message: 'PIN verified successfully! Escrow completed.' });

    } catch (error) {
        console.error("PIN Verification Error:", error);
        res.status(500).json({ error: 'Internal pin verification engine failure' });
    }
});

// ==========================================
// 5. PAYSTACK WEBHOOK HANDLER
// ==========================================
app.post('/api/payment/webhook', async (req, res) => {
    try {
        const event = req.body;
        if (event && event.event === 'charge.success') {
            const transactionId = event.data.metadata.transaction_id;
            await pool.query(`UPDATE transactions SET escrow_status = 'FUNDS_HELD' WHERE id = $1 AND escrow_status = 'PENDING'`, [transactionId]);
            return res.status(200).json({ status: 'success', message: 'Escrow status updated to FUNDS_HELD' });
        }
        res.status(200).json({ message: 'Event received and ignored' });
    } catch (error) {
        console.error("Webhook Error:", error);
        res.status(500).json({ error: 'Internal webhook processing error' });
    }
});

// ==========================================
// 6. AUTOMATED 48-HOUR FORCE-RELEASE TIMER
// ==========================================
cron.schedule('0 * * * *', async () => {
    try {
        await pool.query(`UPDATE transactions SET escrow_status = 'FORCE_RELEASED' WHERE escrow_status = 'FUNDS_HELD' AND automated_release_at <= NOW()`);
    } catch (error) {
        console.error("Cron Job Failure:", error);
    }
});

// ==========================================
// 7. SERVER INITIALIZATION PORT ENGINE
// ==========================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server is running successfully on port ${PORT}`);
});
