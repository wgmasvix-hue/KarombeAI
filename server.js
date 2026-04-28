const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const lancedb = require('vectordb');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MEMORY_FILE = path.join(__dirname, 'memory.json');
const DB_PATH = path.join(__dirname, 'karombe-lancedb');

// ======== ALLOWED ORIGINS (add your domains) ========
const ALLOWED_ORIGINS = [
    'https://karombe.chengetai.co.zw',
    'https://dare.chengetai.co.zw'   // if you want to embed the widget there
];

// ======== LONG-TERM CHAT MEMORY ========
let conversationHistory = [];

function loadMemory() {
    try {
        if (fs.existsSync(MEMORY_FILE)) {
            conversationHistory = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
            console.log(`📚 Loaded ${conversationHistory.length} messages from memory.`);
        } else {
            console.log('📚 No memory file found – starting fresh.');
        }
    } catch (err) {
        console.error('⚠ Error loading memory:', err.message);
        conversationHistory = [];
    }
}

function saveMemory() {
    try {
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(conversationHistory, null, 2));
    } catch (err) {
        console.error('⚠ Could not save memory:', err.message);
    }
}

function trimMemory(maxMessages = 40) {
    if (conversationHistory.length > maxMessages) {
        conversationHistory = conversationHistory.slice(-maxMessages);
    }
}

// Helper: read request body
function getRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

// Helper: serve static files
function serveStaticFile(res, filePath) {
    const extname = path.extname(filePath);
    const contentType = {
        '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
        '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
        '.gif': 'image/gif'
    }[extname] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(data);
        }
    });
}

// ======== VECTOR DB + EMBEDDING ========
let db, table;

async function initVectorDB() {
    db = await lancedb.connect(DB_PATH);
    const tables = await db.tableNames();
    if (!tables.includes('knowledge')) {
        table = await db.createTable('knowledge', [
            { vector: [], text: '', source: '' }
        ]);
        console.log('📚 Created new knowledge base table.');
    } else {
        table = await db.openTable('knowledge');
        console.log('📚 Opened existing knowledge base.');
    }
}

async function addToKnowledge(text, source = 'user') {
    const embedding = await getEmbedding(text);
    await table.add([{ vector: embedding, text, source }]);
}

async function searchKnowledge(query, topK = 3) {
    const queryEmbedding = await getEmbedding(query);
    const results = await table.search(queryEmbedding).limit(topK).execute();
    return results.map(r => r.text);
}

async function getEmbedding(text) {
    // Ollama must be running locally with nomic-embed-text model
    const resp = await fetch('http://localhost:11434/api/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic-embed-text', prompt: text })
    });
    const data = await resp.json();
    return data.embedding;
}

async function getAllKnowledge() {
    const results = await table.execute();
    return results;
}

// ======== CORS Middleware ========
function setCORSHeaders(req, res) {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ======== MAIN SERVER ========
const server = http.createServer(async (req, res) => {
    // Apply CORS
    setCORSHeaders(req, res);
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // ---- INGEST ----
    if (req.method === 'POST' && req.url === '/api/ingest') {
        try {
            const body = await getRequestBody(req);
            const { text, source } = JSON.parse(body);
            if (!text) throw new Error('Missing text');
            await addToKnowledge(text, source || 'user');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'Knowledge added successfully.' }));
        } catch (err) {
            console.error('Ingest Error:', err);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // ---- LIST KNOWLEDGE ----
    if (req.method === 'GET' && req.url === '/api/knowledge') {
        try {
            const all = await getAllKnowledge();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ knowledge: all.map(row => ({ text: row.text, source: row.source })) }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Could not fetch knowledge.' }));
        }
        return;
    }

    // ---- CLEAR MEMORY ----
    if (req.method === 'POST' && req.url === '/api/clear-memory') {
        conversationHistory = [];
        saveMemory();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'Memory cleared' }));
        return;
    }

    // ---- GET MEMORY ----
    if (req.method === 'GET' && req.url === '/api/memory') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ memory: conversationHistory }));
        return;
    }

    // ---- CHAT ----
    if (req.method === 'POST' && req.url === '/api/chat') {
        try {
            const body = await getRequestBody(req);
            const { message } = JSON.parse(body);

            conversationHistory.push({ role: 'user', content: message });

            // RAG: search knowledge
            let context = '';
            try {
                const results = await searchKnowledge(message, 3);
                if (results.length > 0) context = results.join('\n---\n');
            } catch (e) {
                console.warn('Knowledge search failed:', e.message);
            }

            const systemPrompt = {
                role: 'system',
                content: `You are Karombe AI, a wise and helpful assistant created by Chengetai Labs.
You speak with the calm confidence of a lion and are knowledgeable about technology, science, and African innovation.
When someone asks who you are, you proudly say: "I am Karombe AI, powered by Chengetai Labs."
${context ? 'Use the following retrieved knowledge to inform your answer, but only if relevant:\n' + context : ''}`
            };

            const messages = [systemPrompt, ...conversationHistory];
            if (conversationHistory.length > 40) conversationHistory = conversationHistory.slice(-40);

            const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'llama-3.1-8b-instant',
                    messages: messages
                })
            });

            const data = await response.json();
            const reply = data.choices?.[0]?.message?.content || 'No reply from model';
            conversationHistory.push({ role: 'assistant', content: reply });
            saveMemory();

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ reply }));
        } catch (error) {
            console.error('API Error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Error communicating with AI.' }));
        }
        return;
    }

    // ---- SERVE STATIC FILES ----
    let filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);
    serveStaticFile(res, filePath);
});

(async () => {
    loadMemory();
    await initVectorDB();
    server.listen(PORT, () => {
        console.log(`✅ Server running at http://localhost:${PORT}`);
        console.log('   🦁 Karombe AI (Groq + knowledge base + long-term memory)');
    });
})();