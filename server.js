import express from "express";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import os from "os";
import cors from "cors";
import { spawn } from "child_process";
import { v4 as uuid } from "uuid";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ CORS setup
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
app.use(cors({ origin: FRONTEND_URL }));

// ✅ Temp folder
const TMP_DIR = path.join(os.tmpdir(), "maps-scraper");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ✅ In-memory stores (use Redis/db for production)
const jobs = {};
const scrapers = {};

// 🚀 Start scraping job
app.post("/scrape", (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "Missing query or URL" });

  const url = query.startsWith("http")
    ? query
    : `https://www.google.com/maps/search/${encodeURIComponent(query)}/`;

  const jobId = uuid();
  jobs[jobId] = { status: "running" };

  console.log(`🚀 Starting scrape for: ${url} (jobId: ${jobId})`);

  const scraper = spawn("node", [path.join(__dirname, "scrape-maps.js"), url], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  scrapers[jobId] = scraper;

  let errorOutput = "";

  scraper.stdout.on("data", (data) => console.log(data.toString()));
  scraper.stderr.on("data", (data) => {
    errorOutput += data.toString();
    console.error(data.toString());
  });

  scraper.on("close", () => {
    delete scrapers[jobId]; // cleanup process reference

    const latest = fs
      .readdirSync(TMP_DIR)
      .filter((f) => f.endsWith(".csv"))
      .sort(
        (a, b) =>
          fs.statSync(path.join(TMP_DIR, b)).mtime -
          fs.statSync(path.join(TMP_DIR, a)).mtime
      )[0];

    if (latest) {
      jobs[jobId] = { status: "completed", file: latest };
      console.log(`✅ Scrape completed → ${latest} (jobId: ${jobId})`);
    } else {
      jobs[jobId] = { status: "failed", error: errorOutput || "No CSV file generated" };
      console.error(`❌ Scraping failed (jobId: ${jobId}):`, errorOutput);
    }
  });

  res.json({ jobId });
});

// 🧠 Check job status
app.get("/status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// 🛑 Cancel a job
app.post("/cancel/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const scraper = scrapers[jobId];

  if (scraper) {
    scraper.kill("SIGTERM");
    delete scrapers[jobId];
    jobs[jobId] = { status: "cancelled" };
    console.log(`🛑 Cancelled job ${jobId}`);
    return res.json({ success: true, message: "Job cancelled" });
  }

  res.status(404).json({ success: false, message: "No active scraper found" });
});

// 📥 Download CSV
app.get("/download/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || !job.file) return res.status(404).send("File not ready");

  const filePath = path.join(TMP_DIR, job.file);
  if (!fs.existsSync(filePath)) return res.status(404).send("File not found");

  res.download(filePath, (err) => {
    if (!err) fs.unlinkSync(filePath); // cleanup after download
  });
});

// 🧹 Periodic cleanup (optional)
setInterval(() => {
  const files = fs.readdirSync(TMP_DIR);
  const now = Date.now();
  for (const f of files) {
    const filePath = path.join(TMP_DIR, f);
    const age = now - fs.statSync(filePath).mtimeMs;
    if (age > 1000 * 60 * 30) fs.unlinkSync(filePath); // older than 30 mins
  }
}, 1000 * 60 * 10);

// ✅ Start server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
  console.log(`🌐 Frontend URL: ${FRONTEND_URL}`);
});
