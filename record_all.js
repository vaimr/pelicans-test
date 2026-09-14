const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const MAX_CONCURRENT = 3;
const FFmpeg_TIMEOUT = 120000;

function execCmd(cmd, timeout = FFmpeg_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const proc = exec(cmd, { timeout, maxBuffer: 500 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        console.error('    ffmpeg stderr:', stderr.trim().substring(0, 200));
        reject(error);
      } else {
        resolve(stdout);
      }
    });
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch(e) {} }, timeout + 5000);
  });
}

class Semaphore {
  constructor(max) { this.max = max; this.queue = []; this.current = 0; }
  async acquire() {
    if (this.current < this.max) { this.current++; return true; }
    return new Promise(resolve => { this.queue.push(resolve); });
  }
  release() { this.current--; if (this.queue.length > 0) { const next = this.queue.shift(); next(); } }
}

const MODEL_INFO = {
  'gpt':                  { label: 'GPT Astra',             },
  'deepseek':             { label: 'DeepSeek',              },
  'qwen/3.6-local':       { label: 'Qwen 3.6 Local',        },
  'qwen/3.8-local':       { label: 'Qwen 3.8 Local',        },
  'qwen/3.8-flash-local': { label: 'Qwen 3.8 Flash',        },
  'alise':                { label: 'Alise',                 },
  'bigpickle':            { label: 'BigPickle',             },
  'giga':                 { label: 'Giga',                  },
};

/** Extract scene name from filename like "2026-09-pelican-skynet" or "2026-09-reasoning-pelican" */
function getSceneName(sceneFile) {
  if (sceneFile.includes('reasoning')) {
    if (sceneFile.includes('skynet')) return 'Skynet Reasoning';
    if (sceneFile.includes('pelican')) return 'Pelican Reasoning';
    if (sceneFile.includes('frog')) return 'Frog Reasoning';
    return 'Reasoning';
  }
  if (sceneFile.includes('skynet')) return 'Skynet';
  if (sceneFile.includes('pelican')) return 'Pelican';
  if (sceneFile.includes('frog')) return 'Frog';
  return 'Unknown';
}

/** Derive short label for filenames: "Pelican Reasoning" -> "Pelican_Reasoning" */
function sceneToShort(scene) {
  return scene.replace(/[^a-zA-Z0-9а-яА-Я ]/g, '').replace(/\s+/g, '_');
}

function buildPages() {
  const modelOrder = [
    'gpt', 'deepseek', 'qwen/3.6-local', 'qwen/3.8-local', 'qwen/3.8-flash-local',
    'alise', 'bigpickle', 'giga'
  ];
  // Order: pelican -> frog -> skynet, then reasoning variants
  const sceneOrder = [
    'pelican', 'frog', 'pelican-skynet',
    'reasoning-pelican', 'reasoning-frog', 'reasoning-pelican-skynet'
  ];

  const pages = [];
  for (const model of modelOrder) {
    const info = MODEL_INFO[model];
    for (const scene of sceneOrder) {
      const fp = path.join(__dirname, 'tests', model, `2026-09-${scene}.html`);
      if (fs.existsSync(fp)) {
        pages.push({
          filePath: fp,
          modelLabel: info.label,
          scene: getSceneName(scene),
        });
      }
    }
  }
  return pages;
}

async function interactWithPage(page) {
  await page.waitForTimeout(3000);

  // Try to find and click pause/controls
  try {
    const pauseBtn = await page.$('button, label, [class*="pause"], [class*="play"], [class*="control"], [class*="button"]');
    if (pauseBtn) {
      await pauseBtn.click(); await page.waitForTimeout(2000);
      await pauseBtn.click(); await page.waitForTimeout(2000);
    }
  } catch (e) {}

  // Try speed/other controls
  try {
    const btns = await page.$$('button, [class*="speed"], [class*="control"], [class*="rate"]');
    for (const btn of btns) { try { await btn.click(); await page.waitForTimeout(2000); } catch(e) {} }
  } catch (e) {}

  // Smooth scroll down + up
  try {
    const scrollable = await page.evaluate(() => document.body.scrollHeight > window.innerHeight + 50);
    if (scrollable) {
      await page.evaluate(() => new Promise(resolve => {
        const start = 0, end = document.body.scrollHeight, duration = 5500;
        const startTime = performance.now();
        function ease(t) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2; }
        function animate(now) {
          const p = Math.min((now - startTime) / duration, 1);
          window.scrollTo(0, start + (end - start) * ease(p));
          if (p < 1) requestAnimationFrame(animate); else resolve();
        }
        requestAnimationFrame(animate);
      }));
      await page.waitForTimeout(2000);
      await page.evaluate(() => new Promise(resolve => {
        const start = window.scrollY, duration = 3000;
        const startTime = performance.now();
        function ease(t) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2; }
        function animate(now) {
          const p = Math.min((now - startTime) / duration, 1);
          window.scrollTo(0, start * (1 - ease(p)));
          if (p < 1) requestAnimationFrame(animate); else resolve();
        }
        requestAnimationFrame(animate);
      }));
      await page.waitForTimeout(1000);
    }
  } catch (e) {}
}

async function recordPage(pageInfo, videoDir, semaphore) {
  const { filePath, modelLabel, scene } = pageInfo;
  const safeScene = sceneToShort(scene);

  // Clean model label: spaces -> underscores, remove special chars
  const safeModel = modelLabel.replace(/[^a-zA-Z0-9а-яА-Я ]/g, '').replace(/\s+/g, '_');

  const videoName = `${safeModel}_${safeScene}.mp4`;
  const labeledName = `${safeModel}_${safeScene}_labeled.mp4`;
  const videoPath = path.join(videoDir, videoName);
  const labelOverlayPath = path.join(videoDir, labeledName);

  console.log(`  Recording: ${modelLabel} — ${scene}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: videoDir, size: { width: 1920, height: 1080 } },
  });

  const p = await context.newPage();
  const timeoutId = setTimeout(() => { browser.close().catch(()=>{}); }, RECORD_TIMEOUT);

  try {
    const fileUrl = 'file://' + path.resolve(filePath);
    await p.goto(fileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await interactWithPage(p);
    await p.waitForTimeout(10000);

    const video = p.video();
    let actualVideoPath = video ? await video.path() : null;

    clearTimeout(timeoutId);
    await p.close();
    await context.close();
    await browser.close();

    if (!actualVideoPath) throw new Error('No video captured');

    if (actualVideoPath !== videoPath) fs.renameSync(actualVideoPath, videoPath);

    const sizeMB = (fs.statSync(videoPath).size / 1024 / 1024).toFixed(1);
    console.log(`  Recorded: ${videoName} (${sizeMB} MB)`);

    // Add label overlay with ffmpeg
    const labelText = `${modelLabel} — ${scene}`;
    try {
      await execCmd(
        `ffmpeg -y -i "${videoPath}" ` +
        `-vf "drawtext=text='${labelText}':fontsize=36:fontcolor=white:x=30:y=30:enable='between(t,0,3)':box=1:boxcolor=black@0.7:boxborderw=8" ` +
        `-c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p "${labelOverlayPath}" 2>&1`,
        FFmpeg_TIMEOUT
      );
      console.log(`  Labeled: ${labeledName}`);
    } catch (e) {
      console.error(`  Label overlay failed, copying raw: ${e.message}`);
      fs.copyFileSync(videoPath, labelOverlayPath);
    }
  } catch (e) {
    clearTimeout(timeoutId);
    try { await p.close(); } catch(e2){}
    try { await context.close(); } catch(e2){}
    try { await browser.close(); } catch(e2){}
    console.error(`  FAILED: ${e.message}`);
  } finally {
    semaphore.release();
  }

  return { labeledName, videoPath, labelOverlayPath };
}

const RECORD_TIMEOUT = 90000; // 90s per page

async function main() {
  const videoDir = path.join(__dirname, 'screenshots');
  fs.mkdirSync(videoDir, { recursive: true });

  const pages = buildPages();
  console.log(`Total pages to record: ${pages.length}\n`);

  // Clean old labeled videos
  const existing = fs.readdirSync(videoDir);
  existing.forEach(f => {
    if (f.endsWith('_labeled.mp4') || (f.endsWith('.mp4') && !f.startsWith('overview'))) {
      fs.unlinkSync(path.join(videoDir, f));
    }
  });

  const semaphore = new Semaphore(MAX_CONCURRENT);
  const results = [];

  for (let i = 0; i < pages.length; i += MAX_CONCURRENT) {
    const batch = pages.slice(i, i + MAX_CONCURRENT);
    console.log(`\n=== Batch ${Math.floor(i / MAX_CONCURRENT) + 1}: ${batch.map(p => p.modelLabel).join(', ')} ===\n`);

    const promises = batch.map((pageInfo, idx) => {
      return semaphore.acquire().then(() => {
        return recordPage(pageInfo, videoDir, semaphore)
          .then(r => { results.push(r); return r; })
          .catch(e => { console.error(`  ERROR: ${e.message}`); return null; });
      });
    });

    await Promise.all(promises);
  }

  console.log(`\n=== Done. ${results.filter(Boolean).length}/${pages.length} pages ===`);

  // Verification
  const expectedFiles = pages.map(p => {
    const sm = p.modelLabel.replace(/[^a-zA-Z0-9а-яА-Я ]/g, '').replace(/\s+/g, '_');
    return `${sm}_${sceneToShort(p.scene)}_labeled.mp4`;
  });

  const actualFiles = fs.readdirSync(videoDir).filter(f => f.endsWith('_labeled.mp4'));
  console.log(`\nExpected: ${expectedFiles.length}, Found: ${actualFiles.length}`);
  const missing = expectedFiles.filter(f => !actualFiles.includes(f));
  if (missing.length > 0) {
    console.log(`MISSING: ${missing.join('\n  ')}`);
  } else {
    console.log('All 33 videos present ✓');
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
