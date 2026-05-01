const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '70mb' }));
app.use(express.static(__dirname));

const MONGO_URI = process.env.MONGO_URL || 'mongodb://localhost:27017/iqra_v2';
mongoose.connect(MONGO_URI).catch(err => console.log("DB waiting..."));

const User = mongoose.model('User', {
    username: { type: String, unique: true },
    password: { type: String },
    settings: { theme: String, accent: String, radius: String }
});

const Book = mongoose.model('Book', {
    id: String, title: String, size: String, date: String, cover: String, 
    pdfData: String, uploader: String, isPublic: Boolean, isLearning: Boolean
});

const Chat = mongoose.model('Chat', { sender: String, text: String, date: String });

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (user && await bcrypt.compare(password, user.password)) {
        res.json({ success: true, username: user.username, settings: user.settings });
    } else if (!user) {
        const hashed = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashed, settings: { theme:'dark', accent:'#3b82f6', radius:'12px' } });
        await newUser.save();
        res.json({ success: true, username: newUser.username, settings: newUser.settings });
    } else { res.status(401).json({ error: "Auth failed" }); }
});

app.get('/api/books', async (req, res) => {
    const { user, mode, type } = req.query;
    let query = { isPublic: true };
    if (type === 'learning') query = { isLearning: true };
    else if (mode === 'mine' && user) query = { uploader: user };
    else query.isLearning = false;

    const books = await Book.find(query).select('-pdfData').sort({ _id: -1 });
    res.json(books);
});

app.get('/api/books/:id', async (req, res) => {
    const book = await Book.findOne({ id: req.params.id });
    res.json(book);
});

app.post('/api/books', async (req, res) => {
    const newBook = new Book(req.body);
    await newBook.save();
    res.json({ success: true });
});

app.delete('/api/books/:id', async (req, res) => {
    if (req.query.admin_key !== 'coolish2992') return res.status(403).send();
    await Book.deleteOne({ id: req.params.id });
    res.json({ success: true });
});

app.get('/api/chat', async (req, res) => {
    const msgs = await Chat.find().sort({ _id: -1 }).limit(60);
    res.json(msgs.reverse());
});

app.post('/api/chat', async (req, res) => {
    const msg = new Chat({ sender: req.body.sender, text: req.body.text, date: new Date().toLocaleTimeString('ar-EG') });
    await msg.save();
    res.json({ success: true });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Iqra V2 Live`));
