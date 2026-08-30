const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { execSync } = require('child_process');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
    secret: 'render-hosting-secret-12345',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// Setup directories and files
const uploadsDir = path.join(__dirname, 'uploads');
const sitesDir = path.join(__dirname, 'sites');
const usersFile = path.join(__dirname, 'users.json');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(sitesDir)) fs.mkdirSync(sitesDir);
if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, JSON.stringify({}));

// Helper functions for users
function getUsers() {
    try {
        return JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    } catch (e) {
        return {};
    }
}
function saveUsers(users) {
    fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

// GitHub Sync Function
function pushToGitHub(commitMessage) {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;
    
    if (!token || !repo) return;

    try {
        const remoteUrl = `https://${token}@github.com/${repo}.git`;
        execSync(`git config user.email "server@render.com"`);
        execSync(`git config user.name "Auto Server"`);
        execSync(`git add sites/ users.json`);
        const status = execSync('git status --porcelain').toString();
        if (status.length > 0) {
            execSync(`git commit -m "${commitMessage}"`);
            execSync(`git push "${remoteUrl}" HEAD:main`);
        }
    } catch (error) {
        console.error('Failed to save to GitHub:', error.message);
    }
}

// Authentication Middlewares
function requireAuth(req, res, next) {
    if (!req.session.username) return res.redirect('/');
    
    const users = getUsers();
    if (users[req.session.username] && users[req.session.username].banned) {
        req.session.destroy();
        return res.status(403).send('Your account has been banned.');
    }
    next();
}

function requireAdmin(req, res, next) {
    if (req.session.username === 'devyasin') {
        next();
    } else {
        res.status(403).send('Forbidden: Admin access only.');
    }
}

// --- Auth Routes ---
app.post('/register', (req, res) => {
    let { username, password } = req.body;
    if (!username || !password) return res.status(400).send('Username and password required');
    
    username = username.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const users = getUsers();
    
    if (users[username]) {
        if (users[username].banned) return res.status(403).send('This username is permanently banned.');
        return res.status(400).send('Username already exists. Please login.');
    }
    
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    users[username] = { password: hash, projects: [], banned: false };
    saveUsers(users);
    
    setTimeout(() => pushToGitHub(`Registered new user: ${username}`), 500);
    req.session.username = username;
    res.redirect('/dashboard.html');
});

app.post('/login', (req, res) => {
    let { username, password } = req.body;
    username = username.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const users = getUsers();
    
    if (!users[username]) return res.status(400).send('Invalid credentials.');
    if (users[username].banned) return res.status(403).send('Your account has been banned.');
    
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    if (users[username].password !== hash) return res.status(400).send('Invalid credentials.');
    
    req.session.username = username;
    
    if (username === 'devyasin') {
        res.redirect('/devyasin'); // Admin dashboard
    } else {
        res.redirect('/dashboard.html');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// --- URL Checker ---
app.get('/api/check-url', (req, res) => {
    let siteName = req.query.name;
    if (!siteName) return res.json({ available: false });
    siteName = siteName.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    
    const targetDir = path.join(sitesDir, siteName);
    if (fs.existsSync(targetDir)) {
        res.json({ available: false });
    } else {
        res.json({ available: true, cleanName: siteName });
    }
});

// --- Upload Route ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

function processUpload(req, res, isAdminReplace = false) {
    let siteName = req.body.siteName;
    if (!siteName || !req.file) return res.status(400).send('Name and file required.');
    
    siteName = siteName.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const targetDir = path.join(sitesDir, siteName);
    const username = req.session.username;
    const users = getUsers();
    
    if (!isAdminReplace) {
        if (fs.existsSync(targetDir)) {
            if (!users[username].projects.includes(siteName)) {
                fs.unlinkSync(req.file.path);
                return res.status(400).send('URL name is already taken.');
            }
        }
    } else {
        // Admin is replacing a project, ensure it's empty first
        if (fs.existsSync(targetDir)) {
            fs.rmSync(targetDir, { recursive: true, force: true });
        }
    }

    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    
    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();

    try {
        if (ext === '.zip') {
            const zip = new AdmZip(filePath);
            zip.extractAllTo(targetDir, true);
            fs.unlinkSync(filePath);
        } else {
            const newFilePath = path.join(targetDir, (ext === '.html' || ext === '.htm') ? 'index.html' : req.file.originalname);
            fs.renameSync(filePath, newFilePath);
        }
        
        if (!isAdminReplace) {
            if (!users[username].projects) users[username].projects = [];
            if (!users[username].projects.includes(siteName)) {
                users[username].projects.push(siteName);
                saveUsers(users);
            }
        }
        
        setTimeout(() => pushToGitHub(`Uploaded/Replaced site: ${siteName} by ${username}`), 1000);
        
        if (isAdminReplace) {
            res.redirect('/devyasin?msg=Replaced successfully');
        } else {
            res.redirect('/dashboard.html?success=' + siteName);
        }
    } catch (err) {
        console.error(err);
        res.status(500).send('Upload error.');
    }
}

app.post('/upload', requireAuth, upload.single('siteFile'), (req, res) => processUpload(req, res, false));
app.post('/api/admin/replace', requireAuth, requireAdmin, upload.single('siteFile'), (req, res) => processUpload(req, res, true));

// --- Dashboard APIs ---
app.get('/api/user', requireAuth, (req, res) => {
    const users = getUsers();
    const myProjects = users[req.session.username].projects || [];
    const projectDetails = myProjects.map(p => ({
        name: p,
        live: fs.existsSync(path.join(sitesDir, p))
    }));
    res.json({ username: req.session.username, projects: projectDetails });
});

app.post('/api/delete', requireAuth, (req, res) => {
    const { siteName } = req.body;
    const username = req.session.username;
    const users = getUsers();
    
    if (!users[username].projects.includes(siteName)) return res.status(403).send('Not your project.');
    
    const targetDir = path.join(sitesDir, siteName);
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    
    users[username].projects = users[username].projects.filter(p => p !== siteName);
    saveUsers(users);
    
    try { execSync(`git rm -r --ignore-unmatch sites/${siteName}`); } catch(e) {}
    setTimeout(() => pushToGitHub(`Deleted site: ${siteName} by ${username}`), 500);
    
    res.json({ success: true });
});

// --- Admin Endpoints ---
app.get('/devyasin', requireAuth, requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/api/admin/all', requireAuth, requireAdmin, (req, res) => {
    const users = getUsers();
    const sanitizedUsers = {};
    for (let u in users) {
        sanitizedUsers[u] = {
            banned: users[u].banned || false,
            projects: users[u].projects || [],
            projectsStatus: (users[u].projects || []).map(p => ({
                name: p,
                live: fs.existsSync(path.join(sitesDir, p))
            }))
        };
    }
    res.json({ users: sanitizedUsers });
});

app.post('/api/admin/delete-project', requireAuth, requireAdmin, (req, res) => {
    const { siteName, ownerName } = req.body;
    const users = getUsers();
    
    if (users[ownerName]) {
        users[ownerName].projects = users[ownerName].projects.filter(p => p !== siteName);
        saveUsers(users);
    }
    
    const targetDir = path.join(sitesDir, siteName);
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    
    try { execSync(`git rm -r --ignore-unmatch sites/${siteName}`); } catch(e) {}
    setTimeout(() => pushToGitHub(`Admin deleted site: ${siteName}`), 500);
    
    res.json({ success: true });
});

app.post('/api/admin/ban', requireAuth, requireAdmin, (req, res) => {
    const { targetUsername } = req.body;
    if (targetUsername === 'devyasin') return res.status(400).send('Cannot ban admin');
    
    const users = getUsers();
    if (!users[targetUsername]) return res.status(404).send('User not found');
    
    users[targetUsername].banned = true;
    
    // Delete all their projects
    const projects = users[targetUsername].projects || [];
    projects.forEach(p => {
        const targetDir = path.join(sitesDir, p);
        if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
        try { execSync(`git rm -r --ignore-unmatch sites/${p}`); } catch(e) {}
    });
    
    users[targetUsername].projects = []; // Clear projects list
    saveUsers(users);
    
    setTimeout(() => pushToGitHub(`Admin banned user: ${targetUsername}`), 500);
    res.json({ success: true });
});

// --- Static Files ---
app.use(express.static('public')); // Serves index.html, dashboard.html
app.use(express.static('sites')); // Serves uploaded sites

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
