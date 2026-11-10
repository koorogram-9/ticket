// 예매 오픈 알림 구독
// GET                                         → { publicKey } (알림 기능이 켜져 있는지 확인)
// POST { action: "subscribe", code, subscription }
// POST { action: "unsubscribe", code, endpoint }
// POST { action: "test", code }               → 연결된 기기로 시험 알림 보내기
const S = require("./_lib/store");
const P = require("./_lib/push");

const MAX_SUBS = 10; // 동기화 코드 하나에 연결할 수 있는 기기 수

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!P.enabled()) {
    return res.status(503).json({ error: "서버에 알림 설정(VAPID 키, Upstash Redis)이 되어 있지 않아요." });
  }
  if (req.method === "GET") return res.status(200).json({ publicKey: P.PUBLIC });
  if (req.method !== "POST") return res.status(405).json({ error: "POST로 요청해 주세요." });
  try {
    const b = S.body(req);
    const code = S.normCode(b.code);
    if (!code) return res.status(400).json({ error: "동기화 코드 형식이 올바르지 않아요." });
    if (!(await S.getFavs(code))) return res.status(404).json({ error: "이 동기화 코드를 찾지 못했어요." });
    const subs = await S.getSubs(code);

    if (b.action === "subscribe") {
      const sub = P.cleanSub(b.subscription);
      if (!sub) return res.status(400).json({ error: "알림 구독 정보가 올바르지 않아요." });
      const next = subs.filter((s) => s.endpoint !== sub.endpoint).concat(sub).slice(-MAX_SUBS);
      await S.saveSubs(code, next);
      return res.status(200).json({ ok: true, devices: next.length });
    }
    if (b.action === "unsubscribe") {
      const next = subs.filter((s) => s.endpoint !== String(b.endpoint || ""));
      await S.saveSubs(code, next);
      return res.status(200).json({ ok: true, devices: next.length });
    }
    if (b.action === "test") {
      const r = await P.sendToCode(code, [
        { title: "공연 모아보기", body: "알림이 잘 도착했어요. 찜한 공연의 예매가 열리면 알려 드릴게요.", url: "/?mode=saved", tag: "test" },
      ]);
      return res.status(200).json({ ok: true, ...r });
    }
    res.status(400).json({ error: "알 수 없는 요청이에요." });
  } catch (e) {
    res.status(502).json({ error: "알림 서버 처리에 실패했어요. 잠시 뒤 다시 시도해 주세요." });
  }
};
