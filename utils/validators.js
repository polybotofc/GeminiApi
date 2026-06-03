import { sendError } from './response.js';

/**
 * Returns middleware that ensures `paramName` is present in the given
 * `source` ('query' | 'body').  Responds 400 when missing.
 */
export function requireParam(paramName, source = 'query') {
  return (req, res, next) => {
    const value = source === 'body' ? req.body?.[paramName] : req.query?.[paramName];
    if (!value) return sendError(res, 400, `Parameter "${paramName}" diperlukan.`);
    next();
  };
}

/**
 * Returns middleware that rejects requests where the specified param
 * exceeds `maxLen` characters.
 */
export function maxLength(paramName, maxLen, source = 'query') {
  return (req, res, next) => {
    const value = source === 'body' ? req.body?.[paramName] : req.query?.[paramName];
    if (value && value.length > maxLen) return sendError(res, 400, 'Pesan terlalu panjang.');
    next();
  };
}

const YT_ID_REGEX = /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

/**
 * Middleware that validates a YouTube URL from `req.query.url`,
 * extracts the video ID, and stores it as `req.videoId`.
 */
export function validateYouTubeUrl() {
  return (req, res, next) => {
    const url = req.query.url;
    if (!url) return sendError(res, 400, 'Parameter "url" diperlukan.');

    const isYT = url.includes('youtube.com') || url.includes('youtu.be');
    if (!isYT) return sendError(res, 400, 'URL harus YouTube.');

    const match = url.match(YT_ID_REGEX);
    if (!match) return sendError(res, 400, 'Video ID tidak ditemukan.');

    req.videoId = match[1];
    next();
  };
}
