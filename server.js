require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const {
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    ComputeBudgetProgram,
    LAMPORTS_PER_SOL,
    sendAndConfirmTransaction,
} = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');
const BN = require('bn.js');
const {
    OnlinePumpSdk,
    PumpSdk,
    getBuyTokenAmountFromSolAmount,
} = require('@pump-fun/pump-sdk');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ===== CONFIG =====
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const TOKEN_MINT = process.env.TOKEN_MINT;
const BUY_AMOUNT_SOL = parseFloat(process.env.BUY_AMOUNT_SOL) || 0.001;
const PRIORITY_FEE = parseInt(process.env.PRIORITY_FEE) || 1000;
const PORT = parseInt(process.env.PORT) || 3000;

// Validate config
if (!RPC_URL || RPC_URL === 'YOUR_RPC_URL_HERE') {
    console.error('❌ Please set RPC_URL in .env file');
    process.exit(1);
}
if (!PRIVATE_KEY || PRIVATE_KEY === 'YOUR_PRIVATE_KEY_HERE') {
    console.error('❌ Please set PRIVATE_KEY in .env file');
    process.exit(1);
}
if (!TOKEN_MINT || TOKEN_MINT === 'YOUR_TOKEN_MINT_ADDRESS_HERE') {
    console.error('❌ Please set TOKEN_MINT in .env file');
    process.exit(1);
}

// Initialize Solana connection and wallet
const connection = new Connection(RPC_URL, 'confirmed');
let wallet;
try {
    const secretKey = bs58.decode(PRIVATE_KEY);
    wallet = Keypair.fromSecretKey(secretKey);
    console.log('✅ Wallet loaded:', wallet.publicKey.toBase58());
} catch (e) {
    console.error('❌ Invalid private key:', e.message);
    process.exit(1);
}

const mintPubkey = new PublicKey(TOKEN_MINT);

// Initialize Pump.fun SDK
const onlineSdk = new OnlinePumpSdk(connection);
const pumpSdk = new PumpSdk();

// Detect token program (Token-2022 vs legacy) at startup
let tokenProgram = null;
async function detectTokenProgram() {
    const info = await connection.getAccountInfo(mintPubkey);
    if (!info) throw new Error('Mint account not found on chain');
    if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
        tokenProgram = TOKEN_2022_PROGRAM_ID;
        console.log('✅ Token uses Token-2022 program');
    } else {
        tokenProgram = TOKEN_PROGRAM_ID;
        console.log('✅ Token uses legacy Token program');
    }
}
detectTokenProgram().catch(e => console.error('⚠️ Token program detection failed:', e.message));

let txHistory = [];

// Global total SOL bought across ALL players
let totalSolBought = 0;

// Buy queue — processes one tx at a time so Solana never sees conflicting txs
// from the same wallet, but NO buy is ever rejected. Up to 30+ can be queued.
const buyQueue = [];
let isProcessingQueue = false;

async function processBuyQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (buyQueue.length > 0) {
        const { resolve } = buyQueue.shift();
        const result = await executeBuyOnce();
        resolve(result);
    }

    isProcessingQueue = false;
}

function queueBuy() {
    return new Promise((resolve) => {
        buyQueue.push({ resolve });
        console.log(`📋 Buy queued (${buyQueue.length} in queue)`);
        processBuyQueue();
    });
}

// ===== Execute a single buy using official Pump.fun SDK =====
async function executeBuyOnce() {
    const startTime = Date.now();

    try {
        console.log(`🪙 Executing buy: ${BUY_AMOUNT_SOL} SOL for token ${TOKEN_MINT}`);

        const solAmount = new BN(Math.floor(BUY_AMOUNT_SOL * LAMPORTS_PER_SOL));

        // Step 1: Fetch global state and fee config from Pump.fun
        const [global, feeConfig] = await Promise.all([
            onlineSdk.fetchGlobal(),
            onlineSdk.fetchFeeConfig(),
        ]);

        // Step 2: Fetch bonding curve state and user's token account
        if (!tokenProgram) await detectTokenProgram();

        const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } =
            await onlineSdk.fetchBuyState(mintPubkey, wallet.publicKey, tokenProgram);

        // Step 3: Get mint supply
        const mintSupplyInfo = await connection.getTokenSupply(mintPubkey);
        const mintSupply = new BN(mintSupplyInfo.value.amount);

        // Step 4: Calculate token amount from SOL amount
        const tokenAmount = getBuyTokenAmountFromSolAmount({
            global,
            feeConfig,
            mintSupply,
            bondingCurve,
            amount: solAmount,
        });
        console.log(`💰 Will buy ~${tokenAmount.toString()} tokens for ${BUY_AMOUNT_SOL} SOL`);

        // Step 5: Build buy instructions using official SDK
        const buyIxs = await pumpSdk.buyInstructions({
            global,
            bondingCurveAccountInfo,
            bondingCurve,
            associatedUserAccountInfo,
            mint: mintPubkey,
            user: wallet.publicKey,
            amount: tokenAmount,
            solAmount,
            slippage: 25,
            tokenProgram,
        });

        // Step 6: Build transaction with priority fee
        const tx = new Transaction();

        tx.add(
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE })
        );
        tx.add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 250000 })
        );

        for (const ix of buyIxs) {
            tx.add(ix);
        }

        // Step 7: Get blockhash and send
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;

        console.log('📤 Sending transaction...');
        const signature = await sendAndConfirmTransaction(connection, tx, [wallet], {
            skipPreflight: true,
            commitment: 'confirmed',
            maxRetries: 3,
        });

        const elapsed = Date.now() - startTime;
        const result = {
            success: true,
            signature,
            amount: BUY_AMOUNT_SOL,
            elapsed: elapsed,
            message: `Bought with ${BUY_AMOUNT_SOL} SOL`,
        };

        totalSolBought += BUY_AMOUNT_SOL;

        txHistory.push({
            ...result,
            timestamp: new Date().toISOString(),
        });

        console.log(`✅ Buy confirmed: ${signature} (${elapsed}ms)`);
        return result;
    } catch (error) {
        console.error('❌ Buy failed:', error.message);
        if (error.logs) {
            console.error('Logs:', error.logs);
        }
        return {
            success: false,
            message: error.message,
            elapsed: Date.now() - startTime,
        };
    }
}

// ===== RATE LIMITING =====
const ipLastBuy = new Map();
const RATE_LIMIT_MS = 3000; // 1 buy per 3 seconds per IP
const MAX_QUEUE_SIZE = 10;

// Clean up old entries every 60 seconds
setInterval(() => {
    const now = Date.now();
    for (const [ip, time] of ipLastBuy) {
        if (now - time > 60000) ipLastBuy.delete(ip);
    }
}, 60000);

// ===== API ROUTES =====

// Trigger a buy (rate-limited per IP, queued)
app.post('/api/buy', async (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // Rate limit check
    const lastBuy = ipLastBuy.get(ip);
    if (lastBuy && Date.now() - lastBuy < RATE_LIMIT_MS) {
        const wait = Math.ceil((RATE_LIMIT_MS - (Date.now() - lastBuy)) / 1000);
        console.log(`⛔ Rate limited: ${ip} (wait ${wait}s)`);
        return res.status(429).json({ success: false, message: `Rate limited. Wait ${wait}s.` });
    }

    // Queue cap check
    if (buyQueue.length >= MAX_QUEUE_SIZE) {
        console.log(`⛔ Queue full (${buyQueue.length}/${MAX_QUEUE_SIZE})`);
        return res.status(429).json({ success: false, message: 'Server busy. Try again shortly.' });
    }

    ipLastBuy.set(ip, Date.now());

    try {
        const result = await queueBuy();
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get transaction history
app.get('/api/history', (req, res) => {
    res.json({ transactions: txHistory.slice(-50) });
});

// Global stats (polled by all clients for synced totals)
app.get('/api/stats', (req, res) => {
    res.json({
        totalSolBought,
        totalBuys: txHistory.length,
    });
});

// Health check
app.get('/api/health', async (req, res) => {
    try {
        const balance = await connection.getBalance(wallet.publicKey);
        res.json({
            status: 'ok',
            wallet: wallet.publicKey.toBase58(),
            balance: balance / LAMPORTS_PER_SOL,
            tokenMint: TOKEN_MINT,
            buyAmount: BUY_AMOUNT_SOL,
            priorityFee: PRIORITY_FEE,
        });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Serve the game
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`\n🎮 Aero Flap Game Server running at http://localhost:${PORT}`);
    console.log(`💰 Buy amount: ${BUY_AMOUNT_SOL} SOL per coin`);
    console.log(`⚡ Priority fee: ${PRIORITY_FEE} micro-lamports`);
    console.log(`🪙 Token: ${TOKEN_MINT}`);
    console.log(`👛 Wallet: ${wallet.publicKey.toBase58()}\n`);
});
