const BASE = process.env.KOPIS_BASE || "http://www.kopis.or.kr/openApi/restful";
const KEY = process.env.KOPIS_KEY;
const MUSICAL_MIN_SEATS = 1000; // 뮤지컬은 이 좌석 수 이상인 공연장만 보여줌
const CONCURRENCY = 6;
const TIME_BUDGET = 8000; // 이 시간(ms) 안에 확인한 공연만 보여줌
const cache = new Map();

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}
function tag(block, name) {
  const m = block.match(new RegExp("<" + name + ">([\\s\\S]*?)</" + name + ">"));
  return m ? decode(m[1]) : "";
}
function blocks(xml, name) {
  return xml.match(new RegExp("<" + name + ">[\\s\\S]*?</" + name + ">", "g")) || [];
}
const one = (v) => (Array.isArray(v) ? v[0] : v || "");
const num = (s) => parseInt(String(s).replace(/[^\d]/g, ""), 10) || 0;

function friendly(name, url) {
  const u = (url || "").toLowerCase();
  if (u.includes("interpark.com") || name === "놀유니버스") return "인터파크 티켓(NOL)";
  if (u.includes("ticketlink.co.kr")) return "티켓링크";
  if (u.includes("yes24.com")) return "예스24 티켓";
  if (u.includes("melon.com")) return "멜론티켓";
  return name;
}

async function kopis(path, params) {
  const url = new URL(BASE + path);
  url.searchParams.set("service", KEY);
  for (const k in params) if (params[k]) url.searchParams.set(k, params[k]);
  const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.text();
}
function cached(key, fn) {
  if (cache.has(key)) return cache.get(key);
  const p = fn();
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}
function getDetail(id) {
  return cached("d:" + id, async () => {
    const x = await kopis("/pblprfr/" + encodeURIComponent(id), {});
    const seen = {};
    const relates = blocks(x, "relate")
      .map((r) => {
        const url = tag(r, "relateurl");
        return { name: friendly(tag(r, "relatenm"), url), url };
      })
      .filter((r) => r.name && !seen[r.name] && (seen[r.name] = true));
    return { relates, venue: tag(x, "fcltynm"), mt10id: tag(x, "mt10id") };
  });
}
function getFacility(mt10id) {
  return cached("f:" + mt10id, async () => {
    const x = await kopis("/prfplc/" + encodeURIComponent(mt10id), {});
    const top = x.replace(/<mt13s>[\s\S]*?<\/mt13s>/, "");
    return {
      total: num(tag(top, "seatscale")),
      halls: blocks(x, "mt13").map((h) => ({ name: tag(h, "prfplcnm"), seats: num(tag(h, "seatscale")) })),
    };
  });
}
function hallSeats(fac, venue) {
  if (fac.halls.length === 0) return fac.total;
  if (fac.halls.length === 1) return fac.halls[0].seats || fac.total;
  const m = venue.match(/\(([^()]+)\)\s*$/);
  const hall = m ? m[1].trim() : "";
  if (!hall) return 0;
  const h = fac.halls.find((x) => x.name === hall || x.name.includes(hall) || hall.includes(x.name));
  return h ? h.seats : 0;
}

module.exports = async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: "서버에 KOPIS_KEY 환경변수가 설정되지 않았어요." });
    const genre = String(one(req.query.genre));
    const q = String(one(req.query.q)).slice(0, 30);
    const from = String(one(req.query.from));
    const to = String(one(req.query.to));
    const rows = Math.min(Math.max(parseInt(one(req.query.rows), 10) || 100, 1), 100);

    if (genre && !/^[A-Z]{4}$/.test(genre)) return res.status(400).json({ error: "장르 코드 형식이 올바르지 않아요." });
    if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) return res.status(400).json({ error: "날짜는 YYYYMMDD 형식이어야 해요." });

    const start = Date.now();
    const xml = await kopis("/pblprfr", { stdate: from, eddate: to, cpage: "1", rows: String(rows), shcate: genre, shprfnm: q });
    const items = blocks(xml, "db").map((b) => ({
      id: tag(b, "mt20id"),
      name: tag(b, "prfnm"),
      start: tag(b, "prfpdfrom"),
      end: tag(b, "prfpdto"),
      venue: tag(b, "fcltynm"),
      poster: tag(b, "poster"),
      genre: tag(b, "genrenm"),
      state: tag(b, "prfstate"),
      relates: [],
    }));

    let next = 0, failed = 0, lastError = "";
    async function worker() {
      while (next < items.length && Date.now() - start < TIME_BUDGET) {
        const it = items[next++];
        try {
          const d = await getDetail(it.id);
          it.relates = d.relates;
          if (d.venue) it.venue = d.venue;
          if (it.genre === "뮤지컬" && d.relates.length && d.mt10id) {
            it.seats = hallSeats(await getFacility(d.mt10id), d.venue);
          }
          it.checked = true;
        } catch (e) {
          failed++;
          lastError = e.message;
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const checked = items.filter((it) => it.checked).length;
    const shown = items.filter(
      (it) => it.checked && it.relates.length && (it.genre !== "뮤지컬" || (it.seats || 0) >= MUSICAL_MIN_SEATS)
    );
    const unchecked = items.length - checked;

    res.setHeader(
      "Cache-Control",
      unchecked > 0 ? "s-maxage=120" : "s-maxage=1800, stale-while-revalidate=86400"
    );
    res.status(200).json({
      items: shown,
      stats: { listed: items.length, checked, unchecked, failed, lastError, musicalMinSeats: MUSICAL_MIN_SEATS },
    });
  } catch (e) {
    res.status(502).json({ error: "KOPIS 조회에 실패했어요. 잠시 뒤 다시 시도해 주세요." });
  }
};
