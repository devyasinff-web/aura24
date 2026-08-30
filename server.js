const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// Set up storage for uploaded files
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/')
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname)
    }
});

const upload = multer({ storage: storage });

// Create uploads and sites directories if they don't exist
const uploadsDir = path.join(__dirname, 'uploads');
const sitesDir = path.join(__dirname, 'sites');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(sitesDir)) fs.mkdirSync(sitesDir);

// Serve static files from the 'public' directory
app.use(express.static('public'));

// Serve static files for each uploaded site dynamically
app.use(express.static('sites'));

// Function to push directly to your GitHub Repository
function pushToGitHub(siteName) {
    // These must be set in Render Environment Variables
    const token = process.env.GITHUB_TOKEN; 
    const repo = process.env.GITHUB_REPO; // e.g. "devyasinff-web/36"
    
    if (!token || !repo) {
        console.log('Error: GITHUB_TOKEN or GITHUB_REPO is missing. Cannot save to GitHub.');
        return;
    }

    try {
        console.log(`Saving ${siteName} directly to GitHub repo: ${repo}...`);
        
        // This is the URL that has permission to save to your GitHub
        const remoteUrl = `https://${token}@github.com/${repo}.git`;
        
        execSync(`git config user.email "server@render.com"`);
        execSync(`git config user.name "Auto Upload Server"`);
        
        execSync(`git add sites/`);
        
        const status = execSync('git status --porcelain').toString();
        if (status.length > 0) {
            execSync(`git commit -m "Auto-uploaded new site: ${siteName}"`);
            execSync(`git push "${remoteUrl}" HEAD:main`); // Pushing to main branch
            console.log('Successfully saved to GitHub!');
        }
    } catch (error) {
        console.error('Failed to save to GitHub:', error.message);
    }
}

app.post('/upload', upload.single('siteFile'), (req, res) => {
    const siteName = req.body.siteName;
    
    if (!siteName) {
        return res.status(400).send('Please provide a name for your site.');
    }
    if (!req.file) {
        return res.status(400).send('Please upload a file (.html or .zip).');
    }

    const safeSiteName = siteName.replace(/[^a-zA-Z0-9_-]/g, '');
    const targetDir = path.join(sitesDir, safeSiteName);

    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();

    try {
        if (ext === '.zip') {
            const zip = new AdmZip(filePath);
            zip.extractAllTo(targetDir, true);
            fs.unlinkSync(filePath);
            
            // Auto-save to GitHub in the background
            setTimeout(() => pushToGitHub(safeSiteName), 1000);
            
            res.send(`<h2>Success!</h2><p>Your site is live at: <a href="/${safeSiteName}" target="_blank">/${safeSiteName}</a></p><p>Saving to GitHub in background...</p><br><a href="/">Upload another</a>`);
        } else if (ext === '.html' || ext === '.htm') {
            const newFilePath = path.join(targetDir, 'index.html');
            fs.renameSync(filePath, newFilePath);
            
            // Auto-save to GitHub in the background
            setTimeout(() => pushToGitHub(safeSiteName), 1000);
            
            res.send(`<h2>Success!</h2><p>Your site is live at: <a href="/${safeSiteName}" target="_blank">/${safeSiteName}</a></p><p>Saving to GitHub in background...</p><br><a href="/">Upload another</a>`);
        } else {
            const newFilePath = path.join(targetDir, req.file.originalname);
            fs.renameSync(filePath, newFilePath);
            
            setTimeout(() => pushToGitHub(safeSiteName), 1000);
            
            res.send(`<h2>Success!</h2><p>Your file is live at: <a href="/${safeSiteName}/${req.file.originalname}" target="_blank">/${safeSiteName}/${req.file.originalname}</a></p><p>Saving to GitHub in background...</p><br><a href="/">Upload another</a>`);
        }
    } catch (err) {
        console.error(err);
        res.status(500).send('An error occurred.');
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
