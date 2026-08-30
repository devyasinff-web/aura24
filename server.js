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
    if (!req.session.username) return res.redirect('/');
    const users = getUsers();
    if (users[req.session.username] && users[req.session.username].banned) {
        req.session.destroy();
        return res.status(403).send('Your account has been banned.');
    }
    next();
}
function requireAdmin(req, res, next) {
    if (req.session.username === 'devyasin') next();
    else res.status(403).send('Forbidden: Admin access only.');
}

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
    req.session.username = username;
    res.redirect('/dashboard.html');
});

app.post('/login', (req, res) => {
    let { username, password } = req.body;
    username = username.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const users = getUsers();
    if (!users[username]) return res.status(400).send('Invalid credentials.');
    if (users[username].banned) return res.status(403).send('Account banned.');
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    if (users[username].password !== hash) return res.status(400).send('Invalid credentials.');
    req.session.username = username;
    res.redirect(username === 'devyasin' ? '/devyasin' : '/dashboard.html');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
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

    // Rename folders
    const oldSiteDir = path.join(sitesDir, oldName);
    const newSiteDir = path.join(sitesDir, newName);
    const oldVerDir = path.join(versionsDir, oldName);
    const newVerDir = path.join(versionsDir, newName);

    if (fs.existsSync(oldSiteDir)) fs.renameSync(oldSiteDir, newSiteDir);
    if (fs.existsSync(oldVerDir)) fs.renameSync(oldVerDir, newVerDir);

    // Update users.json
    users[username].projects = users[username].projects.map(p => p === oldName ? newName : p);
    saveUsers(users);

    try {
        execSync(`git rm -r --ignore-unmatch sites/${oldName} versions/${oldName}`);
    } catch(e) {}
    
    setTimeout(() => pushToGitHub(`Renamed project from ${oldName} to ${newName}`), 500);
    res.json({ success: true, newName });
});

app.get('/api/download-version', requireAuth, (req, res) => {
    const { project, v } = req.query;
    const username = req.session.username;
    const users = getUsers();
    
    // Admin can download anything, others only their own
    if (username !== 'devyasin' && !users[username].projects.includes(project)) {
        return res.status(403).send('Not authorized.');
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

app.post('/upload', requireAuth, upload.single('siteFile'), (req, res) => {
    let siteName = req.body.siteName;
    if (!siteName || !req.file) return res.status(400).send('Name and file required.');
    
    siteName = siteName.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const username = req.session.username;
    const users = getUsers();
    const isUpdate = req.body.isUpdate === 'true';
    
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

    // Determine Version Number
    if (!fs.existsSync(verTargetDir)) fs.mkdirSync(verTargetDir, { recursive: true });
    const existingVersions = fs.readdirSync(verTargetDir);
    const versionNum = existingVersions.length + 1;
    
    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    
    // Copy to versions
    const verFilePath = path.join(verTargetDir, `${versionNum}.0${ext === '.zip' ? '.zip' : '.html'}`);
    fs.copyFileSync(filePath, verFilePath);

    // Empty target site dir for clean extraction
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
        fs.unlinkSync(filePath); // delete temp upload
        
        if (!users[username].projects) users[username].projects = [];
        if (!users[username].projects.includes(siteName)) {
            users[username].projects.push(siteName);
            saveUsers(users);
        }
        
        setTimeout(() => pushToGitHub(`Uploaded v${versionNum}.0 for ${siteName}`), 1000);
        res.redirect('/dashboard.html?success=' + siteName);
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

// Admin endpoints (omitted re-implementation of replace for brevity, admin can just delete/ban)
app.get('/devyasin', requireAuth, requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/api/admin/all', requireAuth, requireAdmin, (req, res) => {
    const users = getUsers();
    res.json({ users: Object.fromEntries(Object.entries(users).map(([k,v]) => [k, { banned: v.banned, projects: v.projects }])) });
});
app.post('/api/admin/ban', requireAuth, requireAdmin, (req, res) => {
    const { targetUsername } = req.body;
    if (targetUsername === 'devyasin') return res.status(400).send();
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

app.use(express.static('public'));
app.use(express.static('sites'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
