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
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // 1 day
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
    
    if (!token || !repo) {
        console.log('Skipping GitHub push: credentials missing.');
        return;
    }

    try {
        console.log(`Pushing to GitHub: ${commitMessage}...`);
        const remoteUrl = `https://${token}@github.com/${repo}.git`;
        
        execSync(`git config user.email "server@render.com"`);
        execSync(`git config user.name "Auto Server"`);
        
        execSync(`git add sites/ users.json`);
        
        const status = execSync('git status --porcelain').toString();
        if (status.length > 0) {
            execSync(`git commit -m "${commitMessage}"`);
            execSync(`git push "${remoteUrl}" HEAD:main`);
            console.log('Successfully saved to GitHub!');
        }
    } catch (error) {
        console.error('Failed to save to GitHub:', error.message);
    }
}

// Authentication Middleware
function requireAuth(req, res, next) {
    if (req.session.username) {
        next();
    } else {
        res.redirect('/');
    }
}

// --- Auth Routes ---
app.post('/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send('Username and password required');
    
    const users = getUsers();
    if (users[username]) return res.status(400).send('Username already exists. Please <a href="/">Login</a>');
    
    // Hash password
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    users[username] = { password: hash, projects: [] };
    saveUsers(users);
    
    // Sync users.json to GitHub
    setTimeout(() => pushToGitHub(`Registered new user: ${username}`), 500);
    
    req.session.username = username;
    res.redirect('/dashboard.html');
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const users = getUsers();
    
    if (!users[username]) return res.status(400).send('Invalid credentials. <a href="/">Try again</a>');
    
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    if (users[username].password !== hash) return res.status(400).send('Invalid credentials. <a href="/">Try again</a>');
    
    req.session.username = username;
    res.redirect('/dashboard.html');
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Protect dashboard route
app.get('/dashboard.html', requireAuth, (req, res, next) => {
    next(); // Express static will serve the file if auth passes
});

// --- Dashboard API ---
app.get('/api/user', requireAuth, (req, res) => {
    const users = getUsers();
    const myProjects = users[req.session.username].projects || [];
    
    // Check if they are actually running (folder exists)
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
    
    if (!users[username].projects.includes(siteName)) {
        return res.status(403).send('You do not own this project.');
    }
    
    // Delete local folder
    const targetDir = path.join(sitesDir, siteName);
    if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
    }
    
    // Remove from user's list
    users[username].projects = users[username].projects.filter(p => p !== siteName);
    saveUsers(users);
    
    // Push deletion to GitHub
    try {
        // If git rm fails because file wasn't tracked, we just catch and continue
        execSync(`git rm -r --ignore-unmatch sites/${siteName}`);
    } catch(e) {}
    
    setTimeout(() => pushToGitHub(`Deleted site: ${siteName} by ${username}`), 500);
    
    res.json({ success: true });
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
    
    // Force lowercase and clean string
    siteName = siteName.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const targetDir = path.join(sitesDir, siteName);
    
    // Check if name is taken by someone else
    if (fs.existsSync(targetDir)) {
        const users = getUsers();
        if (!users[req.session.username].projects.includes(siteName)) {
            fs.unlinkSync(req.file.path); // remove temp file
            return res.status(400).send('URL name is already taken by someone else. <a href="/dashboard.html">Back</a>');
        }
    }

    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();
    const username = req.session.username;

    try {
        if (ext === '.zip') {
            const zip = new AdmZip(filePath);
            zip.extractAllTo(targetDir, true);
            fs.unlinkSync(filePath);
        } else {
            const newFilePath = path.join(targetDir, (ext === '.html' || ext === '.htm') ? 'index.html' : req.file.originalname);
            fs.renameSync(filePath, newFilePath);
        }
        
        // Update user projects if it's a new project
        const users = getUsers();
        if (!users[username].projects) users[username].projects = [];
        if (!users[username].projects.includes(siteName)) {
            users[username].projects.push(siteName);
            saveUsers(users);
        }
        
        setTimeout(() => pushToGitHub(`Uploaded site: ${siteName} by ${username}`), 1000);
        
        res.redirect('/dashboard.html?success=' + siteName);
    } catch (err) {
        console.error(err);
        res.status(500).send('Upload error.');
    }
});

// --- Static Files ---
app.use(express.static('public')); // Serves index.html, dashboard.html
app.use(express.static('sites')); // Serves uploaded sites

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
