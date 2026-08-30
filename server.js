const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { execSync } = require('child_process');
const cookieSession = require('cookie-session');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Security Middlewares
app.set('trust proxy', 1);
app.use(cors({
    origin: function(origin, callback) { return callback(null, true); },
    credentials: true
})); // Allow external HTML forms from subscribers with cookies

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests from this IP, please try again after 15 minutes',
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(limiter);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cookieSession({
    name: 'session',
    keys: ['render-hosting-secret-12345'],
    maxAge: 24 * 60 * 60 * 1000, // default 24h, overridden in login
    sameSite: 'none',
    secure: true
}));

// Setup directories
const uploadsDir = path.join(__dirname, 'uploads');
const sitesDir = path.join(__dirname, 'sites');
const versionsDir = path.join(__dirname, 'versions');
const usersFile = path.join(__dirname, 'users.json');

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(sitesDir)) fs.mkdirSync(sitesDir);
if (!fs.existsSync(versionsDir)) fs.mkdirSync(versionsDir);
if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, JSON.stringify({}));

// Helper functions
function getUsers() {
    try { return JSON.parse(fs.readFileSync(usersFile, 'utf8')); } 
    catch (e) { return {}; }
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
        execSync(`git add sites/ versions/ users.json`);
        const status = execSync('git status --porcelain').toString();
        if (status.length > 0) {
            execSync(`git commit -m "${commitMessage}"`);
            execSync(`git push "${remoteUrl}" HEAD:main`);
        }
    } catch (error) {
        console.error('Failed to save to GitHub:', error.message);
    }
}

// Middlewares
function requireAuth(req, res, next) {
    if (!req.session.username) return res.status(401).json({ error: 'Unauthorized' });
    const users = getUsers();
    if (users[req.session.username] && users[req.session.username].banned) {
        req.session = null;
        return res.status(403).json({ error: 'Your account has been banned.' });
    }
    next();
}
function requireAdmin(req, res, next) {
    if (req.session.isAdmin) next();
    else res.status(403).send('Forbidden: Admin access only.');
}
// --- Root / Uptime Route ---
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>API Status</title>
            <style>
                body { background: #0f111a; color: #4ade80; font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; flex-direction: column; }
                .pulse { width: 20px; height: 20px; background: #4ade80; border-radius: 50%; box-shadow: 0 0 0 0 rgba(74, 222, 128, 1); animation: pulse 2s infinite; margin-bottom: 20px; }
                @keyframes pulse { 0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.7); } 70% { transform: scale(1); box-shadow: 0 0 0 20px rgba(74, 222, 128, 0); } 100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(74, 222, 128, 0); } }
            </style>
        </head>
        <body>
            <div class="pulse"></div>
            <h2>Server is Running API Active</h2>
        </body>
        </html>
    `);
});

// --- Auth Routes ---
app.post('/register', (req, res) => {
    let { username, password } = req.body;
    if (!username || !password) return res.status(400).send('Required fields missing');
    username = username.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const users = getUsers();
    if (users[username]) {
        if (users[username].banned) return res.status(403).send('This username is permanently banned.');
        return res.status(400).send('Username already exists.');
    }
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    users[username] = { password: hash, projects: [], banned: false };
    saveUsers(users);
    setTimeout(() => pushToGitHub(`Registered user: ${username}`), 500);
    
    if (req.body.remember === 'yes') {
        req.sessionOptions.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
    } else {
        req.sessionOptions.maxAge = false; // session only
    }
    req.session.username = username;
    res.json({ success: true, message: 'Registered successfully', username: username });
});

app.post('/login', (req, res) => {
    let { username, password, remember } = req.body;
    username = username.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const users = getUsers();
    if (!users[username]) return res.status(400).send('Invalid credentials.');
    if (users[username].banned) return res.status(403).send('Account banned.');
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    if (users[username].password !== hash) return res.status(400).send('Invalid credentials.');
    
    if (remember === 'yes') {
        req.sessionOptions.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
    } else {
        req.sessionOptions.maxAge = false; // session only
    }
    
    req.session.username = username;
    res.json({ success: true, message: 'Logged in successfully', username: username });
});

app.get('/logout', (req, res) => {
    req.session = null;
    res.json({ success: true, message: 'Logged out' });
});

// --- Admin Auth ---
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    const adminPass = process.env.ADMIN_PASSWORD || 'default_admin_password_change_me';
    if (password === adminPass) {
        req.session.isAdmin = true;
        res.redirect('/devyasin');
    } else {
        res.send('<h2>Invalid Admin Password. <a href="/devyasin">Try again</a></h2>');
    }
});

app.get('/devyasin', (req, res) => {
    if (req.session.isAdmin) {
        res.sendFile(path.join(__dirname, 'admin.html'));
    } else {
        res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Admin Login</title>
            <script>
                document.addEventListener('contextmenu', event => event.preventDefault());
                document.onkeydown = function(e) {
                    if(e.keyCode == 123) return false;
                    if(e.ctrlKey && e.shiftKey && (e.keyCode == 73 || e.keyCode == 67 || e.keyCode == 74)) return false;
                    if(e.ctrlKey && (e.keyCode == 85 || e.keyCode == 83)) return false;
                };
                document.onselectstart = function() { return false; };
            </script>
            <style>
                body { font-family: 'Segoe UI', sans-serif; background: #1a202c; color: white; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; user-select: none; }
                .login-box { background: #2d3748; padding: 40px; border-radius: 8px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); text-align: center; width: 100%; max-width: 300px; }
                input[type="password"] { width: 100%; padding: 12px; margin: 20px 0; border: 1px solid #4a5568; background: #1a202c; color: white; border-radius: 4px; box-sizing: border-box; }
                button { width: 100%; padding: 12px; background: #3182ce; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; }
            </style>
        </head>
        <body>
            <div class="login-box">
                <h2 style="color:#63b3ed; margin-top:0;">Admin Portal</h2>
                <form action="/api/admin/login" method="POST">
                    <input type="password" name="password" placeholder="Enter Admin Password" required autofocus>
                    <button type="submit">Unlock</button>
                </form>
            </div>
        </body>
        </html>
        `);
    }
});

// --- API Routes ---
app.get('/api/check-url', (req, res) => {
    let siteName = req.query.name;
    if (!siteName) return res.json({ available: false });
    siteName = siteName.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const targetDir = path.join(sitesDir, siteName);
    res.json({ available: !fs.existsSync(targetDir), cleanName: siteName });
});

app.post('/api/rename-project', requireAuth, (req, res) => {
    let { oldName, newName } = req.body;
    const username = req.session.username;
    const users = getUsers();
    
    if (!users[username].projects.includes(oldName)) return res.status(403).send('Not your project.');
    
    newName = newName.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!newName || fs.existsSync(path.join(sitesDir, newName))) {
        return res.status(400).send('New name is invalid or already taken.');
    }

    const oldSiteDir = path.join(sitesDir, oldName);
    const newSiteDir = path.join(sitesDir, newName);
    const oldVerDir = path.join(versionsDir, oldName);
    const newVerDir = path.join(versionsDir, newName);

    if (fs.existsSync(oldSiteDir)) fs.renameSync(oldSiteDir, newSiteDir);
    if (fs.existsSync(oldVerDir)) fs.renameSync(oldVerDir, newVerDir);

    users[username].projects = users[username].projects.map(p => p === oldName ? newName : p);
    saveUsers(users);

    try { execSync(`git rm -r --ignore-unmatch sites/${oldName} versions/${oldName}`); } catch(e) {}
    setTimeout(() => pushToGitHub(`Renamed project from ${oldName} to ${newName}`), 500);
    res.json({ success: true, newName });
});

app.get('/api/download-version', (req, res) => {
    const { project, v } = req.query;
    
    // Check auth
    if (!req.session.isAdmin) {
        if (!req.session.username) return res.status(403).send('Not logged in.');
        const users = getUsers();
        if (!users[req.session.username].projects.includes(project)) return res.status(403).send('Not authorized.');
    }
    
    const verPath = path.join(versionsDir, project);
    if (!fs.existsSync(verPath)) return res.status(404).send('Versions not found.');
    
    const files = fs.readdirSync(verPath);
    const targetFile = files.find(f => f.startsWith(v + '.'));
    
    if (!targetFile) return res.status(404).send('Version not found.');
    res.download(path.join(verPath, targetFile));
});

// --- Upload Route ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

const ANTI_THEFT_SCRIPT = `
<script>
    document.addEventListener('contextmenu', event => event.preventDefault());
    document.onkeydown = function(e) {
        if(e.keyCode == 123) return false;
        if(e.ctrlKey && e.shiftKey && (e.keyCode == 73 || e.keyCode == 67 || e.keyCode == 74)) return false;
        if(e.ctrlKey && (e.keyCode == 85 || e.keyCode == 83)) return false;
    };
    document.onselectstart = function() { return false; };
</script>
<style>body { -webkit-user-select: none; -moz-user-select: none; -ms-user-select: none; user-select: none; }</style>
`;

app.post('/upload', requireAuth, upload.single('siteFile'), (req, res) => {
    let siteName = req.body.siteName;
    if (!siteName || !req.file) return res.status(400).send('Name and file required.');
    
    siteName = siteName.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const username = req.session.username;
    const users = getUsers();
    const isUpdate = req.body.isUpdate === 'true';
    const enableSecurity = req.body.enableSecurity === 'yes';
    
    const targetDir = path.join(sitesDir, siteName);
    const verTargetDir = path.join(versionsDir, siteName);
    
    if (!isUpdate && fs.existsSync(targetDir)) {
        if (!users[username].projects.includes(siteName)) {
            fs.unlinkSync(req.file.path);
            return res.status(400).send('URL taken.');
        }
    }

    if (isUpdate && !users[username].projects.includes(siteName)) {
        fs.unlinkSync(req.file.path);
        return res.status(403).send('Not your project to update.');
    }

    if (!fs.existsSync(verTargetDir)) fs.mkdirSync(verTargetDir, { recursive: true });
    const existingVersions = fs.readdirSync(verTargetDir);
    const versionNum = existingVersions.length + 1;
    
    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    
    const verFilePath = path.join(verTargetDir, `${versionNum}.0${ext === '.zip' ? '.zip' : '.html'}`);
    fs.copyFileSync(filePath, verFilePath);

    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });

    try {
        if (ext === '.zip') {
            const zip = new AdmZip(filePath);
            zip.extractAllTo(targetDir, true);
        } else {
            const newFilePath = path.join(targetDir, 'index.html');
            fs.copyFileSync(filePath, newFilePath);
        }
        fs.unlinkSync(filePath); 
        
        // Anti-Theft Injection
        if (enableSecurity) {
            const targetHtmlFile = path.join(targetDir, 'index.html');
            if (fs.existsSync(targetHtmlFile)) {
                let content = fs.readFileSync(targetHtmlFile, 'utf8');
                if (content.includes('</head>')) {
                    content = content.replace('</head>', ANTI_THEFT_SCRIPT + '\n</head>');
                } else {
                    content += ANTI_THEFT_SCRIPT;
                }
                fs.writeFileSync(targetHtmlFile, content);
            }
        }
        
        if (!users[username].projects) users[username].projects = [];
        if (!users[username].projects.includes(siteName)) {
            users[username].projects.push(siteName);
            saveUsers(users);
        }
        
        setTimeout(() => pushToGitHub(`Uploaded v${versionNum}.0 for ${siteName}`), 1000);
        res.json({ success: true, siteName: siteName });
    } catch (err) {
        console.error(err);
        res.status(500).send('Upload error.');
    }
});

// --- Dashboard API ---
app.get('/api/user', requireAuth, (req, res) => {
    const users = getUsers();
    const myProjects = users[req.session.username].projects || [];
    
    const projectDetails = myProjects.map(p => {
        let versions = [];
        const verPath = path.join(versionsDir, p);
        if (fs.existsSync(verPath)) {
            versions = fs.readdirSync(verPath).map(f => f.split('.')[0] + '.' + f.split('.')[1]).sort((a,b)=> parseFloat(b)-parseFloat(a));
        }
        return {
            name: p,
            live: fs.existsSync(path.join(sitesDir, p)),
            versions: versions
        };
    });
    res.json({ username: req.session.username, projects: projectDetails });
});

app.post('/api/delete', requireAuth, (req, res) => {
    const { siteName } = req.body;
    const username = req.session.username;
    const users = getUsers();
    
    if (!users[username].projects.includes(siteName)) return res.status(403).send('Not your project.');
    
    const targetDir = path.join(sitesDir, siteName);
    const verTargetDir = path.join(versionsDir, siteName);
    
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
    if (fs.existsSync(verTargetDir)) fs.rmSync(verTargetDir, { recursive: true, force: true });
    
    users[username].projects = users[username].projects.filter(p => p !== siteName);
    saveUsers(users);
    
    try { execSync(`git rm -r --ignore-unmatch sites/${siteName} versions/${siteName}`); } catch(e) {}
    setTimeout(() => pushToGitHub(`Deleted site and versions: ${siteName}`), 500);
    
    res.json({ success: true });
});

// --- Admin Endpoints ---
app.get('/api/admin/all', requireAdmin, (req, res) => {
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

app.post('/api/admin/ban', requireAdmin, (req, res) => {
    const { targetUsername } = req.body;
    const users = getUsers();
    if (users[targetUsername]) {
        users[targetUsername].banned = true;
        (users[targetUsername].projects || []).forEach(p => {
            if (fs.existsSync(path.join(sitesDir, p))) fs.rmSync(path.join(sitesDir, p), { recursive: true, force: true });
            if (fs.existsSync(path.join(versionsDir, p))) fs.rmSync(path.join(versionsDir, p), { recursive: true, force: true });
            try { execSync(`git rm -r --ignore-unmatch sites/${p} versions/${p}`); } catch(e) {}
        });
        users[targetUsername].projects = [];
        saveUsers(users);
        setTimeout(() => pushToGitHub(`Admin banned user: ${targetUsername}`), 500);
    }
    res.json({ success: true });
});

app.post('/api/admin/delete-project', requireAdmin, (req, res) => {
    const { siteName, ownerName } = req.body;
    const users = getUsers();
    
    if (users[ownerName]) {
        users[ownerName].projects = users[ownerName].projects.filter(p => p !== siteName);
        saveUsers(users);
    }
    
    if (fs.existsSync(path.join(sitesDir, siteName))) fs.rmSync(path.join(sitesDir, siteName), { recursive: true, force: true });
    if (fs.existsSync(path.join(versionsDir, siteName))) fs.rmSync(path.join(versionsDir, siteName), { recursive: true, force: true });
    
    try { execSync(`git rm -r --ignore-unmatch sites/${siteName} versions/${siteName}`); } catch(e) {}
    setTimeout(() => pushToGitHub(`Admin deleted site: ${siteName}`), 500);
    
    res.json({ success: true });
});

app.use(express.static('public'));
app.use(express.static('sites'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
