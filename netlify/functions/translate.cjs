// netlify/functions/translate.cjs
// Netlify Function: translates PPTX by rewriting <a:t>...</a:t> in slide XML.
// Free translators: Google (unofficial) with fallback to LibreTranslate public instance.

const JSZip = require("jszip");
const https = require("https");
const { URL } = require("url");

function xmlEscape(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function* findTextTags(xml) {
  const re = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
  let m;
  while ((m = re.exec(xml))) {
    yield { match: m[0], start: m.index, end: re.lastIndex, inner: m[1] };
  }
}

function chunkByLength(items, maxChars) {
  const chunks = [];
  let buf = [];
  let len = 0;
  for (const it of items) {
    const add = it.length + 11; // delimiter allowance
    if (len + add > maxChars && buf.length) {
      chunks.push(buf);
      buf = [it];
      len = add;
    } else {
      buf.push(it);
      len += add;
    }
  }
  if (buf.length) chunks.push(buf);
  return chunks;
}

// ЗАМЕНИ ЭТУ ФУНКЦИЮ:
function fetchJSON(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        protocol: u.protocol,
        method: options.method || "GET",
        headers: {
          "User-Agent": "netlify-function",
          "Accept": "application/json",
          ...(options.headers || {}),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error("Bad JSON from Google Translate")); }
        });
      }
    );
    req.setTimeout(options.timeout || 8000, () => {
      req.destroy(new Error("ETIMEDOUT"));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function googleTranslateBatch(texts, source, target) {
  const SEP = "|||SEP|||";
  const q = texts.join(`\n${SEP}\n`);
  const url =
    `https://translate.googleapis.com/translate_a/single?client=gtx` +
    `&sl=${encodeURIComponent(source)}` +
    `&tl=${encodeURIComponent(target)}` +
    `&dt=t&ie=UTF-8&oe=UTF-8` +
    `&q=${encodeURIComponent(q)}`;
  const data = await fetchJSON(url);
  const joined = (data[0] || []).map((x) => x[0]).join("");
  return joined.split(SEP);
}

// ЗАМЕНИ ЭТУ ФУНКЦИЮ:
async function libreTranslateBatch(texts, source, target) {
  // Несколько публичных инстансов (м.б. нестабильны)
  const endpoints = [
    "https://libretranslate.de/translate",
    "https://translate.astian.org/translate"
  ];
  const SEP = "|||SEP|||";
  const q = texts.join(`\n${SEP}\n`);
  const body = JSON.stringify({
    q,
    source: source.toLowerCase() === "auto" ? "auto" : source.toLowerCase(),
    target: target.toLowerCase(),
    format: "text"
  });

  let lastErr;
  for (const ep of endpoints) {
    try {
      const data = await fetchJSON(ep, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        timeout: 8000
      });
      const text = (data && data.translatedText) || "";
      return text.split(SEP);
    } catch (e) {
      lastErr = e;
      // Переходим к следующему endpoint
    }
  }
  throw lastErr || new Error("All LibreTranslate endpoints failed");
}

async function translateBatch(texts, source, target) {
  try {
    return await googleTranslateBatch(texts, source, target);
  } catch {
    // Если Google вернул HTML/не JSON — пробуем LibreTranslate
    return await libreTranslateBatch(texts, source, target);
  }
}

// (опционально) чуть уменьшим размер батча, чтобы реже падал Google по длине URL:
async function translateTexts(texts, source, target) {
  const safeChunks = chunkByLength(texts, 600);
  const out = [];
  for (const ch of safeChunks) {
    const part = await translateBatch(ch, source, target);
    out.push(...part);
  }
  return out;
}

async function translateXml(xml, source, target) {
  const tags = Array.from(findTextTags(xml));
  if (tags.length === 0) return xml;
  const texts = tags.map((t) => t.inner);
  const translated = await translateTexts(
    texts,
    (source || "en"),
    (target || "ru")
  );

  let out = "";
  let cursor = 0;
  tags.forEach((tag, idx) => {
    out += xml.slice(cursor, tag.start);
    const replacement = `<a:t>${xmlEscape(translated[idx] ?? "")}</a:t>`;
    out += replacement;
    cursor = tag.end;
  });
  out += xml.slice(cursor);
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST,OPTIONS",
      },
    };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Use POST with PPTX binary body." };
  }

  try {
    const source =
      (event.queryStringParameters && event.queryStringParameters.source) ||
      "EN";
    const target =
      (event.queryStringParameters && event.queryStringParameters.target) ||
      "RU";

    if (!event.body) return { statusCode: 400, body: "Empty body" };
    const buffer = event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : Buffer.from(event.body);

    const zip = await JSZip.loadAsync(buffer);

    const fileNames = Object.keys(zip.files).filter(
      (name) =>
        (name.startsWith("ppt/slides/slide") && name.endsWith(".xml")) ||
        (name.startsWith("ppt/notesSlides/notesSlide") && name.endsWith(".xml"))
    );

    for (const name of fileNames) {
      const xml = await zip.files[name].async("string");
      const translatedXml = await translateXml(xml, source, target);
      zip.file(name, translatedXml);
    }

    const outBuf = await zip.generateAsync({ type: "nodebuffer" });

    return {
      statusCode: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "Content-Disposition":
          'attachment; filename="translated_ru.pptx"',
      },
      body: outBuf.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: String(err.message || err) };
  }
};
