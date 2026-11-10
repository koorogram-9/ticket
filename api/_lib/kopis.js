// KOPIS(공연예술통합전산망) 호출과 공통 도구. api/ 아래 _ 로 시작하는 폴더라 함수로 배포되지 않아요.
// 인증키는 환경변수 KOPIS_KEY 에만 둡니다. 브라우저 코드에는 절대 넣지 마세요.
const BASE = process.env.KOPIS_BASE || "http://www.kopis.or.kr/openApi/restful";
const KEY = process.env.KOPIS_KEY;
const MUSICAL_MIN_SEATS = 1000; // 뮤지컬은 이 좌석 수 이상만
const GAP_MS = 200; // KOPIS 호출 사이 최소 간격
const CACHE_MAX = 500; // 메모리 캐시에 담아 둘 최대 개수 (넘으면 오래 안 쓴 것부터 지움)
const MIN = 60e3;
const TTL = { detail: 30 * MIN, facility: 24 * 60 * MIN, list: 10 * MIN, boxoffice: 60 * MIN };

const cache = new Map(); // key -> { p: Promise, exp: 만료 시각 }
let lastCall = 0;

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
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
const isHttp = (u) => /^https?:\/\//i.test(u || "");

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
  for (let t = 0; ; t++) {
    const now = Date.now();
    const wait = Math.max(0, lastCall + GAP_MS - now);
    lastCall = now + wait;
    if (wait) await sleep(wait);
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (r.ok) return r.text();
    const body = (await r.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 80);
    if (t >= 1) throw new Error("HTTP " + r.status + " " + body);
    await sleep(1500);
  }
}

// 만료 시간과 개수 제한이 있는 캐시. 꺼낼 때마다 맨 뒤로 옮겨서 오래 안 쓴 것부터 지워요.
function cached(key, ttl, fn) {
  const now = Date.now();
  const hit = cache.get(key);
  cache.delete(key);
  if (hit && hit.exp > now) {
    cache.set(key, hit);
    return hit.p;
  }
  const ent = { p: fn(), exp: now + ttl };
  cache.set(key, ent);
  ent.p.catch(() => {
    if (cache.get(key) === ent) cache.delete(key);
  });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return ent.p;
}

function getDetail(id, ttl = TTL.detail) {
  return cached("d:" + id, ttl, async () => {
    const x = await kopis("/pblprfr/" + encodeURIComponent(id), {});
    if (!/<db>/.test(x)) throw new Error("공연 정보를 찾지 못했어요.");
    const seen = {};
    const relates = blocks(x, "relate")
      .map((r) => {
        const url = tag(r, "relateurl");
        return { name: friendly(tag(r, "relatenm"), url), url };
      })
      .filter((r) => r.name && isHttp(r.url) && !seen[r.name] && (seen[r.name] = true));
    const price = tag(x, "pcseguidance");
    const nums = (price.match(/[\d,]+\s*원/g) || []).map((v) => num(v)).filter((n) => n >= 1000);
    const minPrice = nums.length ? Math.min(...nums) : /무료/.test(price) ? 0 : null;
    const maxPrice = nums.length ? Math.max(...nums) : minPrice;
    let poster = tag(x, "poster");
    if (poster.startsWith("/")) poster = "http://www.kopis.or.kr" + poster;
    return {
      id: tag(x, "mt20id") || id,
      name: tag(x, "prfnm"),
      start: tag(x, "prfpdfrom"),
      end: tag(x, "prfpdto"),
      venue: tag(x, "fcltynm"),
      area: tag(x, "area"),
      genre: tag(x, "genrenm"),
      state: tag(x, "prfstate"),
      poster,
      mt10id: tag(x, "mt10id"),
      cast: tag(x, "prfcast"),
      crew: tag(x, "prfcrew"),
      runtime: tag(x, "prfruntime"),
      age: tag(x, "prfage"),
      time: tag(x, "dtguidance"),
      company: tag(x, "entrpsnm"),
      story: tag(x, "sty"),
      images: blocks(x, "styurl").map((b) => tag(b, "styurl")).filter(isHttp).slice(0, 6),
      relates,
      price,
      minPrice,
      maxPrice,
    };
  });
}
function getFacility(mt10id) {
  return cached("f:" + mt10id, TTL.facility, async () => {
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

// 한국 시간 기준 오늘부터 공연 종료일까지 남은 날 (2026.11.15 같은 형식)
function daysLeft(end) {
  const m = String(end || "").match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
  if (!m) return null;
  const k = new Date(Date.now() + 9 * 3600e3);
  const today = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate());
  return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - today) / 864e5);
}

module.exports = {
  KEY, MUSICAL_MIN_SEATS, TTL,
  tag, blocks, one, num, isHttp, kopis, cached, getDetail, getFacility, hallSeats, daysLeft,
};
