// enhance.js — 4K HD enhancement pipeline for uploaded images & GIFs.
//
// Goal: when users send an image/GIF (chat message), upload a profile
// picture, or upload a banner, the file is automatically enhanced to a
// crisp, high-definition 4K-quality version before it is stored and served.
//
// Strategy by media type:
//   • Static raster images (PNG / JPEG / WebP / BMP / AVIF):
//       Upscaled so the longest edge is up to 3840px (4K UHD) using the
//       high-quality Lanczos3 resampler, then lightly sharpened and
//       re-encoded at maximum quality. Transparency is preserved.
//   • Animated images (animated GIF / animated WebP):
//       The animation (all frames) is preserved and upscaled so the longest
//       edge is up to 1080px (Full HD) using Lanczos3, then lightly
//       sharpened. A full 4K per-frame resize of an animation is far too
//       slow and produces enormous files, so animated media is enhanced to
//       crisp HD instead — still a clear visual upgrade over the source.
//   • SVG: vector format — already infinitely scalable, returned untouched.
//   • Anything sharp cannot read: returned untouched (safe fallback).
//
// The original file is replaced in place with the enhanced version (same
// path / filename) so existing URLs keep working. The function is
// best-effort: on any error it logs and leaves the original file intact.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// 4K UHD longest-edge target for static images.
const STATIC_TARGET = 3840;
// Full-HD longest-edge target for animated images (keeps frame-by-frame
// resizing fast and the resulting file size reasonable).
const ANIMATED_TARGET = 1080;
// A light, crisp sharpening pass — strong enough to recover detail lost
// during upscaling but subtle enough to avoid halos / ringing.
const SHARPEN = { sigma: 0.6, m1: 0.6, m2: 3 };

// Small helper: is this an animated raster (gif / webp with >1 page)?
async function readMeta(filePath) {
  return sharp(filePath, { animated: true }).metadata();
}

/**
 * Enhance an image/GIF file in place to 4K/HD quality.
 * @param {string} filePath absolute path to the uploaded file
 * @returns {Promise<{enhanced:boolean, width:number, height:number, format:string, reason?:string}>}
 */
async function enhanceUpload(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { enhanced: false, width: 0, height: 0, format: '', reason: 'file not found' };
  }
  const ext = path.extname(filePath).toLowerCase();

  // SVG is vector — never rasterize/enhance it.
  if (ext === '.svg') {
    return { enhanced: false, width: 0, height: 0, format: 'svg', reason: 'vector format, untouched' };
  }

  let meta;
  try {
    meta = await readMeta(filePath);
  } catch (e) {
    // sharp could not read it (e.g. a video, a corrupt file, or an
    // unsupported format). Leave it untouched — the server still serves it.
    return { enhanced: false, width: 0, height: 0, format: '', reason: 'unreadable by sharp: ' + e.message };
  }

  const isAnimated = (meta.format === 'gif' || meta.format === 'webp') && (meta.pages || 1) > 1;
  const longestEdge = Math.max(meta.width || 0, (meta.pageHeight || meta.height) || 0);
  const target = isAnimated ? ANIMATED_TARGET : STATIC_TARGET;

  // If the source is already at or above the target resolution, we still
  // run a light sharpen + maximum-quality re-encode to "HD-enhance" it,
  // but we skip the expensive upscale. This guarantees a crisp result.
  const shouldUpscale = longestEdge > 0 && longestEdge < target;
  const resizeOpts = shouldUpscale
    ? { width: target, height: target, fit: 'inside', withoutEnlargement: false, kernel: 'lanczos3' }
    : null;

  try {
    const pipeline = sharp(filePath, { animated: true });
    if (resizeOpts) pipeline.resize(resizeOpts);
    pipeline.sharpen(SHARPEN);

    // Choose output format — keep the original type where possible so
    // transparency and animation are preserved.
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
      // PNG (and anything else) — lossless-ish, preserves transparency.
      outBuf = await pipeline.png({ quality: 100, compressionLevel: 6, palette: false }).toBuffer();
    }

    // Replace the original file with the enhanced buffer.
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
