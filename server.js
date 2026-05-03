import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const AI_API_URL = process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions';
const AI_API_KEY = process.env.AI_API_KEY;

app.use(cors());
app.use(express.json());

// Serve static frontend
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage
let knowledgeBase = [];
let conversationMemory = [];

function systemPrompt() {
  if (knowledgeBase.length === 0) {
    return 'You are Karombe AI, a wise lion-themed assistant from Chengetai Labs. Answer helpfully.';
  }
  const facts = knowledgeBase.map(k => `- ${k.text}`).join('\n');
  return `You are Karombe AI, a wise lion-themed assistant from Chengetai Labs. You have access to this knowledge:\n${facts}\nUse it when relevant.`;
}

// Chat
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  conversationMemory.push({ role: 'user', content: message, timestamp: new Date().toISOString() });

  const messages = [
    { role: 'system', content: systemPrompt() },
    ...conversationMemory.map(m => ({ role: m.role, content: m.content })),
  ];

  try {
    const response = await axios.post(
      AI_API_URL,
      {
        model: 'gpt-3.5-turbo', // adjust to your provider
        messages,
        temperature: 0.7,
        max_tokens: 800,
      },
      {
        headers: {
          'Authorization': `Bearer ${AI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    const reply = response.data.choices[0].message.content;
    conversationMemory.push({ role: 'assistant', content: reply, timestamp: new Date().toISOString() });
    res.json({ reply });
  } catch (err) {
    console.error('AI error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to get response from AI' });
  }
});

// Knowledge ingestion
app.post('/api/ingest', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });
  knowledgeBase.push({ text, source: 'user', timestamp: new Date().toISOString() });
  res.json({ status: 'Knowledge added', count: knowledgeBase.length, index: knowledgeBase.length - 1 });
});

// Get all knowledge
app.get('/api/knowledge', (req, res) => {
  res.json({ knowledge: knowledgeBase });
});

// Delete knowledge
app.delete('/api/knowledge/:index', (req, res) => {
  const idx = parseInt(req.params.index);
  if (isNaN(idx) || idx < 0 || idx >= knowledgeBase.length) {
    return res.status(404).json({ error: 'Index not found' });
  }
  const removed = knowledgeBase.splice(idx, 1);
  res.json({ status: 'Knowledge deleted', removed: removed[0].text });
});

// Get memory
app.get('/api/memory', (req, res) => {
  res.json({ memory: conversationMemory });
});

// Clear chat memory
app.delete('/api/memory', (req, res) => {
  conversationMemory = [];
  res.json({ status: 'Memory cleared' });
});

// Catch-all
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🦁 Karombe AI running at http://localhost:${PORT}`);
});