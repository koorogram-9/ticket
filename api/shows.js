// 공연 목록을 대신 조회해 주는 서버리스 함수
const K = require("./_lib/kopis");

const REGIONS = ["서울", "경기"]; // 이 지역 공연장만
const AREA_CODES = ["11", "41"]; // 예매상황판 지역 코드 (서울 11, 경기 41)
const PAGE_ROWS = 30;
// 트로트 판별용 단어 (공연명이나 출연진에 들어 있으면 트로트로 봄). 자유롭게 추가하세요.
const TROT_WORDS = ["트로트", "트롯", "가요무대", "효콘서트", "임영웅", "송가인", "영탁", "이찬원", "장민호", "정동원",
  "김호중", "김희재", "양지은", "홍지윤", "김다현", "전유진", "박서진", "손태진", "안성훈", "진해성", "장윤정",
  "홍진영", "진성", "나훈아", "남진", "설운도", "태진아", "주현미", "김연자", "조항조", "박현빈", "김용빈", "박지현"];
const isTrot = (it) => TROT_WORDS.some((w) => (it.name + " " + (it.cast || "")).includes(w));
const CONCURRENCY = 2;
const TIME_BUDGET = 7000;

const ymd8 = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const toNum = (s) => s.replace(/\D/g, "");
// 예매상황판(인기 순위)에서 지역·장르별로 가져오기. 뮤지컬은 1,000석 이상만
async function boxoffice(area, cate) {
  const y = new Date(Date.now() + 9 * 3600e3 - 864e5);
  const ed = ymd8(y);
  const sd = ymd8(new Date(y.getTime() - 29 * 864e5));
  const x = await K.kopis("/boxoffice", {
    ststype: "month", date: ed, stdate: sd, eddate: ed,
    catecode: cate, area, srchseatscale: cate === "GGGA" ? String(K.MUSICAL_MIN_SEATS) : "",
  });
  return K.blocks(x, "boxof").map((b) => {
    const pd = K.tag(b, "prfpd").split("~");
    let poster = K.tag(b, "poster");
    if (poster.startsWith("/")) poster = "http://www.kopis.or.kr" + poster;
    return {
      id: K.tag(b, "mt20id"), name: K.tag(b, "prfnm"), rank: K.num(K.tag(b, "rnum")) || 999,
      start: (pd[0] || "").trim(), end: (pd[1] || "").trim(),
      venue: K.tag(b, "prfplcnm"), area: K.tag(b, "area"), poster,
      genre: K.tag(b, "cate"), state: "", relates: [],
    };
  });
}

module.exports = async (req, res) => {
  try {
    if (!K.KEY) return res.status(500).json({ error: "서버에 KOPIS_KEY 환경변수가 설정되지 않았어요." });
    const genre = String(K.one(req.query.genre));
    const q = String(K.one(req.query.q)).trim().slice(0, 30);
    const from = String(K.one(req.query.from));
    const to = String(K.one(req.query.to));
    const page = Math.min(Math.max(parseInt(K.one(req.query.page), 10) || 1, 1), 30);
    const offset = Math.max(parseInt(K.one(req.query.offset), 10) || 0, 0);
    const mode = String(K.one(req.query.mode));
    const trot = String(K.one(req.query.tag)) === "trot";
    // 트로트는 KOPIS 공연명 검색 대신, 상세 조회 뒤 공연명·출연진에서 검색어를 찾아요.
    const nameQ = trot ? "" : q;

    if (genre && !/^[A-Z]{4}$/.test(genre)) return res.status(400).json({ error: "장르 코드 형식이 올바르지 않아요." });
    if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) return res.status(400).json({ error: "날짜는 YYYYMMDD 형식이어야 해요." });

    const start = Date.now();
    const popular = mode !== "upcoming";
    // 예매상황판 뮤지컬 탭은 KOPIS에서 좌석 수로 거르지만, 그 밖에는 공연장 좌석 수를 직접 확인해요.
    const checkSeats = !popular || genre !== "GGGA";
    let all, regional;
    if (popular) {
      const kst = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
      const lists = await K.cached("b:" + genre + ":" + kst, K.TTL.boxoffice, async () => {
        const out = [];
        for (const a of AREA_CODES) out.push(...(await boxoffice(a, genre)));
        return out.sort((p, r) => p.rank - r.rank);
      });
      const seenId = {};
      all = lists.filter((x) => x.id && !seenId[x.id] && (seenId[x.id] = true));
      regional = all
        .map((x) => Object.assign({}, x, { relates: [] }))
        .filter((x) => toNum(x.end) >= from && toNum(x.start) <= to && (!nameQ || x.name.includes(nameQ)));
    } else {
      const xml = await K.cached("l:" + [from, to, genre, nameQ, page].join("|"), K.TTL.list, () =>
        K.kopis("/pblprfr", { stdate: from, eddate: to, cpage: String(page), rows: String(PAGE_ROWS), shcate: genre, shprfnm: nameQ, prfstate: "01" })
      );
      all = K.blocks(xml, "db").map((b) => ({
        id: K.tag(b, "mt20id"),
        name: K.tag(b, "prfnm"),
        start: K.tag(b, "prfpdfrom"),
        end: K.tag(b, "prfpdto"),
        venue: K.tag(b, "fcltynm"),
        area: K.tag(b, "area"),
        poster: K.tag(b, "poster"),
        genre: K.tag(b, "genrenm"),
        state: K.tag(b, "prfstate"),
        relates: [],
      }));
      regional = all.filter((it) => REGIONS.some((r) => it.area.includes(r)));
    }

    const err = { detailFailed: 0, facilityFailed: 0, lastError: "" };
    let i = offset;
    async function worker() {
      while (i < regional.length && Date.now() - start < TIME_BUDGET) {
        const it = regional[i++];
        try {
          const d = await K.getDetail(it.id);
          it.relates = d.relates;
          it.cast = d.cast;
          it.price = d.price;
          it.minPrice = d.minPrice;
          it.maxPrice = d.maxPrice;
          if (d.venue) it.venue = d.venue;
          if (checkSeats && it.genre === "뮤지컬" && d.mt10id) {
            try {
              it.seats = K.hallSeats(await K.getFacility(d.mt10id), d.venue);
            } catch (e) {
              err.facilityFailed++;
              err.lastError = e.message;
            }
          }
          it.checked = true;
        } catch (e) {
          err.detailFailed++;
          err.lastError = e.message;
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const done = regional.slice(offset, i);
    const shown = done.filter(
      (it) =>
        it.checked &&
        (!trot || (isTrot(it) && (!q || (it.name + " " + (it.cast || "")).includes(q)))) &&
        (!popular || it.relates.length > 0) &&
        (!checkSeats || it.genre !== "뮤지컬" || (it.seats || 0) >= K.MUSICAL_MIN_SEATS)
    );
    let next = null;
    if (i < regional.length) next = { page, offset: i };
    else if (!popular && all.length >= PAGE_ROWS) next = { page: page + 1, offset: 0 };

    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=86400");
    res.status(200).json({
      items: shown,
      next,
      stats: {
        mode: popular ? "popular" : "upcoming",
        page,
        listed: all.length,
        regional: regional.length,
        processed: done.length,
        areas: [...new Set(all.map((x) => x.area))].slice(0, 6),
        ...err,
      },
    });
  } catch (e) {
    res.status(502).json({ error: "KOPIS 조회에 실패했어요. 잠시 뒤 다시 시도해 주세요." });
  }
};