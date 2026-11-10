// 하루 한 번 (vercel.json 의 crons) 알림을 켠 사람들의 찜 공연을 확인해요.
// - 예매처가 없던 공연에 예매처가 생기면 "예매 오픈" 알림
// - 공연 종료 7일 전이면 "곧 종료" 알림
// Vercel은 환경변수 CRON_SECRET 이 있으면 Authorization: Bearer <값> 을 붙여서 불러 줘요.
const K = require("./_lib/kopis");
const S = require("./_lib/store");
const P = require("./_lib/push");

const END_SOON_DAYS = 7;
const TIME_BUDGET = 50e3; // vercel.json 의 maxDuration(60초) 안에 끝내기
const DETAIL_TTL = 60 * 60e3;

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== "Bearer " + secret) {
    return res.status(401).json({ error: "CRON_SECRET 이 맞지 않아요." });
  }
  if (!P.enabled() || !K.KEY) return res.status(503).json({ error: "알림 또는 KOPIS 설정이 없어요." });

  const start = Date.now();
  const report = { codes: 0, checked: 0, opened: 0, endSoon: 0, pushed: 0, skipped: 0, errors: 0 };
  try {
    const codes = await S.pushCodes();
    for (const code of codes) {
      if (Date.now() - start > TIME_BUDGET) {
        report.skipped++;
        continue;
      }
      report.codes++;
      try {
        await checkCode(code, report, start);
      } catch (e) {
        report.errors++;
      }
    }
    res.status(200).json(report);
  } catch (e) {
    res.status(502).json({ error: "알림 확인에 실패했어요.", ...report });
  }
};

async function checkCode(code, report, start) {
  const raw = await S.getFavs(code);
  if (!raw) return S.saveSubs(code, []);
  const data = S.clean(raw);
  const sent = await S.getSent(code);
  const now = Date.now();
  const opened = [];
  const endSoon = [];
  const updated = { favs: {}, removed: {} };

  for (const id of Object.keys(data.favs)) {
    if (Date.now() - start > TIME_BUDGET) break;
    const fav = data.favs[id];
    const dl = K.daysLeft(fav.end);
    if (dl !== null && dl < 0) continue; // 이미 끝난 공연은 건너뛰어요
    const flags = sent[id] || (sent[id] = {});

    if (!fav.relates.length && !flags.open) {
      report.checked++;
      try {
        const d = await K.getDetail(id, DETAIL_TTL);
        if (d.relates.length) {
          flags.open = now;
          updated.favs[id] = Object.assign({}, fav, {
            relates: d.relates, minPrice: d.minPrice, maxPrice: d.maxPrice,
            start: d.start || fav.start, end: d.end || fav.end, u: now, opened: now,
          });
          opened.push(updated.favs[id]);
        }
      } catch (e) {
        report.errors++;
      }
    }
    if (dl !== null && dl <= END_SOON_DAYS && !flags.end) {
      flags.end = now;
      endSoon.push({ fav, dl });
    }
  }

  // 찜에서 빠진 공연의 알림 기록은 지워요.
  for (const id of Object.keys(sent)) if (!data.favs[id]) delete sent[id];

  const payloads = [];
  if (opened.length === 1) {
    const f = opened[0];
    payloads.push({ title: "예매가 열렸어요", body: f.name + " · " + f.relates.map((r) => r.name).join(", "), url: "/?show=" + encodeURIComponent(f.id), tag: "open-" + f.id });
  } else if (opened.length > 1) {
    payloads.push({ title: "찜한 공연 " + opened.length + "개의 예매가 열렸어요", body: opened.map((f) => f.name).join(", "), url: "/?mode=saved", tag: "open-many" });
  }
  if (endSoon.length === 1) {
    const { fav, dl } = endSoon[0];
    payloads.push({ title: "곧 끝나는 공연이에요", body: fav.name + " · " + (dl === 0 ? "오늘 종료" : dl + "일 남았어요"), url: "/?show=" + encodeURIComponent(fav.id), tag: "end-" + fav.id });
  } else if (endSoon.length > 1) {
    payloads.push({ title: "찜한 공연 " + endSoon.length + "개가 곧 끝나요", body: endSoon.map((e) => e.fav.name).join(", "), url: "/?mode=saved", tag: "end-many" });
  }
  // 오늘 새로 알림 받은 공연 정보(예매처)를 찜 목록에 반영해서, 다른 기기에서도 보이게 해요.
  if (opened.length) {
    const latest = S.clean((await S.getFavs(code)) || {});
    await S.saveFavs(code, S.merge(latest, updated));
  }
  await S.saveSent(code, sent);
  report.opened += opened.length;
  report.endSoon += endSoon.length;
  if (payloads.length) {
    const r = await P.sendToCode(code, payloads);
    report.pushed += r.sent;
  }
}
