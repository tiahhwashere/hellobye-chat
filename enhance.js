
const fs = require('fs');
const path = require('path');

let sharp;
try {
  sharp = require('sharp');
} catch (err) {
  console.error('[enhance] WARNING: sharp native module failed to load \u2014 image enhancement will be disabled. Original uploads will be served unenhanced. Error:', err.message);
  sharp = null;
}

const STATIC_TARGET = 3840;
const ANIMATED_TARGET = 1080;
const SHARPEN = { sigma: 0.6, m1: 0.6, m2: 3 };

async function readMeta(filePath) {
  return sharp(filePath, { animated: true }).metadata();
}

async function enhanceUpload(filePath, opts) {
  opts = opts || {};
  const staticTarget = opts.maxStatic || STATIC_TARGET;
  const animatedTarget = opts.maxAnimated || ANIMATED_TARGET;
  const noSharpen = opts.noSharpen === true;
  if (!filePath || !fs.existsSync(filePath)) {
    return { enhanced: false, width: 0, height: 0, format: '', reason: 'file not found' };
  }
  if (!sharp) {
    return { enhanced: false, width: 0, height: 0, format: '', reason: 'sharp module unavailable' };
  }
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.svg') {
    return { enhanced: false, width: 0, height: 0, format: 'svg', reason: 'vector format, untouched' };
  }

  let meta;
  try {
    meta = await readMeta(filePath);
  } catch (e) {
    return { enhanced: false, width: 0, height: 0, format: '', reason: 'unreadable by sharp: ' + e.message };
  }

  const isAnimated = (meta.format === 'gif' || meta.format === 'webp') && (meta.pages || 1) > 1;
  const longestEdge = Math.max(meta.width || 0, (meta.pageHeight || meta.height) || 0);

  const skipAnimated = opts.skipAnimated !== false;
  if (isAnimated && skipAnimated) {
    return {
      enhanced: false,
      width: meta.width || 0,
      height: (meta.pageHeight || meta.height) || 0,
      format: meta.format || '',
      animated: true,
      reason: 'animated file served as-is (per-frame resize skipped to avoid lag)',
    };
  }

  const target = isAnimated ? animatedTarget : staticTarget;

  const shouldUpscale = longestEdge > 0 && longestEdge < target;
  const resizeOpts = shouldUpscale
    ? { width: target, height: target, fit: 'inside', withoutEnlargement: false, kernel: 'lanczos3' }
    : null;

  try {
    const pipeline = sharp(filePath, { animated: true });
    if (resizeOpts) pipeline.resize(resizeOpts);
    if (!noSharpen) pipeline.sharpen(SHARPEN);

    let outBuf;
    if (isAnimated) {
      if (meta.format === 'gif') {
        outBuf = await pipeline.gif({ loop: meta.loop || 0, delay: meta.delay }).toBuffer();
      } else {
        outBuf = await pipeline.webp({ quality: 100, alphaQuality: 100 }).toBuffer();
      }
    } else if (meta.format === 'jpeg' || ext === '.jpg' || ext === '.jpeg') {
      outBuf = await pipeline.jpeg({ quality: 95, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer();
    } else if (meta.format === 'webp' || ext === '.webp') {
      outBuf = await pipeline.webp({ quality: 100, alphaQuality: 100, lossless: false }).toBuffer();
    } else {
      outBuf = await pipeline.png({ quality: 100, compressionLevel: 6, palette: false }).toBuffer();
    }

    fs.writeFileSync(filePath, outBuf);

    const outMeta = await readMeta(filePath).catch(() => ({}));
    return {
      enhanced: true,
      width: outMeta.width || 0,
      height: isAnimated ? (outMeta.pageHeight || outMeta.height || 0) : (outMeta.height || 0),
      format: outMeta.format || meta.format,
      upscaled: shouldUpscale,
      animated: isAnimated,
    };
  } catch (e) {
    console.error('[enhance] Failed to enhance', filePath, '—', e.message);
    return { enhanced: false, width: meta.width || 0, height: meta.height || 0, format: meta.format || '', reason: e.message };
  }
}

module.exports = { enhanceUpload };
