const express = require('express');
const { chromium } = require('playwright');
const nodemailer = require('nodemailer');
const { ChromaClient } = require('chromadb');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');
const { exec } = require('child_process');
const net = require('net');
const http = require('http');
const WebSocket = require('ws');
const cron = require('node-cron');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const configPath = path.resolve('./config.json');
let config = JSON.parse(fs.readFileSync(configPath));

const chromaDBPath = path.resolve(__dirname, './data');

let isScraperRunning = false;
let scraperProgress = '';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const isChromaServerRunning = async () => {
  return new Promise((resolve) => {
    const client = new net.Socket();
    client.setTimeout(1000);
    client.connect(8000, 'localhost', () => {
      client.destroy();
      resolve(true);
    });
    client.on('error', () => resolve(false));
    client.on('timeout', () => {
      client.destroy();
      resolve(false);
    });
  });
};

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:89.0) Gecko/20100101 Firefox/89.0'
];

const proxyList = process.env.PROXY_LIST.split(',').map(proxy => {
  const [server, username, password] = proxy.split('|');
  return { server, username, password };
});

let currentProxyIndex = 0;

function getNextProxy() {
  const proxy = proxyList[currentProxyIndex];
  currentProxyIndex = (currentProxyIndex + 1) % proxyList.length;
  return proxy;
}

async function isProxyHealthy(proxy) {
  console.log(`Checking health of proxy: ${proxy.server}`);
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
    proxy: proxy
  });
  try {
    const page = await browser.newPage();
    await page.goto('https://api.ipify.org?format=json', { timeout: 30000 });
    const content = await page.content();
    await browser.close();
    const isHealthy = content.includes(proxy.server.split('://')[1].split(':')[0]);
    console.log(`Proxy ${proxy.server} health check result: ${isHealthy}`);
    return isHealthy;
  } catch (error) {
    console.error(`Proxy ${proxy.server} health check failed:`, error);
    await browser.close();
    return false;
  }
}

const matchesPattern = (url, pattern) => {
  if (!pattern || pattern.trim() === '') return true;
  const regexPattern = pattern.replace(/\./g, '\\.').replace(/\*/g, '.*');
  const regex = new RegExp(regexPattern, 'i');
  return regex.test(url);
};

const chromaServer = exec(`chroma run --path ${chromaDBPath}`, (error, stdout, stderr) => {
  if (error) {
    console.error(`Error starting ChromaDB server: ${error.message}`);
    return;
  }
  if (stderr) {
    console.error(`ChromaDB stderr: ${stderr}`);
  }
  console.log(`ChromaDB stdout: ${stdout}`);
});

chromaServer.stdout.on('data', (data) => {
  console.log(`ChromaDB stdout: ${data}`);
});

chromaServer.stderr.on('data', (data) => {
  console.error(`ChromaDB stderr: ${data}`);
});

wss.on('connection', (ws) => {
  console.log('New WebSocket connection');
  ws.on('close', () => console.log('WebSocket connection closed'));
});

function broadcastUpdate(update) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(update));
    }
  });
}

async function simulateHumanBehavior(page) {
  const viewportSize = await page.viewportSize();
  const { width, height } = viewportSize;

  // Simulate scrolling
  for (let i = 0; i < 5; i++) {
    await page.mouse.move(Math.random() * width, Math.random() * height);
    await page.mouse.wheel(0, (Math.random() - 0.5) * 100);
    await delay(500 + Math.random() * 1000);
  }

  // Simulate random mouse movements
  for (let i = 0; i < 10; i++) {
    await page.mouse.move(Math.random() * width, Math.random() * height);
    await delay(100 + Math.random() * 200);
  }
}

async function checkIP(page) {
  await page.goto('https://api.ipify.org?format=json');
  const ip = await page.evaluate(() => {
    return JSON.parse(document.body.textContent).ip;
  });
  console.log(`Current IP address: ${ip}`);
}

async function scrapeGoogleResults(searchTerm, maxRetries = 5) {
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchTerm)}`;
  
  for (let retries = 0; retries < maxRetries; retries++) {
    const proxy = getNextProxy();
    console.log(`Attempt ${retries + 1} of ${maxRetries} using proxy: ${proxy.server}`);

    if (!(await isProxyHealthy(proxy))) {
      console.log(`Proxy ${proxy.server} is not healthy, trying next...`);
      continue;
    }

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox'],
      proxy: proxy
    });

    try {
      const context = await browser.newContext({
        userAgent: userAgents[Math.floor(Math.random() * userAgents.length)],
        viewport: { width: 1920, height: 1080 }
      });
      const page = await context.newPage();
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
      });

      // Navigate directly to the Google search URL
      await page.goto(searchUrl, { waitUntil: 'networkidle0', timeout: 10000 });
      console.log(`Successfully searched for: ${searchTerm}`);

      const pageContent = await page.content();
      if (pageContent.includes('blocked') || pageContent.includes('captcha')) {
        console.log('Possible block detected');
        throw new Error('Possible block detected');
      }

      await page.waitForSelector('h3', { timeout: 15000 });

      const results = await page.evaluate(() => {
        const resultElements = document.querySelectorAll('.g');
        return Array.from(resultElements).map(result => ({
          title: result.querySelector('h3')?.innerText.trim() || '',
          link: result.querySelector('a')?.href.trim() || '',
          snippet: result.querySelector('.IsZvec')?.innerText.trim() || '',
          date: ''
        }));
      });

      console.log(`Found ${results.length} results for "${searchTerm}"`);
      await browser.close();
      return results;

    } catch (error) {
      console.error(`Error during scraping (Attempt ${retries + 1} of ${maxRetries}):`, error);
      await browser.close();

      if (retries < maxRetries - 1) {
        const delayTime = Math.pow(2, retries + 1) * 1000;
        console.log(`Retrying with a different proxy in ${delayTime / 1000} seconds...`);
        await delay(delayTime);
      } else {
        console.error('Max retries reached. Skipping this search term.');
      }
    }
  }
  return [];
}

async function sendEmailReport(newEntries) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const reportHtml = `
    <h1>Job Scraper Report</h1>
    <p>Total new job listings found: ${newEntries.length}</p>
    <h2>New Listings:</h2>
    <ul>
      ${newEntries.map(entry => `
        <li>
          <strong>${entry.title}</strong><br>
          Job Board: ${entry.jobBoard}<br>
          Search Term: ${entry.searchTerm}<br>
          Location: ${entry.location}<br>
          <a href="${entry.link}">View Job</a>
        </li>
      `).join('')}
    </ul>
  `;

  const mailOptions = {
    from: process.env.SMTP_FROM,
    to: process.env.REPORT_EMAIL,
    subject: 'Job Scraper Report',
    html: reportHtml,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    console.log('Email report sent:', info.messageId);
  } catch (error) {
    console.error('Error sending email report:', error);
  }
}

async function scrapeAndSend() {
  if (isScraperRunning) {
    console.log('Scraper is already running');
    return;
  }

  isScraperRunning = true;
  scraperProgress = 'Scraping in progress...';
  broadcastUpdate({ type: 'scrapeStart' });

  try {
    const entries = [];
    const chromaClient = new ChromaClient({ basePath: 'http://localhost:8000' });
    const collection = await chromaClient.getOrCreateCollection({ name: 'job_listings' });

    for (const jobBoardConfig of config.job_boards) {
      const jobBoard = jobBoardConfig.name;
      for (const searchTerm of config.search_terms) {
        for (const location of config.locations) {
          const combinedSearchTerm = `${jobBoard}: ${searchTerm}, ${location}`;
          console.log(`Searching: ${combinedSearchTerm}`);

          const results = await scrapeGoogleResults(combinedSearchTerm);
          const filteredResults = results.filter(result => matchesPattern(result.link, jobBoardConfig.url_pattern));

          for (const result of filteredResults) {
            if (result.link.toLowerCase().includes(jobBoard.toLowerCase())) {
              const existingEntries = await collection.get({
                where: {
                  $and: [
                    { link: result.link },
                    { jobBoard: jobBoard },
                    { searchTerm: searchTerm },
                    { location: location }
                  ]
                }
              });

              if (existingEntries.ids.length === 0) {
                await collection.add({
                  documents: [result.snippet],
                  metadatas: [{
                    title: result.title,
                    link: result.link,
                    jobBoard: jobBoard,
                    searchTerm: searchTerm,
                    location: location
                  }],
                  ids: [`${result.link}_${jobBoard}_${searchTerm}_${location}`]
                });
                entries.push({ ...result, jobBoard, searchTerm, location });

                broadcastUpdate({
                  type: 'new_listing',
                  data: {
                    ...result,
                    jobBoard,
                    searchTerm,
                    location
                  }
                });
              } else {
                console.log(`Entry already exists: ${result.link} - ${jobBoard} - ${searchTerm} - ${location}`);
              }
            }
          }

          // Implement random delays between requests to mimic human behavior
          const randomDelay = 3000 + Math.random() * 7000; // Random delay between 3 to 10 seconds
          console.log(`Waiting for ${randomDelay / 1000} seconds before next request...`);
          await delay(randomDelay);
        }
      }
    }

    console.log(`Scraping complete. Found ${entries.length} new entries.`);
    broadcastUpdate({ type: 'scrapeComplete', newEntriesCount: entries.length });

    // Send email report
    await sendEmailReport(entries);

  } catch (error) {
    console.error('Error during scraping and sending notifications:', error);
    broadcastUpdate({ type: 'scrapeError', message: 'Error during scraping and sending notifications' });
  } finally {
    isScraperRunning = false;
    scraperProgress = '';
  }
}

cron.schedule('0 10,15 * * *', () => {
  console.log('Running scheduled scrape');
  scrapeAndSend();
});

async function updateListingStatus(id, status) {
  const chromaClient = new ChromaClient({ basePath: 'http://localhost:8000' });
  const collection = await chromaClient.getOrCreateCollection({ name: 'job_listings' });
  
  await collection.update({
    ids: [id],
    metadatas: [{ status: status }]
  });
}

app.post('/update-listing-status', async (req, res) => {
  const { id, status } = req.body;
  try {
    await updateListingStatus(id, status);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating listing status:', error);
    res.status(500).json({ success: false, error: 'Failed to update listing status' });
  }
});

app.get('/', async (req, res) => {
  try {
    const chromaClient = new ChromaClient({ basePath: 'http://localhost:8000' });
    const collection = await chromaClient.getOrCreateCollection({ name: 'job_listings' });
    const result = await collection.get();

    const listings = result.ids.map((id, index) => ({
      id: id,
      title: result.metadatas[index].title,
      link: result.metadatas[index].link,
      snippet: result.documents[index],
      jobBoard: result.metadatas[index].jobBoard,
      searchTerm: result.metadatas[index].searchTerm,
      location: result.metadatas[index].location || 'Unknown Location',
      status: result.metadatas[index].status || 'new'
    }));

    console.log(`Fetched ${listings.length} listings from the database`);

    res.render('index', {
      config,
      listings,
      isScraperRunning,
      scraperProgress
    });
  } catch (error) {
    console.error('Error fetching listings:', error);
    res.render('index', {
      config,
      listings: [],
      error: 'Error fetching listings',
      isScraperRunning,
      scraperProgress,
    });
  }
});

app.post('/update-config', async (req, res) => {
  config.job_boards = req.body.job_boards
    .filter(board => board.name.trim() !== "")
    .map(board => ({
      name: board.name.trim(),
      url_pattern: board.url_pattern.trim()
    }));

  config.search_terms = req.body.search_terms.split(',').map(term => term.trim());
  config.locations = req.body.locations.split(',').map(location => location.trim());

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  res.redirect('/');
});

app.post('/scrape-and-send', (req, res) => {
  if (!isScraperRunning) {
    scrapeAndSend();
    res.json({ success: true, message: 'Scraping started' });
  } else {
    res.json({ success: false, message: 'Scraper is already running' });
  }
});

app.get('/scraper-status', (req, res) => {
  res.json({
    isRunning: isScraperRunning,
    progress: scraperProgress
  });
});

(async () => {
  while (!(await isChromaServerRunning())) {
    console.log('Waiting for ChromaDB server to start...');
    await delay(1000);
  }

  console.log('ChromaDB server is running. Starting the main application...');

  server.listen(5627, '0.0.0.0', () => console.log('Server running on http://0.0.0.0:5627'));
})();