const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ---- Optional dependencies (may not be installed on Render) ----
let lancedb;
try {
    lancedb = require('vectordb');
} catch (e) {
    console.warn('⚠️ vectordb not available – knowledge base disabled');
    lancedb = null;
}

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MEMORY_FILE = path.join(__dirname, 'memory.json');
const DB_PATH = path.join(__dirname, 'karombe-lancedb');

// ---- Allowed CORS origins ----
const ALLOWED_ORIGINS = [
    'https://karombe.chengetai.co.zw',
    'https://dare.chengetai.co.zw',
    'https://karombe.onrender.com'  // for testing
];

// ---- Long‑term chat memory ----
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

// ---- Request helpers ----
function getRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function serveStaticFile(res, filePath) {
    const extname = path.extname(filePath);
    const contentType = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.gif': 'image/gif',
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

// ---- Vector DB (optional) ----
let db, table;

async function initVectorDB() {
    if (!lancedb) {
        console.log('📚 Knowledge base disabled (vectordb missing).');
        table = {
            search: async () => [],
            add: async () => {},
            execute: async () => [],
        };
        return;
    }
    try {
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
    } catch (err) {
        console.error('⚠ Vector DB init failed – knowledge base disabled:', err.message);
        table = { search: async () => [], add: async () => {}, execute: async () => [] };
    }
}

async function addToKnowledge(text, source = 'user') {
    try {
        if (!lancedb) return;
        const embedding = await getEmbedding(text);
        await table.add([{ vector: embedding, text, source }]);
    } catch (err) {
        console.error('Knowledge add failed:', err.message);
        throw err;
    }
}

async function searchKnowledge(query, topK = 3) {
    if (!lancedb) return [];
    try {
        const queryEmbedding = await getEmbedding(query);
        const results = await table.search(queryEmbedding).limit(topK).execute();
        return results.map(r => r.text);
    } catch (err) {
        console.warn('Knowledge search skipped:', err.message);
        return [];
    }
}

async function getEmbedding(text) {
    // Ollama embedding – will throw if Ollama is unreachable
    const resp = await fetch('http://localhost:11434/api/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
    });
    if (!resp.ok) throw new Error('Ollama embedding failed');
    const data = await resp.json();
    return data.embedding;
}

async function getAllKnowledge() {
    if (!lancedb) return [];
    try {
        return await table.execute();
    } catch {
        return [];
    }
}

// ---- CORS middleware ----
function setCORSHeaders(req, res) {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ---- Main server ----
const server = http.createServer(async (req, res) => {
    setCORSHeaders(req, res);
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Ingestion endpoint
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

    // List knowledge
    if (req.method === 'GET' && req.url === '/api/knowledge') {
        try {
            const all = await getAllKnowledge();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ knowledge: all.map(r => ({ text: r.text, source: r.source })) }));
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Could not fetch knowledge.' }));
        }
        return;
    }

    // Clear memory
    if (req.method === 'POST' && req.url === '/api/clear-memory') {
        conversationHistory = [];
        saveMemory();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'Memory cleared' }));
        return;
    }

    // Get memory
    if (req.method === 'GET' && req.url === '/api/memory') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ memory: conversationHistory }));
        return;
    }

    // Chat endpoint
    if (req.method === 'POST' && req.url === '/api/chat') {
        try {
            const body = await getRequestBody(req);
            const { message } = JSON.parse(body);

            conversationHistory.push({ role: 'user', content: message });

            // RAG context (gracefully fails if Ollama/DB missing)
            let context = '';
            try {
                const results = await searchKnowledge(message, 3);
                if (results.length > 0) context = results.join('\n---\n');
            } catch (e) {
                console.warn('Knowledge search failed – continuing without context:', e.message);
            }

            const systemPrompt = {
                role: 'system',
                content: `You are Karombe AI, a wise and helpful assistant created by Chengetai Labs.
You speak with the calm confidence of a lion and are knowledgeable about technology, science, and African innovation.
When someone asks who you are, you proudly say: "I am Karombe AI, powered by Chengetai Labs."
${context ? 'Use the following retrieved knowledge to inform your answer, but only if relevant:\n' + context : ''}`
            };

            const messages = [systemPrompt, ...conversationHistory];
            // Keep memory within limits
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

    // Serve static files
    let filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'index.html' : req.url);
    serveStaticFile(res, filePath);
});

(async () => {
    loadMemory();
    await initVectorDB();
    server.listen(PORT, () => {
        console.log(`✅ Server running at http://localhost:${PORT}`);
        console.log('   🦁 Karombe AI (Groq + optional knowledge base)');
    });
})();